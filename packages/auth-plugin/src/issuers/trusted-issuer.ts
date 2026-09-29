/**
 * Construction-time validation of `AuthPluginOptions.issuers`. Internal.
 *
 * Every refusal here is a configuration that would silently weaken
 * verification, so it throws when `AuthPlugin(...)` is called rather than
 * degrading at request time.
 *
 * @module
 */

import type { IPrincipal } from '@setu-ts/common';
import type { IssuerAlgorithm, TrustedIssuer } from '../interfaces/index.ts';
import { AuthPluginConfigurationError } from '../errors.ts';
import { SUPPORTED_ALGORITHMS } from './key-selection.ts';

/** Resolved key-set timings, in milliseconds. */
export interface KeySetTimings {
  readonly ttlMs: number;
  readonly minRefreshIntervalMs: number;
  readonly fetchTimeoutMs: number;
  readonly maxStaleMs: number;
}

/** A validated issuer entry with every default applied. */
export interface CompiledIssuer {
  readonly name: string;
  readonly issuer: string;
  readonly audience: string;
  /** Explicit JWKS URL, or `null` when discovery supplies it. */
  readonly jwksUri: string | null;
  /** Discovery document URL, or `null` for an explicit JWKS URL. */
  readonly discoveryUrl: string | null;
  readonly algorithms: ReadonlySet<IssuerAlgorithm>;
  readonly clockToleranceSec: number;
  readonly timings: KeySetTimings;
  readonly toPrincipal: (
    claims: Readonly<Record<string, unknown>>,
  ) => IPrincipal | null | Promise<IPrincipal | null>;
}

const DEFAULT_TIMINGS: KeySetTimings = {
  ttlMs: 10 * 60_000,
  minRefreshIntervalMs: 60_000,
  fetchTimeoutMs: 5_000,
  maxStaleMs: 24 * 60 * 60_000,
};

const DEFAULT_CLOCK_TOLERANCE_SEC = 30;
const MAX_TIMER_DELAY_MS = 2_147_483_647;
const MAX_CLOCK_TOLERANCE_SEC = 300;
const LOOPBACK_HOSTS: ReadonlySet<string> = new Set(['localhost', '127.0.0.1', '[::1]']);

/**
 * Whether a URL is `https`, or `http` on a loopback host.
 *
 * @param value - Candidate URL
 * @returns `true` when acceptable
 */
export function isAcceptableUrl(value: string): boolean {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return false;
  }
  if (url.protocol === 'https:') {
    return true;
  }
  return url.protocol === 'http:' && LOOPBACK_HOSTS.has(url.hostname);
}

/**
 * Builds the discovery URL, removing ONE terminating `/` from the issuer
 * (OpenID Connect Discovery §4), so an Auth0-style issuer ending in `/` does
 * not yield `…//.well-known`.
 *
 * @param issuer - The configured issuer
 * @returns The discovery document URL
 */
export function discoveryUrlFor(issuer: string): string {
  const base = issuer.endsWith('/') ? issuer.slice(0, -1) : issuer;
  return `${base}/.well-known/openid-configuration`;
}

function refuse(name: string, reason: string): never {
  throw new AuthPluginConfigurationError(`auth-plugin: issuers['${name}'] ${reason}`);
}

function timing(name: string, key: keyof KeySetTimings, value: number | undefined): number {
  if (value === undefined) {
    return DEFAULT_TIMINGS[key];
  }
  if (!Number.isFinite(value) || value <= 0) {
    refuse(name, `keySet.${key} must be a finite positive number`);
  }
  // `fetchTimeoutMs` becomes a timer delay; a delay above 2^31-1 overflows
  // and fires almost immediately, aborting every fetch.
  if (key === 'fetchTimeoutMs' && value > MAX_TIMER_DELAY_MS) {
    refuse(name, `keySet.fetchTimeoutMs must not exceed ${MAX_TIMER_DELAY_MS}`);
  }
  return value;
}

