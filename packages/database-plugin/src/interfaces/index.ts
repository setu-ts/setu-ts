/**
 * Public interfaces for the database plugin.
 *
 * These contracts define what application code depends on; adapters provide
 * the implementations.
 *
 * @module
 */
import type { IDatabaseAdapter } from '@setu-ts/common';
import type { DrizzleDatabaseIdentity } from '../query/drizzle-database.ts';
import type { CountOptions, FindOptions } from '../query/find-options.ts';
import type { IMongoClient } from '../adapters/mongo/mongo-client.ts';
import type { MongoEntityMapping } from '../adapters/mongo/mongo-mapping.ts';

// Re-export query option types so consumers don't need internal paths.
export type { CountOptions, FindOptions, OrderDirection } from '../query/find-options.ts';

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
 * @typeParam Id - Primary key type (defaults to `string`)
 * @since 0.1.0
 */
export interface IRepository<Entity, Id = string> {
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
  getRepository<Entity, Id = string>(entity: string): IRepository<Entity, Id>;
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
  getRepository<Entity, Id = string>(entity: string): IRepository<Entity, Id>;

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
export type DatabaseAdapterType = 'prisma' | 'drizzle' | 'memory' | 'mongodb' | 'custom';

// Re-export the Mongo structural types the `'mongodb'` arm carries, so an
// application annotating its configuration or implementing the `'custom'` arm
// reaches them from the package barrel. The client/database/object-id structural
// types live on the inject-or-lazy seam; the entity mapping is the two-layer
// public shape.
export type {
  IMongoClient,
  IMongoDatabase,
  IMongoObjectId,
  IMongoObjectIdCtor,
} from '../adapters/mongo/mongo-client.ts';
export type { MongoEntityMapping } from '../adapters/mongo/mongo-mapping.ts';

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
  | MongoDatabaseOptions;

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
   * Entity name → real Drizzle table definition. Required, and must hold at
   * least one entry.
   *
   * @since 0.2.0
   */
  readonly drizzleTables: Record<string, unknown>;
}

/**
 * The arm selecting the Mongo adapter over the native `mongodb` driver.
 *
 * `options.mongo.url` is required by the union unless `options.mongo.client`
 * is supplied, so a registration that forgets both is a compile error instead
 * of a `connect()` throw — the same guarantee the `'custom'` arm gives
 * `adapter`. The client is supplied inject-or-lazy (§12.2 of AI_GUIDELINES):
 * `client` is an already-constructed structural `IMongoClient`, and absent it
 * the adapter performs a literal `import('npm:mongodb@^7')` at connect time.
 *
 * @example
 * ```typescript
 * import { DatabasePlugin } from '@setu-ts/database-plugin';
 *
 * DatabasePlugin({
 *   type: 'mongodb',
 *   options: { mongo: { url: 'mongodb://localhost:27017/mydb' } },
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
 * Options for the {@link MongoAdapter} — the `'mongodb'` arm.
 *
 * @since 0.1.0
 */
export interface MongoAdapterOptions {
  /**
   * The connection string used to construct a client when none is injected.
   *
   * Required in the union arm unless {@linkcode client} is supplied. The
   * database the collections live in is taken from {@linkcode database} when
   * present, otherwise the database encoded in this URI.
   *
   * @since 0.1.0
   */
  readonly url?: string;

  /**
   * An already-constructed `IMongoClient`.
   *
   * When present, the lazy `import('npm:mongodb@^7')` never runs — the seam
   * that keeps the branching unit-testable. Omit it to let the adapter load
   * the driver lazily from {@linkcode url}.
   *
   * @since 0.1.0
   */
  readonly client?: IMongoClient;

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
   * new MongoAdapter({ url }, {
   *   collections: { User: { collection: 'users', primaryKey: 'user_id', idType: 'raw' } },
   * });
   * ```
   * @since 0.1.0
   */
  readonly collections?: Readonly<Record<string, MongoEntityMapping>>;
}
