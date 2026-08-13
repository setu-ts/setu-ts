/**
 * Opaque typed configuration for a Promise-aware Drizzle database.
 *
 * This module deliberately has no dependency on database-plugin interfaces so
 * configuration types can depend on it without creating an import cycle.
 *
 * @module
 */

/**
 * Promise-aware transaction bridge owned by the application at configuration.
 *
 * The bridge is the positive runtime capability required by the adapter. It
 * must invoke `work` inside a native transaction whose implementation awaits
 * the returned promise before committing or rolling back.
 *
 * @typeParam TDatabase - Exact application Drizzle database type
 * @param database - The configured outer database
 * @param work - Package-owned async transaction work
 * @returns The result produced by `work`
 * @since 0.2.0
 */
export type DrizzleTransactionBridge<TDatabase extends object> = <T>(
  database: TDatabase,
  work: (transaction: DrizzleTransaction<TDatabase>) => Promise<T>,
) => Promise<T>;

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

/** Internal private state for one package-created opaque configuration. */
interface DrizzleDatabaseState {
  readonly database: object;
  readonly transaction: (work: (transaction: unknown) => Promise<void>) => Promise<void>;
}

/** Compile-only brands that cannot be named or copied by public consumers. */
declare const DRIZZLE_DATABASE_IDENTITY_BRAND: unique symbol;
declare const DRIZZLE_DATABASE_TYPE_BRAND: unique symbol;

/**
 * Erased identity of a package-created Drizzle configuration.
 *
 * This type is exported only for package-internal storage. The public barrel
 * exports the correlated `DrizzleDatabase<TDatabase>` type instead.
 */
export interface DrizzleDatabaseIdentity {
  /** @internal Compile-time opacity; runtime state lives in a private WeakMap. */
  readonly [DRIZZLE_DATABASE_IDENTITY_BRAND]: true;
}

/**
 * Opaque configuration for one exact Drizzle database and async transaction bridge.
 *
 * The optional private brand makes ordinary structural literals, spreads, and
 * clones statically incompatible. Runtime validity is stronger: only objects
 * whose identity is registered in this module's private WeakMap are accepted.
 *
 * @typeParam TDatabase - Exact application Drizzle database type
 * @since 0.2.0
 */
export interface DrizzleDatabase<TDatabase extends object> extends DrizzleDatabaseIdentity {
  /** @internal Compile-time opacity; runtime state never lives on this object. */
  readonly [DRIZZLE_DATABASE_TYPE_BRAND]: (database: TDatabase) => TDatabase;
}

/** Package-owned registry; keys and values die with their configuration object. */
const DRIZZLE_DATABASES = new WeakMap<object, DrizzleDatabaseState>();

/**
 * Creates the opaque configuration required by the Drizzle adapter and query accessors.
 *
 * The application supplies a positive async transaction bridge. Unknown or
 * structurally async-looking transaction methods are never inferred to be safe.
 * A bridge for a supported driver is normally the direct call
 * `database.transaction(work)` after the application has verified that driver's
 * documented callback contract.
 *
 * @typeParam TDatabase - Exact application Drizzle database type, inferred from `database`
 * @param database - Configured Drizzle database instance
 * @param transaction - Source-owned bridge that guarantees Promise-aware callback semantics
 * @param unsupportedSynchronousDriver - Uncallable guard for typed synchronous callback drivers
 * @returns An opaque frozen configuration tied to the exact database identity
 * @example
 * ```typescript
 * const drizzleDatabase = createDrizzleDatabase(
 *   drizzleDb,
 *   (database, work) => database.transaction(work),
 * );
 * ```
 * @since 0.2.0
 */
export function createDrizzleDatabase<const TDatabase extends object>(
  database: TDatabase,
  transaction: DrizzleTransactionBridge<TDatabase>,
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
  const configured = Object.freeze(Object.create(null)) as DrizzleDatabase<TDatabase>;
  DRIZZLE_DATABASES.set(configured, {
    database,
    transaction: (work) => transaction(database, async (tx) => await work(tx)),
  });
  return configured;
}

/** Read a package-created configuration, rejecting every structural lookalike. */
export function readDrizzleDatabase(value: unknown): DrizzleDatabaseState {
  if ((typeof value !== 'object' && typeof value !== 'function') || value === null) {
    throw new Error(
      'DrizzleAdapter requires options.drizzleInstance to be created by createDrizzleDatabase().',
    );
  }
  const configured = DRIZZLE_DATABASES.get(value);
  if (configured === undefined) {
    throw new Error(
      'DrizzleAdapter requires options.drizzleInstance to be created by createDrizzleDatabase().',
    );
  }
  return configured;
}

/** Test whether two values are the identical package-created configuration. */
export function isDrizzleDatabase(value: unknown): value is DrizzleDatabaseIdentity {
  return value !== null && (typeof value === 'object' || typeof value === 'function') &&
    DRIZZLE_DATABASES.has(value);
}
