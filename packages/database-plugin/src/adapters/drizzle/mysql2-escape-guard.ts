/**
 * The `NO_BACKSLASH_ESCAPES` guard for Drizzle over mysql2 (internal).
 *
 * Drizzle's mysql2 session sends `client.query(sql, params)`, so mysql2 writes
 * every bound string into the statement text, escaping `'` as `\'`. Under
 * `NO_BACKSLASH_ESCAPES` the server reads that backslash as a literal
 * character and the quote as the end of the string, so a bound value can
 * close its literal and append SQL. The adapter therefore refuses while a
 * session reports the mode.
 *
 * mysql2 exposes the server's `SERVER_STATUS_NO_BACKSLASH_ESCAPES` flag only
 * on the handshake (the GLOBAL mode at connect, not `init_connect`) and on OK
 * packets, never on a `SELECT` result, so a per-statement check would cost a
 * round trip per statement. The guard instead reads `@@SESSION.sql_mode` once
 * at `connect()` and, for a pool, on every connection the pool opens later.
 *
 * @module
 */

/** The `sql_mode` flag the guard refuses. */
export const NO_BACKSLASH_ESCAPES = 'NO_BACKSLASH_ESCAPES';

/** Reads the session's mode; also the connect-time check. */
export const READ_SESSION_MODE = 'SELECT @@SESSION.sql_mode AS mode';

/**
 * Removes the flag from a new pooled connection's session. The server runs
 * one connection's statements in order, so this runs before the statement the
 * pool is about to send for its caller, which mysql2 has already formatted;
 * reading the mode and destroying the connection would be too late for it.
 * The literal holds no backslash, so it parses under the mode it removes.
 */
export const STRIP_SESSION_MODE =
  "SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(CONCAT(',', @@SESSION.sql_mode, ','), ',NO_BACKSLASH_ESCAPES,', ','))";

/** The callback-style connection a mysql2 pool emits with `'connection'`. */
interface Mysql2CoreConnection {
  query(sql: string, callback: (error: unknown, rows?: unknown) => void): unknown;
  destroy(): void;
}

/** The part of a mysql2 pool (callback or promise) the guard uses. */
interface Mysql2PoolLike {
  getConnection: unknown;
  on(event: 'connection', listener: (connection: Mysql2CoreConnection) => void): unknown;
  removeListener(
    event: 'connection',
    listener: (connection: Mysql2CoreConnection) => void,
  ): unknown;
}

/**
 * Whether a Drizzle database is the `drizzle-orm/mysql2` driver's.
 *
 * Read from Drizzle's `entityKind` brand, so detection needs no import of
 * `drizzle-orm/mysql2`, which loads `mysql2` and fails without it.
 *
 * @param database - The configured Drizzle database
 * @param entityKind - Drizzle's `entityKind` symbol
 * @returns `true` for a `MySql2Database`
 */
export function isMysql2Database(database: unknown, entityKind: unknown): boolean {
  const constructor = (database as { constructor?: Record<PropertyKey, unknown> } | null)
    ?.constructor;
  return typeof entityKind === 'symbol' && constructor?.[entityKind] === 'MySql2Database';
}

/**
 * Whether a `sql_mode` value includes `NO_BACKSLASH_ESCAPES`.
 *
 * @param mode - The `@@SESSION.sql_mode` value
 * @returns `true` when the flag is set
 */
export function hasNoBackslashEscapes(mode: string): boolean {
  return mode.split(',').some((flag) => flag.trim().toUpperCase() === NO_BACKSLASH_ESCAPES);
}

/**
 * Reads the mode from a mysql2 `SELECT` result: `[rows, fields]` through
 * Drizzle's `execute()`, or the bare rows a callback connection returns.
 *
 * @param result - The driver result
 * @returns The mode, or `undefined` when the result holds none
 */
export function sessionModeOf(result: unknown): string | undefined {
  const rows: unknown = Array.isArray(result) && Array.isArray(result[0]) ? result[0] : result;
  const mode = Array.isArray(rows) ? (rows[0] as { mode?: unknown } | undefined)?.mode : undefined;
  return typeof mode === 'string' ? mode : undefined;
}

/**
 * Guards every connection a mysql2 pool opens from now on: reads its mode,
 * reporting the flag through `onRefused`, and strips the flag before the
 * pool's caller's statement runs. A strip the server refuses destroys the
 * connection. A plain connection is not a pool and gets no listener.
 *
 * @param client - Drizzle's `$client`
 * @param onRefused - Called when a new connection reported the flag
 * @returns A function that removes the listener, or `undefined` for a non-pool
 */
export function guardMysql2Pool(client: unknown, onRefused: () => void): (() => void) | undefined {
  const pool = client as Partial<Mysql2PoolLike> | null | undefined;
  if (
    typeof pool?.getConnection !== 'function' ||
    typeof pool.on !== 'function' ||
    typeof pool.removeListener !== 'function'
  ) {
    return undefined;
  }
  const guarded = pool as Mysql2PoolLike;
  const listener = (connection: Mysql2CoreConnection): void => {
    connection.query(READ_SESSION_MODE, (error, rows) => {
      const mode = error == null ? sessionModeOf(rows) : undefined;
      if (mode !== undefined && hasNoBackslashEscapes(mode)) onRefused();
    });
    connection.query(STRIP_SESSION_MODE, (error) => {
      if (error != null) connection.destroy();
    });
  };
  guarded.on('connection', listener);
  return () => {
    guarded.removeListener('connection', listener);
  };
}
