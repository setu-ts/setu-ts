/**
 * Database adapter contracts, implemented by database backends wherever they
 * live — the DatabasePlugin's own Prisma/Drizzle/Memory adapters, and
 * out-of-package backends such as `cloudflare-plugin`'s `D1Adapter`.
 *
 * The repository and unit-of-work interfaces stay owned by the database
 * plugin; `common` defines the adapter port and the query shape that port
 * speaks. Both are here because a backend in another package must be able to
 * implement the port without importing another plugin (AI_GUIDELINES §2.2).
 *
 * @module
 */

/**
 * A database transaction handle.
 *
 * @since 0.1.0
 */
export interface ITransaction {
  /**
   * Commits the transaction.
   */
  commit(): Promise<void>;
  /**
   * Rolls the transaction back.
   */
  rollback(): Promise<void>;
}

/**
 * ORM adapter port — what the DatabasePlugin requires from any ORM
 * integration.
 *
 * This is the **lifecycle half** of the contract. A backend that also serves
 * data access implements {@linkcode IDatabaseAdapter}, which extends this.
 *
 * @since 0.1.0
 */
export interface IOrmAdapter {
  /**
   * Opens the underlying connection (pool).
   */
  connect(): Promise<void>;
  /**
   * Closes the underlying connection (pool).
   */
  disconnect(): Promise<void>;
  /**
   * Reports whether the adapter is connected and usable.
   *
   * @returns `true` when ready
   */
  isReady(): boolean;
  /**
   * Begins a transaction.
   *
   * @returns The transaction handle
   */
  beginTransaction(): Promise<ITransaction>;
}

/**
 * Sort direction for a single field.
 *
 * @since 0.2.0
 */
export type OrderDirection = 'asc' | 'desc';

/**
 * A repository query with every option resolved to a concrete value — the
 * shape a {@linkcode IDataSource} evaluates.
 *
 * Produced by the database plugin's `normalizeQuery()` from the caller's
 * `FindOptions`, so an adapter never has to reason about absent fields.
 *
 * @since 0.2.0
 */
export interface NormalizedQuery {
  /** Filter conditions, matched by equality. Empty means no filter. */
  readonly where: Record<string, unknown>;
  /** Field-to-direction sort specification. Empty means no ordering. */
  readonly orderBy: Record<string, OrderDirection>;
  /** Maximum results, or `-1` for unlimited. */
  readonly limit: number;
  /** Number of leading rows to skip. */
  readonly offset: number;
  /** Field projection. Empty means all fields. */
  readonly select: readonly string[];
}

/**
 * The data-access seam a backend provides per entity.
 *
 * One instance is bound to one entity (table/model/collection). The data
 * source owns query evaluation end to end: it applies `where`, `orderBy`,
 * `offset`/`limit` and `select` itself, and the repository above it must not
 * re-apply any of them.
 *
 * **Transaction-scoped instances may defer their writes.** A backend whose
 * store has no interactive transaction (Cloudflare D1, where a pre-declared
 * `batch()` is the only unit of atomicity) has to buffer writes and apply them
 * at commit. On such a backend the write methods below describe what WILL be
 * written rather than what already is, and reads observe committed state only.
 * A backend that defers must document it; `D1Adapter` is the worked example.
 *
 * @since 0.2.0
 */
export interface IDataSource {
  /**
   * Find every entity matching the normalized query.
   *
   * @param query - The fully-resolved query
   * @returns The matching rows, already filtered, sorted, paginated and projected
   */
  findAll(query: NormalizedQuery): Promise<Record<string, unknown>[]>;
  /**
   * Find a single entity by its primary key value.
   *
   * @param id - The primary key value
   * @returns The row, or `null` when no row has that key
   */
  findById(id: string | number): Promise<Record<string, unknown> | null>;
  /**
   * Insert a new entity.
   *
   * @param data - The column values to insert
   * @returns The persisted row, including any generated columns. On a
   * deferred-write transaction the row is the one that will be written, and a
   * generated column is therefore not yet known.
   */
  create(data: Partial<Record<string, unknown>>): Promise<Record<string, unknown>>;
  /**
   * Update an existing entity by primary key.
   *
   * @param id - The primary key value
   * @param data - The columns to merge into the row
   * @returns The updated row
   * @throws {Error} When no row has that key
   */
  update(
    id: string | number,
    data: Partial<Record<string, unknown>>,
  ): Promise<Record<string, unknown>>;
  /**
   * Delete an entity by primary key.
   *
   * @param id - The primary key value
   * @returns `true` when a row was deleted, `false` when none matched. On a
   * deferred-write transaction this reports whether a committed row matched,
   * and the delete itself lands at commit.
   */
  delete(id: string | number): Promise<boolean>;
  /**
   * Count entities matching a filter.
   *
   * @param where - Filter conditions, matched by equality; empty counts all
   * @returns The matching row count
   */
  count(where: Record<string, unknown>): Promise<number>;
}

/**
 * A transaction handle that can also open entity data sources bound to
 * itself.
 *
 * The scoped factory is what makes a Unit of Work atomic: every repository
 * opened from one handle targets the same underlying transaction, so a single
 * commit or rollback covers all of them.
 *
 * @since 0.2.0
 */
export interface IAdapterTransaction extends ITransaction {
  /**
   * Open a data source for `entity` bound to THIS transaction.
   *
   * @param entity - Entity name (for example `'User'`)
   * @returns A data source whose reads and writes participate in this transaction
   */
  createDataSource(entity: string): IDataSource;
}

/**
 * The full database backend port: lifecycle plus data access.
 *
 * This is the seam an application implements to plug a database the framework
 * does not ship an adapter for, and hand it to
 * `DatabasePlugin({ type: 'custom', adapter })`. It lives in `common` rather
 * than inside the database plugin precisely so a backend can be written in
 * another package — `cloudflare-plugin`'s `D1Adapter` is the first.
 *
 * `migrate()` is deliberately absent: programmatic migration is not honestly
 * implementable across the supported backends, and every one of them owns
 * migrations through its own CLI.
 *
 * @example
 * ```typescript
 * class MyAdapter implements IDatabaseAdapter {
 *   connect(): Promise<void> { return Promise.resolve(); }
 *   disconnect(): Promise<void> { return Promise.resolve(); }
 *   isReady(): boolean { return true; }
 *   createDataSource(entity: string): IDataSource { return makeSource(entity); }
 *   beginTransaction(): Promise<IAdapterTransaction> { return openTx(); }
 *   rawQuery<T>(sql: string, params?: unknown[]): Promise<T[]> { return run(sql, params); }
 * }
 * ```
 * @since 0.2.0
 */
export interface IDatabaseAdapter extends IOrmAdapter {
  /**
   * Open a non-transactional data source for the named entity.
   *
   * @param entity - Entity name (for example `'User'`)
   * @returns A data source bound to that entity
   */
  createDataSource(entity: string): IDataSource;

  /**
   * Begin a transaction, returning a handle that can open transaction-scoped
   * data sources as well as commit and roll back.
   *
   * @returns The transaction handle
   */
  beginTransaction(): Promise<IAdapterTransaction>;

  /**
   * Execute a raw query in the backend's own dialect.
   *
   * @typeParam T - Expected row shape
   * @param sql - The query text
   * @param params - Positional parameters
   * @returns The result rows
   */
  rawQuery<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
