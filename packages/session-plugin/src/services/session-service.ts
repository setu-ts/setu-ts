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
  ILogger,
  IRequestContext,
  ISession,
  ISessionService,
  ISessionStore,
  SessionView,
} from '@setu-ts/common';
import {
  CAPABILITIES,
  parseCookie,
  requestOriginOf,
  serializeCookie,
  SESSION_STATE_KEY,
} from '@setu-ts/common';

import type { KeyRing } from '../codec/crypto.ts';
import { open, seal } from '../codec/crypto.ts';
import { SessionMiddlewareMissingError, SessionTooLargeError } from '../errors.ts';
import type { ResolvedSessionConfig } from '../options.ts';
import type { Session } from './session.ts';
import { createSession, holdsOnlyReservedKeys, parseSnapshot, restoreSession } from './session.ts';

/**
 * Whether a session payload may be sealed into the cookie on the store
 * strategy (M113e, V9-46): it holds only the reserved keys, the form-CSRF token
 * and the tenant binding. Both exist to serve requests before anyone signs in,
 * and a store row behind them buys nothing — there is nothing to revoke in a
 * session holding only those. The first write of any other key moves the
 * session into the store. Pending sign-in secrets (`auth-plugin`'s state, nonce
 * and PKCE verifier) are deliberately NOT reserved: they stay server-side.
 */
const isCookieHeld = holdsOnlyReservedKeys;

/**
 * The two revocation marker kinds. `revoked` is written for a sign-out (`destroy()`, or a commit
 * that moves a stored session back into the cookie); `superseded` for the old id of a
 * `regenerate()`. A marker lives under its own id, `<kind>:<session id>`, so a racing commit to the
 * session id cannot overwrite it. Session ids are UUIDs and never contain `:`.
 */
type MarkerKind = 'revoked' | 'superseded';

/** The payload field a marker carries, so an empty or foreign row never counts as a marker. */
const MARKER_FIELD = '__setu_marker';

const MARKER_KINDS: readonly MarkerKind[] = ['revoked', 'superseded'];

/**
 * The prefix of a successor link, `successor:<old id>`, which a committed regeneration writes
 * naming the id it moved the session to. It lives under its own key, apart from the `superseded`
 * marker, so a failed regeneration's cleanup (which writes only the marker) cannot erase it.
 */
const SUCCESSOR_PREFIX = 'successor';

/** The field of a successor link naming the new id. */
const SUCCESSOR_FIELD = 'next';

/**
 * How much longer than `maxAge` a marker lives, so a store that rounds a TTL down to whole seconds
 * still keeps it for the whole window in which a request that loaded the session may commit.
 */
const MARKER_TTL_MARGIN_MS = 1000;

/** Whether an id is a marker id rather than a session id. */
function isMarkerId(id: string): boolean {
  return [...MARKER_KINDS, SUCCESSOR_PREFIX].some((kind) => id.startsWith(`${kind}:`));
}

/**
 * What a {@linkcode SessionService.commit} did: `'written'` (the session was persisted and its
 * cookie sent, or a destroy cleared it), `'refused'` (the session was revoked or superseded while
 * this request ran, or its row was gone; nothing was written and no cookie sent), or `'skipped'`
 * (nothing needed writing, or the policy declined the commit).
 * @since 0.14.0
 */
export type SessionCommitOutcome = 'written' | 'refused' | 'skipped';

/**
 * Which commits a response allows, computed by the session middleware from the response. Both
 * default to `true`. A response a shared cache may store sets both to `false`, so it carries no
 * session cookie for a commit that only refreshes the expiry or only stores a new session's
 * reserved keys (a CSRF mint, a tenant binding).
 * @since 0.14.0
 */
export interface SessionCommitPolicy {
  /** Allow a commit that only refreshes the session (`rolling` or `idleTimeoutMs`). */
  readonly refresh?: boolean;
  /** Allow committing a NEW session that holds only reserved keys. */
  readonly reservedOnlyNew?: boolean;
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
  /** When each store-held session was loaded, so a commit outliving every marker is refused. */
  readonly #loadedAt = new WeakMap<Session, number>();

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

