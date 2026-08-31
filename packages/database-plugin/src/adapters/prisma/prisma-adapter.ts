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
import type {
  DatabaseAdapterOptions,
  PrismaAdapterOptions,
  PrismaSqlProvider,
} from '../../interfaces/index.ts';
import type {
  CursorPayload,
  EntityKey,
  FilterExpression,
  IAdapterTransaction,
  IDatabaseAdapter,
  NormalizedQuery,
  OrderDirection,
  PageResult,
} from '@setu-ts/common';
import { decodeCursor, keysetPredicate, mintNextCursor, sortFingerprint } from '@setu-ts/common';
import type { DataSource } from '../../repositories/base-repository.ts';
import { UnsupportedFilterOperatorError, UnsupportedQueryFeatureError } from '../../errors.ts';
import { escapeLikePattern } from '../../query/like-escape.ts';
import { keyValues } from '../../query/key-target.ts';
import {
  normalizePageQuery,
  PageNormalizationError,
  projectFields,
} from '../../query/query-builder.ts';

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
  private readonly _options: DatabaseAdapterOptions | PrismaAdapterOptions | undefined;
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
    const entities = (this._options as PrismaAdapterOptions | undefined)?.entities;

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
        return createPrismaDataSourceInner(
          tx,
          entity,
          provider,
          entities?.[entity]?.keyColumns ?? ['id'],
          entities?.[entity]?.compositeKeyName,
        );
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
    const entities = (this._options as PrismaAdapterOptions | undefined)?.entities;
    return createPrismaDataSourceInner(
      this._client,
      entity,
      this._provider,
      entities?.[entity]?.keyColumns ?? ['id'],
      entities?.[entity]?.compositeKeyName,
    );
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
/**
 * Build a Prisma compound-key `where` from an {@linkcode EntityKey} and the
 * resolved column values.
 *
 * For a scalar key, the shape is `{ id: value }` (today's path). For a
 * composite key, the shape is `{ <compoundField>: { col1: val1, col2: val2 } }`
 * — Prisma's compound-key syntax, order-insensitive (P3).
 *
 * @param id - The primary key value
 * @param entity - Entity name (used for error messages)
 * @param columns - The resolved key columns
 * @param compoundKeyField - The compound-key field name, derived or overridden
 * @returns The `where` argument for `findUnique`/`update`/`delete`
 */
function buildCompoundWhere(
  id: EntityKey,
  entity: string,
  columns: readonly string[],
  compoundKeyField: string,
): Record<string, unknown> {
  if (typeof id === 'string' || typeof id === 'number') {
    return { id };
  }
  const values = keyValues(id, columns, `findById on '${entity}'`);
  const record: Record<string, unknown> = {};
  for (let i = 0; i < columns.length; i++) {
    record[columns[i]] = values[i];
  }
  return { [compoundKeyField]: record };
}

/**
 * Translate a normalized query into a Prisma `findMany` argument object.
 *
 * The ONE argument builder behind both entry points — {@linkcode DataSource.findAll}
 * and {@linkcode DataSource.findPage} — so the two cannot drift about how a
 * where clause, a sort, a limit, a skip or a projection reach the delegate.
 * `take` is set only for a positive limit (Prisma treats an absent `take` as
 * unbounded) and `skip` only for a positive offset.
 *
 * @param where - The translated Prisma `where` input, or `undefined` for none
 * @param orderBy - Field-to-direction sort specification (empty for no sort)
 * @param limit - Maximum rows, or a non-positive value for unbounded
 * @param offset - Leading rows to skip, or `0` for none
 * @param select - Projected fields (empty means all fields)
 * @returns The `findMany` argument object
 */
function buildFindManyArgs(
  where: Record<string, unknown> | undefined,
  orderBy: Record<string, OrderDirection>,
  limit: number,
  offset: number,
  select: readonly string[],
): Parameters<ModelDelegate['findMany']>[0] {
  const args: Parameters<ModelDelegate['findMany']>[0] = {};
  if (where !== undefined) {
    args.where = where;
  }
  if (Object.keys(orderBy).length > 0) {
    // Translate { field: 'asc'|'desc' } → Prisma { field: 'asc' }
    args.orderBy = {} as Record<string, unknown>;
    for (const [field, dir] of Object.entries(orderBy)) {
      (args.orderBy as Record<string, unknown>)[field] = dir;
    }
  }
  if (limit > 0) {
    args.take = limit;
  }
  if (offset > 0) {
    args.skip = offset;
  }
  if (select.length > 0) {
    args.select = {} as Record<string, unknown>;
    for (const field of select) {
      (args.select as Record<string, unknown>)[field] = true;
    }
  }
  return args;
}

