/**
 * The Cloudflare Cache API handle, and the one place the platform global is
 * read.
 *
 * `caches.default` is a Cloudflare-specific global with no module to import, so
 * reading it inline would make the middleware untestable and would break on
 * Deno — where `caches` exists (the web Cache API) but `caches.default` does
 * not. One internal resolver keeps that read in a single unit-tested function
 * and lets every branch of the middleware be driven from a fake.
 *
 * @module
 */

/**
 * The subset of the platform's `Cache` this package calls.
 *
 * A real `caches.default` satisfies it structurally.
 *
 * **Scope is per-datacenter.** `caches.default` is the colo's own cache: a hit
 * rate measured in one location says nothing about another, and a `delete` does
 * not evict globally. It is an edge-latency optimisation, not a shared store —
 * for that, use `CAPABILITIES.CACHE` over KV.
 *
 * @since 0.2.0
 */
export interface ICacheApi {
  /**
   * Looks up a cached response.
   *
   * @param request - The cache key, as a `Request` or a URL string
   * @returns The cached response, or `undefined` on a miss
   */
  match(request: Request | string): Promise<Response | undefined>;
  /**
   * Stores a response.
   *
   * Throws on the platform's own refusals — a non-GET request, status 206,
   * `Vary: *`, or an uncleared `Set-Cookie` — which is why
   * `assessCacheability` checks first rather than letting this reject.
   *
   * @param request - The cache key
   * @param response - The response to store
   */
  put(request: Request | string, response: Response): Promise<void>;
  /**
   * Removes a cached response.
   *
   * @param request - The cache key
   * @returns `true` when an entry was removed
   */
  delete(request: Request | string): Promise<boolean>;
}

/** The shape of the global scope this resolver probes. */
interface CacheGlobal {
  readonly caches?: { readonly default?: unknown };
}

/**
 * Reads `caches.default` from the global scope.
 *
 * Returns `undefined` rather than throwing when the platform is not Cloudflare
 * Workers, so a middleware composed for several targets degrades to a
 * pass-through instead of failing to serve — the M24b runtime-gating precedent.
 *
 * @param scope - The global scope to probe; defaults to `globalThis`
 * @returns The Cache API handle, or `undefined` when it is not present
 * @internal
 */
export function resolveCacheApi(scope: unknown = globalThis): ICacheApi | undefined {
  const candidate = (scope as CacheGlobal).caches?.default;
  if (typeof candidate !== 'object' || candidate === null) return undefined;

  const record = candidate as Record<string, unknown>;
  // Checked member by member rather than trusting the name: Deno's `caches` is
  // a `CacheStorage` with no `default` at all, and a partial shim would fail
  // at the first call rather than here.
  const usable = typeof record.match === 'function' &&
    typeof record.put === 'function' &&
    typeof record.delete === 'function';

  return usable ? (candidate as ICacheApi) : undefined;
}
