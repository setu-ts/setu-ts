/**
 * The verification core for a compact JWS signed by an outside issuer. Internal:
 * not exported from the package barrel.
 *
 * This is the one place that turns a provider's token into verified claims. Both
 * consumers use it: the `issuers` strategy (M100b — a bearer access token) and the
 * sign-in callback (M100c — an ID token from the same provider). Two copies of
 * algorithm selection, key selection and claim checks is how an ID token ends up
 * verified to a weaker standard than an access token from the same issuer.
 *
 * The order of checks is load-bearing and unchanged from M100b: the algorithm is
 * checked BEFORE any key is looked at, so `none` and every HMAC algorithm are
 * refused without touching the key set (the algorithm-confusion attack), and a
 * stream of forged `kid`s cannot turn requests into outbound fetches.
 *
 * @module
 */

import type { IRuntimeServices } from '@setu-ts/common';
import { decodeBase64Url } from '../utils/base64url.ts';
import type { IssuerAlgorithm } from '../interfaces/index.ts';
import type { Jwk, KeyRefusal } from './key-selection.ts';
import { checkAlgorithm, selectKey, SignatureVerifier } from './key-selection.ts';

/**
 * The key-set read the verifier needs. `IssuerKeySet` satisfies it, and a test
 * can supply one directly: the verifier must not depend on the cache's private
 * state, only on being handed usable keys or `null`.
 */
export interface KeySetReader {
  keys(force?: boolean): Promise<readonly Jwk[] | null>;
}

/** Claims whose signature and base validity have been established. */
export type VerifiedClaims = Readonly<Record<string, unknown>>;

/** The outcome: verified claims, or the fixed reason the token was refused. */
export type VerifyOutcome =
  | { readonly ok: true; readonly claims: VerifiedClaims }
  | { readonly ok: false; readonly reason: string };

/**
 * Decodes a base64url JSON object segment.
 *
 * @param segment - The header or payload segment
 * @returns The object, or `null` when it is not a JSON object
 */
export function decodeJsonSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/** Deps for {@linkcode JwtVerifier}: one issuer's verification standard. */
export interface JwtVerifierDeps {
  /** Where the issuer's keys come from, including its refetch cooldown. */
  readonly keySet: KeySetReader;
  readonly runtime: IRuntimeServices;
  readonly algorithms: ReadonlySet<IssuerAlgorithm>;
  /** The `aud` value that must appear in the token. */
  readonly audience: string;
  readonly clockToleranceSec: number;
}

const TEXT = new TextEncoder();

/**
 * Verifies a compact JWS against one issuer's key set and base claims.
 */
export class JwtVerifier {
  readonly #keySet: KeySetReader;
  readonly #runtime: IRuntimeServices;
  readonly #algorithms: ReadonlySet<IssuerAlgorithm>;
  readonly #audience: string;
  readonly #clockToleranceSec: number;
  readonly #signatureVerifier: SignatureVerifier;

  /**
   * @param deps - Key set, runtime, algorithm allowlist, audience, clock tolerance
   */
  constructor(deps: JwtVerifierDeps) {
    this.#keySet = deps.keySet;
    this.#runtime = deps.runtime;
    this.#algorithms = deps.algorithms;
    this.#audience = deps.audience;
    this.#clockToleranceSec = deps.clockToleranceSec;
    this.#signatureVerifier = new SignatureVerifier(deps.runtime.subtle);
  }

  /**
   * Verifies a token and returns its claims.
   *
   * Never throws: every failure is an `{ ok: false }` outcome carrying a fixed
   * reason code, never a value from the token.
   *
   * @param compact - The compact JWS (`header.payload.signature`)
   * @returns The verified claims, or the refusal reason
   */
  async verify(compact: string): Promise<VerifyOutcome> {
    const segments = compact.split('.');
    if (segments.length !== 3) {
      return { ok: false, reason: 'malformed-token' };
    }
    const header = decodeJsonSegment(segments[0]);
    if (header === null) {
      return { ok: false, reason: 'malformed-header' };
    }
    // Decoded here rather than after the signature check, so a payload that is
    // valid base64url but not a JSON object fails with a named reason instead of
    // leaving that branch reachable only by minting a valid signature over it.
    // Nothing decoded here is trusted: every claim read below happens after the
    // signature over these exact bytes has verified.
    const payload = decodeJsonSegment(segments[1]);
    if (payload === null) {
      return { ok: false, reason: 'malformed-payload' };
    }
    if (header.crit !== undefined) {
      return { ok: false, reason: 'crit-unsupported' };
    }
    const family = checkAlgorithm(header.alg, this.#algorithms);
    if (family === 'algorithm-refused' || family === 'algorithm-not-allowed') {
      return { ok: false, reason: family };
    }
    if (header.kid !== undefined && typeof header.kid !== 'string') {
      return { ok: false, reason: 'malformed-header' };
    }
    const kid = header.kid;

    let keys = await this.#keySet.keys();
    if (keys === null) {
      return { ok: false, reason: 'no-key-set' };
    }
    let selected: Jwk | KeyRefusal = selectKey(keys, family, kid);
    if (selected === 'no-matching-key' && kid !== undefined) {
      keys = await this.#keySet.keys(true);
      if (keys === null) {
        return { ok: false, reason: 'no-key-set' };
      }
      selected = selectKey(keys, family, kid);
    }
    if (typeof selected === 'string') {
      return { ok: false, reason: selected };
    }

    let signature: Uint8Array;
    try {
      signature = decodeBase64Url(segments[2]);
    } catch {
      return { ok: false, reason: 'malformed-signature' };
    }
    const signingInput = TEXT.encode(`${segments[0]}.${segments[1]}`);
    if (!await this.#signatureVerifier.verify(selected, family, signature, signingInput)) {
      return { ok: false, reason: 'bad-signature' };
    }

    const claimFailure = this.#checkClaims(payload);
    if (claimFailure !== null) {
      return { ok: false, reason: claimFailure };
    }
    return { ok: true, claims: Object.freeze(payload) };
  }

  #checkClaims(payload: Record<string, unknown>): string | null {
    const aud = payload.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(this.#audience)) {
      return 'audience-mismatch';
    }
    const now = this.#runtime.now() / 1000;
    const skew = this.#clockToleranceSec;
    const { exp, nbf, iat } = payload;
    if (typeof exp !== 'number' || !Number.isFinite(exp)) {
      return 'exp-missing';
    }
    if (now > exp + skew) {
      return 'expired';
    }
    if (nbf !== undefined && (typeof nbf !== 'number' || now + skew < nbf)) {
      return 'not-yet-valid';
    }
    if (iat !== undefined && (typeof iat !== 'number' || iat > now + skew)) {
      return 'issued-in-future';
    }
    return null;
  }
}
