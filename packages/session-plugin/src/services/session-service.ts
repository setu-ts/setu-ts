/**
 * The session service registered under `CAPABILITIES.SESSION`.
 *
 * Owns the two strategies behind one surface: with no store the cookie carries
 * the whole payload, and with a store the cookie carries only an opaque id. Both
 * paths run through the same `load`/`commit` pair, so no caller can observe a
 * differently-configured session (one capability, one implementation).
 *
 * @module
 */
import type { IRequestContext, ISession, ISessionService, ISessionStore } from '@setu-ts/common';
import { parseCookie, serializeCookie } from '@setu-ts/common';

import type { KeyRing } from '../codec/crypto.ts';
import { open, seal } from '../codec/crypto.ts';
import { SessionMiddlewareMissingError, SessionTooLargeError } from '../errors.ts';
import type { ResolvedSessionConfig } from '../options.ts';
import type { Session } from './session.ts';
import { createSession, parseSnapshot, restoreSession } from './session.ts';

/**
 * Key under which the middleware parks the live session in
 * {@linkcode IRequestContext.state}.
 *
 * `ctx.state` is the carrier rather than a new `IRequestContext` member because
 * that interface is fully `readonly`: adding a `session` field would oblige
 * every producer — the kernel, the testing package's `createTestContext`, and
 * every hand-rolled double — to construct one, and would type it as present on
 * requests the middleware never touched.
 */
export const SESSION_STATE_KEY = 'setu-ts:session';

/** Runtime capabilities the service needs, injected for testability. */
export interface SessionServiceDeps {
  /** Web Crypto, from `IRuntimeServices.subtle`. */
  readonly subtle: SubtleCrypto;
  /** Random bytes, from `IRuntimeServices.randomBytes`. */
  readonly randomBytes: (length: number) => Uint8Array;
  /** Wall-clock milliseconds, from `IRuntimeServices.now`. */
  readonly now: () => number;
  /** Identifier source, from `IRuntimeServices.uuid`. */
  readonly uuid: () => string;
}

/**
 * Loads, exposes, and commits the per-request session.
 *
 * @since 0.2.0
 */
export class SessionService implements ISessionService {
  readonly #config: ResolvedSessionConfig;
  readonly #ring: KeyRing;
  readonly #deps: SessionServiceDeps;
  readonly #store: ISessionStore | undefined;

  /**
   * @param config - Resolved configuration
   * @param ring - Derived key ring; index 0 seals
   * @param deps - Runtime capabilities
   * @param store - Server-side store; omit for the cookie strategy
   */
  constructor(
    config: ResolvedSessionConfig,
    ring: KeyRing,
    deps: SessionServiceDeps,
    store?: ISessionStore,
  ) {
    this.#config = config;
    this.#ring = ring;
    this.#deps = deps;
    this.#store = store;
  }

  /** Which strategy is in effect, for the health indicator. */
  get strategy(): 'cookie' | 'store' {
    return this.#store === undefined ? 'cookie' : 'store';
  }

  /** How the cookie is protected, for the health indicator. */
  get mode(): string {
    return this.#ring.mode;
  }

  /** How many keys can open a cookie, for the health indicator. */
  get keyCount(): number {
    return this.#ring.keys.length;
  }

  from(ctx: IRequestContext): ISession {
    const session = ctx.state.get(SESSION_STATE_KEY);
    if (session === undefined) {
      throw new SessionMiddlewareMissingError();
    }
    return session as ISession;
  }

