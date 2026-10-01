/**
 * The WebAuthn ceremonies: registration (plan §3.2), authentication (§3.3),
 * the passkey as a second factor (§3.4), and challenge handling (§3.5).
 * Internal: built by `AuthPlugin` when its `signIn.passkeys` option is
 * configured; the routes in `routes.ts` are thin adapters over this class.
 *
 * Every refusal is one of a small set of fixed reason codes — nothing a client
 * sent ever reaches a body, a URL, or a log line verbatim.
 *
 * @module
 */

import type {
  IAuthSessionService,
  IPrincipal,
  IRequestContext,
  IRuntimeServices,
  ISession,
  ISessionService,
} from '@setu-ts/common';
import type { IPasskeyStore, StoredPasskey } from '../stores/passkey-store.ts';
import type { PendingPromotion } from '../sign-in/auth-session-service.ts';
import { asPendingPromotion } from '../sign-in/auth-session-service.ts';
import { AuthPluginConfigurationError } from '../errors.ts';
import { decodeBase64Url, encodeBase64Url } from '../utils/base64url.ts';
import { decodeCbor } from './cbor.ts';
import { COSE_ALGORITHMS, coseAlgorithm, coseKeyToJwk } from './cose-key.ts';
import type { PasskeyAlgorithm } from './cose-key.ts';
import { parseAuthenticatorData } from './authenticator-data.ts';
import { concatBytes, derToRawSignature, verifyPasskeySignature } from './signature.ts';

export type { StoredPasskey };

/** The reserved session key holding the current WebAuthn challenge. */
export const WEBAUTHN_CHALLENGE_SESSION_KEY = '__setu_auth_webauthn';

/**
 * How long a challenge may sit before it is refused, in milliseconds, and the
 * `timeout` the options advertise: 300 000 ms (5 minutes).
 */
export const CHALLENGE_TTL_MS = 300_000;

/** The entropy of a challenge, in bytes. */
const CHALLENGE_BYTES = 32;

/** The byte length of the opaque per-principal user handle (plan §3.2). */
const USER_HANDLE_BYTES = 32;

/** Which ceremony a stored challenge belongs to. */
export type CeremonyKind = 'registration' | 'authentication';

/** What the session holds under {@linkcode WEBAUTHN_CHALLENGE_SESSION_KEY}. */
interface StoredChallenge {
  readonly kind: CeremonyKind;
  /** The base64url challenge. */
  readonly challenge: string;
  /** The user handle issued with a registration challenge, base64url. */
  readonly userHandle?: string;
  /** When the challenge lapses, from `runtime.now()`, in ms. */
  readonly expiresAt: number;
}

/** The `userVerification` policy values WebAuthn defines. */
export type UserVerification = 'required' | 'preferred' | 'discouraged';

/** A validated `signIn.passkeys` option, with every default applied. */
export interface CompiledPasskeys {
  /** The RP ID: the origin's host or a registrable suffix of it. */
  readonly rpId: string;
  /** The RP name shown to the user by the browser. */
  readonly rpName: string;
  /** The exact-match origin allowlist. */
  readonly origins: readonly string[];
  /** The credential store. */
  readonly store: IPasskeyStore;
  /** Resolves a credential's principal id; `null` refuses the sign-in. */
  readonly resolvePrincipal: (
    principalId: string,
  ) => IPrincipal | null | Promise<IPrincipal | null>;
  /** The user-verification policy. Defaults to `required`. */
  readonly userVerification: UserVerification;
}

/** The configured `signIn.passkeys` option (plan §3.6). */
export interface PasskeyOptions {
  /** The RP ID: the origin's host or a registrable suffix of it. */
  readonly rpId: string;
  /** The RP name shown to the user by the browser. */
  readonly rpName: string;
  /** The exact-match origin allowlist the ceremonies verify `clientDataJSON` against. */
  readonly origins: readonly string[];
  /** The credential store; see {@linkcode IPasskeyStore}. */
  readonly store: IPasskeyStore;
  /** Resolves a credential's stored principal id to a principal; `null` refuses. */
  readonly resolvePrincipal: (
    principalId: string,
  ) => IPrincipal | null | Promise<IPrincipal | null>;
  /** The user-verification policy. Defaults to `required`. */
  readonly userVerification?: UserVerification;
}

