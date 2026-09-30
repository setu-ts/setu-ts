/**
 * Authentication strategy for access tokens from an outside issuer. Internal:
 * built by `AuthPlugin` from `AuthPluginOptions.issuers`.
 *
 * Flow: header → unverified decode for `iss` only → configuration lookup →
 * {@linkcode JwtVerifier}. Nothing from the unverified payload is used except
 * `iss` as a lookup key into configuration. Every failure returns `null` so the
 * chain continues, and is reported with a fixed reason code — never the token.
 *
 * The signature and claim checks live in `JwtVerifier`, shared with the sign-in
 * callback (M100c), so an ID token from a provider cannot be verified to a
 * different standard than an access token from that same provider.
 *
 * @module
 */

import type { IAuthStrategy, IPrincipal, IRequest, IRuntimeServices } from '@setu-ts/common';
import type { IssuerKeySet } from '../issuers/key-set-cache.ts';
import type { CompiledIssuer } from '../issuers/trusted-issuer.ts';
import { decodeJsonSegment, JwtVerifier } from '../issuers/jwt-verifier.ts';

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

/**
 * Strategy verifying tokens against each configured issuer's published keys.
 */
export class IssuerStrategy implements IAuthStrategy {
  readonly name = 'issuers';
  readonly #byIssuer: ReadonlyMap<string, IssuerBinding>;
  readonly #verifiers: ReadonlyMap<string, JwtVerifier>;
  readonly #report: TokenRefusalReporter;
  readonly #header: string;
  readonly #scheme: string;

  /**
   * @param options - Bindings, runtime, reporter, and the header/scheme to read
   */
  constructor(options: IssuerStrategyOptions) {
    this.#byIssuer = new Map(options.bindings.map((binding) => [binding.issuer.issuer, binding]));
    // One verifier per issuer: it owns the key-set reference, the algorithm
    // allowlist, the audience and the clock tolerance, so routing to the right
    // verifier is the same lookup that routes the token.
    this.#verifiers = new Map(
      options.bindings.map((binding) => [
        binding.issuer.issuer,
        new JwtVerifier({
          keySet: binding.keySet,
          runtime: options.runtime,
          algorithms: binding.issuer.algorithms,
          audience: binding.issuer.audience,
          clockToleranceSec: binding.issuer.clockToleranceSec,
        }),
      ]),
    );
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
    const compact = parts[1];
    const segments = compact.split('.');
    if (segments.length !== 3) {
      return null;
    }
    // `iss` is read unverified for exactly one purpose: choosing which
    // configured issuer verifies the token. It is never trusted as a fact.
    const payload = decodeJsonSegment(segments[1]);
    const iss = payload?.iss;
    if (payload === null || typeof iss !== 'string') {
      return null;
    }
    const binding = this.#byIssuer.get(iss);
    if (binding === undefined) {
      return null;
    }
    const verifier = this.#verifiers.get(iss);
    // `#byIssuer` and `#verifiers` are built from the same list, so this cannot
    // be undefined; guarded so a future edit that desynchronises them fails
    // closed (anonymous) rather than throwing inside the strategy chain.
    if (verifier === undefined) {
      return null;
    }

    // One try/catch around verification AND the application's mapping, exactly as
    // before the extraction: a throw anywhere in here must not escape into the
    // strategy chain, which would turn a refused token into a 500.
    try {
      const outcome = await verifier.verify(compact);
      if (outcome.ok === false) {
        this.#report(binding.issuer.name, outcome.reason);
        return null;
      }
      return await binding.issuer.toPrincipal(outcome.claims);
    } catch {
      this.#report(binding.issuer.name, 'verification-error');
      return null;
    }
  }
}
