/**
 * The one owner of "who is signed in" for a session, fulfilling
 * `IAuthSessionService` under `CAPABILITIES.AUTH_SESSION`. Internal: built by
 * `AuthPlugin` when its `signIn` option is configured.
 *
 * The record lives in the session, so the session middleware commits it and this
 * service never issues a `Set-Cookie` itself. Storing it anywhere else — a
 * plugin-private key, an application's own key — is exactly the duplication this
 * contract exists to prevent: M100c–M100f each create, hold back, or promote the
 * same record.
 *
 * @module
 */

import type {
  AuthMethod,
  IAuthSessionService,
  IPrincipal,
  IRequestContext,
  ISessionService,
  PendingSignIn,
  SignInOptions,
  SignInOutcome,
} from '@setu-ts/common';

/** The reserved session key holding the signed-in record. */
export const AUTH_SESSION_KEY = '__setu_auth_principal';

/**
 * The reserved key naming the provider a federated sign-in came through, written
 * only for the provider configured for RP-initiated logout.
 */
export const RP_PROVIDER_SESSION_KEY = '__setu_auth_rp';

/** The reserved key holding the ID token, when `idTokenHint` is opted in. */
export const ID_TOKEN_SESSION_KEY = '__setu_auth_id_token';

/**
 * The reserved session key holding a pending second-factor record. Written by
 * `signIn` when the `mfa.required` option answers `true` and the methods hold
 * no second factor; consumed by the package's own verifiers through
 * {@linkcode promotePending}.
 */
export const PENDING_MFA_SESSION_KEY = '__setu_auth_pending_mfa';

/** The authentication methods the framework recognises (RFC 8176 `amr` values). */
const AUTH_METHODS: readonly AuthMethod[] = ['pwd', 'otp', 'pop', 'fed'];

/** What the session holds under {@linkcode AUTH_SESSION_KEY}. */
export interface AuthSessionRecord {
  /** The signed-in identity. */
  readonly principal: IPrincipal;
  /** The methods that produced it; the only source of the request's `amr`. */
  readonly methods: readonly AuthMethod[];
  /** When the sign-in happened, from `runtime.now()`, in milliseconds. */
  readonly at: number;
}

/**
 * Validates a stored record read from under {@linkcode AUTH_SESSION_KEY}.
 *
 * The payload survived a JSON round-trip and an application can clear or corrupt
 * the session key, so nothing is trusted: a malformed record reads as "not
 * signed in" rather than producing a principal with an `id` of the wrong type.
 *
 * Takes the raw payload rather than a session, so the same validator serves the
 * write-side service (which holds an `ISession`) and the authentication strategy
 * (which holds only a read-only `SessionView`).
 *
 * @param raw - Whatever is stored under the key, or `undefined`
 * @returns The record, or `null` when absent or malformed
 */
export function parseAuthSessionRecord(raw: unknown): AuthSessionRecord | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Partial<AuthSessionRecord>;
  const principal = candidate.principal;
  if (
    typeof principal !== 'object' ||
    principal === null ||
    Array.isArray(principal) ||
    typeof (principal as IPrincipal).id !== 'string'
  ) {
    return null;
  }
  if (!Array.isArray(candidate.methods)) {
    return null;
  }
  // Unknown method values are dropped rather than trusted: a bogus `amr` would
  // otherwise reach an authorization decision that checks for, say, `'pwd'`.
  const methods = (candidate.methods as readonly unknown[]).filter((method): method is AuthMethod =>
    typeof method === 'string' && AUTH_METHODS.includes(method as AuthMethod)
  );
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) {
    return null;
  }
  return { principal: principal as IPrincipal, methods, at: candidate.at };
}

/**
 * Validates a pending MFA record read from under {@linkcode PENDING_MFA_SESSION_KEY}.
 *
 * The same trust rules as {@linkcode parseAuthSessionRecord}: the payload
 * survived a JSON round-trip and an application can clear or corrupt the key.
 *
 * @param raw - Whatever is stored under the key, or `undefined`
 * @returns The record, or `null` when absent or malformed
 */
