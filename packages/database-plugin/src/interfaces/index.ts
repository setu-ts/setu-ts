/**
 * Public interfaces for the database plugin.
 *
 * These contracts define what application code depends on; adapters provide
 * the implementations.
 *
 * @module
 */
import type { EntityKey, IDatabaseAdapter } from '@setu-ts/common';
import type { DrizzleDatabaseIdentity } from '../query/drizzle-database.ts';
import type { CountOptions, FindOptions, Page, PageOptions } from '../query/find-options.ts';
import type { SqlJsonDialect } from '../query/json-path.ts';
import type { IMongoClient, IMongoObjectIdCtor } from '../adapters/mongo/mongo-client.ts';
import type { MongoEntityMapping } from '../adapters/mongo/mongo-mapping.ts';
import type { ICosmosClient } from '../adapters/cosmos/cosmos-client.ts';
import type { CosmosEntityMapping } from '../adapters/cosmos/cosmos-mapping.ts';

// Re-export query option types so consumers don't need internal paths.
export type {
  CountOptions,
  FindOptions,
  OrderDirection,
  Page,
  PageOptions,
} from '../query/find-options.ts';

/**
 * The SQL connector a Prisma client is bound to.
 *
 * Only `contains` is connector-sensitive in the Prisma adapter, and only
 * because the escaping it applies is correct solely on connectors whose `LIKE`
 * defaults the escape character to backslash. The three groups are:
 *
 * - **Escaped** (`postgresql`/`postgres`, `mysql`, `sqlserver`, `cockroachdb`)
 *   — `LIKE`-based with a backslash default escape, so the value is escaped.
 * - **Passed through** (`mongodb`) — `contains` compiles to a `$regex` match in
 *   which `%` and `_` are already literal, so escaping them would be wrong.
 *   **This arm is unreachable on Prisma v7**: a Prisma client for MongoDB
 *   cannot be constructed (generation succeeds, construction fails — MongoDB
 *   did not make the Prisma 7 release and returns in Prisma 8). It is retained
 *   because it is a published export (AI_GUIDELINES §9.2), and the reasoning
 *   stays correct for any future Prisma-Mongo client. The supported MongoDB
 *   route is the `'mongodb'` **adapter arm** ({@linkcode MongoDatabaseOptions}).
 * - **Refused** (`sqlite`) — `LIKE`-based with no default escape character and
 *   no `ESCAPE` clause from Prisma, so a literal `contains` is inexpressible.
 *
 * `'postgres'` is accepted alongside `'postgresql'` because the schema spells
 * it the long way while the driver adapter reports the short one. An
 * application whose connector cannot be detected passes `provider` explicitly
 * rather than have the adapter guess.
 *
 * @since 0.2.0
 */
export type PrismaSqlProvider =
  | 'postgresql'
  | 'postgres'
  | 'mysql'
  | 'sqlserver'
  | 'cockroachdb'
  | 'mongodb'
  | 'sqlite';

/**
 * Generic repository providing CRUD operations over an entity type.
 *
 * @typeParam Entity - The entity shape the repository manages
 * @typeParam Id - Primary key type, constrained to {@linkcode EntityKey} (scalar `string`/`number` or composite record). Defaults to `string`.
 * @since 0.1.0
 */
export interface IRepository<Entity, Id extends EntityKey = string> {
  /**
   * Fetch a single entity by its primary key.
   *
   * @param id - Primary key value
   * @returns The entity or `null` when not found
   * @since 0.1.0
   */
  findById(id: Id): Promise<Entity | null>;

  /**
   * Fetch entities with optional filtering, sorting, and pagination.
   *
   * @param options - Find options (filter, sort, paginate)
   * @returns Matching entities
   * @since 0.1.0
   */
  findAll(options?: FindOptions): Promise<Entity[]>;

  /**
   * Fetch the first entity matching the optional filter.
   *
   * @param options - Find options; at most one matching entity is returned
   * @returns The first matching entity, or `null` when none matches
   * @since 0.2.0
   */
  findOne(options?: FindOptions): Promise<Entity | null>;

