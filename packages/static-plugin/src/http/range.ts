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
  rangeHeader?: string | undefined;
  /** The If-Range header value */
  ifRange?: string | undefined;
  /** The current ETag */
  etag?: string | undefined;
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
 * Supports single-byte-range forms: `bytes=start-end`, `bytes=start-`, and `bytes=-suffix`.
 * Multi-range headers (containing commas) return null so callers can fall through to a full 200.
 *
 * @param rangeHeader - The Range header value
 * @param size - The total file size
 * @returns The parsed range, or null if invalid or multi-range
 * @since 0.1.0
 */
export function parseRange(rangeHeader: string, size: number): ParsedRange | null {
  // Multi-range headers contain a comma and are ignored per RFC 9110 §7.1.6
  if (rangeHeader.includes(',')) {
    return null;
  }

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
    // An empty representation cannot satisfy any suffix range; without this the
    // result would be `{ start: 0, end: -1 }` and emit `Content-Range: bytes 0--1/0`.
    if (size === 0) {
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
  if (isNaN(end) || end < start) {
    return null;
  }

  // Clamp explicit end beyond EOF when start is satisfiable
  const clampedEnd = Math.min(end, size - 1);
  return { start, end: clampedEnd };
}

/**
 * Checks whether a Range header is syntactically valid but unsatisfiable
 * (e.g. start >= size). Returns false for multi-range headers (which contain
 * commas) and for malformed headers — callers should fall through to a full
 * 200 response in those cases.
 *
 * @param rangeHeader - The raw Range header value
 * @param size - The file size
 * @returns True if the range is unsatisfiable, false otherwise
 * @since 0.1.0
 */
export function isRangeUnsatisfiable(rangeHeader: string, size: number): boolean {
  // Multi-range headers contain a comma and are ignored (serve 200).
  if (rangeHeader.includes(',')) {
    return false;
  }
  const parsed = parseRange(rangeHeader, size);
  // parseRange returns null for both unsatisfiable AND malformed ranges.
  // We only treat it as unsatisfiable when the header matches the single-range
  // pattern but the offsets are out of bounds.
  const match = /^bytes=(\d*)-(\d*)$/.exec(rangeHeader);
  if (!match) {
    return false;
  }
  return parsed === null;
}

/**
 * Normalizes an ETag for comparison by stripping the weak indicator.
 *
 * @param etag - The ETag string
 * @returns The normalized ETag
 * @since 0.1.0
 */
function normalizeEtagForComparison(etag: string): string {
  return etag.startsWith('W/') ? etag.slice(2) : etag;
}

/**
 * Checks if a range request should be honored.
 *
 * If-Range semantics per RFC 7233 §3.2:
 * - If absent, honor the range.
 * - If present and matches the current ETag, honor the range.
 * - If present and does not match, serve the full file (200).
 * - Weak validators in If-Range are NOT honored (RFC 7233): only strong
 *   tags or date-form values authorize partial content.
 * - If no ETag is present, If-Range is ignored and the range is honored.
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

  // If-Range: if present, must match the current validator
  if (ifRange) {
    // If no ETag is present, If-Range is ignored per RFC 7233
    // "A recipient MUST ignore an If-Range header field received in a request
    // for a resource that does not have validators"
    if (!etag) {
      return true;
    }
    // If-Range with a weak tag must NOT authorize partial content (RFC 7233)
    if (ifRange.startsWith('W/')) {
      return false;
    }
    // If-Range is a strong tag — compare with weak comparison
    // (a strong If-Range matches both strong and weak ETags)
    return normalizeEtagForComparison(ifRange) === normalizeEtagForComparison(etag);
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