/** The reason a ceremony refused a response. Fixed codes, never client text. */
export type PasskeyRefusal =
  | 'malformed'
  | 'ceremony-type'
  | 'challenge-missing'
  | 'challenge-used'
  | 'origin-refused'
  | 'cross-origin'
  | 'rp-id-mismatch'
  | 'flags-refused'
  | 'algorithm-refused'
  | 'credential-duplicate'
  | 'credential-unknown'
  | 'user-handle-mismatch'
  | 'wrong-principal'
  | 'pending-missing'
  | 'signature-invalid'
  | 'counter-refused'
  | 'principal-refused'
  | 'sign-in-required';

/** The outcome of a registration verify. */
export type RegistrationOutcome =
  | { readonly ok: true; readonly credentialId: string }
  | { readonly ok: false; readonly reason: PasskeyRefusal };

/** The outcome of an authentication verify. */
export type AuthenticationOutcome =
  | { readonly ok: true; readonly status: 'signed-in' | 'second-factor-required' }
  | { readonly ok: false; readonly reason: PasskeyRefusal };

/** One entry of `pubKeyCredParams`. */
export interface PublicKeyCredentialParametersJson {
  readonly type: 'public-key';
  readonly alg: number;
}

/** One entry of `excludeCredentials` / `allowCredentials`. */
export interface PublicKeyCredentialDescriptorJson {
  readonly type: 'public-key';
  readonly id: string;
  readonly transports?: readonly string[];
}

/** The JSON the browser passes to `navigator.credentials.create()`. */
export interface RegistrationOptionsJson {
  readonly rp: { readonly id: string; readonly name: string };
  readonly user: { readonly id: string; readonly name: string; readonly displayName: string };
  readonly challenge: string;
  readonly pubKeyCredParams: readonly PublicKeyCredentialParametersJson[];
  readonly timeout: number;
  readonly attestation: 'none';
  readonly authenticatorSelection: {
    readonly residentKey: 'required';
    readonly requireResidentKey: boolean;
    readonly userVerification: UserVerification;
  };
  readonly excludeCredentials: readonly PublicKeyCredentialDescriptorJson[];
}

/** The JSON the browser passes to `navigator.credentials.get()`. */
export interface AuthenticationOptionsJson {
  readonly challenge: string;
  readonly rpId: string;
  readonly timeout: number;
  readonly userVerification: UserVerification;
  readonly allowCredentials: readonly PublicKeyCredentialDescriptorJson[];
}

function refuse(reason: string): never {
  throw new AuthPluginConfigurationError(`auth-plugin: signIn.passkeys ${reason}`);
}

/**
 * The loopback hostnames an `http` origin may use (the `isAcceptableUrl`
 * rule). The IPv6 loopback is deliberately excluded: an RP ID can never
 * contain a colon, so `http://[::1]` could never satisfy the host check and
 * admitting it would be a dead branch.
 */
function isLoopbackHost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1';
}

/**
 * Validates and compiles the `signIn.passkeys` option at construction, so
 * every refusal happens before an application exists rather than at the first
 * ceremony (plan §3.6).
 *
 * An origin must be `https`, or `http` on a loopback host, and carry no path,
 * query or fragment — it is compared against `clientDataJSON.origin` as an
 * exact string. An `rpId` must be the origin's host or a dot-boundary suffix
 * of it; without a public-suffix list the check cannot refuse `co.uk` for
 * `example.co.uk` and does not claim to — the browser refuses such an RP ID at
 * the ceremony.
 *
 * @param options - The configured value
 * @returns The compiled configuration, defaults applied
 * @throws {AuthPluginConfigurationError} On a malformed `rpId`, an empty
 *   `rpName`, an origin that is not https-or-loopback or carries a path, an
 *   `rpId` that is not a host or dot-boundary suffix of every origin's host, a
 *   store missing one of the port's methods, a non-function `resolvePrincipal`,
 *   or a `userVerification` outside the three defined values
 */
