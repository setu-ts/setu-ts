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
  #discoveryAttemptAt: number | null = null;
  // Shared by the key-set path and the sign-in routes, so a burst of logins
  // cannot each fetch the document.
  #discoveryInflight: Promise<void> | null = null;
  #closed = false;
  readonly #controllers = new Set<AbortController>();

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
      // A caller whose cached set is still fresh and who did not ask for a
      // refresh never waits on someone else's: otherwise one forged-`kid`
      // token would park every valid request behind a slow or blocked fetch.
      if (fresh && !force) {
        return this.#usable();
      }
      await this.#inflight;
    } else if ((!fresh || force) && !this.#closed && this.#cooldownElapsed()) {
      this.#inflight = this.#refresh().finally(() => {
        this.#inflight = null;
      });
      await this.#inflight;
    }
    return this.#usable();
  }

  /**
   * Stops refreshing and aborts any fetch in flight, so an application stop
   * is not held open by a key-set request or its timeout timer. A cached set
   * stays usable for requests still draining.
   */
  close(): void {
    this.#closed = true;
    for (const controller of this.#controllers) {
      controller.abort();
    }
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
   * The cached OpenID Connect discovery document, fetched when absent or past
   * the key-set TTL, and checked against the configured issuer.
   *
   * Exposed so the sign-in routes (M100c) read the authorization, token, and
   * end-session endpoints from the SAME issuer-checked document that supplies
   * `jwks_uri` — otherwise a spoofed document could send a login one place and
   * a verification another. Returns `null` when the document cannot be read,
   * rather than throwing, so a provider outage answers a login failure instead
   * of a 500.
   *
   * @returns The document, or `null` when it could not be fetched or was rejected
   */
  async discovery(): Promise<Readonly<Record<string, unknown>> | null> {
    if (this.#closed) {
      return null;
    }
    try {
      await this.#ensureDiscovery();
    } catch (error) {
      this.#report(
        this.#issuer.name,
        error instanceof RefreshError ? error.message : 'discovery-fetch-failed',
      );
    }
    // A failed or cooled-down refresh keeps serving the last issuer-checked
    // document for as long as the keys it produced would stay usable.
    if (
      this.#discovery === null ||
      this.#runtime.hrtime() - this.#discoveryAt > this.#issuer.timings.maxStaleMs
    ) {
      return null;
    }
    return this.#discovery;
  }

  /**
   * Fetches the discovery document unless a fresh one is already held,
   * de-duplicating concurrent readers onto one request.
   */
  async #ensureDiscovery(): Promise<void> {
    const now = this.#runtime.hrtime();
    if (this.#discovery !== null && now - this.#discoveryAt < this.#issuer.timings.ttlMs) {
      return;
    }
    // Concurrent logins must not each fetch: one in-flight read is shared.
    if (this.#discoveryInflight !== null) {
      await this.#discoveryInflight;
      return;
    }
    // The login route is unauthenticated, so it gets the key set's cooldown:
    // during an outage a stream of logins cannot become a stream of fetches.
    if (
      this.#discoveryAttemptAt !== null &&
      now - this.#discoveryAttemptAt < this.#issuer.timings.minRefreshIntervalMs
    ) {
      if (this.#discovery === null) {
        throw new RefreshError('discovery-cooldown');
      }
      return;
    }
    this.#discoveryAttemptAt = now;
    this.#discoveryInflight = (async () => {
      const document = await this.#fetchJson(this.#issuer.discoveryUrl ?? '');
      // OpenID Connect Discovery §4.3: a mismatched issuer means a spoofed or
      // misrouted document.
      if (document.issuer !== this.#issuer.issuer) {
        throw new RefreshError('discovery-issuer-mismatch');
      }
      this.#discovery = document;
      this.#discoveryAt = this.#runtime.hrtime();
    })();
    try {
      await this.#discoveryInflight;
    } finally {
      this.#discoveryInflight = null;
    }
  }

  /**
   * Reads `jwks_uri` from the discovery document, fetching it when absent or
   * past the key-set TTL. The whole document is kept for later readers.
   */
  async #discover(): Promise<string> {
    await this.#ensureDiscovery();
    const jwksUri = this.#discovery?.jwks_uri;
    if (typeof jwksUri !== 'string' || !isAcceptableUrl(jwksUri)) {
      throw new RefreshError('discovery-jwks-uri-invalid');
    }
    return jwksUri;
  }

  async #fetchJson(url: string): Promise<Readonly<Record<string, unknown>>> {
    const controller = new AbortController();
    this.#controllers.add(controller);
    // Raced rather than trusted: an injected seam that ignores the signal would
    // otherwise hold a sign-in route (and the stop drain) open. The abort —
    // from the timer or from close() — settles the race either way.
    const aborted = Promise.withResolvers<never>();
    const onAbort = (): void => aborted.reject(new RefreshError('fetch-aborted'));
    controller.signal.addEventListener('abort', onAbort, { once: true });
    const timer = this.#runtime.setTimeout(
      () => controller.abort(),
      this.#issuer.timings.fetchTimeoutMs,
    );
    let response: { readonly status: number; readonly body: string };
    try {
      response = await Promise.race([
        this.#http.get(url, { signal: controller.signal, maxBytes: MAX_RESPONSE_BYTES }),
        aborted.promise,
      ]);
    } finally {
      // Detached before anything can abort later: a rejection of `aborted` after
      // the race settled would have no handler.
      controller.signal.removeEventListener('abort', onAbort);
      this.#runtime.clearTimeout(timer);
      this.#controllers.delete(controller);
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
