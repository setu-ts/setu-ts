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
 * character word containing a digit); pass an explicit `cacheControl` value or
 * callback for a deterministic policy.
 *
 * @since 0.1.0
 */
export const IMMUTABLE_PATTERN = /[.-](?=[A-Za-z0-9_-]*[0-9])[A-Za-z0-9_-]{8,}\.[a-z0-9]+$/i;

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
   * Custom cache control configuration. When a callback, it receives the
   * leading-slash root-relative request path (e.g. `/assets/app-A9acsx54.js`).
   */
  cacheControl?: string | ((relativePath: string) => string) | undefined;
};

/**
 * Resolves the Cache-Control header value for a given path.
 *
 * @param relativePath - The root-relative path, beginning with '/'
 * @param options - Cache control options
 * @returns The Cache-Control header value
 * @since 0.1.0
 */
export function resolveCacheControl(
  relativePath: string,
  options: CacheControlOptions,
): string {
  const { cacheControl } = options;

  if (typeof cacheControl === 'string') {
    return cacheControl;
  }

  if (typeof cacheControl === 'function') {
    return cacheControl(relativePath);
  }

  // Default: immutable for hashed assets, mutable otherwise
  if (IMMUTABLE_PATTERN.test(relativePath)) {
    return DEFAULT_IMMUTABLE;
  }

  return DEFAULT_MUTABLE;
}