export function compilePasskeys(options: PasskeyOptions): CompiledPasskeys {
  if (typeof options.rpId !== 'string' || options.rpId.length === 0) {
    refuse('rpId must be a non-empty string');
  }
  const rpId = options.rpId.toLowerCase();
  if (/[/:\s]/.test(rpId)) {
    refuse('rpId must be a bare host, without a scheme, port or path');
  }
  if (typeof options.rpName !== 'string' || options.rpName.length === 0) {
    refuse('rpName must be a non-empty string');
  }
  if (!Array.isArray(options.origins) || options.origins.length === 0) {
    refuse('origins must be a non-empty array of origin strings');
  }
  const origins = options.origins.map((origin) => {
    if (typeof origin !== 'string') {
      refuse('origins must be an array of strings');
    }
    let parsed: URL;
    try {
      parsed = new URL(origin);
    } catch {
      refuse(`origin '${origin}' is not a URL`);
    }
    if (
      parsed.protocol !== 'https:' &&
      !(parsed.protocol === 'http:' && isLoopbackHost(parsed.hostname))
    ) {
      refuse(`origin '${origin}' must be https, or http on a loopback host`);
    }
    if (parsed.pathname !== '/' || parsed.search !== '' || parsed.hash !== '') {
      refuse(`origin '${origin}' must be a bare origin, without a path, query or fragment`);
    }
    return parsed.origin;
  });
  for (const origin of origins) {
    const host = new URL(origin).hostname;
    if (host !== rpId && !host.endsWith(`.${rpId}`)) {
      refuse(
        `rpId '${rpId}' must be the host of origin '${origin}' or a registrable suffix of it`,
      );
    }
  }
  const store = options.store;
  if (
    !(store instanceof Object) ||
    typeof store.listByPrincipal !== 'function' ||
    typeof store.findById !== 'function' ||
    typeof store.save !== 'function' ||
    typeof store.updateCounter !== 'function' ||
    typeof store.delete !== 'function' ||
    typeof store.claimChallenge !== 'function'
  ) {
    refuse('store must implement IPasskeyStore');
  }
  if (typeof options.resolvePrincipal !== 'function') {
    refuse('resolvePrincipal must be a function');
  }
  const userVerification = options.userVerification ?? 'required';
  if (
    userVerification !== 'required' && userVerification !== 'preferred' &&
    userVerification !== 'discouraged'
  ) {
    refuse("userVerification must be 'required', 'preferred' or 'discouraged'");
  }
  return {
    rpId,
    rpName: options.rpName,
    origins,
    store,
    resolvePrincipal: options.resolvePrincipal,
    userVerification,
  };
}

/** Deps for {@linkcode PasskeyCeremonies}. */
export interface PasskeyCeremonyDeps {
  /** The compiled `signIn.passkeys` option. */
  readonly config: CompiledPasskeys;
  /** Runtime services (entropy, clock, Web Crypto). */
  readonly runtime: IRuntimeServices;
  /** Opens the session for a request; the session middleware must have run. */
  readonly sessionService: ISessionService;
  /** The sign-in owner the ceremonies record and promote principals through. */
  readonly authSession: IAuthSessionService;
  /** Best-effort debug reporting; a throwing implementation is ignored. */
  readonly debug?: (message: string) => void;
}

/** Whether two byte strings are equal, length-first. */
function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  for (let i = 0; i < a.length; i++) {
    if (a[i] !== b[i]) {
      return false;
    }
  }
  return true;
}

/** SHA-256 over `data`, as bytes. */
async function sha256(runtime: IRuntimeServices, data: Uint8Array): Promise<Uint8Array> {
  return new Uint8Array(await runtime.subtle.digest('SHA-256', data as BufferSource));
}

/** Decodes a base64url field, mapping an invalid encoding to `null`. */
function decodeField(value: unknown): Uint8Array | null {
  if (typeof value !== 'string' || value.length === 0) {
    return null;
  }
  try {
    return decodeBase64Url(value);
  } catch {
    return null;
  }
}

/** Reads a string field from a parsed JSON body. */
function strField(body: Record<string, unknown>, key: string): string | null {
  const value = body[key];
  return typeof value === 'string' && value.length > 0 ? value : null;
}