  /**
   * Insert a new entity.
   *
   * @param data - Partial entity (at minimum the required fields)
   * @returns The persisted entity (with generated fields populated)
   * @since 0.1.0
   */
  create(data: Partial<Entity>): Promise<Entity>;

  /**
   * Update an existing entity by primary key.
   *
   * @param id - Primary key of the entity to update
   * @param data - Fields to merge into the entity
   * @returns The updated entity
   * @throws {Error} If the entity does not exist
   * @since 0.1.0
   */
  update(id: Id, data: Partial<Entity>): Promise<Entity>;

  /**
   * Delete an entity by primary key.
   *
   * @param id - Primary key of the entity to delete
   * @returns `true` if an entity was deleted, `false` if not found
   * @since 0.1.0
   */
  delete(id: Id): Promise<boolean>;

  /**
   * Check whether an entity with the given primary key exists.
   *
   * @param id - Primary key value
   * @returns `true` when the entity exists
   * @since 0.1.0
   */
  exists(id: Id): Promise<boolean>;

  /**
   * Count entities with optional filtering.
   *
   * @param options - Count options (equality and portable expression filters)
   * @returns Matching entity count
   * @since 0.1.0
   */
  count(options?: CountOptions): Promise<number>;

  /**
   * Find a page of entities by cursor pagination.
   *
   * @param options - Find options, optionally carrying a cursor position
   * @returns The page of entities plus a `nextCursor` that is `null` when the page is the last
   * @throws {UnsupportedQueryFeatureError} When the bound data source lacks `findPage`
   * @since 0.2.0
   */
  findPage(options: PageOptions): Promise<Page<Entity>>;
}

/**
 * Unit of Work: transaction-scoped repository access.
 *
 * All repositories obtained from a Unit of Work share the same underlying
 * transaction and commit or roll back together.
 *
 * @since 0.1.0
 */
export interface IUnitOfWork {
  /**
   * Get a transaction-scoped repository for the named entity.
   *
   * @typeParam Entity - Entity shape
   * @typeParam Id - Primary key type
   * @param entity - Entity name (e.g. `'User'`)
   * @returns Repository bound to the current transaction
   * @since 0.1.0
   */
  getRepository<Entity, Id extends EntityKey = string>(entity: string): IRepository<Entity, Id>;
}

/**
 * High-level database service combining repository access, unit of work,
 * raw queries, and lifecycle management.
 *
 * @since 0.1.0
 */
export interface IDatabaseService {
  /**
   * Get a repository for the named entity type.
   *
   * @typeParam Entity - Entity shape
   * @typeParam Id - Primary key type
   * @param entity - Entity name (e.g. `'User'`)
   * @returns Repository for the entity
   * @since 0.1.0
   */
  getRepository<Entity, Id extends EntityKey = string>(entity: string): IRepository<Entity, Id>;

  /**
   * Execute the `work` callback within a database transaction.
   *
   * On success the transaction commits and the callback result is returned.
   * On error the transaction rolls back and the error propagates.
   *
   * @typeParam T - Return type of the work callback
   * @param work - Function receiving a transaction-scoped Unit of Work
   * @returns The result of the `work` callback
   * @throws {Error} If the work callback throws — transaction is rolled back
   * @since 0.1.0
   */
  transaction<T>(work: (uow: IUnitOfWork) => Promise<T>): Promise<T>;

  /**
   * Execute a raw SQL query and return results.
   *
   * @typeParam T - Expected row shape
   * @param sql - SQL query string
   * @param params - Query parameters (replaced positionally)
   * @returns Query result rows
   * @since 0.1.0
   */
  query<T>(sql: string, params?: unknown[]): Promise<T[]>;

  /**
   * Programmatic migrations are unsupported by the current adapters. Each ORM
   * owns schema migration through its own CLI, so this method rejects.
   *
   * @returns A rejected promise naming the unsupported operation
   * @since 0.1.0
   */
  migrate(): Promise<void>;

  /**
   * Health-check probe: verifies the database connection is alive.
   *
   * @returns `true` when the database is reachable
   * @since 0.1.0
   */
  isHealthy(): Promise<boolean>;

  /**
   * Gracefully close all database connections.
   *
   * @since 0.1.0
   */
  close(): Promise<void>;
}