/**
 * Conjoin two optional portable filters, preferring the single expression when
 * only one is present — an `and` node with one child would be a shape the
 * caller never wrote and every backend translates differently.
 *
 * @param base - The caller's own filter, or `undefined`
 * @param extra - The keyset predicate, or `undefined` on the first page
 * @returns The conjoined expression, or `undefined` when neither is present
 */
function conjoinFilters(
  base: FilterExpression | undefined,
  extra: FilterExpression | undefined,
): FilterExpression | undefined {
  if (base === undefined) return extra;
  if (extra === undefined) return base;
  return { type: 'and', filters: [base, extra] };
}

/**
 * Core `findPage` for the Prisma data source — the §3.8 keyset pipeline, one
 * implementation shared with the transaction data source (both are built by
 * {@linkcode createPrismaDataSourceInner}).
 *
 * Pipeline:
 * 1. `normalizePageQuery` — a non-zero `offset` beside a `cursor` is refused
 *    by name before any backend call (§3.10).
 * 2. Decode the incoming cursor. Malformed is refused by name; absent starts
 *    the walk at page one.
 * 3. Verify the sort fingerprint, so a cursor minted under one sort and
 *    presented under another is refused rather than served a silently wrong
 *    page.
 * 4. Build the portable keyset predicate with {@linkcode keysetPredicate} and
 *    conjoin it with the caller's `where` and `filter` — the predicate is a
 *    `FilterExpression`, so it translates through the existing
 *    {@linkcode prismaFilter} path with no new translation code.
 * 5. `findMany` with `take: limit + 1` (the one-extra-row probe): more than
 *    `limit` rows means a next page exists and the LAST returned row mints the
 *    next cursor; otherwise the page is terminal and `nextCursor` is `null`.
 * 6. When a projection is present, the key columns (and the ordered fields the
 *    cursor minting reads) join the internal select so they participate in the
 *    probe and cursor minting, and are stripped from the returned rows so the
 *    caller's projection is what comes back — plan §8 risk.
 *
 * @param delegate - The Prisma model delegate for the entity
 * @param query - The normalized page query, carrying an optional `cursor`
 * @param entity - Entity name, quoted in every refusal
 * @param provider - The Prisma SQL provider (connector)
 * @param keyColumns - The resolved primary-key columns
 * @returns A {@linkcode PageResult} carrying `rows` and the `nextCursor`
 * @throws {UnsupportedQueryFeatureError} When the token is malformed or the
 *   fingerprint does not match the current sort (rejected, never a synchronous
 *   throw)
 */
