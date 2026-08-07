/**
 * Conditional request handling (ETag, If-None-Match, If-Modified-Since).
 *
 * @module
 */

import type { StatResult } from '@setu-ts/common';

/**
 * Options for conditional request handling.
 *
 * @since 0.1.0
 */
export type ConditionalOptions = {
  /** Whether to generate ETags (default: true) */
  etag?: boolean;
  /** The stat result for the file */
  stat: StatResult;
  /** The If-None-Match header value */
  ifNoneMatch?: string;
  /** The If-Modified-Since header value */
  ifModifiedSince?: string;
};

/**
 * Computes the ETag for a file based on its stat result.
 *
 * @param stat - The file stat result
 * @returns The ETag string
 * @since 0.1.0
 */
export function computeETag(stat: StatResult): string {
  if (stat.mtime) {
    const mtimeMs = stat.mtime.getTime();
    return `W/"${stat.size}-${mtimeMs}"`;
  }
  return `W/"${stat.size}"`;
}

/**
 * Checks if a conditional request should result in a 304 Not Modified.
 *
 * @param options - Conditional request options
 * @returns True if the response should be 304
 * @since 0.1.0
 */
export function shouldReturn304(options: ConditionalOptions): boolean {
  const { etag = true, stat, ifNoneMatch, ifModifiedSince } = options;

  // If-None-Match takes precedence over If-Modified-Since (RFC 9110 §13.1.3)
  if (etag && ifNoneMatch) {
    const etag = computeETag(stat);
    // Handle wildcard and multiple values
    if (ifNoneMatch === '*') {
      return true;
    }
    const ifNoneMatchValues = ifNoneMatch.split(',').map((v) => v.trim());
    return ifNoneMatchValues.includes(etag);
  }

  if (ifModifiedSince && stat.mtime) {
    const modifiedSince = new Date(ifModifiedSince);
    // If-Modified-Since is only valid when If-None-Match is absent
    return stat.mtime.getTime() <= modifiedSince.getTime();
  }

  return false;
}
