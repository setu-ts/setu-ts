/**
 * Internal adapter contracts for the database plugin.
 *
 * These interfaces live BETWEEN the concrete ORM adapters and the
 * service/repository layer. They are NOT exported from the public barrel —
 * only `src/index.ts` defines what is public (AI_GUIDELINES §10).
 *
 * Reuses the shipped {@linkcode DataSource} seam (equivalent to the plan's
 * `IEntityDataSource`) rather than renaming it to minimize diff surface.
 *
 * @module
 */

import type { IOrmAdapter, ITransaction } from '@hono-enterprise/common';
import type { DataSource } from '../repositories/base-repository.ts';

/**
 * Transaction handle that also exposes a transaction-scoped data-source
 * factory consumed by {@linkcode UnitOfWork}.
 *
 * The scoped factory ensures every repository opened inside the same Unit of
 * Work targets the exact same underlying transaction, so that a single
 * commit/rollback covers all operations.
 *
 * @internal
 */
export interface IAdapterTransaction extends ITransaction {
  /**
   * Build a DataSource bound to THIS transaction for the named entity.
   *
   * @param entity - Entity name (e.g. `'User'`)
   * @returns A data source whose reads/writes participate in this transaction
   */
  createDataSource(entity: string): DataSource;
}

/**
 * Full adapter contract: the common lifecycle port (connect / disconnect /
 * isReady) plus this plugin's data-access surface.
 *
 * Replaces the bare {@linkcode IOrmAdapter} everywhere inside the service
 * layer so that the transaction handle carries a scoped factory and raw
 * queries are available on a uniform surface.
 *
 * `migrate()` is NOT on the contract — programmatic migrations are not
 * honestly implementable for any of our supported adapters (see plan
 * deviation §2).
 *
 * @internal
 */
export interface IDatabaseAdapter extends IOrmAdapter {
  /**
   * Begin a new transaction. Returns a handle whose commit/rollback controls
   * the transaction boundary AND whose `createDataSource` builds scoped
   * repositories.
   */
  beginTransaction(): Promise<IAdapterTransaction>;

  /**
   * Execute a raw SQL query.
   *
   * Prisma delegates to `$queryRawUnsafe`; Drizzle to the instance's raw
   * execute surface; Memory adapter throws (no raw SQL support).
   *
   * @typeParam T - Expected row shape
   * @param sql - SQL query string
   * @param params - Query parameters (positional)
   * @returns Query result rows
   */
  rawQuery<T>(sql: string, params?: unknown[]): Promise<T[]>;
}
