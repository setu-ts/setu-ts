/**
 * Typed access to an application's native Drizzle query object.
 *
 * The symbol protocol in this module is internal. Only {@linkcode getDrizzle}
 * is exported from the package barrel.
 *
 * @module
 */
import type { DatabaseAdapterType, IDatabaseService, IUnitOfWork } from '../interfaces/index.ts';

/**
 * The native transaction object supplied by a configured Drizzle database.
 *
 * This derives the callback parameter structurally, without importing a
 * dialect- or version-specific Drizzle type into production source. It keeps
 * schema/query inference while excluding operations available only on the
 * outer database (for example SQLite Proxy's `batch()`).
 *
 * @typeParam TDatabase - The application's configured outer Drizzle database type
 * @since 0.2.0
 */
export type DrizzleTransaction<TDatabase extends object> = TDatabase extends
  { transaction: infer TMethod }
  ? TMethod extends (...args: infer TArguments) => unknown
    ? TArguments[0] extends (transaction: infer TTransaction, ...args: never[]) => unknown
      ? TTransaction
    : never
  : never
  : never;

/** Internal key used to pass a native Drizzle object without widening portable contracts. */
export const DRIZZLE_QUERY_HANDLE: unique symbol = Symbol('setu.database.drizzle-query-handle');

/** Internal structural provider implemented by plugin-created Drizzle scopes. */
export interface DrizzleQueryHandleProvider {
  [DRIZZLE_QUERY_HANDLE](): unknown;
}

/** Error used when a scope was not created by this package. */
export const INVALID_DRIZZLE_SCOPE_ERROR =
  'Drizzle query access requires a database-plugin service or unit of work.';

/** Return the stable wrong-adapter diagnostic for an adapter type. */
export function wrongDrizzleAdapterError(adapterType: DatabaseAdapterType): string {
  return `Drizzle query access requires adapter 'drizzle'; configured adapter is '${adapterType}'.`;
}

/** Assert that a plugin-created scope is configured for the built-in Drizzle adapter. */
export function assertDrizzleAdapter(adapterType: DatabaseAdapterType | undefined): void {
  if (adapterType === undefined) {
    throw new Error(INVALID_DRIZZLE_SCOPE_ERROR);
  }
  if (adapterType !== 'drizzle') {
    throw new Error(wrongDrizzleAdapterError(adapterType));
  }
}

/** Read an internal native handle, rejecting external structural stand-ins. */
export function readDrizzleQueryHandle(value: unknown): unknown {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    typeof (value as Partial<DrizzleQueryHandleProvider>)[DRIZZLE_QUERY_HANDLE] !== 'function'
  ) {
    throw new Error(INVALID_DRIZZLE_SCOPE_ERROR);
  }
  return (value as DrizzleQueryHandleProvider)[DRIZZLE_QUERY_HANDLE]();
}

/**
 * Returns the application's native Drizzle query object for a database scope.
 *
 * At service scope this is the exact `drizzleInstance` supplied to
 * `DatabasePlugin`. Inside `IDatabaseService.transaction()` it is Drizzle's
 * callback-scoped transaction object, so native builders participate in the
 * same commit or rollback as Unit-of-Work repositories.
 *
 * Supply the application's configured outer database type explicitly. The
 * helper cannot infer a schema through a capability token, and omitting
 * `TDatabase` infers `object`.
 *
 * @typeParam TDatabase - The type of the application's configured outer Drizzle database
 * @param scope - A database-plugin service or transaction Unit of Work
 * @returns The identical outer or transaction-scoped native Drizzle object
 * @throws {Error} If the scope is external or is not configured with the built-in Drizzle adapter
 * @example
 * ```typescript
 * const outer = getDrizzle<typeof drizzleDb>(databaseService);
 * const rows = await outer.select().from(users);
 *
 * await databaseService.transaction(async (uow) => {
 *   const tx = getDrizzle<typeof drizzleDb>(uow);
 *   await tx.select().from(users).innerJoin(teams, eq(users.teamId, teams.id));
 * });
 * ```
 * @since 0.2.0
 */
export function getDrizzle<TDatabase extends object>(scope: IDatabaseService): TDatabase;
/**
 * Returns Drizzle's transaction-safe callback object for a Unit of Work.
 *
 * @typeParam TDatabase - The application's configured outer Drizzle database type
 * @param scope - A transaction Unit of Work created by the database plugin
 * @returns The native callback-scoped transaction object
 * @throws {Error} If the scope is external or is not configured with the built-in Drizzle adapter
 * @since 0.2.0
 */
export function getDrizzle<TDatabase extends object>(
  scope: IUnitOfWork,
): DrizzleTransaction<TDatabase>;
export function getDrizzle<TDatabase extends object>(
  scope: IDatabaseService | IUnitOfWork,
): TDatabase | DrizzleTransaction<TDatabase> {
  return readDrizzleQueryHandle(scope) as TDatabase | DrizzleTransaction<TDatabase>;
}
