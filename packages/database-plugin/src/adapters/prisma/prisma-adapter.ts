/**
 * Prisma ORM adapter over an application-injected generated Prisma v7 client.
 *
 * Transaction bridging uses **two deferreds** (`txReady` + `hold`) so that
 * `beginTransaction()` does not return until the Prisma `$transaction`
 * callback has actually received the transaction client, and so that
 * `commit()` / `rollback()` properly await the outer `$transaction` promise
 * (avoiding unhandled rejections in Deno).
 *
 * @module
 */
import type { DatabaseAdapterOptions, PrismaSqlProvider } from '../../interfaces/index.ts';
import type { FilterExpression, IAdapterTransaction, IDatabaseAdapter } from '@setu-ts/common';
import type { DataSource } from '../../repositories/base-repository.ts';
import { UnsupportedFilterOperatorError } from '../../errors.ts';
import { escapeLikePattern } from '../../query/like-escape.ts';

// ---------------------------------------------------------------------------
// Prisma connector (provider) — decides how `contains` is translated.
// ---------------------------------------------------------------------------

/** The connectors whose `LIKE` defaults the escape character to backslash. */
const ESCAPING_PROVIDERS: ReadonlySet<string> = new Set([
  'postgresql',
  'postgres',
  'mysql',
  'sqlserver',
  'cockroachdb',
]);

/**
 * Connectors whose `contains` is not `LIKE`-based, so the value is already a
 * literal substring and escaping it would be actively wrong.
 *
 * MongoDB is the case: Prisma compiles `contains` to a `$regex` match, in which
 * `%` and `_` carry no special meaning at all. Escaping them to `\%` / `\_`
 * would search for a backslash that is not in the data — the same class of
 * wrong answer escaping produces on SQLite, reached from the other direction.
 */
const PASSTHROUGH_PROVIDERS: ReadonlySet<string> = new Set(['mongodb']);

/** Every connector the adapter recognises, for structural detection. */
const PROVIDERS: ReadonlySet<string> = new Set<string>([
  ...ESCAPING_PROVIDERS,
  ...PASSTHROUGH_PROVIDERS,
  'sqlite',
]);

// ---------------------------------------------------------------------------
// Prisma client type — resolved from the application at connect() time.
// ---------------------------------------------------------------------------

/**
 * Structural shape of the Prisma client used by this adapter.
 *
 * The client is injected via `options.prismaClient`. Prisma v7 generates its
 * client into an application-selected output path, which this package cannot
 * discover safely.
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
 * The application injects a generated Prisma v7 client through
 * `options.prismaClient`.
 *
 * @since 0.1.0
 */
export class PrismaAdapter implements IDatabaseAdapter {
  private _client: PrismaClient | null = null;
  private _connected = false;
  private readonly _options: DatabaseAdapterOptions | undefined;
  /** The resolved connector, or `undefined` when it could not be determined. */
  private _provider: PrismaSqlProvider | undefined;

  constructor(options?: DatabaseAdapterOptions) {
    this._options = options ?? undefined;
  }