/**
 * Supported adapter backends.
 *
 * `'custom'` accepts any {@linkcode IDatabaseAdapter}, so a backend can live
 * in another package — `cloudflare-plugin`'s `D1Adapter` is the first.
 *
 * @since 0.1.0
 */
export type DatabaseAdapterType =
  | 'prisma'
  | 'drizzle'
  | 'memory'
  | 'mongodb'
  | 'cosmos'
  | 'custom';

// Re-export the Mongo structural types the `'mongodb'` arm carries, so an
// application annotating its configuration reaches them from the package
// barrel. The client and ObjectId constructor are the only parts of the
// inject-or-lazy seam application configuration needs; the remaining driver
// shapes stay internal.
export type { IMongoClient, IMongoObjectIdCtor } from '../adapters/mongo/mongo-client.ts';
export type { MongoEntityMapping } from '../adapters/mongo/mongo-mapping.ts';

// Re-export the Cosmos structural types the `'cosmos'` arm carries. The client
// facade is the only part of the inject-or-lazy seam application configuration
// needs; the remaining SDK shapes stay internal.
export type {
  CosmosAccessCondition,
  CosmosBatchOperation,
  CosmosBatchResponse,
  CosmosContainerDefinition,
  CosmosFeedResponse,
  CosmosItemResponse,
  CosmosPartitionKeyValue,
  CosmosPatchOperation,
  CosmosQueryParameter,
  CosmosQuerySpec,
  CosmosRequestOptions,
  ICosmosClient,
  ICosmosContainer,
  ICosmosDatabase,
  ICosmosItem,
  ICosmosItems,
  ICosmosQueryIterator,
} from '../adapters/cosmos/cosmos-client.ts';
export type { CosmosEntityMapping } from '../adapters/cosmos/cosmos-mapping.ts';

/**
 * The options every {@linkcode DatabasePluginOptions} arm shares.
 *
 * @since 0.2.0
 */
export interface DatabaseConnectionOptions {
  /**
   * Named connection for multi-database support. Defaults to `'default'`.
   *
   * When a name is provided, the service registers under
   * `database.<name>` (e.g. `database.primary`); otherwise it uses the
   * canonical `CAPABILITIES.DATABASE` token. Dot notation, not a colon:
   * `createCapabilityToken` rejects colons.
   *
   * @since 0.1.0
   */
  readonly name?: string;

  /**
   * Adapter-specific options.
   *
   * On the `'custom'` arm the adapter is already constructed, so only the
   * options the *service* reads still apply — `logQueries` routes a custom
   * adapter's data sources through the same single logging wrapper every
   * built-in adapter uses.
   *
   * @since 0.1.0
   */
  readonly options?: DatabaseAdapterOptions;
}

/**
 * The arm selecting the zero-dependency in-memory adapter, which is also what
 * an omitted `type` means.
 *
 * @since 0.2.0
 */
export interface MemoryDatabaseOptions extends DatabaseConnectionOptions {
  /**
   * ORM adapter type. Defaults to `'memory'`.
   *
   * @since 0.1.0
   */
  readonly type?: 'memory';
}

/**
 * The arm selecting the Prisma adapter.
 *
 * `options.prismaClient` is required by the union rather than optional on a
 * nested bag, so a registration that forgets it is a compile error instead of
 * a `connect()` throw — the same guarantee the `'custom'` arm gives `adapter`.
 *
 * @example
 * ```typescript
 * import { PrismaPg } from '@prisma/adapter-pg';
 * import { PrismaClient } from './generated/prisma/client.ts';
 *
 * DatabasePlugin({
 *   type: 'prisma',
 *   options: {
 *     prismaClient: new PrismaClient({
 *       adapter: new PrismaPg({ connectionString: config.getOrThrow('DATABASE_URL') }),
 *     }),
 *   },
 * });
 * ```
 * @since 0.2.0
 */
export interface PrismaDatabaseOptions extends DatabaseConnectionOptions {
  /** Selects the Prisma arm. */
  readonly type: 'prisma';
  /** Prisma adapter configuration; `prismaClient` is required. */
  readonly options: PrismaAdapterOptions;
}

