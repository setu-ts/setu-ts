/**
 * The per-request session object.
 *
 * Mutations are buffered here and written back by the session middleware after
 * the handler returns, so nothing in application code issues a `Set-Cookie`.
 *
 * Expiry is enforced from the payload, never from the cookie's `Max-Age`: that
 * attribute is client-controlled, so a server trusting it has no expiry at all.
 * Both stamps are wall-clock readings from `runtime.now()` because they are
 * serialized and compared across processes — `hrtime()` is monotonic from an
 * arbitrary origin and is meaningless once persisted.
 *
 * @module
 */
import type { ISession, SessionData } from '@setu-ts/common';
import { SESSION_TENANT_BINDING_KEY } from '@setu-ts/common';
import { CSRF_SESSION_KEY } from '../csrf/token.ts';

/**
 * The reserved keys the framework itself writes: the form-CSRF token and the tenant binding. On the
 * store strategy a session holding only these is sealed into the cookie (M113e, V9-46). Reading or
 * writing them does not make a response per-visitor: only the application's own keys do.
 */
export const RESERVED_SESSION_KEYS: ReadonlySet<string> = new Set([
  CSRF_SESSION_KEY,
  SESSION_TENANT_BINDING_KEY,
]);

/** Whether every key of `data` is a {@linkcode RESERVED_SESSION_KEYS} entry. */
export function holdsOnlyReservedKeys(data: SessionData): boolean {
  return Object.keys(data).every((key) => RESERVED_SESSION_KEYS.has(key));
}

/** The serialized session payload carried in the cookie. */
export interface SessionSnapshot {
  /** Session identifier. */
  readonly id: string;
  /** Session payload. Empty on the store strategy, where the store holds it. */
  readonly data: SessionData;
  /** Absolute expiry as a wall-clock epoch in milliseconds. */
  readonly exp: number;
  /** Last-activity stamp as a wall-clock epoch in milliseconds. */
  readonly seen: number;
  /**
   * `'cookie'` on the store strategy when the cookie itself carries the
   * payload because it holds only reserved keys (M113e, V9-46) — no store row
   * exists for it. Absent otherwise.
   */
  readonly held?: 'cookie';
}

/**
 * Default {@linkcode ISession} implementation.
 *
 * Not exported from the package barrel: consumers depend on the `ISession`
 * contract, and the extra members here (dirty tracking, the previous id) are
 * the middleware's business rather than an application's.
 */
export class Session implements ISession {
  #id: string;
  #data: SessionData;
  #exp: number;
  #seen: number;
  #dirty = false;
  #regenerated = false;
  #destroyed = false;
  #previousId: string | null = null;
  // The keys this request set or deleted, and whether it cleared the payload, so a store commit can
  // apply only this request's changes to the current row (`storeCommit: 'changes'`).
  readonly #changed = new Set<string>();
  #cleared = false;
  // Whether the application read a key of its own, and whether a CSRF token was read: the signals
  // the session middleware's cache marking reads.
  #applicationRead = false;
  #csrfRead = false;
  #onFirstWrite: (() => void) | undefined;
  #onFirstRead: (() => void) | undefined;
  readonly #loadedId: string;
  readonly #isNew: boolean;
  readonly #storeHeld: boolean;
  readonly #uuid: () => string;

  /**
   * @param snapshot - Initial state
   * @param isNew - Whether this session was created rather than restored
   * @param uuid - Identifier source, from `IRuntimeServices.uuid`
   * @param storeHeld - Whether it was restored from a store row
   */
  constructor(
    snapshot: SessionSnapshot,
    isNew: boolean,
    uuid: () => string,
    storeHeld: boolean = false,
  ) {
    this.#id = snapshot.id;
    this.#loadedId = snapshot.id;
    this.#data = { ...snapshot.data };
    this.#exp = snapshot.exp;
    this.#seen = snapshot.seen;
    this.#isNew = isNew;
    this.#storeHeld = storeHeld;
    this.#uuid = uuid;
  }

  /**
   * Whether this session was restored from a store row, so a commit that moves
   * it into the cookie knows to delete that row (M113e, V9-46).
   */
  get wasStoreHeld(): boolean {
    return this.#storeHeld;
  }

  get id(): string {
    return this.#id;
  }

  /** The id this session was created or restored with, before any `regenerate()` or rotation. */
  get loadedId(): string {
    return this.#loadedId;
  }

  /** Whether the application read one of its own keys (`get`, `has` or `toJSON`). */
  get wasReadByApplication(): boolean {
    return this.#applicationRead;
  }

