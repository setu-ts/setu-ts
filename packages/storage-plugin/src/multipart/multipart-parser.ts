/**
 * Zero-dependency multipart/form-data parser.
 *
 * Splits a raw `Uint8Array` body on the boundary extracted from the
 * `content-type` header, yielding `{ name, data, mimeType }` parts.
 *
 * @module
 */

/** A single parsed part from a multipart body. */
export interface ParsedPart {
  readonly name: string;
  readonly data: Uint8Array;
  readonly mimeType: string;
}

const CONTENT_TYPE_HEADER = 'Content-Type:';
const MIME_DEFAULT = 'application/octet-stream';

/**
 * Parses a `multipart/form-data` body into its constituent parts.
 *
 * @param body - The raw request bytes
 * @param contentType - The `content-type` header (must include `boundary=`)
 * @returns The parsed parts
 * @throws {Error} If no boundary is found in content-type
 */
export function parseMultipart(
  body: Uint8Array,
  contentType: string,
): ParsedPart[] {
  // Extract boundary from content-type header.
  const boundary = extractBoundary(contentType);
  if (boundary === null) {
    throw new Error('Missing boundary in content-type header');
  }

  // Build the boundary marker bytes.
  const boundaryBytes = new TextEncoder().encode(`--${boundary}`);
  const lastBoundaryBytes = new TextEncoder().encode(`--${boundary}--`);

  const parts: ParsedPart[] = [];
  let offset = 0;

  while (offset < body.length) {
    // Check for final boundary → done.
    if (tryMatch(body, offset, lastBoundaryBytes)) {
      break;
    }

    // Skip current boundary line + CRLF.
    offset += boundaryBytes.length;
    if (tryMatch(body, offset, new TextEncoder().encode('\r\n'))) {
      offset += 2;
    } else if (tryMatch(body, offset, new TextEncoder().encode('\n'))) {
      offset += 1;
    }

    // Check for next boundary → end of body.
    if (offset >= body.length) break;
    if (tryMatch(body, offset, boundaryBytes) || tryMatch(body, offset, lastBoundaryBytes)) {
      break;
    }

    // Parse headers until blank line (\r\n\r\n or \n\n).
    const headerEnd = findDoubleCrlf(body, offset);
    if (headerEnd === -1) break;

    const headerBlock = body.slice(offset, headerEnd);
    const headers = parseHeaders(headerBlock);
    const name = headers.name ?? 'unknown';
    const mimeType = headers.mime ?? MIME_DEFAULT;

    // Content ends at next boundary.
    // headerEnd points to the first \r of \r\n\r\n; data starts 4 bytes later.
    const dataStart = headerEnd + 4;
    const nextBoundary = findNextBoundary(body, dataStart, boundaryBytes, lastBoundaryBytes);
    if (nextBoundary === -1) break;

    // Strip trailing \r\n before next boundary.
    const dataEnd = nextBoundary - 2;
    const partData = body.slice(dataStart, dataEnd > dataStart ? dataEnd : dataStart);

    parts.push({ name, data: partData, mimeType });
    offset = nextBoundary;
  }

  return parts;
}

/** Extracts the boundary parameter from a content-type header. */
function extractBoundary(contentType: string): string | null {
  const match = contentType.match(/boundary=(["']?)(.+)\1/);
  return match ? match[2] : null;
}

/** Checks if `body` at `offset` starts with `prefix`. */
function tryMatch(body: Uint8Array, offset: number, prefix: Uint8Array): boolean {
  if (offset + prefix.length > body.length) return false;
  for (let i = 0; i < prefix.length; i++) {
    if (body[offset + i] !== prefix[i]) return false;
  }
  return true;
}

/** Finds the double-CRLF separator within `body` starting at `offset`. */
function findDoubleCrlf(body: Uint8Array, offset: number): number {
  const crlf = new Uint8Array([13, 10, 13, 10]);
  const lfLf = new Uint8Array([10, 10]);
  let pos = body.indexOf(crlf[0], offset);
  while (pos !== -1) {
    if (tryMatch(body, pos, crlf)) return pos;
    if (tryMatch(body, pos, lfLf)) return pos;
    pos = body.indexOf(crlf[0], pos + 1);
  }
  return -1;
}

/** Parses header lines into { name, mime }. */
function parseHeaders(block: Uint8Array): { name?: string; mime?: string } {
  const text = new TextDecoder().decode(block);
  const result: { name?: string; mime?: string } = {};

  for (const line of text.split('\r\n').filter(Boolean)) {
    const trimmed = line.trim();
    // Extract name from Content-Disposition header: look for name="..." anywhere in the line
    if (trimmed.includes('Content-Disposition')) {
      const nameMatch = trimmed.match(/name="([^"]*)"/);
      if (nameMatch) {
        result.name = nameMatch[1];
      }
    }
    if (trimmed.startsWith(CONTENT_TYPE_HEADER)) {
      result.mime = trimmed.slice(CONTENT_TYPE_HEADER.length).trim();
    }
  }

  return result;
}

/** Finds the next boundary marker starting at `offset`. */
function findNextBoundary(
  body: Uint8Array,
  offset: number,
  boundary: Uint8Array,
  lastBoundary: Uint8Array,
): number {
  let pos = body.indexOf(boundary[0], offset);
  while (pos !== -1) {
    if (tryMatch(body, pos, boundary) || tryMatch(body, pos, lastBoundary)) {
      return pos;
    }
    pos = body.indexOf(boundary[0], pos + 1);
  }
  return -1;
}