/**
 * The arm selecting the Drizzle adapter.
 *
 * Both `options.drizzleInstance` and `options.drizzleTables` are required by
 * the union, so omitting either is a compile error rather than a `connect()`
 * throw.
 *
 * @since 0.2.0
 */
export interface DrizzleDatabaseOptions extends DatabaseConnectionOptions {
  /** Selects the Drizzle arm. */
  readonly type: 'drizzle';
  /** Drizzle adapter configuration; the instance and table registry are required. */
  readonly options: DrizzleAdapterOptions;
}

/**
 * The arm selecting one of the adapters this package ships.
 *
 * A union of the three built-in arms: each names the options its adapter
 * cannot run without, so the compiler rejects a configuration the adapter
 * would only reject at startup.
 *
 * @since 0.2.0
 */
export type BuiltInDatabaseOptions =
  | MemoryDatabaseOptions
  | PrismaDatabaseOptions
  | DrizzleDatabaseOptions
  | MongoDatabaseOptions
  | CosmosDatabaseOptions;

/**
 * The arm supplying an externally-implemented backend.
 *
 * `adapter` is required by the union, so a `'custom'` registration that
 * forgets it is a compile error rather than a startup throw.
 *
 * @example
 * ```typescript
 * import { D1Adapter } from '@setu-ts/cloudflare-plugin';
 *
 * app.register(DatabasePlugin({
 *   type: 'custom',
 *   adapter: new D1Adapter(env.DB as ID1Database),
 * }));
 * ```
 * @since 0.2.0
 */
export interface CustomDatabaseOptions extends DatabaseConnectionOptions {
  /** Selects the external-adapter arm. */
  readonly type: 'custom';
  /**
   * The backend to use, already constructed. The plugin calls `connect()` on
   * it during `register()` and `disconnect()` during shutdown; it never
   * constructs or replaces it.
   *
   * @since 0.2.0
   */
  readonly adapter: IDatabaseAdapter;
}

/**
 * Options for the {@link DatabasePlugin | DatabasePlugin} factory.
 *
 * A union discriminated on `type`: the built-in arm keeps `type` optional
 * (so an omitted `type` still means `'memory'`), while `'custom'` requires an
 * `adapter`.
 *
 * @since 0.1.0
 */
export type DatabasePluginOptions = BuiltInDatabaseOptions | CustomDatabaseOptions;

/**
 * Adapter-specific configuration passed to the database adapter.
 *
 * @since 0.1.0
 */
export interface DatabaseAdapterOptions {
  /**
   * Database connection URL (e.g., `postgresql://localhost:5432/mydb`).
   *
   * @deprecated Prisma v7 clients are generated at an application-selected
   * output path and receive their connection configuration when the
   * application constructs them. Inject that generated client through
   * `prismaClient` instead. This field remains for source compatibility and
   * is not read by the Prisma adapter.
   *
   * @since 0.1.0
   */
  readonly url?: string;

  /**
   * When `true`, log SQL queries to the registered logger.
   *
   * @since 0.1.0
   */
  readonly logQueries?: boolean;

  /**
   * Inject an application-generated Prisma v7 client. This is required for
   * the Prisma adapter because generated-client output belongs to the
   * application rather than this package — see
   * {@linkcode PrismaAdapterOptions}, which makes that a compile error rather
   * than a startup throw.
   *
   * A Prisma 7 client needs a driver adapter of its own
   * (`new PrismaClient({ adapter: new PrismaPg({ connectionString }) })`); the
   * engine-bundled `new PrismaClient()` constructor was removed in v7.
   *
   * @since 0.1.0
   */
  readonly prismaClient?: unknown;

  /**
   * The SQL connector the injected Prisma client is bound to.
   *
   * Only `contains` is connector-sensitive in the Prisma adapter. When omitted
   * the adapter reads the client's active provider structurally at
   * `connect()` time; when that cannot be determined, a `contains` filter
   * throws `UnsupportedFilterOperatorError` naming this option as the fix.
   * Pass it explicitly when the adapter cannot detect the connector.
   *
   * @since 0.2.0
   */
  readonly provider?: PrismaSqlProvider;

