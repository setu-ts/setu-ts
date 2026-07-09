/**
 * Public interfaces for the database plugin.
 *
 * These contracts define what application code depends on; adapters provide
 * the implementations.
 *
 * @module
 */
import type { CountOptions, FindOptions } from '../query/find-options.ts';

// Re-export query option types so consumers don't need internal paths.
export type { CountOptions, FindOptions, OrderDirection } from '../query/find-options.ts';

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
   * @param options - Count options (where clause)
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
   * Run database migrations. The exact behavior depends on the adapter
   * (Prisma runs `db push`, Drizzle runs schema sync, Memory is a no-op).
   *
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
 * Supported ORM adapter backends.
 *
 * @since 0.1.0
 */
export type DatabaseAdapterType = 'prisma' | 'drizzle' | 'memory';

/**
 * Options for the {@link DatabasePlugin | DatabasePlugin} factory.
 *
 * @since 0.1.0
 */
export interface DatabasePluginOptions {
  /**
   * ORM adapter type. Defaults to `'memory'`.
   *
   * @since 0.1.0
   */
  readonly type?: DatabaseAdapterType;

  /**
   * Named connection for multi-database support. Defaults to `'default'`.
   *
   * When a name is provided, the service registers under
   * `database:<name>` (e.g., `database:primary`); otherwise it uses the
   * canonical `CAPABILITIES.DATABASE` token.
   *
   * @since 0.1.0
   */
  readonly name?: string;

  /**
   * Adapter-specific options.
   *
   * @since 0.1.0
   */
  readonly options?: DatabaseAdapterOptions;
}

/**
 * Adapter-specific configuration passed to the database adapter.
 *
 * @since 0.1.0
 */
export interface DatabaseAdapterOptions {
  /**
   * Database connection URL (e.g., `postgresql://localhost:5432/mydb`).
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
   * Inject a pre-loaded Prisma client instance, bypassing the lazy
   * `import('npm:prisma')` path. Useful for testing.
   *
   * @since 0.1.0
   */
  readonly prismaClient?: unknown;

  /**
   * Inject a pre-loaded Drizzle database instance, bypassing the lazy
   * `import('npm:drizzle-orm')` path. Useful for testing.
   *
   * @since 0.1.0
   */
  readonly drizzleInstance?: unknown;
}
