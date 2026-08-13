/**
 * Typed access to an application's native Drizzle query objects.
 *
 * Outer and Unit-of-Work access are deliberately different functions. Their
 * static inputs and package-created runtime scope kinds therefore cannot be
 * confused by structural overlap between public interfaces.
 *
 * @module
 */
import type { DatabaseAdapterType, IDatabaseService, IUnitOfWork } from '../interfaces/index.ts';
import { isDrizzleDatabase, readDrizzleDatabase } from './drizzle-database.ts';
import type {
  DrizzleDatabase,
  DrizzleDatabaseIdentity,
  DrizzleTransaction,
} from './drizzle-database.ts';

export { createDrizzleDatabase } from './drizzle-database.ts';
export type {
  DrizzleDatabase,
  DrizzleDatabaseIdentity,
  DrizzleTransaction,
  DrizzleTransactionBridge,
} from './drizzle-database.ts';

/** Scope kind supplied only by package-created services and Units of Work. */
export type DrizzleQueryScope = 'outer' | 'transaction';

/** Internal key used to pass a native Drizzle object without widening portable contracts. */
export const DRIZZLE_QUERY_HANDLE: unique symbol = Symbol('setu.database.drizzle-query-handle');

/** One correlated configuration and its current outer/transaction query object. */
export interface NativeDrizzleQueryHandle {
  readonly database: DrizzleDatabaseIdentity;
  readonly query: unknown;
  readonly scope: DrizzleQueryScope;
}

/** Internal structural provider implemented by plugin-created Drizzle scopes. */
export interface DrizzleQueryHandleProvider {
  [DRIZZLE_QUERY_HANDLE](): NativeDrizzleQueryHandle;
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
export function readDrizzleQueryHandle(value: unknown): NativeDrizzleQueryHandle {
  if (
    value === null ||
    (typeof value !== 'object' && typeof value !== 'function') ||
    typeof (value as Partial<DrizzleQueryHandleProvider>)[DRIZZLE_QUERY_HANDLE] !== 'function'
  ) {
    throw new Error(INVALID_DRIZZLE_SCOPE_ERROR);
  }
  const handle = (value as DrizzleQueryHandleProvider)[DRIZZLE_QUERY_HANDLE]();
  if (
    handle === null ||
    typeof handle !== 'object' ||
    !isDrizzleDatabase(handle.database) ||
    (handle.scope !== 'outer' && handle.scope !== 'transaction')
  ) {
    throw new Error(INVALID_DRIZZLE_SCOPE_ERROR);
  }
  return handle;
}

/** Validate configured identity and requested runtime scope before returning a query object. */
function readScopedDrizzle(
  scope: unknown,
  database: DrizzleDatabaseIdentity,
  expectedScope: DrizzleQueryScope,
): unknown {
  readDrizzleDatabase(database);
  const handle = readDrizzleQueryHandle(scope);
  if (handle.database !== database) {
    throw new Error(
      'Drizzle query access requires the configuration registered for this database scope.',
    );
  }
  if (handle.scope !== expectedScope) {
    throw new Error(
      `Drizzle query access expected '${expectedScope}' scope but received '${handle.scope}' scope.`,
    );
  }
  return handle.query;
}

/**
 * Returns the exact configured outer Drizzle database for a database service.
 *
 * @typeParam TDatabase - Exact application Drizzle database type
 * @param service - Database service created by this package
 * @param database - Opaque configuration supplied to this plugin instance
 * @returns The identical configured outer database
 * @throws {Error} If the service, adapter, configuration, or runtime scope does not match
 * @since 0.2.0
 */
export function getDrizzleDatabase<TDatabase extends object>(
  service: IDatabaseService,
  database: DrizzleDatabase<TDatabase>,
): TDatabase {
  return readScopedDrizzle(service, database, 'outer') as TDatabase;
}

/**
 * Returns Drizzle's callback-scoped transaction object for a Unit of Work.
 *
 * @typeParam TDatabase - Exact application Drizzle database type
 * @param unitOfWork - Unit of Work created for the active transaction
 * @param database - Opaque configuration supplied to this plugin instance
 * @returns The native callback-scoped transaction object
 * @throws {Error} If the Unit of Work, adapter, configuration, or runtime scope does not match
 * @since 0.2.0
 */
export function getDrizzleTransaction<TDatabase extends object>(
  unitOfWork: IUnitOfWork,
  database: DrizzleDatabase<TDatabase>,
): DrizzleTransaction<TDatabase> {
  return readScopedDrizzle(unitOfWork, database, 'transaction') as DrizzleTransaction<TDatabase>;
}