  /**
   * Registry mapping entity name → a real Drizzle table definition. Required
   * when `type: 'drizzle'` — see {@linkcode DrizzleAdapterOptions}, which makes
   * that a compile error rather than a startup throw.
   *
   * The registry accepts any table definition, including one with a composite
   * primary key. An `id` column is a REPOSITORY precondition (`findById`,
   * `update` and `delete` are single-key by contract), so it is checked when a
   * repository is asked for rather than at `connect()` — a table registered
   * only so the typed query builder can name it needs none.
   *
   * @since 0.1.0
   */
  readonly drizzleTables?: Record<string, unknown>;

  /**
   * Timeout (ms) for Prisma interactive transactions. Defaults to 30_000.
   * Prisma's default is ~5s which is too short for a full Unit of Work.
   *
   * Read by the Prisma adapter only; Memory and Drizzle ignore it.
   *
   * @since 0.1.0
   */
  readonly transactionTimeout?: number;

  /**
   * Inject the application's opaque configured Drizzle database, created by
   * `createDrizzleDatabase(database, transactionBridge)`. Required when
   * `type: 'drizzle'` — see {@linkcode DrizzleAdapterOptions}, which makes that
   * a compile error rather than a startup throw. The explicit bridge positively
   * guarantees Promise-aware native callback semantics instead of inferring
   * them from a structural transaction method.
   *
   * @since 0.1.0
   */
  readonly drizzleInstance?: DrizzleDatabaseIdentity;
}

/**
 * Per-entity overrides for the Prisma adapter.
 *
 * Used to customise how the adapter addresses compound-key fields on a Prisma
 * model — in particular the {@linkcode PrismaCompositeKeyOptions.compositeKeyName}
 * override that is mandatory when a model uses a named `@@id` constraint.
 *
 * @since 0.2.0
 */
export interface PrismaCompositeKeyOptions {
  /**
   * Override for the derived compound-key field name.
   *
   * Prisma generates an unnamed `@@id([a, b])` as `a_b`; a named
   * `@@id([...], name: "custom")` generates only `custom`. When the derived
   * name does not match the schema (e.g. a named `@@id`), set this to the
   * Prisma-side generated field name so `findById`/`update`/`delete` emit the
   * correct compound-key `where` argument.
   *
   * @since 0.2.0
   */
  readonly compositeKeyName?: string;

  /**
   * The primary-key columns for this entity, in Prisma schema declaration order.
   *
   * Required when {@linkcode compositeKeyName} is set: the adapter needs the
   * column names to build the compound-key object that Prisma expects inside
   * the `where` argument. Omitting it while naming a `compositeKeyName` leaves
   * the columns at the scalar default `['id']`, and every composite key is
   * refused for missing the `id` column — measured against live PostgreSQL in
   * the M79 live suite. Supply every column, in declaration order, for both
   * unnamed `@@id` (derived field `tenantId_userId`) and named `@@id` models.
   *
   * Defaults to `['id']` when absent (scalar-key path).
   *
   * @example
   * ```typescript
   * // Named @@id: columns must be supplied explicitly.
   * entities: {
   *   Enrollment: { compositeKeyName: 'enrollmentKey', keyColumns: ['courseId', 'personId'] },
   * }
   * ```
   * @since 0.2.0
   */
  readonly keyColumns?: readonly string[];
}

/**
 * {@linkcode DatabaseAdapterOptions} narrowed for the Prisma arm: the injected
 * client is required.
 *
 * @since 0.2.0
 */
export interface PrismaAdapterOptions extends DatabaseAdapterOptions {
  /**
   * The application-generated Prisma v7 client. Required — a framework package
   * cannot locate an application-selected generated-client output path, and
   * `PrismaAdapter.connect()` rejects without it.
   *
   * @since 0.2.0
   */
  readonly prismaClient: unknown;

  /**
   * Per-entity overrides for key resolution and other model-specific tuning.
   *
   * The only override exercised today is `compositeKeyName` on entities that
   * carry a named `@@id` constraint — Prisma generates the field name from the
   * `name:` argument rather than joining column names with `_`, so the derived
   * name is wrong for such models. Setting the override tells the adapter the
   * correct field to address in the compound-key `where` argument.
   *
   * @example
   * ```typescript
   * new PrismaAdapter({
   *   prismaClient,
   *   entities: {
   *     Enrollment: { compositeKeyName: 'enrollmentKey' },
   *   },
   * });
   * ```
   * @since 0.2.0
   */
  readonly entities?: Readonly<Record<string, PrismaCompositeKeyOptions>>;
}

