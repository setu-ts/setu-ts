/**
 * Session contracts, fulfilled by the SessionPlugin under
 * `CAPABILITIES.SESSION`.
 *
 * A session is per-request state keyed by a cookie. The plugin ships two
 * strategies behind these contracts: the payload lives in the cookie itself
 * (default, zero infrastructure), or the cookie carries an opaque id and the
 * payload lives behind {@linkcode ISessionStore} (opt-in, revocable).
 *
 * @module
 */
import type { IRequestContext } from '../http.ts';

/**
 * Arbitrary serializable session payload.
 *
 * Values must survive `JSON.stringify`/`JSON.parse`, because both strategies
 * serialize the payload — a `Date` comes back as a string, and a `Map` does not
 * survive at all.
 *
 * @since 0.2.0
 */
export type SessionData = Record<string, unknown>;

/**
 * A read-only projection of a session: its identifier and payload, with no
 * mutation surface.
 *
 * Returned by {@linkcode ISessionService.fromHeaders} for a session that can be
 * opened from a `Headers` object alone — the headers-only read used by non-HTTP
 * entry points (a WebSocket `onOpen` handler, an auth strategy reading a cookie)
 * where there is no request context to commit onto. Because it exposes no
 * `set`/`destroy`/`regenerate`, nothing handed out here can fail silently: a
 * caller cannot write a value that would never persist.
 *
 * `data` is returned verbatim, including any reserved keys the session plugin
 * stores in the payload (e.g. the tenant binding key), so `fromHeaders(...)` and
 * {@linkcode ISession.toJSON} agree about the same session.
 *
 * @since 0.3.0
 */
export type SessionView = {
  /** The session identifier. */
  readonly id: string;
  /** The session payload, exactly as stored. */
  readonly data: Readonly<SessionData>;
};

/**
 * Per-request session handle.
 *
 * Obtained from {@linkcode ISessionService.from} (or the plugin's `getSession`
 * helper). Mutations are buffered and written back by the session middleware
 * after the handler returns, so a handler never issues a `Set-Cookie` itself.
 *
 * @example
 * ```typescript
 * const session = getSession(ctx);
 * session.set('cartId', cart.id);
 * const userId = session.get<string>('userId');
 * ```
 * @since 0.2.0
 */
export interface ISession {
  /**
   * The session identifier. Stable for the session's lifetime until
   * {@linkcode ISession.regenerate} is called.
   */
  readonly id: string;
  /**
   * Whether this session was created for this request rather than restored
   * from a cookie. `true` for a first visit, and for a request whose cookie was
   * missing, expired, or failed authentication.
   */
  readonly isNew: boolean;
  /**
   * Reads a value.
   *
   * @typeParam T - The expected value type; validate before trusting it, since
   *   the payload survived a JSON round-trip
   * @param key - Session key
   * @returns The value, or `undefined` when absent
   */
  get<T = unknown>(key: string): T | undefined;
  /**
   * Writes a value and marks the session for commit.
   *
   * Passing `undefined` removes the key instead of storing it. `undefined` is not
   * JSON-serializable, so storing it would make {@linkcode ISession.has} report a
   * key that serialization then drops — presence would be `true` before a commit
   * and `false` after the next load.
   *
   * @typeParam T - The value type
   * @param key - Session key
   * @param value - Value to store; must be JSON-serializable. `undefined` removes the key
   */
  set<T>(key: string, value: T): void;
  /**
   * Reports whether a key is present.
   *
   * @param key - Session key
   * @returns `true` when the key exists
   */
  has(key: string): boolean;
  /**
   * Removes a key and marks the session for commit.
   *
   * @param key - Session key
   * @returns `true` when a value was removed
   */
  delete(key: string): boolean;
  /**
   * Removes every key, keeping the session and its id.
   *
   * Use {@linkcode ISession.destroy} to end the session instead.
   */
  clear(): void;
  /**
   * Issues a new session id while keeping the current data.
   *
   * Call this on privilege change (most importantly immediately after login) so
   * that a session id an attacker planted before authentication does not carry
   * into the authenticated session — session fixation. On the store strategy
   * the previous entry is deleted, making this a real revocation.
   */
  regenerate(): void;
  /**
   * Ends the session: clears the data, deletes any stored entry, and instructs
   * the client to drop the cookie.
   */
  destroy(): void;
  /**
   * Returns a plain snapshot of the current data.
   *
   * @returns A detached copy; mutating it does not affect the session
   */
  toJSON(): SessionData;
}

/**
 * Session service registered under `CAPABILITIES.SESSION`.
 *
 * @example
 * ```typescript
 * const sessions = ctx.services.get<ISessionService>(CAPABILITIES.SESSION);
 * const session = sessions.from(ctx);
 * ```
 * @since 0.2.0
 */
export interface ISessionService {
  /**
   * Returns the session the middleware loaded for this request.
   *
   * This is the single entry point: the middleware, route handlers, the CSRF
   * middleware, and framework bridges all read the same instance, so no caller
   * can observe a differently-configured session.
   *
   * @param ctx - The request context
   * @returns The session for this request
   * @throws {Error} If the session middleware did not run for this request
   */
  from(ctx: IRequestContext): ISession;
  /**
   * Opens a session from a `Headers` object alone — the headers-only read for
   * non-HTTP entry points that have no request context to commit onto (a
   * WebSocket `onOpen` handler, an auth strategy reading a cookie).
   *
   * This is READ-ONLY: it never commits, never advances the session's `seen`
   * stamp, and never writes to the store or the cookie. It runs the same
   * envelope-open, snapshot-parse, and store-read path as the load behind
   * {@linkcode ISessionService.from}, so it inherits real revocation on the
   * store strategy.
   *
   * @param headers - The request headers to read the session cookie from
   * @returns A read-only {@linkcode SessionView}, or `null` when there is no
   *   usable session — the cookie is absent, the envelope cannot be opened, the
   *   snapshot cannot be parsed, the absolute expiry or idle timeout has passed,
   *   or the stored entry is gone (revoked)
   * @since 0.3.0
   */
  fromHeaders(headers: Headers): Promise<SessionView | null>;
}

/**
 * Server-side session storage port.
 *
 * Implemented by the plugin's `MemorySessionStore` and `CacheSessionStore`, and
 * by any application-supplied backend. Only the store strategy uses it; the
 * default cookie strategy keeps the payload in the cookie and needs no store.
 *
 * Every method is async so a network-backed store fits without change.
 *
 * @since 0.2.0
 */
export interface ISessionStore {
  /**
   * Reads a stored session payload.
   *
   * @param id - Session identifier
   * @returns The payload, or `null` when absent or expired
   */
  read(id: string): Promise<SessionData | null>;
  /**
   * Writes a session payload, replacing any existing one.
   *
   * @param id - Session identifier
   * @param data - The payload to persist
   * @param ttlMs - Time-to-live in **milliseconds** from now
   */
  write(id: string, data: SessionData, ttlMs: number): Promise<void>;
  /**
   * Removes a stored session.
   *
   * @param id - Session identifier
   * @returns `true` when an entry was removed
   */
  destroy(id: string): Promise<boolean>;
  /**
   * Reports the store's reachability, for the plugin's health indicator.
   *
   * Optional: a store with no meaningful liveness check omits it, and the
   * indicator then reports only that a store is configured.
   *
   * @returns `true` when the store is reachable
   */
  isHealthy?(): Promise<boolean>;
  /**
   * Releases resources held by the store (timers, connections).
   *
   * Optional: called from the plugin's `onClose`. A store holding nothing
   * omits it.
   */
  close?(): Promise<void>;
}