    return { id: restored.id, data: restored.snapshot().data };
  }

  /**
   * Deletes the stored row a regeneration superseded, without committing the
   * session. The session middleware calls it when the request throws: the
   * new session is not written then, but a `regenerate()` is a revocation of
   * the old id (an auth-session stamp mismatch relies on it, M131b), and the old
   * row must not survive the throw. A no-op without a store or a regeneration.
   * A sign-in or second-factor step that regenerates and then throws therefore
   * also loses the pre-login stored session (fails closed; the user starts again).
   *
   * @param session - The request's session
   * @since 0.12.0
   */
  async revokeSuperseded(session: Session): Promise<void> {
    if (session.wasRegenerated && this.#hadRow(session)) {
      // A logout by `clear()` and `regenerate()` that then throws is still a sign-out.
      const signedOut = holdsOnlyReservedKeys(session.snapshot().data);
      await this.#revoke(session.loadedId, signedOut ? 'revoked' : 'superseded');
    }
  }

  /**
   * Writes the session back, when it needs writing.
   *
   * A clean session emits no header at all: committing on every request would
   * rewrite the cookie on pure reads and defeat downstream caching.
   *
   * On the store strategy a commit to a restored session checks the revocation
   * markers after its write and deletes its own write when the session was
   * signed out or superseded while this request ran, so an in-flight request
   * cannot undo a `destroy()` or `regenerate()`. A refused commit sends no
   * cookie.
   *
   * @param ctx - The request context
   * @param session - The session returned by {@linkcode SessionService.load}
   * @param policy - Which commits this response allows; both allowed when omitted
   * @returns What the commit did
   * @throws {SessionTooLargeError} If the serialized cookie exceeds the budget
   * @since 0.2.0
   */
  async commit(
    ctx: IRequestContext,
    session: Session,
    policy: SessionCommitPolicy = {},
  ): Promise<SessionCommitOutcome> {
    const store = this.#store;
    const source = this.#hadRow(session) ? session.loadedId : null;

    if (session.isDestroyed) {
      // Only the id the request restored from the store has a row. After a
      // `regenerate()` in this same request `session.id` is a new id that was
      // never written, and a new or cookie-held session has no row at all, so
      // neither gets a marker: anonymous `POST /logout` traffic writes nothing.
      if (source !== null) await this.#revoke(source, 'revoked');
      ctx.response.appendHeader('set-cookie', this.#cookie(ctx, '', 0));
      return 'written';
    }

    const rolling = this.#config.rolling;
    // An idle timeout has to be refreshed by activity to mean anything, and
    // `seen` only advances when this method commits. Without this, a user making
    // read-only requests inside the idle window never refreshes it and is signed
    // out while demonstrably active — so a configured idle timeout commits on
    // every request exactly as `rolling` does. It does NOT extend absolute
    // expiry; only `rolling` does that (see below).
    const refreshesIdleWindow = rolling || this.#config.idleTimeoutMs !== undefined;
    const changed = session.isDirty || session.wasRegenerated;
    if (!changed && !(refreshesIdleWindow && !session.isNew)) {
      return 'skipped';
    }
    if (!changed && policy.refresh === false) {
      return 'skipped';
    }
    if (
      session.isNew &&
      !session.wasRegenerated &&
      policy.reservedOnlyNew === false &&
      holdsOnlyReservedKeys(session.snapshot().data)
    ) {
      return 'skipped';
    }

    const now = this.#deps.now();
    // A marker lives at least `maxAgeMs` from its sign-out, which came after this request loaded the
    // session. A commit later than that could no longer see one, so it is refused outright.
    if (source !== null && now - (this.#loadedAt.get(session) ?? now) >= this.#config.maxAgeMs) {
      // A regeneration is still a revocation of the old id (an auth-session stamp relies on it),
      // and so is a sign-out that cleared every application key.
      if (session.wasRegenerated) {
        await this.revokeSuperseded(session);
      } else if (isCookieHeld(session.snapshot().data)) {
        await this.#revoke(source, 'revoked');
      }
      return this.#refused(ctx);
    }

    // A regeneration whose source was signed out while this request ran must
    // not carry that session's data to a fresh id.
    if (store !== undefined && session.wasRegenerated && source !== null) {
      if (await this.#hasMarker(source, ['revoked'])) {
        return this.#refused(ctx);
      }
    }

    session.touch(now);
    if (rolling) {
      session.extend(now + this.#config.maxAgeMs);
    }

    // The payload to persist. In `'changes'` mode a commit to the row this
    // request restored applies only this request's changes to the row as it is
    // now, so a concurrent request's keys survive; a missing row means the
    // session was revoked or expired, and the commit is refused.
    let data = session.snapshot().data;
    const mergesOntoRow =
      store !== undefined &&
      source !== null &&
      !session.wasRegenerated &&
      this.#config.storeCommit === 'changes';
    if (mergesOntoRow) {
      const current = await store.read(source);
      if (current === null) {
        return this.#refused(ctx);
      }
      data = session.applyChangesTo(current);
    }

    const cookieHeld = store !== undefined && isCookieHeld(data);
    if (store !== undefined && !cookieHeld && !session.wasStoreHeld && !session.isNew) {
      // A copied anonymous cookie must not know the promoted row's id. Avoid
      // regenerate(): this id has no row to revoke or regeneration to record.
      session.rotateId(this.#deps.uuid());
    }

    const snapshot = { ...session.snapshot(), data };
    const ttlMs = Math.max(snapshot.exp - now, 0);

    // On the store strategy the payload goes server-side and the cookie carries
    // only the id, which is why the same envelope stays well under any limit —
    // unless the session holds only reserved keys, in which case the cookie
    // carries them and no row is written (M113e, V9-46), so anonymous traffic
    // rendering forms does not grow the store.
    const payload =
      store === undefined
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

    if (store !== undefined) {
      if (session.wasRegenerated && source !== null) {
        // The old id is superseded — or, when this commit moves the session into
        // the cookie (a logout by `clear()` and `regenerate()`), revoked, so an
        // in-flight regeneration on the old cookie is refused too.
        if (cookieHeld) {
          await this.#revoke(source, 'revoked');
        } else {
          await this.#revoke(source, 'superseded', snapshot.id);
        }
      } else if (cookieHeld && source !== null) {
        // Moving a stored session into the cookie (a logout clearing every
        // other key) revokes its row: otherwise a copy of the old id-only
        // cookie would keep restoring the signed-in data until its TTL.
        await this.#revoke(source, 'revoked');
      }

      if (!cookieHeld) {
        await store.write(snapshot.id, snapshot.data, ttlMs);
        if (await this.#fenced(session, source, snapshot.id)) {
          return this.#refused(ctx);
        }
      }
    }

    ctx.response.appendHeader('set-cookie', header);
    return 'written';
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
    if (snapshot === null || isMarkerId(snapshot.id)) {
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

    const store = this.#store;
    const [stored, marked] = await Promise.all([
      store.read(snapshot.id),
      this.#config.restoreRevocationCheck
        ? this.#hasMarker(snapshot.id, MARKER_KINDS)
        : Promise.resolve(false),
    ]);
    if (stored === null || marked) {
      // Revoked or expired server-side. The cookie is authentic but the
      // session behind it is gone, so this must not restore.
      return null;
    }
    const restored = restoreSession(
      { ...snapshot, data: stored },
      now,
      this.#deps.uuid,
      this.#config.idleTimeoutMs,
      true,
    );
    if (restored !== null) {
      this.#loadedAt.set(restored, now);
    }
    return restored;
  }

  /** Whether the session was restored from a store row, which is the only kind a marker fences. */
  #hadRow(session: Session): boolean {
    return this.#store !== undefined && session.wasStoreHeld;
  }

  /**
   * Revokes a stored id: writes its marker FIRST, then deletes the row. A
   * marker that is written fences every later commit to the id even when the
   * delete then fails. A marker write that fails still attempts the delete and
   * then rethrows, so a sign-out never reports success with its marker missing.
   *
   * A committed regeneration also writes a successor link, `successor:<old>`,
   * naming its new id. A sign-out then reads its id's link and revokes the id
   * it names, and so on along the whole chain: a regeneration writes its link
   * before its fence reads `revoked`, and a sign-out writes `revoked` before
   * reading the link, so on a linearizable store one of them always sees the
   * other — the regeneration refuses, or the sign-out ends the new session. A
   * failed regeneration's cleanup writes only the `superseded` marker, never
   * the link. The link names one successor: when two requests regenerate the
   * same id and both commit, the later link overwrites the earlier, and a
   * sign-out racing both follows only the id the later one names.
   */
  async #revoke(
    id: string,
    kind: MarkerKind,
    successor?: string,
    visited: Set<string> = new Set(),
  ): Promise<void> {
    const store = this.#store!;
    const ttlMs = this.#config.maxAgeMs + MARKER_TTL_MARGIN_MS;
    visited.add(id);
    if (successor !== undefined) {
      // Before the marker, so the link exists whenever a sign-out can see the regeneration at all.
      await store.write(
        `${SUCCESSOR_PREFIX}:${id}`,
        { [MARKER_FIELD]: SUCCESSOR_PREFIX, [SUCCESSOR_FIELD]: successor },
        ttlMs,
      );
    }
    let fault: { readonly error: unknown } | undefined;
    try {
      await store.write(`${kind}:${id}`, { [MARKER_FIELD]: kind }, ttlMs);
    } catch (error) {
      fault = { error };
    }
    try {
      await store.destroy(id);
    } catch (error) {
      if (fault === undefined) throw error;
    }
    if (fault !== undefined) throw fault.error;
    if (kind === 'revoked') {
      // The whole chain: every link names a committed regeneration, so it is finite, and the
      // visited set stops a cycle a hostile or corrupt store could form.
      const next = await this.#successorOf(id);
      if (next !== undefined && !visited.has(next)) {
        await this.#revoke(next, 'revoked', undefined, visited);
      }
    }
  }

  /** The id a committed regeneration of `id` moved the session to, from its successor link. */
  async #successorOf(id: string): Promise<string | undefined> {
    const row = await this.#store!.read(`${SUCCESSOR_PREFIX}:${id}`);
    const next = row?.[SUCCESSOR_FIELD];
    return row?.[MARKER_FIELD] === SUCCESSOR_PREFIX && typeof next === 'string' && !isMarkerId(next)
      ? next
      : undefined;
  }

  /** Whether any of the given markers is present for `id`; a read fault propagates. */
  async #hasMarker(id: string, kinds: readonly MarkerKind[]): Promise<boolean> {
    const store = this.#store!;
    const rows = await Promise.all(kinds.map((kind) => store.read(`${kind}:${id}`)));
    return rows.some((row, index) => row !== null && row[MARKER_FIELD] === kinds[index]);
  }

  /**
   * The write-then-verify fence, run after a commit's row write: a write to
   * the restored id checks both markers of that id, and a regenerating write
   * checks that its source was not signed out meanwhile. When the check fails,
   * or the check itself throws, the commit deletes its own write.
   */
  async #fenced(session: Session, source: string | null, written: string): Promise<boolean> {
    if (source === null) {
      // A fresh id with no stored source: no other request can hold it.
      return false;
    }
    const kinds: readonly MarkerKind[] = session.wasRegenerated ? ['revoked'] : MARKER_KINDS;
    let marked: boolean;
    try {
      marked = await this.#hasMarker(source, kinds);
    } catch (error) {
      await this.#store!.destroy(written).catch(() => false);
      throw error;
    }
    // The read above saw every marker still alive when it ran. A marker lives at least `maxAgeMs`
    // past the load, so only a fence that finishes within that window has covered the write: a
    // commit that stalled past it (after its first age check) is refused too.
    const now = this.#deps.now();
    const stale = now - (this.#loadedAt.get(session) ?? now) >= this.#config.maxAgeMs;
    if (marked || stale) {
      await this.#store!.destroy(written);
    }
    return marked || stale;
  }

  /** A refused commit: no cookie, one `debug` line carrying no id. */
  #refused(ctx: IRequestContext): SessionCommitOutcome {
    if (ctx.services.has(CAPABILITIES.LOGGER)) {
      ctx.services
        .get<ILogger>(CAPABILITIES.LOGGER)
        .debug('session commit refused: the session was revoked or superseded during this request');
    }
    return 'refused';
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
