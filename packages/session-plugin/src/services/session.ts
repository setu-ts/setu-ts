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
import type { ISession, SessionData } from '@hono-enterprise/common';

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
  readonly #isNew: boolean;
  readonly #uuid: () => string;

  /**
   * @param snapshot - Initial state
   * @param isNew - Whether this session was created rather than restored
   * @param uuid - Identifier source, from `IRuntimeServices.uuid`
   */
  constructor(snapshot: SessionSnapshot, isNew: boolean, uuid: () => string) {
    this.#id = snapshot.id;
    this.#data = { ...snapshot.data };
    this.#exp = snapshot.exp;
    this.#seen = snapshot.seen;
    this.#isNew = isNew;
    this.#uuid = uuid;
  }

  get id(): string {
    return this.#id;
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
  }

  has(key: string): boolean {
    return Object.hasOwn(this.#data, key);
  }

  delete(key: string): boolean {
    if (!Object.hasOwn(this.#data, key)) {
      return false;
    }
    delete this.#data[key];
    this.#dirty = true;
    return true;
  }

  clear(): void {
    this.#data = {};
    this.#dirty = true;
  }

  regenerate(): void {
    // Captured only on the first call, so two regenerations in one request
    // still identify the id that is actually persisted server-side.
    if (this.#previousId === null) {
      this.#previousId = this.#id;
    }
    this.#id = this.#uuid();
    this.#regenerated = true;
  }

  destroy(): void {
    this.#data = {};
    this.#destroyed = true;
  }

  toJSON(): SessionData {
    // A JSON round-trip rather than a spread, so the copy is genuinely detached
    // at every depth. Session values must be JSON-serializable anyway, since
    // both strategies serialize them.
    return JSON.parse(JSON.stringify(this.#data)) as SessionData;
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
    return { id: this.#id, data: this.toJSON(), exp: this.#exp, seen: this.#seen };
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
 * @returns The restored session, or `null` when it must not be used
 * @since 0.2.0
 */
export function restoreSession(
  snapshot: SessionSnapshot,
  now: number,
  uuid: () => string,
  idleTimeoutMs?: number,
): Session | null {
  if (snapshot.exp <= now) {
    return null;
  }
  if (idleTimeoutMs !== undefined && now - snapshot.seen > idleTimeoutMs) {
    return null;
  }
  return new Session(snapshot, false, uuid);
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
  const { id, exp, seen, data } = candidate;

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

  return {
    id,
    data: (data ?? {}) as SessionData,
    exp: exp as number,
    seen: seen as number,
  };
}
