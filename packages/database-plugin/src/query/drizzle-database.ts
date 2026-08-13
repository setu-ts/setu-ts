/**
 * Typed configuration witness for Promise-aware Drizzle databases.
 *
 * This module deliberately has no dependency on database-plugin interfaces so
 * configuration types can depend on it without creating an import cycle.
 *
 * @module
 */

/** Internal key that makes a configured Drizzle database a source-owned typed witness. */
export const DRIZZLE_DATABASE: unique symbol = Symbol('setu.database.drizzle-database');

/**
 * A source-owned typed witness for one configured, Promise-aware Drizzle database.
 *
 * Create this only with {@linkcode createDrizzleDatabase}. Its private package
 * key ties the inferred application type to the same runtime object the adapter
 * uses, so a Unit-of-Work accessor cannot select an unrelated generic type.
 *
 * @typeParam TDatabase - Exact application Drizzle database type
 * @since 0.2.0
 */
export interface DrizzleDatabase<TDatabase extends object> {
  /** @internal Exact configured database, hidden behind a package-private key. */
  readonly [DRIZZLE_DATABASE]: TDatabase;
}

/**
 * Creates the typed witness required by the Drizzle adapter and query accessor.
 *
 * Drizzle drivers whose transaction method accepts a synchronous callback are
 * rejected at compile time. The adapter also detects a synchronous return at
 * runtime before exposing a Unit of Work. Its imperative bridge must
 * hold the native callback open across awaited application work, which only a
 * Promise-aware transaction implementation can guarantee.
 *
 * @typeParam TDatabase - Exact application Drizzle database type, inferred from `database`
 * @param database - Configured Promise-aware Drizzle database instance
 * @param unsupportedSynchronousDriver - Uncallable guard for synchronous callback drivers
 * @returns A typed witness carrying the exact configured database identity
 * @example
 * ```typescript
 * const drizzleDatabase = createDrizzleDatabase(drizzleDb);
 * app.register(DatabasePlugin({
 *   type: 'drizzle',
 *   options: { drizzleInstance: drizzleDatabase, drizzleTables: { User: users } },
 * }));
 * ```
 * @since 0.2.0
 */
export function createDrizzleDatabase<const TDatabase extends object>(
  database: TDatabase,
  ...unsupportedSynchronousDriver: TDatabase extends {
    transaction(
      callback: (transaction: infer _TTransaction) => {
        readonly __setuSynchronousTransactionResult: true;
      },
      ...args: unknown[]
    ): { readonly __setuSynchronousTransactionResult: true };
  } ? [unsupportedSynchronousDriver: never]
    : []
): DrizzleDatabase<TDatabase> {
  void unsupportedSynchronousDriver;
  return { [DRIZZLE_DATABASE]: database };
}
