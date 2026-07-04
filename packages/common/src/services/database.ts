/**
 * Database adapter contracts, implemented by ORM adapters in the
 * DatabasePlugin (Prisma, Drizzle, Memory).
 *
 * The repository and unit-of-work interfaces are owned by the database
 * plugin itself; `common` defines only the adapter port.
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