/**
 * The WebAuthn ceremonies over one compiled configuration.
 *
 * A challenge is stored in the session under
 * {@linkcode WEBAUTHN_CHALLENGE_SESSION_KEY} with a 5-minute expiry, removed
 * from the session before verification, and ALSO claimed once in the
 * credential store (plan §3.5): on the default encrypted-cookie session
 * strategy an older cookie still carries a consumed challenge, and a synced
 * passkey's counter is always `0`, so the session alone cannot stop a
 * replayed assertion.
 */
export class PasskeyCeremonies {
  readonly #config: CompiledPasskeys;
  readonly #runtime: IRuntimeServices;
  readonly #sessionService: ISessionService;
  readonly #authSession: IAuthSessionService;
  readonly #debug: ((message: string) => void) | undefined;

  /**
   * Builds the ceremonies.
   *
   * @param deps - The compiled configuration, runtime, session service, sign-in owner, and reporter
   */
  constructor(deps: PasskeyCeremonyDeps) {
    this.#config = deps.config;
    this.#runtime = deps.runtime;
    this.#sessionService = deps.sessionService;
    this.#authSession = deps.authSession;
    this.#debug = deps.debug;
  }

  /** The compiled configuration, for the routes' path building and tests. */
  get config(): CompiledPasskeys {
    return this.#config;
  }

  /**
   * Reads the signed-in principal through the ceremonies' own sign-in owner,
   * for the register routes' admission check.
   *
   * @param ctx - The request context; the session middleware must have run
   * @returns The principal, or `null` when the session holds no identity
   */
  currentPrincipal(ctx: IRequestContext): IPrincipal | null {
    return this.#authSession.current(ctx);
  }