export function parsePendingMfaRecord(raw: unknown): PendingSignIn | null {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return null;
  }
  const candidate = raw as Partial<PendingSignIn>;
  const principal = candidate.principal;
  if (
    typeof principal !== 'object' ||
    principal === null ||
    Array.isArray(principal) ||
    typeof (principal as IPrincipal).id !== 'string'
  ) {
    return null;
  }
  if (!Array.isArray(candidate.methods)) {
    return null;
  }
  const methods = (candidate.methods as readonly unknown[]).filter((method): method is AuthMethod =>
    typeof method === 'string' && AUTH_METHODS.includes(method as AuthMethod)
  );
  if (typeof candidate.at !== 'number' || !Number.isFinite(candidate.at)) {
    return null;
  }
  return { principal: principal as IPrincipal, methods, at: candidate.at };
}

/** Deps for {@linkcode AuthSessionService}. */
export interface AuthSessionServiceDeps {
  /** Opens the session for a request; throws when the middleware did not run. */
  readonly sessionService: ISessionService;
  /** The wall-clock time in milliseconds. */
  readonly now: () => number;
  /**
   * The MFA policy: decides whether a second factor is required for a given
   * principal and set of methods. Absent means no second factor is ever
   * required.
   */
  readonly mfa?: {
    readonly required: (
      principal: IPrincipal,
      methods: readonly AuthMethod[],
    ) => boolean | Promise<boolean>;
    readonly pendingTtlMs: number;
  };
}

/**
 * The plugin's `IAuthSessionService`.
 *
 * `signIn` writes the record and rotates the session id (a session id a caller
 * planted before authentication must not survive into the authenticated
 * session); `current` reads it back without running the strategy chain;
 * `pending` reads the pending second-factor record; `signOut` destroys the
 * session.
 */
export class AuthSessionService implements IAuthSessionService {
  readonly #sessionService: ISessionService;
  readonly #now: () => number;
  readonly #mfa: AuthSessionServiceDeps['mfa'];

  /**
   * @param deps - The session service, clock, and optional MFA policy
   */
  constructor(deps: AuthSessionServiceDeps) {
    this.#sessionService = deps.sessionService;
    this.#now = deps.now;
    this.#mfa = deps.mfa;
  }