  /** Whether a CSRF token was read for this request. */
  get csrfTokenRead(): boolean {
    return this.#csrfRead;
  }

  /** Whether the session holds any key other than the reserved ones. */
  get holdsApplicationData(): boolean {
    return !holdsOnlyReservedKeys(this.#data);
  }

  /** Records that a CSRF token was read for this request. */
  markCsrfTokenRead(): void {
    this.#csrfRead = true;
  }

  /**
   * Registers a callback run once, at the first write that will make the response carry the
   * session cookie: a `set`/`delete`/`clear` of a non-reserved key, a `regenerate()` or a
   * `destroy()`. Writes of reserved keys do not run it.
   */
  onFirstWrite(callback: () => void): void {
    this.#onFirstWrite = callback;
  }

  /**
   * Registers a callback run once, at the first application read (`get`/`has` of a non-reserved
   * key, or `toJSON()`). Reads of reserved keys do not run it.
   */
  onFirstRead(callback: () => void): void {
    this.#onFirstRead = callback;
  }

  get isNew(): boolean {
    return this.#isNew;
  }

  /** Absolute expiry (wall-clock ms). Read by the middleware when committing. */
  get expiresAt(): number {
    return this.#exp;
  }

  /** Last-activity stamp (wall-clock ms). */
  get lastSeen(): number {
    return this.#seen;
  }

  /** Whether the payload changed and therefore needs committing. */
  get isDirty(): boolean {
    return this.#dirty;
  }

  /** Whether {@linkcode Session.destroy} was called. */
  get isDestroyed(): boolean {
    return this.#destroyed;
  }

  /** Whether {@linkcode Session.regenerate} was called. */
  get wasRegenerated(): boolean {
    return this.#regenerated;
  }

  /**
   * The id this session held before the first `regenerate()`, so the middleware
   * can delete the superseded store entry. `null` when never regenerated.
   */
  get previousId(): string | null {
    return this.#previousId;
  }

  /**
   * Reads a value.
   *
   * Note that a nested object is returned by reference: mutating it does not
   * mark the session dirty, so call {@linkcode Session.set} again after
   * changing a nested value.
   *
   * @typeParam T - The expected value type
   * @param key - Session key
   * @returns The value, or `undefined` when absent
   */
  get<T = unknown>(key: string): T | undefined {
    this.#noteRead(key);
    return this.#data[key] as T | undefined;
  }

  /**
   * Writes a value, or removes the key when the value is `undefined`.
   *
   * `undefined` is treated as a removal rather than stored, because it is not
   * JSON-serializable: storing it would make {@linkcode Session.has} report a key
   * that `JSON.stringify` then drops, so presence would be true before a commit
   * and false after the next load. Treating it as an unset keeps `has` truthful
   * across the round-trip.
   *
   * @typeParam T - The value type
   * @param key - Session key
   * @param value - Value to store; `undefined` removes the key
   */
  set<T>(key: string, value: T): void {
    if (value === undefined) {
      this.delete(key);
      return;
    }
    this.#data[key] = value;
    this.#dirty = true;
    this.#changed.add(key);
    this.#noteWrite(key);
  }

  has(key: string): boolean {
    this.#noteRead(key);
    return Object.hasOwn(this.#data, key);
  }

  delete(key: string): boolean {
    if (!Object.hasOwn(this.#data, key)) {
      return false;
    }
    delete this.#data[key];
    this.#dirty = true;
    this.#changed.add(key);
    this.#noteWrite(key);
    return true;
  }

  clear(): void {
    this.#data = {};
    this.#dirty = true;
    this.#cleared = true;
    this.#noteWrite(undefined);
  }

  regenerate(): void {
    this.delete(CSRF_SESSION_KEY);
    // Captured only on the first call, so two regenerations in one request
    // still identify the id that is actually persisted server-side.
    if (this.#previousId === null) {
      this.#previousId = this.#id;
    }
    this.#id = this.#uuid();
    this.#regenerated = true;
    this.#noteWrite(undefined);
  }

  /** Rotates a cookie-held id for promotion without recording a store row to revoke. */
  rotateId(id: string): void {
    this.#id = id;
  }

  destroy(): void {
    this.#data = {};
    this.#destroyed = true;
    this.#noteWrite(undefined);
  }

  toJSON(): SessionData {
    this.#markApplicationRead();
    return this.#copy();
  }

  /**
   * Applies this request's changes to `current`, the row as it is now: every key it set or deleted,
   * or its whole payload after a `clear()`. Keys it never touched keep their current values.
   */
  applyChangesTo(current: SessionData): SessionData {
    const own = this.#copy();
    if (this.#cleared) {
      return own;
    }
    const merged: Record<string, unknown> = { ...current };
    for (const key of this.#changed) {
      if (Object.hasOwn(own, key)) {
        merged[key] = own[key];
      } else {
        delete merged[key];
      }
    }
    return merged;
  }

  /** Records activity at `now`, for the idle-timeout check on the next load. */
  touch(now: number): void {
    this.#seen = now;
  }

  /** Moves the absolute expiry, used by the rolling-session commit path. */
  extend(exp: number): void {
    this.#exp = exp;
  }

  /** The snapshot to serialize into the cookie. */
  snapshot(): SessionSnapshot {
    return { id: this.#id, data: this.#copy(), exp: this.#exp, seen: this.#seen };
  }

  // A JSON round-trip rather than a spread, so the copy is genuinely detached at every depth.
  // Session values must be JSON-serializable anyway, since both strategies serialize them.
  #copy(): SessionData {
    return JSON.parse(JSON.stringify(this.#data)) as SessionData;
  }

  #noteRead(key: string): void {
    if (!RESERVED_SESSION_KEYS.has(key)) {
      this.#markApplicationRead();
    }
  }

  #markApplicationRead(): void {
    this.#applicationRead = true;
    const callback = this.#onFirstRead;
    if (callback !== undefined) {
      this.#onFirstRead = undefined;
      callback();
    }
  }

  /** Runs the first-write callback once; `key` is `undefined` for a whole-session write. */
  #noteWrite(key: string | undefined): void {
    if (key !== undefined && RESERVED_SESSION_KEYS.has(key)) {
      return;
    }
    const callback = this.#onFirstWrite;
    if (callback !== undefined) {
      this.#onFirstWrite = undefined;
      callback();
    }
  }
}

/**
 * Creates a fresh, empty session.
 *
 * @param now - Current wall-clock time in milliseconds
 * @param maxAgeMs - Absolute lifetime in milliseconds
 * @param uuid - Identifier source
 * @returns A new session marked `isNew`
 * @since 0.2.0
 */
export function createSession(now: number, maxAgeMs: number, uuid: () => string): Session {
  return new Session({ id: uuid(), data: {}, exp: now + maxAgeMs, seen: now }, true, uuid);
}

/**
 * Restores a session from a decoded snapshot, rejecting one that has expired or
 * gone idle.
 *
 * Returning `null` rather than a partially-valid session is what makes an
 * expired cookie behave exactly like no cookie at all.
 *
 * @param snapshot - The decoded payload
 * @param now - Current wall-clock time in milliseconds
 * @param uuid - Identifier source
 * @param idleTimeoutMs - Reject when the last-activity stamp is older than this
 * @param storeHeld - Whether the payload came from a store row
 * @returns The restored session, or `null` when it must not be used
 * @since 0.2.0
 */
export function restoreSession(
  snapshot: SessionSnapshot,
  now: number,
  uuid: () => string,
  idleTimeoutMs?: number,
  storeHeld: boolean = false,
): Session | null {
  if (snapshot.exp <= now) {
    return null;
  }
  if (idleTimeoutMs !== undefined && now - snapshot.seen > idleTimeoutMs) {
    return null;
  }
  return new Session(snapshot, false, uuid, storeHeld);
}

/**
 * Parses a decrypted payload into a snapshot, returning `null` when it does not
 * have the expected shape.
 *
 * The payload is authenticated by the time it reaches here, so a shape mismatch
 * means a format change rather than an attack — but it is still validated,
 * because a cookie written by a different framework version must degrade to "no
 * session" instead of producing a session with `NaN` expiry.
 *
 * @param json - The decrypted payload text
 * @returns The snapshot, or `null` when the payload is unusable
 * @since 0.2.0
 */
export function parseSnapshot(json: string): SessionSnapshot | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }

  const candidate = parsed as Record<string, unknown>;
  const { id, exp, seen, data, held } = candidate;

  if (typeof id !== 'string' || id === '') {
    return null;
  }
  if (!Number.isFinite(exp) || !Number.isFinite(seen)) {
    return null;
  }
  // `data` is absent on the store strategy, where the store owns the payload.
  if (data !== undefined && (typeof data !== 'object' || data === null || Array.isArray(data))) {
    return null;
  }

  // The marker is inside the sealed plaintext, so a client cannot set it; any
  // value other than the one this package writes is a format it does not know.
  if (held !== undefined && held !== 'cookie') {
    return null;
  }

  return {
    id,
    data: (data ?? {}) as SessionData,
    exp: exp as number,
    seen: seen as number,
    ...(held === 'cookie' ? { held } : {}),
  };
}
