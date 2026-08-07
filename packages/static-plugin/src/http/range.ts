/**
 * Range request handling for static file serving.
 *
 * @module
 */

/**
 * Options for range request handling.
 *
 * @since 0.1.0
 */
export type RangeOptions = {
  /** The file size */
  size: number;
  /** The Range header value */
  rangeHeader?: string;
  /** The If-Range header value */
  ifRange?: string;
  /** The current ETag */
  etag?: string;
};

/**
 * Parsed range specification.
 *
 * @since 0.1.0
 */
export type ParsedRange = {
  /** Start byte (inclusive) */
  start: number;
  /** End byte (inclusive) */
  end: number;
};

/**
 * Parses a Range header value into a ParsedRange.
 *
 * @param rangeHeader - The Range header value
 * @param size - The total file size
 * @returns The parsed range, or null if invalid
 * @since 0.1.0
 */
export function parseRange(rangeHeader: string, size: number): ParsedRange | null {
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return null;
  }

  const [, startStr, endStr] = match;

  if (startStr === '' && endStr === '') {
    return null;
  }

  if (startStr === '') {
    // Suffix range: bytes=-500
    const suffixLength = parseInt(endStr, 10);
    if (isNaN(suffixLength) || suffixLength === 0) {
      return null;
    }
    const start = Math.max(0, size - suffixLength);
    return { start, end: size - 1 };
  }

  const start = parseInt(startStr, 10);
  if (isNaN(start) || start >= size) {
    return null;
  }

  if (endStr === '') {
    // Open-ended range: bytes=500-
    return { start, end: size - 1 };
  }

  const end = parseInt(endStr, 10);
  if (isNaN(end) || end < start || end >= size) {
    return null;
  }

  return { start, end };
}

/**
 * Checks if a range request should be honored.
 *
 * @param options - Range options
 * @returns True if the range should be honored
 * @since 0.1.0
 */
export function shouldHonourRange(options: RangeOptions): boolean {
  const { rangeHeader, ifRange, etag } = options;

  if (!rangeHeader) {
    return false;
  }

  // If-Range: if present and doesn't match ETag, serve full file
  if (ifRange && etag) {
    return ifRange === etag;
  }

  return true;
}

/**
 * Formats the Content-Range header for a range response.
 *
 * @param range - The parsed range
 * @param size - The total file size
 * @returns The Content-Range header value
 * @since 0.1.0
 */
export function formatContentRange(range: ParsedRange, size: number): string {
  return `bytes ${range.start}-${range.end}/${size}`;
}