/**
 * Per-entity overrides for the Drizzle adapter.
 *
 * The only override exercised today is {@linkcode DrizzleCompositeKeyOptions.primaryKey},
 * which replaces the hardcoded `'id'` column the adapter reads otherwise. A
 * scalar name yields a single-column key; an array yields a composite-key
 * predicate that ANDs every named column.
 *
 * @since 0.2.0
 */
export interface DrizzleCompositeKeyOptions {
  /**
   * Primary-key column(s) for this entity.
   *
   * Defaults to `['id']` when absent — the adapter's previous hardcoded path,
   * so an unconfigured entity behaves exactly as it did before, including its
   * refuse-by-name on an absent `id` column.
   *
   * Pass an array for a composite-key table that has no `id` column but carries
   * a compound primary key (e.g. `{ tenantId, flag }`).
   *
   * @example
   * ```typescript
   * // Scalar key (default path).
   * entities: { User: {} }
   *
   * // Composite key — replace the hardcoded 'id'.
   * entities: {
   *   TenantFlag: { primaryKey: ['tenantId', 'flag'] },
   * }
   * ```
   * @since 0.2.0
   */
  readonly primaryKey?: string | readonly string[];
}

/**
 * {@linkcode DatabaseAdapterOptions} narrowed for the Drizzle arm: the
 * configured instance and the table registry are both required.
 *
 * @since 0.2.0
 */
export interface DrizzleAdapterOptions extends DatabaseAdapterOptions {
  /**
   * The opaque configuration returned by
   * `createDrizzleDatabase(database, transactionBridge)`. Required.
   *
   * @since 0.2.0
   */
  readonly drizzleInstance: DrizzleDatabaseIdentity;

  /**
   * The SQL dialect, used only to translate a **nested JSON filter path**
   * (`field: ['profile', 'city']`). No two dialects spell JSON extraction
   * alike: PostgreSQL uses `#>>`, MySQL `JSON_UNQUOTE(JSON_EXTRACT(...))` and
   * SQLite `json_extract`.
   *
   * Absent, the adapter reads the dialect off the Drizzle instance, which
   * covers every instance Drizzle ships. Set it when that detection cannot
   * name the dialect — a nested-path filter is then refused by name rather
   * than emitted in a guessed syntax that would return wrong rows.
   *
   * @since 0.2.0
   */
  readonly dialect?: SqlJsonDialect;

  /**
   * Entity name → real Drizzle table definition. Required, and must hold at
   * least one entry.
   *
   * @since 0.2.0
   */
  readonly drizzleTables: Record<string, unknown>;

  /**
   * Per-entity overrides keyed by the entity name passed to
   * {@linkcode IRepository.getRepository}.
   *
   * The only override exercised today is `primaryKey`, which replaces the
   * hardcoded `'id'` column the adapter reads when building `findById`/
   * `update`/`delete` predicates. An absent entry falls back to `['id']`,
   * preserving the prior behaviour (including its refuse-by-name when `id` is
   * missing from the table).
   *
   * @example
   * ```typescript
   * import { DatabasePlugin } from '@setu-ts/database-plugin';
   *
   * app.register(DatabasePlugin({
   *   type: 'drizzle',
   *   options: {
   *     drizzleInstance: createDrizzleDatabase(db, bridge),
   *     drizzleTables: { Tenant: tenants, TenantFlag: tenantFlags },
   *     entities: {
   *       TenantFlag: { primaryKey: ['tenantId', 'flag'] },
   *     },
   *   },
   * }));
   * ```
   * @since 0.2.0
   */
  readonly entities?: Readonly<Record<string, DrizzleCompositeKeyOptions>>;
}

