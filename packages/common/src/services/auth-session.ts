/**
 * The signed-in principal contract, fulfilled by the AuthPlugin under
 * `CAPABILITIES.AUTH_SESSION`.
 *
 * One place records "this session is signed in as this principal". Before this
 * contract, every application wrote its own session key and read it back
 * through its own mapping, so an authentication feature that needed to create,
 * hold back, or promote that record had to duplicate the write. This is the one
 * contract that owns it.
 *
 * @module
 */

import type { IRequestContext } from '../http.ts';
import type { IPrincipal } from './auth.ts';

/**
 * How a session was authenticated, using the RFC 8176 `amr` (authentication
 * methods) values the framework emits today.
 *
 * - `'pwd'` — a password or other shared secret.
 * - `'otp'` — a one-time password, including a TOTP code from an authenticator.
 * - `'pop'` — proof-of-possession, a hardware-bound credential such as a
 *   passkey.
 * - `'fed'` — federation: the assertion came from an outside identity provider.
 *
 * @since 0.8.0
 */
export type AuthMethod = 'pwd' | 'otp' | 'pop' | 'fed';

/**
 * Parameters of {@linkcode IAuthSessionService.signIn}.
 *
 * @since 0.8.0
 */
export interface SignInOptions {
  /**
   * The authentication methods that produced this principal, recorded so a later
   * authorization decision or a second-factor check can read them. The record's
   * list is the only source: the authentication strategy overwrites any `amr`
   * the principal itself carried.
   */
  readonly methods: readonly AuthMethod[];
}

/**
 * The result of {@linkcode IAuthSessionService.signIn}.
 *
 * A single arm today. A milestone that adds a second factor widens it with a
 * "second factor required" arm, so a caller that has to branch on it is written
 * now and stays correct afterwards.
 *
 * @since 0.8.0
 */
export type SignInOutcome = { readonly status: 'signed-in' };

/**
 * The one owner of "who is signed in" for a session.
 *
 * Registered by `AuthPlugin` when its `signIn` option is configured. A password
 * login, a federated sign-in, a passkey assertion and a SAML assertion all
 * record their principal through {@linkcode IAuthSessionService.signIn}, and the
 * plugin's own authentication strategy reads that record back — so an
 * application needs no hand-written middleware to turn its session into a
 * principal.
 *
 * @example
 * ```typescript
 * import { CAPABILITIES, type IAuthSessionService } from '@setu-ts/common';
 *
 * const auth = ctx.services.get<IAuthSessionService>(CAPABILITIES.AUTH_SESSION);
 * await auth.signIn(ctx, principal, { methods: ['pwd'] });
 * ```
 * @since 0.8.0
 */
export interface IAuthSessionService {
  /**
   * Records `principal` as the signed-in identity of the request's session.
   *
   * The write happens inside the session, so it is committed by the session
   * middleware after the handler returns — the service never issues a
   * `Set-Cookie` itself. The session id is regenerated, because a session id a
   * caller planted before authentication must not survive into the
   * authenticated session (session fixation).
   *
   * Requires the session middleware to have run for this request; it throws
   * otherwise, exactly as {@linkcode ISessionService.from} does.
   *
   * @param ctx - The request context whose session signs in
   * @param principal - The identity to record
   * @param options - The methods that authenticated it
   * @returns Resolves once the record has been written
   * @throws {Error} If the session middleware did not run for this request
   */
  signIn(
    ctx: IRequestContext,
    principal: IPrincipal,
    options: SignInOptions,
  ): Promise<SignInOutcome>;

  /**
   * Reads the signed-in principal of the request's session, without running the
   * authentication strategy chain.
   *
   * @param ctx - The request context whose session is read
   * @returns The principal, or `null` when the session holds no identity
   * @throws {Error} If the session middleware did not run for this request
   */
  current(ctx: IRequestContext): IPrincipal | null;

  /**
   * Ends the signed-in session.
   *
   * **What is revoked depends on the session strategy**, and callers must know
   * which one they run. On the store strategy (`SessionPlugin({ store: … })`)
   * the stored entry is deleted, so a cookie copied before this call stops
   * authenticating immediately. On the default encrypted-cookie strategy there
   * is nothing server-side to delete: a cookie copied before sign-out keeps
   * authenticating until its `maxAge` expires, because the payload the cookie
   * carries is itself the session. Use the store strategy wherever sign-out has
   * to mean revocation.
   *
   * @param ctx - The request context whose session ends
   * @throws {Error} If the session middleware did not run for this request
   */
  signOut(ctx: IRequestContext): void;
}
