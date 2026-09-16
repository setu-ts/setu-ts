/**
 * Cache-Control header resolution for static file serving.
 *
 * @module
 */

/**
 * Heuristic pattern to detect content-hashed filenames (e.g.,
 * `index-a1b2c3d4.js`, `entry.client-A9acsx54.js`).
 *
 * A segment after a `[.-]` separator that is base64url-shaped and at least 8
 * characters long is treated as a content hash only when it contains at least
 * one digit — requiring the digit keeps ordinary words like `production` from
 * acquiring an unrecoverable one-year `immutable` cache. The heuristic can
 * under-match (a hash with no digit and no hex shape) and over-match (an 8+
 * character run containing a digit). The run may span hyphens, so an
 * ISO-date suffix (`report-2024-01-15.pdf`) is excluded explicitly — a dated
 * file is republished at the same URL, and an unrecoverable one-year cache is
 * the worst outcome this heuristic can produce. Other over-matches remain
 * possible; pass an explicit `cacheControl` value or callback for a
 * deterministic policy on any directory holding files that are not
 * content-hashed.
 *
 * @since 0.1.0
 */
export const IMMUTABLE_PATTERN =
  /[.-](?![0-9]{4}-[0-9]{2}-[0-9]{2}\.)(?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i;

/**
 * Default immutable cache control for hashed assets.
 *
 * @since 0.1.0
 */
export const DEFAULT_IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Default mutable cache control for non-hashed assets.
 *
 * @since 0.1.0
 */
export const DEFAULT_MUTABLE = 'public, max-age=0, must-revalidate';

/**
 * Options for cache control resolution.
 *
 * @since 0.1.0
 */
export type CacheControlOptions = {
  /**
   * Custom cache control configuration. When a callback, it receives the FULL
   * leading-slash request path INCLUDING the `urlPrefix`
   * (e.g. `/assets/app-A9acsx54.js` for `urlPrefix: '/assets'`) — a cache
   * policy is about the URL the client caches under, so the served path is the
   * input, never the prefix-stripped server path and never the absolute
   * filesystem path. A directory request delivers its resolved index path
   * (`/index.html` under a root mount), so for a `root` that is a directory —
   * what `root` documents — the callback never receives the literal `'/'`.
   * (Point `root` at a FILE instead and a request for the mount root does
   * deliver `'/'`; that configuration is outside the option's contract and is
   * noted so the guarantee reads as scoped rather than absolute.) It is never
   * the `.br`/`.gz` sidecar path either, so a hashed asset keeps its policy
   * whichever encoding is negotiated.
   */
  cacheControl?: string | ((requestPath: string) => string) | undefined;
};

/**
 * Resolves the Cache-Control header value for a given path.
 *
 * @param requestPath - The full leading-slash request path, including
 *   `urlPrefix`, beginning with '/' — see {@linkcode CacheControlOptions}
 * @param options - Cache control options
 * @returns The Cache-Control header value
 * @since 0.1.0
 */
export function resolveCacheControl(
  requestPath: string,
  options: CacheControlOptions,
): string {
  const { cacheControl } = options;

  if (typeof cacheControl === 'string') {
    return cacheControl;
  }

  if (typeof cacheControl === 'function') {
    return cacheControl(requestPath);
  }

  // Default: immutable for hashed assets, mutable otherwise
  if (IMMUTABLE_PATTERN.test(requestPath)) {
    return DEFAULT_IMMUTABLE;
  }

  return DEFAULT_MUTABLE;
}