/**
 * The arm selecting the Mongo adapter over the native `mongodb` driver.
 *
 * `options.url` is required by the union unless `options.client` is supplied,
 * so a registration that forgets both is a compile error instead of a
 * `connect()` throw — the same guarantee the `'custom'` arm gives
 * `adapter`. The client is supplied inject-or-lazy (§12.2 of AI_GUIDELINES):
 * `client` is an already-constructed structural `IMongoClient`, and absent it
 * the adapter performs a literal `import('npm:mongodb@^6.21.0')` at connect time.
 *
 * @example
 * ```typescript
 * import { DatabasePlugin } from '@setu-ts/database-plugin';
 *
 * DatabasePlugin({
 *   type: 'mongodb',
 *   options: { url: 'mongodb://localhost:27017/mydb' },
 * });
 * ```
 * @since 0.1.0
 */
export interface MongoDatabaseOptions extends DatabaseConnectionOptions {
  /** Selects the Mongo arm. */
  readonly type: 'mongodb';
  /** Mongo adapter configuration; `url` (or `client`) is required. */
  readonly options: MongoAdapterOptions;
}

/**
 * The options both {@linkcode MongoAdapterOptions} arms share — everything
 * that is optional regardless of how the client is supplied.
 *
 * It is exported because the arms below reference it, so a caller building a
 * configuration incrementally can name the shared half.
 *
 * @since 0.1.0
 */
export interface MongoAdapterOptionsBase extends Pick<DatabaseAdapterOptions, 'logQueries'> {
  /**
   * The driver's `ObjectId` constructor when {@linkcode MongoAdapterOptions.client} is injected.
   *
   * A `MongoClient` instance does not expose the driver's `ObjectId` class.
   * Supplying it preserves the adapter's `_id` conversion for injected clients
   * while still avoiding a lazy driver import. It is not needed on the lazy
   * path because that import supplies the constructor.
   *
   * @since 0.1.0
   */
  readonly objectIdCtor?: IMongoObjectIdCtor;

  /**
   * The database the collections live in.
   *
   * Absent, the one encoded in {@linkcode url} is used; absent from both,
   * `connect()` fails at startup naming the option.
   *
   * @since 0.1.0
   */
  readonly database?: string;

  /**
   * Per-entity collection and primary-key overrides, keyed by the entity name
   * passed to `getRepository()`.
   *
   * An entity with no entry uses its own name as the collection and `'id'` as
   * the key, which is why the zero-config path works for a schema whose
   * collection names already match — the D1 two-layer shape.
   *
   * @example
   * ```typescript
   * new MongoAdapter({
   *   url: 'mongodb://127.0.0.1:27017/app',
   *   collections: { User: { collection: 'users', primaryKey: 'user_id', idType: 'raw' } },
   * });
   * ```
   * @since 0.1.0
   */
  readonly collections?: Readonly<Record<string, MongoEntityMapping>>;
}

/**
 * Options for the {@link MongoAdapter} — the `'mongodb'` arm.
 *
 * A **union of two arms**, so supplying neither `url` nor `client` is a
 * compile error rather than a `connect()` throw — the guarantee every other
 * built-in arm gives (`'prisma'` requires `prismaClient`, `'drizzle'` requires
 * both Drizzle options, `'custom'` requires `adapter`). Both members stay
 * readable on either arm, so the adapter reads `options.url` and
 * `options.client` without narrowing first.
 *
 * @example
 * ```typescript
 * const lazy: MongoAdapterOptions = { url: 'mongodb://127.0.0.1:27017/app' };
 * const injected: MongoAdapterOptions = { client: myMongoClient, database: 'app' };
 * ```
 * @since 0.1.0
 */
export type MongoAdapterOptions =
  | (MongoAdapterOptionsBase & {
    /**
     * The connection string used to construct a client when none is injected.
     *
     * The database the collections live in is taken from `database` when
     * present, otherwise the database encoded in this URI.
     */
    readonly url: string;
    /** An already-constructed client; omit it to load the driver lazily. */
    readonly client?: IMongoClient;
  })
  | (MongoAdapterOptionsBase & {
    /**
     * An already-constructed `IMongoClient`.
     *
     * When present, the lazy `import('npm:mongodb@^6.21.0')` never runs — the
     * seam that keeps the branching unit-testable.
     */
    readonly client: IMongoClient;
    /** The connection string; unread once a client is injected. */
    readonly url?: string;
  });

