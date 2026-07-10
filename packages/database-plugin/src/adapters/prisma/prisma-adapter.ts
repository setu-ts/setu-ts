/**
 * Prisma ORM adapter — lazily loads Prisma via `npm:@prisma/client` import
 * or accepts an injected client.
 *
 * Transaction bridging uses **two deferreds** (`txReady` + `hold`) so that
 * `beginTransaction()` does not return until the Prisma `$transaction`
 * callback has actually received the transaction client, and so that
 * `commit()` / `rollback()` properly await the outer `$transaction` promise
 * (avoiding unhandled rejections in Deno).
 *
 * @module
 */
import type { DatabaseAdapterOptions } from '../../interfaces/index.ts';
import type { IAdapterTransaction, IDatabaseAdapter } from '../adapter.ts';
import type { DataSource } from '../../repositories/base-repository.ts';

// ---------------------------------------------------------------------------
// Prisma client type — lazily resolved at connect() time.
// ---------------------------------------------------------------------------

/**
 * Structural shape of the Prisma client used by this adapter.
 *
 * The client is either injected via `options.prismaClient` or lazily loaded
 * through `import('npm:@prisma/client@7.8.0')`.
 */
type PrismaClient = {
  $connect(): Promise<void>;
  $disconnect(): Promise<void>;
  $transaction<T>(
    fn: (tx: PrismaClient) => Promise<T>,
    options?: { maxWait?: number; timeout?: number },
  ): Promise<T>;
  $queryRawUnsafe<T>(sql: string, ...params: unknown[]): Promise<T[]>;
};

/**
 * Model delegate — what each Prisma model exposes on the client.
 *
 * Convention: entity name `'User'` maps to `client.user` (first letter
 * lowercased). Documented because application code controls the entity name
 * passed to `getRepository()` / `createPrismaDataSource()`.
 */
type ModelDelegate = {
  findUnique(args: { where: Record<string, unknown> }): Promise<Record<string, unknown> | null>;
  findMany(args?: {
    where?: Record<string, unknown>;
    orderBy?: Record<string, unknown>;
    take?: number;
    skip?: number;
    select?: Record<string, unknown>;
  }): Promise<Record<string, unknown>[]>;
  create(args: { data: Record<string, unknown> }): Promise<Record<string, unknown>>;
  update(args: {
    where: Record<string, unknown>;
    data: Record<string, unknown>;
  }): Promise<Record<string, unknown>>;
  delete(args: { where: Record<string, unknown> }): Promise<Record<string, unknown>>;
  count(args?: { where?: Record<string, unknown> }): Promise<number>;
};

/**
 * Deferred promise — resolves or rejects exactly once.
 *
 * @internal
 */
class Deferred<T> {
  readonly promise: Promise<T>;
  private _resolve: (value: T) => void = () => {};
  private _reject: (reason: unknown) => void = () => {};
  private settled = false;

  constructor() {
    this.promise = new Promise<T>((resolve, reject) => {
      this._resolve = resolve;
      this._reject = reject;
    });
  }

  resolve(value: T): void {
    if (!this.settled) {
      this.settled = true;
      this._resolve(value);
    }
  }

  reject(reason: unknown): void {
    if (!this.settled) {
      this.settled = true;
      this._reject(reason);
    }
  }
}

// ---------------------------------------------------------------------------
// Prisma adapter
// ---------------------------------------------------------------------------

/**
 * Prisma adapter wrapping the official Prisma client.
 *
 * The client is either injected via `options.prismaClient` or lazily loaded
 * through `import('npm:@prisma/client@7.8.0')`.
 *
 * @since 0.1.0
 */
export class PrismaAdapter implements IDatabaseAdapter {
  private _client: PrismaClient | null = null;
  private _connected = false;
  private readonly _options: DatabaseAdapterOptions | undefined;

  constructor(options?: DatabaseAdapterOptions) {
    this._options = options ?? undefined;
  }

