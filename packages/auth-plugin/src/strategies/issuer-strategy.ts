/**
 * Authentication strategy for access tokens from an outside issuer. Internal:
 * built by `AuthPlugin` from `AuthPluginOptions.issuers`.
 *
 * Flow: header → unverified decode for `iss` only → configuration lookup →
 * algorithm allowlist → key filter → signature verify → claim checks →
 * `toPrincipal`. Nothing from the unverified payload is used except `iss` as a
 * lookup key into configuration. Every failure returns `null` so the chain
 * continues, and is reported with a fixed reason code — never the token.
 *
 * @module
 */

import type { IAuthStrategy, IPrincipal, IRequest, IRuntimeServices } from '@setu-ts/common';
import { decodeBase64Url } from '../utils/base64url.ts';
import type { Jwk, KeyRefusal } from '../issuers/key-selection.ts';
import { checkAlgorithm, selectKey, SignatureVerifier } from '../issuers/key-selection.ts';
import type { IssuerKeySet } from '../issuers/key-set-cache.ts';
import type { CompiledIssuer } from '../issuers/trusted-issuer.ts';

/** Reports why a token was refused. `reason` is a fixed code. */
export type TokenRefusalReporter = (issuer: string, reason: string) => void;

/** One configured issuer with its key-set cache. */
export interface IssuerBinding {
  readonly issuer: CompiledIssuer;
  readonly keySet: IssuerKeySet;
}

/** Options for {@link IssuerStrategy}. */
export interface IssuerStrategyOptions {
  readonly bindings: readonly IssuerBinding[];
  readonly runtime: IRuntimeServices;
  readonly report: TokenRefusalReporter;
  readonly header?: string;
  readonly scheme?: string;
}

const TEXT = new TextEncoder();

/**
 * Decodes a base64url JSON object segment.
 *
 * @param segment - The segment
 * @returns The object, or `null` when it is not a JSON object
 */
function decodeSegment(segment: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(new TextDecoder().decode(decodeBase64Url(segment)));
    return typeof value === 'object' && value !== null && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  } catch {
    return null;
  }
}

/**
 * Strategy verifying tokens against each configured issuer's published keys.
 */
export class IssuerStrategy implements IAuthStrategy {
  readonly name = 'issuers';
  readonly #byIssuer: ReadonlyMap<string, IssuerBinding>;
  readonly #runtime: IRuntimeServices;
  readonly #verifier: SignatureVerifier;
  readonly #report: TokenRefusalReporter;
  readonly #header: string;
  readonly #scheme: string;

  /**
   * @param options - Bindings, runtime, reporter, and the header/scheme to read
   */
  constructor(options: IssuerStrategyOptions) {
    this.#byIssuer = new Map(options.bindings.map((binding) => [binding.issuer.issuer, binding]));
    this.#runtime = options.runtime;
    this.#verifier = new SignatureVerifier(options.runtime.subtle);
    this.#report = options.report;
    this.#header = options.header ?? 'authorization';
    this.#scheme = (options.scheme ?? 'bearer').toLowerCase();
  }

  /**
   * Verifies a bearer token from a configured issuer.
   *
   * @param request - The incoming request
   * @returns The principal, or `null` to continue the chain
   */
  async authenticate(request: IRequest): Promise<IPrincipal | null> {
    const value = request.headers.get(this.#header);
    if (!value) {
      return null;
    }
    const parts = value.split(' ');
    if (parts.length !== 2 || parts[0].toLowerCase() !== this.#scheme || !parts[1]) {
      return null;
    }
    const segments = parts[1].split('.');
    if (segments.length !== 3) {
      return null;
    }
    const payload = decodeSegment(segments[1]);
    const iss = payload?.iss;
    if (payload === null || typeof iss !== 'string') {
      return null;
    }
    const binding = this.#byIssuer.get(iss);
    if (binding === undefined) {
      return null;
    }
    try {
      return await this.#verify(binding, segments, payload);
    } catch {
      this.#report(binding.issuer.name, 'verification-error');
      return null;
    }
  }

  async #verify(
    binding: IssuerBinding,
    segments: readonly string[],
    payload: Record<string, unknown>,
  ): Promise<IPrincipal | null> {
    const { issuer, keySet } = binding;
    const refuse = (reason: string): null => {
      this.#report(issuer.name, reason);
      return null;
    };

    const header = decodeSegment(segments[0]);
    if (header === null) {
      return refuse('malformed-header');
    }
    if (header.crit !== undefined) {
      return refuse('crit-unsupported');
    }
    const family = checkAlgorithm(header.alg, issuer.algorithms);
    if (family === 'algorithm-refused' || family === 'algorithm-not-allowed') {
      return refuse(family);
    }
    if (header.kid !== undefined && typeof header.kid !== 'string') {
      return refuse('malformed-header');
    }
    const kid = header.kid;

    let keys = await keySet.keys();
    if (keys === null) {
      return refuse('no-key-set');
    }
    let selected: Jwk | KeyRefusal = selectKey(keys, family, kid);
    if (selected === 'no-matching-key' && kid !== undefined) {
      keys = await keySet.keys(true);
      if (keys === null) {
        return refuse('no-key-set');
      }
      selected = selectKey(keys, family, kid);
    }
    if (typeof selected === 'string') {
      return refuse(selected);
    }

    let signature: Uint8Array;
    try {
      signature = decodeBase64Url(segments[2]);
    } catch {
      return refuse('malformed-signature');
    }
    const signingInput = TEXT.encode(`${segments[0]}.${segments[1]}`);
    if (!await this.#verifier.verify(selected, family, signature, signingInput)) {
      return refuse('bad-signature');
    }

    const claimFailure = this.#checkClaims(issuer, payload);
    if (claimFailure !== null) {
      return refuse(claimFailure);
    }
    return await issuer.toPrincipal(Object.freeze({ ...payload }));
  }

  #checkClaims(issuer: CompiledIssuer, payload: Record<string, unknown>): string | null {
    const aud = payload.aud;
    const audiences = Array.isArray(aud) ? aud : [aud];
    if (!audiences.includes(issuer.audience)) {
      return 'audience-mismatch';
    }
    const now = this.#runtime.now() / 1000;
    const skew = issuer.clockToleranceSec;
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
