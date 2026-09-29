/**
 * Per-issuer key-set cache: discovery, fetch, rotation and bounds. Internal.
 *
 * Every timing is on the MONOTONIC clock (`runtime.hrtime()`). An unknown `kid`
 * triggers at most one refetch per `minRefreshIntervalMs`, and concurrent
 * refreshes share one in-flight fetch, so a stream of forged `kid`s cannot turn
 * requests into outbound fetches. On failure the last good set stays usable for
 * `maxStaleMs` after it was last confirmed; beyond that it is dropped, so a key
 * the provider removed cannot keep authenticating while its endpoint is
 * unreachable.
 *
 * @module
 */

import type { IRuntimeServices } from '@setu-ts/common';
import type { IAuthHttp } from '../interfaces/index.ts';
import type { Jwk } from './key-selection.ts';
import type { CompiledIssuer } from './trusted-issuer.ts';
import { isAcceptableUrl } from './trusted-issuer.ts';

/** Largest key-set or discovery response accepted, in bytes. */
export const MAX_RESPONSE_BYTES = 64 * 1024;
/** Largest number of keys accepted in one key set. */
export const MAX_KEYS = 64;

/** Cached key-set state, as the health indicator reports it. */
export type KeySetState = 'current' | 'stale' | 'expired' | 'unfetched';

/** Reports one refresh failure. `reason` is a fixed code, never response data. */
export type RefreshFailureReporter = (issuer: string, reason: string) => void;

class RefreshError extends Error {}

/**
 * Key-set cache for one issuer.
 */
export class IssuerKeySet {
  readonly #issuer: CompiledIssuer;
  readonly #runtime: IRuntimeServices;
  readonly #http: IAuthHttp;
  readonly #report: RefreshFailureReporter;
  #keys: readonly Jwk[] | null = null;
  #confirmedAt = 0;
  #everFetched = false;
  #lastAttemptAt: number | null = null;
  #inflight: Promise<void> | null = null;
  #discovery: Readonly<Record<string, unknown>> | null = null;
  #discoveryAt = 0;

  /**
   * @param issuer - The compiled issuer entry
   * @param runtime - Runtime services (monotonic clock and timers)
   * @param http - Outbound HTTP seam
   * @param report - Refresh-failure reporter
   */
  constructor(
    issuer: CompiledIssuer,
    runtime: IRuntimeServices,
    http: IAuthHttp,
    report: RefreshFailureReporter,
  ) {
    this.#issuer = issuer;
    this.#runtime = runtime;
    this.#http = http;
    this.#report = report;
  }

  /**
   * The cached state, read without any I/O.
   *
   * @returns The state
   */
  state(): KeySetState {
    if (this.#keys === null) {
      return this.#everFetched ? 'expired' : 'unfetched';
    }
    const age = this.#runtime.hrtime() - this.#confirmedAt;
    if (age < this.#issuer.timings.ttlMs) {
      return 'current';
    }
    return age <= this.#issuer.timings.maxStaleMs ? 'stale' : 'expired';
  }

  /**
   * Returns the usable key set, refreshing first when it is past its TTL (or
   * when `force` is set, for an unknown `kid`) and the cooldown allows.
   *
   * @param force - Refresh even within the TTL, subject to the cooldown
   * @returns The keys, or `null` when no usable set exists
   */
  async keys(force = false): Promise<readonly Jwk[] | null> {
    const fresh = this.#keys !== null &&
      this.#runtime.hrtime() - this.#confirmedAt < this.#issuer.timings.ttlMs;
    if (this.#inflight !== null) {
      await this.#inflight;
    } else if ((!fresh || force) && this.#cooldownElapsed()) {
      this.#inflight = this.#refresh().finally(() => {
        this.#inflight = null;
      });
      await this.#inflight;
    }
    return this.#usable();
  }

  #usable(): readonly Jwk[] | null {
    if (this.#keys === null) {
      return null;
    }
    if (this.#runtime.hrtime() - this.#confirmedAt > this.#issuer.timings.maxStaleMs) {
      this.#keys = null;
      return null;
    }
    return this.#keys;
  }

  #cooldownElapsed(): boolean {
    return this.#lastAttemptAt === null ||
      this.#runtime.hrtime() - this.#lastAttemptAt >= this.#issuer.timings.minRefreshIntervalMs;
  }

  async #refresh(): Promise<void> {
    this.#lastAttemptAt = this.#runtime.hrtime();
    try {
      const jwksUri = this.#issuer.jwksUri ?? await this.#discover();
      const document = await this.#fetchJson(jwksUri);
      const keys = document.keys;
      if (!Array.isArray(keys)) {
        throw new RefreshError('key-set-malformed');
      }
      if (keys.length > MAX_KEYS) {
        throw new RefreshError('key-set-too-many-keys');
      }
      this.#keys = keys.filter((key): key is Jwk =>
        typeof key === 'object' && key !== null && !Array.isArray(key)
      );
      this.#confirmedAt = this.#runtime.hrtime();
      this.#everFetched = true;
    } catch (error) {
      this.#report(
        this.#issuer.name,
        error instanceof RefreshError ? error.message : 'key-set-fetch-failed',
      );
    }
  }

  /**
   * Reads `jwks_uri` from the discovery document, fetching it when absent or
   * past the key-set TTL. The whole document is kept for later readers.
   */
  async #discover(): Promise<string> {
    const now = this.#runtime.hrtime();
    if (this.#discovery === null || now - this.#discoveryAt >= this.#issuer.timings.ttlMs) {
      const document = await this.#fetchJson(this.#issuer.discoveryUrl ?? '');
      // OpenID Connect Discovery §4.3: a mismatched issuer means a spoofed or
      // misrouted document.
      if (document.issuer !== this.#issuer.issuer) {
        throw new RefreshError('discovery-issuer-mismatch');
      }
      this.#discovery = document;
      this.#discoveryAt = this.#runtime.hrtime();
    }
    const jwksUri = this.#discovery.jwks_uri;
    if (typeof jwksUri !== 'string' || !isAcceptableUrl(jwksUri)) {
      throw new RefreshError('discovery-jwks-uri-invalid');
    }
    return jwksUri;
  }

  async #fetchJson(url: string): Promise<Readonly<Record<string, unknown>>> {
    const controller = new AbortController();
    const timer = this.#runtime.setTimeout(
      () => controller.abort(),
      this.#issuer.timings.fetchTimeoutMs,
    );
    let response: { readonly status: number; readonly body: string };
    try {
      response = await this.#http.get(url, {
        signal: controller.signal,
        maxBytes: MAX_RESPONSE_BYTES,
      });
    } finally {
      this.#runtime.clearTimeout(timer);
    }
    if (response.status !== 200) {
      throw new RefreshError('http-status');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(response.body);
    } catch {
      throw new RefreshError('invalid-json');
    }
    if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
      throw new RefreshError('invalid-json');
    }
    return parsed as Readonly<Record<string, unknown>>;
  }
}
