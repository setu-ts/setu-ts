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
import {
  AUTH_SESSION_KEY,
  parseAuthSessionRecord,
  verifyAuthSessionRecord,
} from '../sign-in/auth-session-service.ts';
import type { AuthSessionChecks } from '../sign-in/auth-session-service.ts';
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
  readonly #checks: AuthSessionChecks;

  /**
   * @param options - The session service, the optional per-request re-read and
   *   the optional session stamp
   */
  constructor(options: AuthSessionStrategyOptions) {
    this.#sessionService = options.sessionService;
    this.#checks = {
      ...(options.refreshPrincipal === undefined
        ? {}
        : { refreshPrincipal: options.refreshPrincipal }),
      ...(options.sessionStamp === undefined ? {} : { sessionStamp: options.sessionStamp }),
    };
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
    return verifyAuthSessionRecord(record, this.#checks);
  }
}