/**
 * The arm selecting the Cosmos adapter over the `@azure/cosmos` SDK — Azure
 * Cosmos DB's NoSQL (SQL) API.
 *
 * `options.database` is required, and `options.endpoint` + `options.key` are
 * required unless `options.client` is supplied, so a registration that forgets
 * them is a compile error instead of a `connect()` throw — the guarantee every
 * other built-in arm gives.
 *
 * Cosmos DB's **MongoDB API** is a different wire protocol and is served by the
 * {@linkcode MongoDatabaseOptions} arm pointed at a Cosmos connection string,
 * not by this one.
 *
 * @example
 * ```typescript
 * import { DatabasePlugin } from '@setu-ts/database-plugin';
 *
 * DatabasePlugin({
 *   type: 'cosmos',
 *   options: {
 *     endpoint: 'https://my-account.documents.azure.com:443/',
 *     key: cosmosKey,
 *     database: 'app',
 *   },
 * });
 * ```
 * @since 0.2.0
 */
export interface CosmosDatabaseOptions extends DatabaseConnectionOptions {
  /** Selects the Cosmos arm. */
  readonly type: 'cosmos';
  /** Cosmos adapter configuration; `database` and one credential form are required. */
  readonly options: CosmosAdapterOptions;
}

/**
 * The options both {@linkcode CosmosAdapterOptions} arms share — everything
 * that is required or optional regardless of how the client is supplied.
 *
 * @since 0.2.0
 */
export interface CosmosAdapterOptionsBase extends Pick<DatabaseAdapterOptions, 'logQueries'> {
  /**
   * The database the containers live in. Required on both arms: a Cosmos
   * endpoint encodes no database name, so unlike a MongoDB URI there is
   * nothing to fall back to.
   *
   * @since 0.2.0
   */
  readonly database: string;

  /**
   * Per-entity container, primary-key and partition-key overrides, keyed by
   * the entity name passed to `getRepository()`.
   *
   * An entity with no entry uses its own name as the container and `'id'` as
   * the primary key, and its partition key is DISCOVERED from the container
   * definition — which is both less to configure and safer, since a wrong
   * partition key answers 404 rather than an error. A declared `partitionKey`
   * is validated against the container and refused by name when it disagrees.
   *
   * @example
   * ```typescript
   * new CosmosAdapter({
   *   endpoint,
   *   key,
   *   database: 'app',
   *   containers: { Order: { container: 'orders', partitionKey: 'tenantId' } },
   * });
   * ```
   * @since 0.2.0
   */
  readonly containers?: Readonly<Record<string, CosmosEntityMapping>>;
}

/**
 * Options for the {@link CosmosAdapter} — the `'cosmos'` arm.
 *
 * A **union of two arms**, so supplying neither an `endpoint`/`key` pair nor a
 * `client` is a compile error rather than a `connect()` throw. Both members
 * stay readable on either arm, so the adapter reads `options.client` and
 * `options.endpoint` without narrowing first. An application using Entra ID
 * (managed identity) constructs its own client and injects it, which is why
 * this carries no credential surface beyond the account key.
 *
 * @example
 * ```typescript
 * const lazy: CosmosAdapterOptions = { endpoint, key, database: 'app' };
 * const injected: CosmosAdapterOptions = { client: myCosmosClient, database: 'app' };
 * ```
 * @since 0.2.0
 */
export type CosmosAdapterOptions =
  | (CosmosAdapterOptionsBase & {
    /** The account endpoint, used to construct a client when none is injected. */
    readonly endpoint: string;
    /** The account key. */
    readonly key: string;
    /** An already-constructed client; omit it to load the SDK lazily. */
    readonly client?: ICosmosClient;
  })
  | (CosmosAdapterOptionsBase & {
    /**
     * An already-constructed `ICosmosClient`.
     *
     * When present, the lazy `import('npm:@azure/cosmos@^4')` never runs — the
     * seam that keeps the branching unit-testable.
     */
    readonly client: ICosmosClient;
    /** The account endpoint; unread once a client is injected. */
    readonly endpoint?: string;
    /** The account key; unread once a client is injected. */
    readonly key?: string;
  });