async function findPrismaPage(
  delegate: ModelDelegate,
  query: NormalizedQuery,
  entity: string,
  provider: PrismaSqlProvider | undefined,
  keyColumns: readonly string[],
): Promise<PageResult> {
  // 1. §3.10 — offset and cursor are contradictory; refuse before any call.
  const normalized = normalizePageQuery(query);
  if (normalized instanceof PageNormalizationError) {
    return Promise.reject(normalized);
  }

  // 2. Decode cursor. A missing cursor means start of the walk; a malformed
  //    token is refused by name.
  let decoded: CursorPayload | null = null;
  if (normalized.cursor !== undefined) {
    decoded = decodeCursor(normalized.cursor);
    if (decoded === null) {
      return Promise.reject(
        new UnsupportedQueryFeatureError(
          'cursor-pagination',
          'prisma',
          `cursor-pagination: entity '${entity}': malformed cursor token`,
        ),
      );
    }
  }

  // 3. Sort-fingerprint guard — a cross-sort cursor would return a silently
  //    wrong page.
  const fingerprint = sortFingerprint(normalized.orderBy);
  if (decoded !== null && decoded.sortFingerprint !== fingerprint) {
    return Promise.reject(
      new UnsupportedQueryFeatureError(
        'cursor-pagination',
        'prisma',
        `cursor-pagination: entity '${entity}': cursor fingerprint mismatch — expected ` +
          `'${fingerprint}', got '${decoded.sortFingerprint}'`,
      ),
    );
  }

  // 4. Keyset predicate through the shared builder; it is a FilterExpression,
  //    so it reaches the delegate through the existing prismaFilter path.
  const keyset = decoded === null
    ? undefined
    : keysetPredicate(decoded.orderedValues, decoded.keyValues, normalized.orderBy, keyColumns);

  // 5. One-extra-row probe. A non-zero skip is never applied: the keyset
  //    position replaces offset (and §3.10 refused the two together).
  const probeLimit = normalized.limit > 0 ? normalized.limit + 1 : normalized.limit;
  const internalSelect = normalized.select.length > 0
    ? [...new Set([...normalized.select, ...keyColumns, ...Object.keys(normalized.orderBy)])]
    : [];
  const found = await delegate.findMany(
    buildFindManyArgs(
      prismaWhere(normalized.where, conjoinFilters(normalized.filter, keyset), provider),
      normalized.orderBy,
      probeLimit,
      0,
      internalSelect,
    ),
  );

  // 6. Probe outcome: more than `limit` rows means a next page exists and the
  //    LAST returned row mints the cursor; otherwise the page is terminal.
  const hasMore = normalized.limit > 0 && found.length > normalized.limit;
  const pageRows = hasMore ? found.slice(0, normalized.limit) : found;
  const nextCursor = mintNextCursor(
    pageRows,
    normalized.orderBy,
    keyColumns,
    fingerprint,
    hasMore,
  );

  // 7. The caller's projection is what comes back — the key columns and the
  //    ordered fields joined the internal select only for the probe and the
  //    cursor minting, and are stripped here.
  const rows = internalSelect.length > 0
    ? pageRows.map((row) => projectFields(row, normalized.select) as Record<string, unknown>)
    : pageRows;
  return { rows, nextCursor };
}

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
 * @param provider - The Prisma SQL provider (connector)
 * @param keyColumns - The resolved primary-key columns (defaults to `['id']`)
 * @param compoundKeyField - The compound-key field name, or `undefined` for scalar keys
 * @returns A data source bound to the Prisma model
 * @since 0.1.0
 */
export function createPrismaDataSource(
  client: PrismaClient,
  entity: string,
  provider?: PrismaSqlProvider,
  keyColumns?: readonly string[],
  compoundKeyField?: string,
): DataSource {
  return createPrismaDataSourceInner(
    client,
    entity,
    provider,
    keyColumns ?? ['id'],
    compoundKeyField,
  );
}

/**
 * Internal factory used by both the public surface and the transaction bridge.
 *
 * @param client - The Prisma client (or transaction client) instance
 * @param entity - Entity / model name (e.g. `'User'`)
 * @param provider - The Prisma SQL provider (connector)
 * @param keyColumns - The resolved primary-key columns
 * @param compoundKeyField - The compound-key field name, or `undefined` for scalar keys
 * @returns A data source bound to the Prisma model
 * @internal
 */