  /**
   * Records `principal` as the session's identity and rotates the session id.
   *
   * When the `mfa.required` option answers `true` and the methods hold no
   * second factor, the principal is stored in a pending record under
   * {@linkcode PENDING_MFA_SESSION_KEY} (NOT the signed-in key) and the
   * outcome is `{ status: 'second-factor-required' }`.
   *
   * @param ctx - The request context whose session signs in
   * @param principal - The identity to record
   * @param options - The methods that authenticated it
   * @returns `{ status: 'signed-in' }` or `{ status: 'second-factor-required' }`
   * @throws {Error} If the session middleware did not run for this request
   */
  async signIn(
    ctx: IRequestContext,
    principal: IPrincipal,
    options: SignInOptions,
  ): Promise<SignInOutcome> {
    const session = this.#sessionService.from(ctx);
    const methods = options.methods.filter((method) => AUTH_METHODS.includes(method));

    // Check the MFA policy: when it answers `true` and the methods hold no
    // second factor, hold the principal back in a pending record.
    if (this.#mfa !== undefined) {
      const hasSecondFactor = methods.some((m) => m === 'otp' || m === 'pop');
      if (!hasSecondFactor) {
        const required = await this.#mfa.required(principal, methods);
        if (required) {
          const pending: PendingSignIn = { principal, methods, at: this.#now() };
          session.set(PENDING_MFA_SESSION_KEY, pending);
          // Clear any prior signed-in record: the principal is NOT signed in.
          session.delete(AUTH_SESSION_KEY);
          session.delete(RP_PROVIDER_SESSION_KEY);
          session.delete(ID_TOKEN_SESSION_KEY);
          session.regenerate();
          return { status: 'second-factor-required' };
        }
      }
    }

    const record: AuthSessionRecord = { principal, methods, at: this.#now() };
    session.set(AUTH_SESSION_KEY, record);
    // Provider-session facts belong to the sign-in that wrote them. A later
    // sign-in in the same session (a password login after a federated one)
    // must not inherit them, or logout would end a provider session this
    // identity never had, carrying another sign-in's ID token.
    session.delete(RP_PROVIDER_SESSION_KEY);
    session.delete(ID_TOKEN_SESSION_KEY);
    // Clear any prior pending MFA record: a new sign-in supersedes it.
    session.delete(PENDING_MFA_SESSION_KEY);
    // Rotation keeps the data (ISession.regenerate), so it runs after the write.
    session.regenerate();
    return { status: 'signed-in' };
  }

  /**
   * Reads the session's signed-in principal without running the strategy chain.
   *
   * @param ctx - The request context whose session is read
   * @returns The principal, or `null` when the session holds no usable identity
   * @throws {Error} If the session middleware did not run for this request
   */
  current(ctx: IRequestContext): IPrincipal | null {
    const record = parseAuthSessionRecord(
      this.#sessionService.from(ctx).get(AUTH_SESSION_KEY),
    );
    return record?.principal ?? null;
  }

  /**
   * Reads the pending second-factor record, if one exists.
   *
   * @param ctx - The request context whose session is read
   * @returns The pending record, or `null` when none is stored
   * @throws {Error} If the session middleware did not run for this request
   */
  pending(ctx: IRequestContext): PendingSignIn | null {
    return parsePendingMfaRecord(
      this.#sessionService.from(ctx).get(PENDING_MFA_SESSION_KEY),
    );
  }

  /**
   * Ends the session.
   *
   * What that revokes depends on the session strategy: on the store strategy the
   * stored entry is deleted, so a cookie copied before this call stops
   * authenticating immediately; on the default encrypted-cookie strategy nothing
   * server-side exists to delete, so a copied cookie keeps authenticating until
   * its `maxAge`. The contract documents the same distinction.
   *
   * @param ctx - The request context whose session ends
   * @throws {Error} If the session middleware did not run for this request
   */
  signOut(ctx: IRequestContext): void {
    this.#sessionService.from(ctx).destroy();
  }
}

/** Deps for {@linkcode promotePending}. */
export interface PromotePendingDeps {
  /** Opens the session for a request. */
  readonly sessionService: ISessionService;
  /** The wall-clock time in milliseconds. */
  readonly now: () => number;
  /** How long a pending record may sit before it is refused, in milliseconds. */
  readonly pendingTtlMs: number;
}

/**
 * Promotes a pending second-factor record to the signed-in key.
 *
 * Internal: reached ONLY through the package's own verifiers
 * (`TotpService.completeSignIn`, 100e's ceremony). NOT exported from
 * `src/index.ts` — a public promotion call would let a caller decide what was
 * verified, and a caller-supplied `{ method, principalId }` is not evidence.
 *
 * Reads the pending record from the session, checks it is not expired, writes
 * the signed-in record with the appended method, regenerates the session id,
 * and deletes the pending record.
 *
 * @param ctx - The request context
 * @param method - The second-factor method to append (`'otp'` or `'pop'`)
 * @param deps - Session service, clock, and TTL
 * @returns `'signed-in'` on success, `'no-pending'` when nothing is pending or
 *   the record is expired
 */
export function promotePending(
  ctx: IRequestContext,
  method: AuthMethod,
  deps: PromotePendingDeps,
): 'signed-in' | 'no-pending' {
  const session = deps.sessionService.from(ctx);
  const pending = parsePendingMfaRecord(session.get(PENDING_MFA_SESSION_KEY));
  if (pending === null) {
    return 'no-pending';
  }
  const now = deps.now();
  if (now - pending.at > deps.pendingTtlMs) {
    // Expired: delete the stale record and refuse.
    session.delete(PENDING_MFA_SESSION_KEY);
    return 'no-pending';
  }
  const methods = [...pending.methods, method];
  const record: AuthSessionRecord = { principal: pending.principal, methods, at: now };
  session.set(AUTH_SESSION_KEY, record);
  session.delete(PENDING_MFA_SESSION_KEY);
  session.delete(RP_PROVIDER_SESSION_KEY);
  session.delete(ID_TOKEN_SESSION_KEY);
  session.regenerate();
  return 'signed-in';
}
