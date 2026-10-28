/**
 * The `auth-session` authentication strategy: turns a signed-in session into a
 * principal, with no hand-written middleware. Internal to the plugin: configured
 * through `AuthPluginOptions.signIn`, never barrel-exported.
 *
 * Before M100c an application that signed users in had to write its own
 * middleware to read its own session key and hand the kernel a principal (the
 * M100a composition gap). The record this strategy reads is the one
 * `IAuthSessionService` writes, so a password login, a federated sign-in, a
 * passkey assertion and a SAML assertion all authenticate the same way.
 *
 * @module
 */

import type {
  IAuthStrategy,
  IPrincipal,
  IRequest,
  ISessionService,
  SessionView,
} from '@setu-ts/common';
import type { RefreshPrincipal } from '../interfaces/index.ts';
import { AUTH_SESSION_KEY, parseAuthSessionRecord } from '../sign-in/auth-session-service.ts';
import type { AuthSessionRecord } from '../sign-in/auth-session-service.ts';
import { sessionStampMatches } from '../sign-in/session-stamp.ts';
import type { SessionStampCheck } from '../sign-in/session-stamp.ts';

/** Options for {@linkcode AuthSessionStrategy}. */
export interface AuthSessionStrategyOptions {
  /** Opens the session from request headers (read-only; never commits). */
  readonly sessionService: ISessionService;
  /**
   * Per-request re-read of the stored principal. Absent means the session
   * snapshot is trusted until it ends — roles revoked after sign-in stay in
   * force, which is why this is opt-in.
   */
  readonly refreshPrincipal?: RefreshPrincipal;
  /**
   * The session stamp (`signIn.sessionStamp`), compared after the principal is
   * resolved. Absent means no stamp is compared.
   */
  readonly sessionStamp?: SessionStampCheck;
}

/**
 * A principal carrying `amr` from the session record.
 *
 * The record's `methods` is the ONLY source: any `amr` the stored principal
 * itself carried is overwritten, so a provider that put `amr` in an ID token
 * cannot claim a stronger authentication than the plugin recorded.
 */
function withAmr(principal: IPrincipal, record: AuthSessionRecord): IPrincipal {
  // `amr` is placed AFTER the spread so it replaces any value the stored
  // principal carried, and the result is frozen so nothing downstream can
  // quietly upgrade the authentication method of an authenticated request.
  return Object.freeze({
    ...principal,
    claims: Object.freeze({
      ...(principal.claims ?? {}),
      amr: Object.freeze([...record.methods]),
    }),
  });
}

/**
 * Internal strategy authenticating a request from its session's signed-in record.
 *
 * Returns `null` — leaving the chain to continue — when the request carries no
 * usable session, when the session holds no record, when the record is
 * malformed, when `refreshPrincipal` returns `null` (revocation), or when the
 * user's session stamp no longer matches the one recorded at sign-in.
 */
export class AuthSessionStrategy implements IAuthStrategy {
  /** Strategy name for identification. */
  readonly name = 'auth-session';
  readonly credential = 'cookie' as const;
  readonly #sessionService: ISessionService;
  // `| undefined` explicitly: the project compiles with exactOptionalPropertyTypes,
  // so assigning an optional option to an optional field needs the wider type.
  readonly #refreshPrincipal: RefreshPrincipal | undefined;
  readonly #sessionStamp: SessionStampCheck | undefined;

  /**
   * @param options - The session service, the optional per-request re-read and
   *   the optional session stamp
   */
  constructor(options: AuthSessionStrategyOptions) {
    this.#sessionService = options.sessionService;
    this.#refreshPrincipal = options.refreshPrincipal;
    this.#sessionStamp = options.sessionStamp;
  }

  /**
   * Opens the session from the request's headers and resolves its principal.
   *
   * @param request - The incoming request
   * @returns The principal, or `null` when the session carries no usable identity
   */
  async authenticate(request: IRequest): Promise<IPrincipal | null> {
    const view: SessionView | null = await this.#sessionService.fromHeaders(request.headers);
    if (view === null) {
      return null;
    }
    const record = parseAuthSessionRecord(view.data[AUTH_SESSION_KEY]);
    if (record === null) {
      return null;
    }
    const principal = await this.#resolve(record);
    if (principal === null) {
      return null;
    }
    // The stamp is compared against the principal the request resolved, so a
    // `refreshPrincipal` that loaded the user can carry the stamp in a claim.
    // A mismatch, a throw or a malformed value makes the request anonymous.
    if (
      this.#sessionStamp !== undefined &&
      !(await sessionStampMatches(this.#sessionStamp, principal, record.stamp ?? null))
    ) {
      return null;
    }
    return withAmr(principal, record);
  }

  /** The record's principal, re-read through `refreshPrincipal` when configured. */
  async #resolve(record: AuthSessionRecord): Promise<IPrincipal | null> {
    if (this.#refreshPrincipal === undefined) {
      return record.principal;
    }
    // A re-read that throws is treated as "anonymous" rather than propagating:
    // a failing identity store must not turn every signed-in request into a 500,
    // and it must not fall back to the stale snapshot either — that would make
    // the revocation check fail open.
    try {
      return await this.#refreshPrincipal(record.principal);
    } catch {
      return null;
    }
  }
}
