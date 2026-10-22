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
import type {
  IRequestContext,
  ISession,
  ISessionService,
  ISessionStore,
  SessionData,
  SessionView,
} from '@setu-ts/common';
import {
  parseCookie,
  requestOriginOf,
  serializeCookie,
  SESSION_STATE_KEY,
  SESSION_TENANT_BINDING_KEY,
} from '@setu-ts/common';

import type { KeyRing } from '../codec/crypto.ts';
import { open, seal } from '../codec/crypto.ts';
import { SessionMiddlewareMissingError, SessionTooLargeError } from '../errors.ts';
import type { ResolvedSessionConfig } from '../options.ts';
import type { Session } from './session.ts';
import { createSession, parseSnapshot, restoreSession } from './session.ts';
import { CSRF_SESSION_KEY } from '../csrf/token.ts';

/**
 * The reserved keys a session may hold and still be sealed into the cookie on
 * the store strategy (M113e, V9-46): the form-CSRF token and the tenant
 * binding. Both exist to serve requests before anyone signs in, and a store
 * row behind them buys nothing — there is nothing to revoke in a session
 * holding only those. The first write of any other key moves the session into
 * the store. Pending sign-in secrets (`auth-plugin`'s state, nonce and PKCE
 * verifier) are deliberately NOT here: they stay server-side.
 */
const COOKIE_HELD_KEYS: ReadonlySet<string> = new Set([
  CSRF_SESSION_KEY,
  SESSION_TENANT_BINDING_KEY,
]);

/** Whether every key of `data` is one {@linkcode COOKIE_HELD_KEYS} allows. */
function isCookieHeld(data: SessionData): boolean {
  return Object.keys(data).every((key) => COOKIE_HELD_KEYS.has(key));
}

/**
 * Key under which the middleware parks the live session in
 * {@linkcode IRequestContext.state}.
 *
 * `ctx.state` is the carrier rather than a new `IRequestContext` member because
 * that interface is fully `readonly`: adding a `session` field would oblige
 * every producer — the kernel, the testing package's `createTestContext`, and
 * every hand-rolled double — to construct one, and would type it as present on
 * requests the middleware never touched.
 *
 * Re-exported from `@setu-ts/common`, where it is defined so the
 * multi-tenancy plugin's tenant-side tenant-binding compare (M101c, V8-7)
 * reads the same key; exactly one definition exists.
 */