  /** @inheritdoc */
  async connect(): Promise<void> {
    this._client = await this.resolveClient();
    this._provider = this.resolveProvider();
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
    // Capture for the returned transaction's data-source factory, whose `this`
    // is the transaction object, not this adapter.
    const provider = this._provider;

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
    // If $transaction rejects before handing back `tx` (e.g. it fails to open
    // the interactive transaction), unblock the waiter so beginTransaction
    // rejects instead of hanging on a promise that never settles.
    outer.catch((err: unknown) => txReady.reject(err));

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
        return createPrismaDataSourceInner(tx, entity, provider);
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
   * @inheritdoc
   *
   * Builds a non-transactional data source over the main client.
   */
  createDataSource(entity: string): DataSource {
    if (!this._client) {
      throw new Error('PrismaAdapter is not connected — call connect() first');
    }
    return createPrismaDataSourceInner(this._client, entity, this._provider);
  }

  /**
   * Create a DataSource for the named entity using the main client.
   *
   * @deprecated Use {@linkcode PrismaAdapter.createDataSource} instead — it is
   * the promoted {@linkcode IDatabaseAdapter} member, so the plugin reaches it
   * without casting to this concrete class. Will be removed in the next major
   * version.
   * @param entity - Entity name
   * @returns DataSource bound to the entity
   */
  createDataSourceForEntity(entity: string): DataSource {
    return this.createDataSource(entity);
  }

  /**
   * Resolve the application-generated Prisma v7 client from options.
   *
   * @returns Prisma client instance
   * @throws {Error} If no generated Prisma client was injected
   */
  private resolveClient(): PrismaClient {
    if (this._options?.prismaClient) {
      return this.validateClient(this._options.prismaClient);
    }
    throw new Error(
      'PrismaAdapter requires options.prismaClient: construct and generate a Prisma v7 client in ' +
        'the application, then inject it into DatabasePlugin.',
    );
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

  /**
   * Resolve the connector the client is bound to.
   *
   * An explicit `options.provider` always wins. Otherwise the client's active
   * provider is read structurally — `{ _activeProvider?: unknown }` narrowed
   * with `typeof === 'string'`, never a cast to `any` — and accepted only when
   * it is one of the known connectors. The field is underscore-prefixed and
   * therefore not a stability promise, which is exactly why an unrecognised or
   * absent value is `undefined` (refuse) rather than a guess, and why the
   * explicit option exists.
   *
   * @returns The resolved connector, or `undefined` when undetermined
   */
  private resolveProvider(): PrismaSqlProvider | undefined {
    const explicit = this._options?.provider;
    if (explicit !== undefined) {
      return explicit;
    }
    const client = this._client as unknown as Record<string, unknown>;
    const active = client._activeProvider;
    if (typeof active === 'string' && (PROVIDERS as ReadonlySet<string>).has(active)) {
      return active as PrismaSqlProvider;
    }
    return undefined;
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
  provider?: PrismaSqlProvider,
): DataSource {
  return createPrismaDataSourceInner(client, entity, provider);
}

function createPrismaDataSourceInner(
  client: PrismaClient,
  entity: string,
  provider?: PrismaSqlProvider,
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
      const where = prismaWhere(query.where, query.filter, provider);
      if (where !== undefined) {
        args.where = where;
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

    count: (where, filter) => {
      const predicate = prismaWhere(where, filter, provider);
      return delegate.count(predicate === undefined ? {} : { where: predicate });
    },
  };
}

function prismaWhere(
  where: Record<string, unknown>,
  filter?: FilterExpression,
  provider?: PrismaSqlProvider,
): Record<string, unknown> | undefined {
  const equality = Object.keys(where).length === 0 ? undefined : where;
  if (filter === undefined) return equality;
  const expression = prismaFilter(filter, provider);
  if (equality === undefined) return expression;
  return { AND: [equality, expression] };
}

function prismaFilter(
  filter: FilterExpression,
  provider?: PrismaSqlProvider,
): Record<string, unknown> {
  if (filter.type !== 'comparison') {
    return filter.type === 'and'
      ? { AND: filter.filters.map((f) => prismaFilter(f, provider)) }
      : { OR: filter.filters.map((f) => prismaFilter(f, provider)) };
  }
  switch (filter.operator) {
    case 'eq':
      return { [filter.field]: filter.value };
    case 'contains':
      return { [filter.field]: { contains: prismaContainsValue(filter.value, provider) } };
    case 'gt':
      return { [filter.field]: { gt: filter.value } };
    case 'gte':
      return { [filter.field]: { gte: filter.value } };
    case 'lt':
      return { [filter.field]: { lt: filter.value } };
    case 'lte':
      return { [filter.field]: { lte: filter.value } };
    case 'in': {
      const nonNullValues = filter.value.filter((value) => value !== null);
      if (!filter.value.includes(null)) {
        return { [filter.field]: { in: nonNullValues } };
      }
      if (nonNullValues.length === 0) {
        return { [filter.field]: null };
      }
      return {
        OR: [
          { [filter.field]: null },
          { [filter.field]: { in: nonNullValues } },
        ],
      };
    }
  }
}

/**
 * Translate a `contains` filter value for Prisma, honouring the connector.
 *
 * - Escaping connectors (`postgresql`, `postgres`, `mysql`, `sqlserver`,
 *   `cockroachdb`): escape `\`, `%` and `_` so the value is a literal
 *   substring. Their `LIKE` defaults the escape character to backslash, so the
 *   escaping is effective without an `ESCAPE` clause.
 * - Passthrough connectors (`mongodb`): return the value unchanged. `contains`
 *   compiles to a `$regex` match there, so `%` and `_` are already literal and
 *   escaping them would search for a backslash the data does not contain.
 * - `sqlite`: **refuse**. Prisma emits no `ESCAPE` clause and SQLite defines
 *   no default escape character, so a literal `contains` is not expressible
 *   through Prisma's filter API there. Returning wrong rows quietly is the
 *   defect; returning a named error is the repair.
 * - Connector not determined: refuse, naming the `provider` option as the fix.
 *
 * The refusal is at translation time, not at `connect()`: an application that
 * never uses `contains` must not be blocked from starting because its
 * connector could not be identified.
 *
 * @param value - The raw search value
 * @param provider - The resolved connector, or `undefined` when undetermined
 * @returns The (escaped) value to pass to Prisma's `contains`
 * @throws {UnsupportedFilterOperatorError} When the connector is `sqlite` or
 *   could not be determined
 */
function prismaContainsValue(
  value: string,
  provider: PrismaSqlProvider | undefined,
): string {
  if (provider === 'sqlite') {
    throw new UnsupportedFilterOperatorError(
      'contains',
      'sqlite',
      "The 'contains' filter operator is not supported by the Prisma adapter on SQLite: " +
        'Prisma emits no ESCAPE clause and SQLite defines no default escape character, so a ' +
        "literal substring match is not expressible through Prisma's filter API there. Use a raw " +
        "query, or the memory/drizzle adapter (both honour 'contains' as a literal substring).",
    );
  }
  if (provider === undefined) {
    throw new UnsupportedFilterOperatorError(
      'contains',
      undefined,
      "The 'contains' filter operator requires a known Prisma connector, and it could not be " +
        "determined. Pass `provider` (e.g. `provider: 'postgresql'`) in the database adapter " +
        "options so the adapter knows how to translate 'contains'.",
    );
  }
  // Not `LIKE`-based: the value is already a literal substring, so escaping it
  // would be the wrong answer rather than a safer one.
  if (PASSTHROUGH_PROVIDERS.has(provider)) {
    return value;
  }
  // Every remaining recognised connector defaults its LIKE escape character to
  // backslash, so the escaping is effective.
  if (!ESCAPING_PROVIDERS.has(provider)) {
    // Defensive: an unrecognised provider that slipped through detection.
    throw new UnsupportedFilterOperatorError(
      'contains',
      provider,
      `The 'contains' filter operator is not supported by the Prisma adapter on connector ` +
        `'${provider}'.`,
    );
  }
  return escapeLikePattern(value);
}