/**
 * Validates and compiles the issuer list.
 *
 * @param issuers - The configured issuers
 * @returns The compiled entries, in configuration order
 * @throws {AuthPluginConfigurationError} On a duplicate name or issuer, an
 *   empty audience, an unsupported algorithm, an out-of-range clock tolerance
 *   or timing, a `ttlMs` above `maxStaleMs`, or a URL that is neither `https` nor loopback `http`
 */
export function compileIssuers(issuers: readonly TrustedIssuer[]): readonly CompiledIssuer[] {
  const names = new Set<string>();
  const issuerValues = new Set<string>();
  return issuers.map((entry) => {
    const name = entry.name;
    if (typeof name !== 'string' || name.length === 0) {
      throw new AuthPluginConfigurationError('auth-plugin: every issuer needs a non-empty name');
    }
    if (names.has(name)) {
      refuse(name, 'duplicates another issuer name');
    }
    names.add(name);
    if (typeof entry.issuer !== 'string' || entry.issuer.length === 0) {
      refuse(name, 'needs a non-empty issuer');
    }
    if (issuerValues.has(entry.issuer)) {
      refuse(name, `duplicates the issuer '${entry.issuer}'`);
    }
    issuerValues.add(entry.issuer);
    if (typeof entry.audience !== 'string' || entry.audience.length === 0) {
      refuse(name, 'needs a non-empty audience');
    }
    if (typeof entry.toPrincipal !== 'function') {
      refuse(name, 'needs a toPrincipal function');
    }

    const algorithms = entry.algorithms ?? SUPPORTED_ALGORITHMS;
    if (algorithms.length === 0) {
      refuse(name, 'algorithms must not be empty');
    }
    for (const algorithm of algorithms) {
      if (!(SUPPORTED_ALGORITHMS as readonly string[]).includes(algorithm)) {
        refuse(
          name,
          `algorithm '${String(algorithm)}' is not supported (${SUPPORTED_ALGORITHMS.join(', ')})`,
        );
      }
    }

    const tolerance = entry.clockToleranceSec ?? DEFAULT_CLOCK_TOLERANCE_SEC;
    if (!Number.isFinite(tolerance) || tolerance < 0 || tolerance > MAX_CLOCK_TOLERANCE_SEC) {
      refuse(name, `clockToleranceSec must be a finite number in [0, ${MAX_CLOCK_TOLERANCE_SEC}]`);
    }

    let jwksUri: string | null = null;
    let discoveryUrl: string | null = null;
    if ('jwksUri' in entry.keys) {
      jwksUri = entry.keys.jwksUri;
      if (!isAcceptableUrl(jwksUri)) {
        refuse(name, 'keys.jwksUri must be https, or http on a loopback host');
      }
    } else if (entry.keys.discovery === true) {
      discoveryUrl = discoveryUrlFor(entry.issuer);
      if (!isAcceptableUrl(discoveryUrl)) {
        refuse(name, 'issuer must be an https URL, or http on a loopback host, for discovery');
      }
    } else {
      refuse(name, 'keys must be { jwksUri } or { discovery: true }');
    }

    const keySet = entry.keySet ?? {};
    const timings: KeySetTimings = {
      ttlMs: timing(name, 'ttlMs', keySet.ttlMs),
      minRefreshIntervalMs: timing(name, 'minRefreshIntervalMs', keySet.minRefreshIntervalMs),
      fetchTimeoutMs: timing(name, 'fetchTimeoutMs', keySet.fetchTimeoutMs),
      maxStaleMs: timing(name, 'maxStaleMs', keySet.maxStaleMs),
    };
    // A set still fresh by its TTL must never be past the stale cap, or the
    // cap drops it while no refresh is due and a valid token is refused.
    if (timings.ttlMs > timings.maxStaleMs) {
      refuse(name, 'keySet.ttlMs must not exceed keySet.maxStaleMs');
    }
    return {
      name,
      issuer: entry.issuer,
      audience: entry.audience,
      jwksUri,
      discoveryUrl,
      algorithms: new Set(algorithms),
      clockToleranceSec: tolerance,
      timings,
      toPrincipal: entry.toPrincipal,
    };
  });
}