  /** @inheritdoc */
  async connect(): Promise<void> {
    this._client = await this.resolveClient();
    await this._client.$connect();
    this._connected = true;
  }

  /** @inheritdoc */
  async disconnect(): Promise<void> {
    if (this._client) {
      await this._client.$disconnect();
    }
    this._connected = false;
  }

  /** @inheritdoc */
  isReady(): boolean {
    return this._connected && this._client !== null;
  }

  /**
   * @inheritdoc
   *
   * Uses a two-deferred bridge:
   * - `txReady` — resolves when `$transaction` hands back the `tx` client.
   * - `hold` — kept open until `commit()` / `rollback()` settles it.
   *
   * `commit()` resolves `hold` then awaits the outer `$transaction` promise
   * so commit failures surface. `rollback()` rejects `hold` with a private
   * sentinel, then awaits the outer promise swallowing **only** that sentinel
   * to prevent a Deno-fatal unhandled rejection.
   *
   * Prisma interactive transactions have a ~5s default timeout — the bridge
   * holds the callback open for the entire Unit of Work. A custom timeout can
   * be passed through `options.transactionTimeout`.
   */
  async beginTransaction(): Promise<IAdapterTransaction> {
    if (!this.isReady()) {
      throw new Error('PrismaAdapter is not connected — call connect() first');
    }
    const client = this._client!;

    const txReady = new Deferred<PrismaClient>();
    const hold = new Deferred<void>();
    const outer = client.$transaction(
      async (tx) => {
        txReady.resolve(tx);
        await hold.promise;
      },
      {
        maxWait: 2000,
        timeout: this._options?.transactionTimeout ?? 30_000,
      },
    );

    // Wait for the tx client to be handed to us; if $transaction fails first,
    // beginTransaction rejects with that error.
    let tx: PrismaClient;
    try {
      tx = await txReady.promise;
    } catch {
      await outer.catch(() => {}); // suppress unhandled rejection on early fail
      throw new Error('Prisma transaction failed to start');
    }

    // Private sentinel so rollback can swallow only its own rejection.
    const rollbackSentinel = { code: 'ROLLBACK_SENTINEL' };

    return {
      createDataSource(entity: string): DataSource {
        return createPrismaDataSourceInner(tx, entity);
      },

      async commit(): Promise<void> {
        hold.resolve();
        await outer;
      },

      async rollback(): Promise<void> {
        hold.reject(rollbackSentinel);
        try {
          await outer;
        } catch (err) {
          // Swallow only our sentinel — rethrow anything else.
          if (err !== rollbackSentinel) {
            throw err;
          }
        }
      },
    };
  }

  /** @inheritdoc */
  rawQuery<T>(sql: string, params?: unknown[]): Promise<T[]> {
    if (!this.isReady()) {
      throw new Error('PrismaAdapter is not connected — call connect() first');
    }
    return this._client!.$queryRawUnsafe<T>(sql, ...(params ?? []));
  }

  /**
   * Create a DataSource for the named entity using the main client.
   * Used by the plugin's service-level data-source factory.
   *
   * @param entity - Entity name
   * @returns DataSource bound to the entity
   */
  createDataSourceForEntity(entity: string): DataSource {
    if (!this._client) {
      throw new Error('PrismaAdapter is not connected — call connect() first');
    }
    return createPrismaDataSourceInner(this._client, entity);
  }

  /**
   * Resolve the Prisma client from options or lazy import.
   *
   * @returns Prisma client instance
   * @throws {Error} If Prisma cannot be loaded
   */
  private async resolveClient(): Promise<PrismaClient> {
    // Prefer injected client.
    if (this._options?.prismaClient) {
      return this.validateClient(this._options.prismaClient);
    }

    // Lazy-load Prisma.
    try {
      const prismaModule = await import('npm:@prisma/client@7.8.0');
      const PrismaClient = (prismaModule as Record<string, unknown>).PrismaClient as new (
        opts: Record<string, unknown>,
      ) => PrismaClient;
      const client = new PrismaClient({
        datasources: { db: { url: this._options?.url } },
      });
      return this.validateClient(client);
    } catch (error) {
      throw new Error(
        `Failed to load Prisma: ${
          (error as Error).message
        }. Install @prisma/client AND run \`prisma generate\`, or inject via options.prismaClient.`,
      );
    }
  }

