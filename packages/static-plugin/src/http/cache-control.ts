/**
 * Cache-Control header resolution for static file serving.
 *
 * @module
 */

/**
 * Pattern to detect content-hashed filenames (e.g., index-a1b2c3d4.js).
 *
 * @since 0.1.0
 */
export const IMMUTABLE_PATTERN = /[.-][0-9a-f]{8,}\.[a-z0-9]+$/i;

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
  /** Custom cache control configuration */
  cacheControl?: string | ((relativePath: string) => string) | undefined;
};

/**
 * Resolves the Cache-Control header value for a given path.
 *
 * @param relativePath - The root-relative path
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
