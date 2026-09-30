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
  SignInOptions,
  SignInOutcome,
} from '@setu-ts/common';

/** The reserved session key holding the signed-in record. */
export const AUTH_SESSION_KEY = '__setu_auth_principal';

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

/** Deps for {@linkcode AuthSessionService}. */
export interface AuthSessionServiceDeps {
  /** Opens the session for a request; throws when the middleware did not run. */
  readonly sessionService: ISessionService;
  /** The wall-clock time in milliseconds. */
  readonly now: () => number;
}

/**
 * The plugin's `IAuthSessionService`.
 *
 * `signIn` writes the record and rotates the session id (a session id a caller
 * planted before authentication must not survive into the authenticated
 * session); `current` reads it back without running the strategy chain;
 * `signOut` destroys the session.
 */
export class AuthSessionService implements IAuthSessionService {
  readonly #sessionService: ISessionService;
  readonly #now: () => number;

  /**
   * @param deps - The session service and the clock
   */
  constructor(deps: AuthSessionServiceDeps) {
    this.#sessionService = deps.sessionService;
    this.#now = deps.now;
  }

  /**
   * Records `principal` as the session's identity and rotates the session id.
   *
   * @param ctx - The request context whose session signs in
   * @param principal - The identity to record
   * @param options - The methods that authenticated it
   * @returns `{ status: 'signed-in' }`
   * @throws {Error} If the session middleware did not run for this request
   */
  signIn(
    ctx: IRequestContext,
    principal: IPrincipal,
    options: SignInOptions,
  ): Promise<SignInOutcome> {
    // Not `async`, since nothing here awaits; the body is still wrapped so a
    // missing session middleware REJECTS rather than throwing synchronously out
    // of a method typed to return a promise (the M52b defect class).
    try {
      const session = this.#sessionService.from(ctx);
      const methods = (options?.methods ?? []).filter((method) => AUTH_METHODS.includes(method));
      const record: AuthSessionRecord = { principal, methods, at: this.#now() };
      session.set(AUTH_SESSION_KEY, record);
      // Rotation keeps the data (ISession.regenerate), so it runs after the write.
      session.regenerate();
      return Promise.resolve({ status: 'signed-in' });
    } catch (error) {
      return Promise.reject(error);
    }
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