  /**
   * Structural validation: injected client must have $connect / $disconnect /
   * $transaction functions.
   */
  private validateClient(client: unknown): PrismaClient {
    const ns = client as Record<string, unknown>;
    if (
      typeof ns.$connect !== 'function' ||
      typeof ns.$disconnect !== 'function' ||
      typeof ns.$transaction !== 'function'
    ) {
      throw new Error(
        'Injected prismaClient does not look like a Prisma client ' +
          '(missing $connect / $disconnect / $transaction).',
      );
    }
    return client as PrismaClient;
  }
}

// ---------------------------------------------------------------------------
// Prisma data-source factory (used both for the service path and inside the
// transaction bridge where `tx` replaces the main client).
// ---------------------------------------------------------------------------

/**
 * Creates a {@linkcode DataSource} backed by a Prisma client for the given
 * entity name.
 *
 * **Convention**: entity name `'User'` → delegate accessed as `client.user`
 * (first letter lowercased). If the delegate is absent on the client, the
 * error names the entity and the convention so the caller can fix the entity
 * name.
 *
 * @param client - The Prisma client (or transaction client) instance
 * @param entity - Entity / model name (e.g. `'User'`)
 * @returns A data source bound to the Prisma model
 * @since 0.1.0
 */
export function createPrismaDataSource(
  client: PrismaClient,
  entity: string,
): DataSource {
  return createPrismaDataSourceInner(client, entity);
}

function createPrismaDataSourceInner(
  client: PrismaClient,
  entity: string,
): DataSource {
  // Resolve delegate: 'User' → client.user
  const delegateKey = entity.charAt(0).toLowerCase() + entity.slice(1);
  const delegate = (client as unknown as Record<string, ModelDelegate>)[delegateKey];
  if (!delegate) {
    throw new Error(
      `Prisma client has no model '${entity}' (delegate accessed as '${delegateKey}'); ` +
        `ensure a model ${entity} exists in schema.prisma and \`prisma generate\` was run.`,
    );
  }

  return {
    findById: (id) => delegate.findUnique({ where: { id } }),

    findAll: (query) => {
      const args: Parameters<ModelDelegate['findMany']>[0] = {};
      if (query.where && Object.keys(query.where).length > 0) {
        args.where = query.where;
      }
      if (query.orderBy && Object.keys(query.orderBy).length > 0) {
        // Translate { field: 'asc'|'desc' } → Prisma { field: 'asc' }
        args.orderBy = {} as Record<string, unknown>;
        for (const [field, dir] of Object.entries(query.orderBy)) {
          (args.orderBy as Record<string, unknown>)[field] = dir;
        }
      }
      if (query.limit !== undefined && query.limit > 0) {
        args.take = query.limit;
      }
      if (query.offset !== undefined && query.offset > 0) {
        args.skip = query.offset;
      }
      if (query.select && query.select.length > 0) {
        args.select = {} as Record<string, unknown>;
        for (const field of query.select) {
          (args.select as Record<string, unknown>)[field] = true;
        }
      }
      return delegate.findMany(args);
    },

    create: (data) => delegate.create({ data }),

    update(id, data) {
      return delegate.update({ where: { id }, data }).catch((err) => {
        const code = (err as { code?: string }).code;
        if (code === 'P2025') {
          throw new Error(`Entity '${entity}' with id '${id}' not found`);
        }
        throw err;
      });
    },

    async delete(id) {
      try {
        await delegate.delete({ where: { id } });
        return true;
      } catch (err) {
        const code = (err as { code?: string }).code;
        if (code === 'P2025') {
          return false;
        }
        throw err;
      }
    },

    count: (where) => delegate.count({ where: where ?? undefined }),
  };
}