export { SESSION_STATE_KEY };

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
    const raw = this.#readCookieValue(ctx.request.headers);

    if (raw !== undefined && raw !== '') {
      const restored = await this.#restore(raw, now);
      if (restored !== null) {
        return restored;
      }
    }

    return createSession(now, this.#config.maxAgeMs, this.#deps.uuid);
  }

  /**
   * Opens a session from a `Headers` object alone — the headers-only read for
   * non-HTTP entry points that have no request context to commit onto (a
   * WebSocket `onOpen` handler, an auth strategy reading a cookie).
   *
   * Read-only by contract: it runs the same envelope-open, snapshot-parse, and
   * store-read path as {@linkcode SessionService.load} but never advances the
   * session's `seen` stamp, never commits, and never writes to the store. It
   * returns `null` for every condition `load` treats as "no usable session" —
   * the cookie is absent or empty, the envelope cannot be opened, the snapshot
   * cannot be parsed, the absolute expiry or idle timeout has passed, or (on
   * the store strategy) the stored entry is gone.
   *
   * @param headers - The request headers to read the session cookie from
   * @returns A read-only {@linkcode SessionView}, or `null` when there is no usable session
   * @since 0.3.0
   */
  async fromHeaders(headers: Headers): Promise<SessionView | null> {
    const raw = this.#readCookieValue(headers);
    if (raw === undefined || raw === '') {
      return null;
    }

    const restored = await this.#restore(raw, this.#deps.now());
    if (restored === null) {
      return null;
    }

    return { id: restored.id, data: restored.toJSON() };
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
      ctx.response.appendHeader('set-cookie', this.#cookie(ctx, '', 0));
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
    const shouldCommit =
      session.isDirty || session.wasRegenerated || (refreshesIdleWindow && !session.isNew);
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

    const cookieHeld = this.#store !== undefined && isCookieHeld(session.toJSON());
    if (this.#store !== undefined && !cookieHeld && !session.wasStoreHeld && !session.isNew) {
      // A copied anonymous cookie must not know the promoted row's id. Avoid
      // regenerate(): this id has no row to revoke or regeneration to record.
      session.rotateId(this.#deps.uuid());
    }

    const snapshot = session.snapshot();
    const ttlMs = Math.max(snapshot.exp - now, 0);

    // On the store strategy the payload goes server-side and the cookie carries
    // only the id, which is why the same envelope stays well under any limit —
    // unless the session holds only reserved keys, in which case the cookie
    // carries them and no row is written (M113e, V9-46), so anonymous traffic
    // rendering forms does not grow the store.
    const payload =
      this.#store === undefined
        ? snapshot
        : cookieHeld
          ? { ...snapshot, held: 'cookie' as const }
          : { id: snapshot.id, data: {}, exp: snapshot.exp, seen: snapshot.seen };

    const sealed = await seal(
      this.#deps.subtle,
      this.#ring,
      JSON.stringify(payload),
      this.#deps.randomBytes,
    );
    const header = this.#cookie(ctx, sealed, Math.ceil(ttlMs / 1000));

    // Checked BEFORE the store write, so a rejected commit leaves no trace. The
    // reverse order persisted a row for a session whose cookie was never sent,
    // which would then be unreachable but still occupying its TTL.
    if (header.length > this.#config.maxCookieBytes) {
      throw new SessionTooLargeError(header.length, this.#config.maxCookieBytes);
    }

    if (this.#store !== undefined) {
      if (cookieHeld) {
        // Moving a stored session into the cookie (a logout clearing every
        // other key) deletes its row: otherwise a copy of the old id-only
        // cookie would keep restoring the signed-in data until its TTL.
        await this.#destroyStored(session.wasStoreHeld ? snapshot.id : null);
      } else {
        await this.#store.write(snapshot.id, snapshot.data, ttlMs);
      }
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
   * Reads the session cookie value from a `Headers` object.
   *
   * The single cookie read both entry points — {@linkcode SessionService.load}
   * and {@linkcode SessionService.fromHeaders} — delegate through, so the two
   * can never observe a differently-named cookie.
   */
  #readCookieValue(headers: Headers): string | undefined {
    return parseCookie(headers.get('cookie'))[this.#config.cookieName];
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

    if (this.#store === undefined) {
      return restoreSession(snapshot, now, this.#deps.uuid, this.#config.idleTimeoutMs);
    }

    if (snapshot.held === 'cookie') {
      // A cookie-held session (M113e, V9-46) has no row to read. It must hold
      // reserved keys only — `commit` never seals anything else this way, so
      // anything else is refused rather than trusted.
      if (!isCookieHeld(snapshot.data)) {
        return null;
      }
      return restoreSession(snapshot, now, this.#deps.uuid, this.#config.idleTimeoutMs);
    }

    const stored = await this.#store.read(snapshot.id);
    if (stored === null) {
      // Revoked or expired server-side. The cookie is authentic but the
      // session behind it is gone, so this must not restore.
      return null;
    }
    return restoreSession(
      { ...snapshot, data: stored },
      now,
      this.#deps.uuid,
      this.#config.idleTimeoutMs,
      true,
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
  #cookie(ctx: IRequestContext, value: string, maxAge: number): string {
    const c = this.#config;
    return serializeCookie(c.cookieName, value, {
      maxAge,
      path: c.cookiePath,
      sameSite: c.cookieSameSite,
      secure:
        c.cookieSecure === 'auto' ? requestOriginOf(ctx).protocol === 'https' : c.cookieSecure,
      httpOnly: c.cookieHttpOnly,
      ...(c.cookieDomain === undefined ? {} : { domain: c.cookieDomain }),
    });
  }
}