  /**
   * Loads the session for a request, falling back to a fresh one whenever the
   * cookie is absent, malformed, tampered with, expired, idle, or (on the store
   * strategy) no longer present server-side.
   *
   * @param ctx - The request context
   * @returns The session to serve this request with
   * @since 0.2.0
   */
  async load(ctx: IRequestContext): Promise<Session> {
    const now = this.#deps.now();
    const raw = parseCookie(ctx.request.headers.get('cookie'))[this.#config.cookieName];

    if (raw !== undefined && raw !== '') {
      const restored = await this.#restore(raw, now);
      if (restored !== null) {
        return restored;
      }
    }

    return createSession(now, this.#config.maxAgeMs, this.#deps.uuid);
  }

  /**
   * Writes the session back, when it needs writing.
   *
   * A clean session emits no header at all: committing on every request would
   * rewrite the cookie on pure reads and defeat downstream caching.
   *
   * @param ctx - The request context
   * @param session - The session returned by {@linkcode SessionService.load}
   * @throws {SessionTooLargeError} If the serialized cookie exceeds the budget
   * @since 0.2.0
   */
  async commit(ctx: IRequestContext, session: Session): Promise<void> {
    if (session.isDestroyed) {
      // Both ids, not just the current one. After a `regenerate()` in this same
      // request `session.id` is the NEW id, which was never written to the
      // store — while the cookie the client presented still carries the old one.
      // Deleting only the current id would leave that row readable until its
      // TTL, so a stolen copy of the original cookie would keep authenticating
      // after an explicit destroy.
      await this.#destroyStored(session.id, session.previousId);
      ctx.response.appendHeader('set-cookie', this.#cookie('', 0));
      return;
    }

    const rolling = this.#config.rolling;
    // An idle timeout has to be refreshed by activity to mean anything, and
    // `seen` only advances when this method commits. Without this, a user making
    // read-only requests inside the idle window never refreshes it and is signed
    // out while demonstrably active — so a configured idle timeout commits on
    // every request exactly as `rolling` does. It does NOT extend absolute
    // expiry; only `rolling` does that (see below).
    const refreshesIdleWindow = rolling || this.#config.idleTimeoutMs !== undefined;
    const shouldCommit = session.isDirty || session.wasRegenerated ||
      (refreshesIdleWindow && !session.isNew);
    if (!shouldCommit) {
      return;
    }

    const now = this.#deps.now();

    // A regenerated session leaves its old server-side row behind, which would
    // otherwise stay readable until its TTL — that is what makes regeneration a
    // real revocation rather than a rename.
    await this.#destroyStored(session.previousId);

    session.touch(now);
    if (rolling) {
      session.extend(now + this.#config.maxAgeMs);
    }

    const snapshot = session.snapshot();
    const ttlMs = Math.max(snapshot.exp - now, 0);

    // On the store strategy the payload goes server-side and the cookie carries
    // only the id, which is why the same envelope stays well under any limit.
    const payload = this.#store === undefined
      ? snapshot
      : { id: snapshot.id, data: {}, exp: snapshot.exp, seen: snapshot.seen };

    const sealed = await seal(
      this.#deps.subtle,
      this.#ring,
      JSON.stringify(payload),
      this.#deps.randomBytes,
    );
    const header = this.#cookie(sealed, Math.ceil(ttlMs / 1000));

    // Checked BEFORE the store write, so a rejected commit leaves no trace. The
    // reverse order persisted a row for a session whose cookie was never sent,
    // which would then be unreachable but still occupying its TTL.
    if (header.length > this.#config.maxCookieBytes) {
      throw new SessionTooLargeError(header.length, this.#config.maxCookieBytes);
    }

    if (this.#store !== undefined) {
      await this.#store.write(snapshot.id, snapshot.data, ttlMs);
    }

    ctx.response.appendHeader('set-cookie', header);
  }

  /**
   * Reports store reachability for the health indicator.
   *
   * @returns `true`/`false` from the store's own check, or `undefined` when
   *   there is no store or it exposes no check
   * @since 0.2.0
   */
  async storeHealth(): Promise<boolean | undefined> {
    const check = this.#store?.isHealthy;
    if (check === undefined || this.#store === undefined) {
      return undefined;
    }
    return await check.call(this.#store);
  }

  /** Releases store resources; called from the plugin's `onClose`. */
  async close(): Promise<void> {
    await this.#store?.close?.();
  }

  /**
   * Opens a cookie and rebuilds the session, or returns `null` when any step
   * says this request has no usable session.
   */
  async #restore(raw: string, now: number): Promise<Session | null> {
    const plaintext = await open(this.#deps.subtle, this.#ring, raw);
    if (plaintext === null) {
      return null;
    }

    const snapshot = parseSnapshot(plaintext);
    if (snapshot === null) {
      return null;
    }

    let data = snapshot.data;
    if (this.#store !== undefined) {
      const stored = await this.#store.read(snapshot.id);
      if (stored === null) {
        // Revoked or expired server-side. The cookie is authentic but the
        // session behind it is gone, so this must not restore.
        return null;
      }
      data = stored;
    }

    return restoreSession(
      { ...snapshot, data },
      now,
      this.#deps.uuid,
      this.#config.idleTimeoutMs,
    );
  }

  /**
   * Deletes the given ids from the store, skipping `null` and de-duplicating.
   *
   * A no-op on the cookie strategy, where there is no store to clean up.
   */
  async #destroyStored(...ids: readonly (string | null)[]): Promise<void> {
    const store = this.#store;
    if (store === undefined) {
      return;
    }
    for (const id of new Set(ids)) {
      if (id !== null) {
        await store.destroy(id);
      }
    }
  }

  /** Builds the `Set-Cookie` header value for a value and remaining lifetime. */
  #cookie(value: string, maxAge: number): string {
    const c = this.#config;
    return serializeCookie(c.cookieName, value, {
      maxAge,
      path: c.cookiePath,
      sameSite: c.cookieSameSite,
      secure: c.cookieSecure,
      httpOnly: c.cookieHttpOnly,
      ...(c.cookieDomain === undefined ? {} : { domain: c.cookieDomain }),
    });
  }
}