  #report(message: string): void {
    try {
      this.#debug?.(message);
    } catch {
      // A throwing logger must not abort a ceremony whose outcome is decided.
    }
  }

  /**
   * Reads, validates and removes the session's challenge record for `kind`.
   *
   * Removal happens BEFORE any verification, so a response can never be
   * verified twice against a challenge the session still holds.
   *
   * @returns The challenge, or `null` when absent, of the wrong kind, or expired
   */
  #takeChallenge(
    session: ISession,
    kind: CeremonyKind,
  ): { challenge: string; userHandle?: string } | null {
    const raw = session.get<unknown>(WEBAUTHN_CHALLENGE_SESSION_KEY);
    session.delete(WEBAUTHN_CHALLENGE_SESSION_KEY);
    if (typeof raw !== 'object' || raw === null) {
      return null;
    }
    const candidate = raw as Partial<StoredChallenge>;
    if (
      candidate.kind !== kind ||
      typeof candidate.challenge !== 'string' ||
      candidate.challenge.length === 0 ||
      typeof candidate.expiresAt !== 'number' ||
      !Number.isFinite(candidate.expiresAt) ||
      candidate.expiresAt <= this.#runtime.now()
    ) {
      return null;
    }
    return typeof candidate.userHandle === 'string'
      ? { challenge: candidate.challenge, userHandle: candidate.userHandle }
      : { challenge: candidate.challenge };
  }

  /**
   * Claims the challenge in the store after the session has given it up.
   *
   * @returns `false` when the claim is refused (already used)
   */
  #claim(challenge: string): Promise<boolean> {
    const expiresAt = this.#runtime.now() + CHALLENGE_TTL_MS;
    return this.#config.store.claimChallenge(challenge, this.#runtime.now(), expiresAt);
  }

  /**
   * Decodes and checks `clientDataJSON` (plan §3.2, §3.3): the ceremony type,
   * the challenge, the origin against the exact allowlist, and `crossOrigin`.
   *
   * @param clientDataJson - The base64url `clientDataJSON`
   * @param expectedType - The ceremony the response must carry
   * @param expectedChallenge - The base64url challenge this server issued
   * @returns The decoded JSON bytes (the authentication hash input), or the refusal
   */
  #checkClientData(
    clientDataJson: string,
    expectedType: 'webauthn.create' | 'webauthn.get',
    expectedChallenge: string,
  ): { ok: true; bytes: Uint8Array } | { ok: false; reason: PasskeyRefusal } {
    const bytes = decodeField(clientDataJson);
    if (bytes === null) {
      return { ok: false, reason: 'malformed' };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(new TextDecoder().decode(bytes));
    } catch {
      return { ok: false, reason: 'malformed' };
    }
    if (typeof parsed !== 'object' || parsed === null) {
      return { ok: false, reason: 'malformed' };
    }
    const clientData = parsed as Record<string, unknown>;
    if (clientData.type !== expectedType) {
      return { ok: false, reason: 'ceremony-type' };
    }
    if (clientData.challenge !== expectedChallenge) {
      return { ok: false, reason: 'challenge-missing' };
    }
    if (
      typeof clientData.origin !== 'string' || !this.#config.origins.includes(clientData.origin)
    ) {
      return { ok: false, reason: 'origin-refused' };
    }
    // An embedding iframe on another site would otherwise run the ceremony
    // (plan §3.2): only an absent or `false` `crossOrigin` passes.
    if (clientData.crossOrigin === true) {
      return { ok: false, reason: 'cross-origin' };
    }
    return { ok: true, bytes };
  }

  /** Compares `authenticatorData`'s RP ID hash against SHA-256 of the RP ID. */
  async #checkRpIdHash(authData: { rpIdHash: Uint8Array }): Promise<PasskeyRefusal | null> {
    const expected = await sha256(this.#runtime, new TextEncoder().encode(this.#config.rpId));
    return bytesEqual(authData.rpIdHash, expected) ? null : 'rp-id-mismatch';
  }

  /**
   * Builds the registration options (plan §3.2).
   *
   * The user handle is an opaque 32-byte value generated once per principal
   * and reused for every later credential, so a principal id used directly —
   * which could exceed WebAuthn's 64-byte limit or leak the id to the
   * authenticator — never reaches the client.
   *
   * @param ctx - The request context; the session middleware must have run
   * @returns The options, or `null` when no principal is signed in
   */
  async registrationOptions(ctx: IRequestContext): Promise<RegistrationOptionsJson | null> {
    const principal = this.#authSession.current(ctx);
    if (principal === null) {
      return null;
    }
    const session = this.#sessionService.from(ctx);
    const existing = await this.#config.store.listByPrincipal(principal.id);
    const userHandle = existing[0]?.userHandle ??
      encodeBase64Url(this.#runtime.randomBytes(USER_HANDLE_BYTES));
    const challenge = encodeBase64Url(this.#runtime.randomBytes(CHALLENGE_BYTES));
    session.set(
      WEBAUTHN_CHALLENGE_SESSION_KEY,
      {
        kind: 'registration',
        challenge,
        userHandle,
        expiresAt: this.#runtime.now() + CHALLENGE_TTL_MS,
      } satisfies StoredChallenge,
    );
    // A new options request replaces any prior challenge (plan §3.5); the
    // write above already replaced it.
    return {
      rp: { id: this.#config.rpId, name: this.#config.rpName },
      user: { id: userHandle, name: principal.id, displayName: principal.id },
      challenge,
      pubKeyCredParams: COSE_ALGORITHMS.map((alg) => ({ type: 'public-key' as const, alg })),
      timeout: CHALLENGE_TTL_MS,
      attestation: 'none',
      authenticatorSelection: {
        residentKey: 'required',
        requireResidentKey: true,
        userVerification: this.#config.userVerification,
      },
      excludeCredentials: existing.map((credential) => ({
        type: 'public-key' as const,
        id: credential.id,
        ...(credential.transports.length > 0 ? { transports: [...credential.transports] } : {}),
      })),
    };
  }

  /**
   * Verifies a registration response (plan §3.2).
   *
   * The attestation `fmt` is accepted in ANY value and its `attStmt` is never
   * read or trusted: requesting `attestation: 'none'` permits but does not
   * oblige the client to strip a statement, and refusing `packed`
   * self-attestation would refuse real users. The credential key always comes
   * from `authData`, and the stored credential records
   * `attestation: 'unverified'`.
   *
   * @param ctx - The request context; the session middleware must have run
   * @param body - The parsed JSON request body
   * @param principal - The signed-in principal registering the credential
   * @returns The credential id, or why the registration was refused
   */
  async verifyRegistration(
    ctx: IRequestContext,
    body: unknown,
    principal: IPrincipal,
  ): Promise<RegistrationOutcome> {
    if (typeof body !== 'object' || body === null) {
      return { ok: false, reason: 'malformed' };
    }
    const record = body as Record<string, unknown>;
    const response = record.response;
    if (typeof response !== 'object' || response === null) {
      return { ok: false, reason: 'malformed' };
    }
    const responseRecord = response as Record<string, unknown>;
    const clientDataJson = strField(responseRecord, 'clientDataJSON');
    const attestationObject = strField(responseRecord, 'attestationObject');
    if (clientDataJson === null || attestationObject === null) {
      return { ok: false, reason: 'malformed' };
    }

    const session = this.#sessionService.from(ctx);
    const taken = this.#takeChallenge(session, 'registration');
    if (taken === null) {
      return { ok: false, reason: 'challenge-missing' };
    }
    if (!(await this.#claim(taken.challenge))) {
      this.#report('auth-plugin: passkeys registration refused (challenge-used)');
      return { ok: false, reason: 'challenge-used' };
    }

    const clientData = this.#checkClientData(
      clientDataJson,
      'webauthn.create',
      taken.challenge,
    );
    if (clientData.ok === false) {
      this.#report(`auth-plugin: passkeys registration refused (${clientData.reason})`);
      return clientData;
    }

    const attestationBytes = decodeField(attestationObject);
    if (attestationBytes === null) {
      return { ok: false, reason: 'malformed' };
    }
    const attestation = decodeCbor(attestationBytes);
    if (attestation.ok === false || !(attestation.value instanceof Map)) {
      return { ok: false, reason: 'malformed' };
    }
    // `fmt` must be present and a string; ANY value is accepted (plan §3.2).
    const fmt = attestation.value.get('fmt');
    if (typeof fmt !== 'string') {
      return { ok: false, reason: 'malformed' };
    }
    const authDataBytes = attestation.value.get('authData');
    if (!(authDataBytes instanceof Uint8Array)) {
      return { ok: false, reason: 'malformed' };
    }
    const authData = parseAuthenticatorData(authDataBytes);
    if (
      authData === null ||
      !authData.attestedCredentialDataIncluded ||
      authData.credentialId === undefined ||
      authData.credentialPublicKey === undefined
    ) {
      return { ok: false, reason: 'malformed' };
    }
    const rpIdRefusal = await this.#checkRpIdHash(authData);
    if (rpIdRefusal !== null) {
      this.#report(`auth-plugin: passkeys registration refused (${rpIdRefusal})`);
      return { ok: false, reason: rpIdRefusal };
    }
    if (!authData.userPresent) {
      return { ok: false, reason: 'flags-refused' };
    }
    if (this.#config.userVerification === 'required' && !authData.userVerified) {
      return { ok: false, reason: 'flags-refused' };
    }
    const algorithm = coseAlgorithm(authData.credentialPublicKey);
    if (algorithm === null) {
      return { ok: false, reason: 'algorithm-refused' };
    }
    const jwk = coseKeyToJwk(authData.credentialPublicKey, algorithm);
    if (jwk === null) {
      return { ok: false, reason: 'malformed' };
    }
    const credentialId = encodeBase64Url(authData.credentialId);
    if ((await this.#config.store.findById(credentialId)) !== null) {
      return { ok: false, reason: 'credential-duplicate' };
    }
    if (taken.userHandle === undefined) {
      // A registration challenge always carries the user handle its options
      // issued; a session that lost it cannot attest which handle the
      // authenticator saw.
      return { ok: false, reason: 'malformed' };
    }
    const transports = readTransports(responseRecord.transports);
    const stored: StoredPasskey = {
      id: credentialId,
      principalId: principal.id,
      userHandle: taken.userHandle,
      publicKey: jwk,
      algorithm: coseAlgorithmOf(algorithm),
      counter: authData.signCounter,
      backedUp: authData.backedUp,
      transports,
      attestation: 'unverified',
      createdAt: this.#runtime.now(),
    };
    await this.#config.store.save(stored);
    return { ok: true, credentialId };
  }

  /**
   * Builds the authentication options (plan §3.3, §3.4).
   *
   * When a sign-in is pending, the options carry the pending principal's
   * credentials in `allowCredentials` — a hint to the browser only; the
   * server-side principal comparison at verify time is the check. Otherwise
   * the options are discoverable (an empty `allowCredentials`), for
   * username-less sign-in.
   *
   * @param ctx - The request context; the session middleware must have run
   * @returns The options
   */
  async authenticationOptions(ctx: IRequestContext): Promise<AuthenticationOptionsJson> {
    const session = this.#sessionService.from(ctx);
    const pending = this.#authSession.pending(ctx);
    let allowCredentials: readonly PublicKeyCredentialDescriptorJson[] = [];
    if (pending !== null) {
      const credentials = await this.#config.store.listByPrincipal(pending.principal.id);
      allowCredentials = credentials.map((credential) => ({
        type: 'public-key' as const,
        id: credential.id,
        ...(credential.transports.length > 0 ? { transports: [...credential.transports] } : {}),
      }));
    }
    const challenge = encodeBase64Url(this.#runtime.randomBytes(CHALLENGE_BYTES));
    session.set(
      WEBAUTHN_CHALLENGE_SESSION_KEY,
      {
        kind: 'authentication',
        challenge,
        expiresAt: this.#runtime.now() + CHALLENGE_TTL_MS,
      } satisfies StoredChallenge,
    );
    return {
      challenge,
      rpId: this.#config.rpId,
      timeout: CHALLENGE_TTL_MS,
      userVerification: this.#config.userVerification,
      allowCredentials,
    };
  }

  /**
   * Verifies an authentication response (plan §3.3, §3.4).
   *
   * With a pending sign-in the credential must belong to the pending
   * principal — `allowCredentials` is only a hint, so the comparison is
   * server-side — and success promotes the pending record with the `pop`
   * method. Without one, the assertion signs the user in username-less and
   * MUST carry user verification: without UV it proves possession alone, and
   * recording `pop` for it would satisfy `requireMfa()` with one factor.
   *
   * @param ctx - The request context; the session middleware must have run
   * @param body - The parsed JSON request body
   * @returns The sign-in outcome, or why the assertion was refused
   */
  async verifyAuthentication(ctx: IRequestContext, body: unknown): Promise<AuthenticationOutcome> {
    if (typeof body !== 'object' || body === null) {
      return { ok: false, reason: 'malformed' };
    }
    const record = body as Record<string, unknown>;
    const response = record.response;
    if (typeof response !== 'object' || response === null) {
      return { ok: false, reason: 'malformed' };
    }
    const responseRecord = response as Record<string, unknown>;
    const clientDataJson = strField(responseRecord, 'clientDataJSON');
    const authenticatorDataBase64 = strField(responseRecord, 'authenticatorData');
    const signatureBase64 = strField(responseRecord, 'signature');
    const credentialId = strField(record, 'id');
    if (
      clientDataJson === null ||
      authenticatorDataBase64 === null ||
      signatureBase64 === null ||
      credentialId === null
    ) {
      return { ok: false, reason: 'malformed' };
    }

    const session = this.#sessionService.from(ctx);
    const taken = this.#takeChallenge(session, 'authentication');
    if (taken === null) {
      return { ok: false, reason: 'challenge-missing' };
    }
    if (!(await this.#claim(taken.challenge))) {
      this.#report('auth-plugin: passkeys authentication refused (challenge-used)');
      return { ok: false, reason: 'challenge-used' };
    }

    const clientData = this.#checkClientData(
      clientDataJson,
      'webauthn.get',
      taken.challenge,
    );
    if (clientData.ok === false) {
      this.#report(`auth-plugin: passkeys authentication refused (${clientData.reason})`);
      return clientData;
    }

    const authDataBytes = decodeField(authenticatorDataBase64);
    const signatureBytes = decodeField(signatureBase64);
    if (authDataBytes === null || signatureBytes === null) {
      return { ok: false, reason: 'malformed' };
    }
    const authData = parseAuthenticatorData(authDataBytes);
    if (authData === null) {
      return { ok: false, reason: 'malformed' };
    }
    const rpIdRefusal = await this.#checkRpIdHash(authData);
    if (rpIdRefusal !== null) {
      this.#report(`auth-plugin: passkeys authentication refused (${rpIdRefusal})`);
      return { ok: false, reason: rpIdRefusal };
    }
    if (!authData.userPresent) {
      return { ok: false, reason: 'flags-refused' };
    }

    const pending = this.#authSession.pending(ctx);
    // A UV-less assertion proves possession alone: refused for username-less
    // sign-in, accepted only as the second factor after a first one (§3.3).
    if (pending === null && !authData.userVerified) {
      return { ok: false, reason: 'flags-refused' };
    }

    const credential = await this.#config.store.findById(credentialId);
    if (credential === null) {
      return { ok: false, reason: 'credential-unknown' };
    }
    const userHandleField = responseRecord.userHandle;
    if (
      userHandleField !== undefined &&
      userHandleField !== null &&
      userHandleField !== credential.userHandle
    ) {
      return { ok: false, reason: 'user-handle-mismatch' };
    }
    if (pending !== null && credential.principalId !== pending.principal.id) {
      // `allowCredentials` is only a hint to the browser; an attacker's own
      // authenticator can answer regardless, so the server-side comparison is
      // the check (plan §3.4).
      return { ok: false, reason: 'wrong-principal' };
    }

    const algorithmName = algorithmOf(credential.algorithm);
    if (algorithmName === null) {
      return { ok: false, reason: 'credential-unknown' };
    }
    const signedData = concatBytes(
      authDataBytes,
      await sha256(this.#runtime, clientData.bytes),
    );
    const rawSignature = algorithmName === 'ES256'
      ? derToRawSignature(signatureBytes)
      : signatureBytes;
    if (rawSignature === null) {
      return { ok: false, reason: 'signature-invalid' };
    }
    const verified = await verifyPasskeySignature(
      this.#runtime,
      algorithmName,
      credential.publicKey,
      signedData,
      rawSignature,
    );
    if (!verified) {
      this.#report('auth-plugin: passkeys authentication refused (signature-invalid)');
      return { ok: false, reason: 'signature-invalid' };
    }

    // Atomic compare-and-advance (plan §3.7): a `false` answer covers both a
    // counter that went backwards — a possible cloned authenticator, reported
    // as such — and a concurrent assertion that advanced it first.
    const advanced = await this.#config.store.updateCounter(credential.id, authData.signCounter);
    if (!advanced) {
      this.#report(
        'auth-plugin: passkeys authentication refused (counter-refused; possible cloned authenticator)',
      );
      return { ok: false, reason: 'counter-refused' };
    }

    if (pending !== null) {
      const promotion: PendingPromotion | null = asPendingPromotion(this.#authSession);
      if (promotion === null) {
        return { ok: false, reason: 'pending-missing' };
      }
      if (promotion.promotePending(ctx, 'pop') !== 'signed-in') {
        // The pending record expired between the options request and this
        // verification; the assertion itself was valid but there is nothing
        // left to complete.
        return { ok: false, reason: 'pending-missing' };
      }
      return { ok: true, status: 'signed-in' };
    }

    const principal = await this.#config.resolvePrincipal(credential.principalId);
    if (principal === null) {
      return { ok: false, reason: 'principal-refused' };
    }
    // `pop` (proof of possession), never `hwk`/`swk`: with attestation
    // unverified the plugin cannot know how the key is protected, and
    // `backedUp` says only whether the key syncs (plan §3.3).
    const outcome = await this.#authSession.signIn(ctx, principal, { methods: ['pop'] });
    return { ok: true, status: outcome.status };
  }
}

/** Maps a JWK algorithm name back to its COSE identifier. */
function coseAlgorithmOf(algorithm: PasskeyAlgorithm): number {
  if (algorithm === 'ES256') {
    return -7;
  }
  if (algorithm === 'RS256') {
    return -257;
  }
  return -8;
}

/** Maps a stored COSE algorithm identifier to its JWK name, or `null`. */
function algorithmOf(coseAlg: number): PasskeyAlgorithm | null {
  if (coseAlg === -7) {
    return 'ES256';
  }
  if (coseAlg === -257) {
    return 'RS256';
  }
  if (coseAlg === -8) {
    return 'EdDSA';
  }
  return null;
}

/** Reads the optional `transports` array, accepting only strings. */
function readTransports(value: unknown): readonly string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value.filter((item): item is string => typeof item === 'string');
}