function createPrismaDataSourceInner(
  client: PrismaClient,
  entity: string,
  provider?: PrismaSqlProvider,
  keyColumns: readonly string[] = ['id'],
  compoundKeyField?: string,
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
    findById: (id) => {
      if (typeof id === 'object') {
        if (compoundKeyField === undefined) {
          return Promise.reject(
            new UnsupportedQueryFeatureError(
              'composite-key',
              'prisma',
              `composite-key: PrismaAdapter.findById (adapter 'prisma') requires a composite key configuration; got ${typeof id}. ` +
                `Pass entities.\`${entity}\`.compositeKeyName and entities.\`${entity}\`.keyColumns via PrismaAdapterOptions to enable.`,
            ),
          );
        }
        return delegate.findUnique({
          where: buildCompoundWhere(id, entity, keyColumns, compoundKeyField),
        });
      }
      return delegate.findUnique({ where: { id } });
    },

    findAll: (query) => {
      return delegate.findMany(
        buildFindManyArgs(
          prismaWhere(query.where, query.filter, provider),
          query.orderBy,
          query.limit,
          query.offset,
          query.select,
        ),
      );
    },

    findPage: (query) => findPrismaPage(delegate, query, entity, provider, keyColumns),

    create: (data) => delegate.create({ data }),

    update(id, data) {
      if (typeof id === 'object') {
        if (compoundKeyField === undefined) {
          return Promise.reject(
            new UnsupportedQueryFeatureError(
              'composite-key',
              'prisma',
              `composite-key: PrismaAdapter.update (adapter 'prisma') requires a composite key configuration; got ${typeof id}. ` +
                `Pass entities.\`${entity}\`.compositeKeyName and entities.\`${entity}\`.keyColumns via PrismaAdapterOptions to enable.`,
            ),
          );
        }
        return delegate.update({
          where: buildCompoundWhere(id, entity, keyColumns, compoundKeyField),
          data,
        }).catch((err: unknown) => {
          const code = (err as { code?: string }).code;
          if (code === 'P2025') {
            throw new Error(`Entity '${entity}' with id not found`);
          }
          throw err;
        });
      }
      return delegate.update({ where: { id }, data }).catch((err: unknown) => {
        const code = (err as { code?: string }).code;
        if (code === 'P2025') {
          throw new Error(`Entity '${entity}' with id '${id}' not found`);
        }
        throw err;
      });
    },

    async delete(id) {
      if (typeof id === 'object') {
        if (compoundKeyField === undefined) {
          return Promise.reject(
            new UnsupportedQueryFeatureError(
              'composite-key',
              'prisma',
              `composite-key: PrismaAdapter.delete (adapter 'prisma') requires a composite key configuration; got ${typeof id}. ` +
                `Pass entities.\`${entity}\`.compositeKeyName and entities.\`${entity}\`.keyColumns via PrismaAdapterOptions to enable.`,
            ),
          );
        }
        try {
          await delegate.delete({
            where: buildCompoundWhere(id, entity, keyColumns, compoundKeyField),
          });
          return true;
        } catch (err) {
          const code = (err as { code?: string }).code;
          if (code === 'P2025') {
            return false;
          }
          throw err;
        }
      }
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

/** Build a Prisma path-form operator object from a path array and operator name. */
function pathOperator(
  field: readonly string[],
  operator: string,
  value: unknown,
): Record<string, unknown> {
  const root = field[0];
  const path = field.slice(1);
  return { [root]: { path, [operator]: value } };
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
  const field = Array.isArray(filter.field) ? filter.field : [filter.field];
  switch (filter.operator) {
    case 'eq':
      return field.length === 1
        ? { [field[0]]: filter.value }
        : pathOperator(field, 'equals', filter.value);
    case 'contains':
      return field.length === 1
        ? { [field[0]]: { contains: prismaContainsValue(filter.value, provider) } }
        : pathOperator(field, 'contains', prismaContainsValue(filter.value, provider));
    case 'gt':
      return field.length === 1
        ? { [field[0]]: { gt: filter.value } }
        : pathOperator(field, 'gt', filter.value);
    case 'gte':
      return field.length === 1
        ? { [field[0]]: { gte: filter.value } }
        : pathOperator(field, 'gte', filter.value);
    case 'lt':
      return field.length === 1
        ? { [field[0]]: { lt: filter.value } }
        : pathOperator(field, 'lt', filter.value);
    case 'lte':
      return field.length === 1
        ? { [field[0]]: { lte: filter.value } }
        : pathOperator(field, 'lte', filter.value);
    case 'in': {
      const nonNullValues = filter.value.filter((value) => value !== null);
      if (field.length === 1) {
        if (!filter.value.includes(null)) {
          return { [field[0]]: { in: nonNullValues } };
        }
        if (nonNullValues.length === 0) {
          return { [field[0]]: null };
        }
        return {
          OR: [
            { [field[0]]: null },
            { [field[0]]: { in: nonNullValues } },
          ],
        };
      }
      // Multi-segment path: build the OR-based null/in predicate under the path object.
      const pathEq = pathOperator(field, 'equals', null);
      if (!filter.value.includes(null)) {
        return pathOperator(field, 'in', nonNullValues);
      }
      if (nonNullValues.length === 0) {
        return pathEq;
      }
      return {
        OR: [
          pathEq,
          pathOperator(field, 'in', nonNullValues),
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
