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
  etag?: boolean | undefined;
  /** The stat result for the file */
  stat: StatResult;
  /** The If-None-Match header value */
  ifNoneMatch?: string | undefined;
  /** The If-Modified-Since header value */
  ifModifiedSince?: string | undefined;
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
 * If-None-Match takes precedence over If-Modified-Since per RFC 9110 §13.1.3.
 * If-Modified-Since is evaluated independently when ETag generation is disabled
 * and only when If-None-Match is absent.
 *
 * @param options - Conditional request options
 * @returns True if the response should be 304
 * @since 0.1.0
 */
export function shouldReturn304(options: ConditionalOptions): boolean {
  const { etag = true, stat, ifNoneMatch, ifModifiedSince } = options;

  // If-None-Match takes precedence over If-Modified-Since (RFC 9110 §13.1.3)
  if (etag && ifNoneMatch) {
    const computedEtag = computeETag(stat);
    // Handle wildcard and multiple values with weak comparison
    if (ifNoneMatch === '*') {
      return true;
    }
    const ifNoneMatchValues = ifNoneMatch.split(',').map((v) => v.trim());
    // Weak comparison: strip weak validator indicator if present
    const normalizeForComparison = (tag: string): string =>
      tag.startsWith('W/"') ? `"${tag.slice(3, -1)}"` : tag;
    const normalizedComputed = normalizeForComparison(computedEtag);
    return ifNoneMatchValues.some(
      (v) => normalizeForComparison(v) === normalizedComputed,
    );
  }

  // Reached only when If-None-Match is absent or ETags are disabled, so this
  // one block covers both cases — an earlier `!etag`-guarded copy was
  // byte-identical to this one and unreachable in any state this does not
  // already handle.
  if (ifModifiedSince && stat.mtime) {
    // Compare at whole-second precision (RFC 7232)
    const modifiedSince = new Date(ifModifiedSince);
    const mtimeSeconds = Math.floor(stat.mtime.getTime() / 1000);
    const sinceSeconds = Math.floor(modifiedSince.getTime() / 1000);
    return mtimeSeconds <= sinceSeconds;
  }

  return false;
}
