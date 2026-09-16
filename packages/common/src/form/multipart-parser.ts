/**
 * Zero-dependency multipart/form-data parser.
 *
 * Splits a raw `Uint8Array` body on the boundary extracted from the
 * `content-type` header, yielding `{ name, data, mimeType }` parts.
 *
 * @module
 */

import { parseContentType } from './content-type.ts';

/**
 * A single parsed part from a multipart body.
 */
export interface ParsedPart {
  /**
   * The form field name, from the Content-Disposition `name` parameter in
   * either its quoted (`name="…"`) or unquoted (`name=x`) form — the parameter
   * NAME is matched case-insensitively. A part whose Content-Disposition
   * carries no `name` parameter at all is DROPPED by {@linkcode parseMultipart}
   * rather than renamed; `name=""` (a quoted empty value) is a defined name and
   * is kept.
   */
  readonly name: string;
  /**
   * The client-provided file name (Content-Disposition `filename`), when
   * present — in either its quoted or unquoted form. Presence of this member
   * is what makes a part a file rather than a text field.
   */
  readonly filename?: string;
  readonly data: Uint8Array;
  readonly mimeType: string;
}

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
    const mimeType = headers.mime ?? MIME_DEFAULT;
    const filename = headers.filename;

    // Content ends at next boundary.
    // headerEnd points to the first \r of \r\n\r\n; data starts 4 bytes later.
    const dataStart = headerEnd + 4;
    const nextBoundary = findNextBoundary(body, dataStart, boundaryBytes, lastBoundaryBytes);
    if (nextBoundary === -1) break;

    // Strip the line break that belongs to the delimiter, which is 2 bytes for
    // a CRLF body and 1 for a bare-LF one.
    const dataEnd = nextBoundary - precedingLineBreakLength(body, nextBoundary);
    const partData = body.slice(dataStart, dataEnd > dataStart ? dataEnd : dataStart);

    // A part with no usable name is DROPPED, not renamed (M95c §3.4/§3.5). The
    // platform discards a nameless part; the previous `'unknown'` sentinel was
    // a REAL field name, so a nameless part collided with a legitimate
    // `unknown` field and a part whose header failed to parse was
    // indistinguishable from a field of that name. `name=""` is a defined
    // (empty) name and is kept; only an ABSENT `name` parameter drops.
    if (headers.name !== undefined) {
      // Omit `filename` when absent (exactOptionalPropertyTypes forbids `undefined`).
      parts.push(
        filename !== undefined
          ? { name: headers.name, filename, data: partData, mimeType }
          : { name: headers.name, data: partData, mimeType },
      );
    }
    offset = nextBoundary;
  }

  return parts;
}

/**
 * Extracts the `boundary` parameter through the SAME parse the classifier
 * reads, so `formEncodingOf` cannot promise a parse this function then refuses
 * (M94b review). The previous regex matched `boundary=` anywhere in the raw
 * header, so `xboundary=q` supplied a delimiter for a header that names none.
 */
function extractBoundary(contentType: string): string | null {
  const boundary = parseContentType(contentType).parameters.get('boundary');
  return boundary === undefined || boundary === '' ? null : boundary;
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

/**
 * Parses one part's header block into `{ name, filename, mime }`.
 *
 * Each line is split at its FIRST `:` and the field name is compared
 * case-insensitively, because RFC 7578 header field names are
 * case-insensitive like every other HTTP header. The previous implementation
 * matched the exact strings `Content-Disposition` and `Content-Type`, so a
 * client sending `content-disposition` (legal, and what several HTTP libraries
 * emit) lost the field name, the filename discriminator and the MIME type
 * entirely — measured before that was fixed, a CSRF token was never found and
 * an upload was never delivered.
 *
 * The Content-Disposition parameters are read by
 * {@linkcode dispositionParameter}, which admits the unquoted token form and
 * matches the parameter NAME case-insensitively; the previous quoted-only,
 * case-sensitive regexes silently discarded the name of a part a client sent
 * as `name=x` (the platform delivers it) and demoted an upload sent with an
 * unquoted `filename=a.txt` to a text field.
 */
function parseHeaders(block: Uint8Array): { name?: string; mime?: string; filename?: string } {
  const text = new TextDecoder().decode(block);
  const result: { name?: string; mime?: string; filename?: string } = {};

  for (const line of text.split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon === -1) continue;
    const field = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();

    if (field === 'content-disposition') {
      const name = dispositionParameter(value, 'name');
      if (name !== undefined) result.name = name;
      const filename = dispositionParameter(value, 'filename');
      if (filename !== undefined) result.filename = filename;
    } else if (field === 'content-type') {
      result.mime = value;
    }
  }

  return result;
}

/**
 * Reads one `Content-Disposition` parameter's value, quoted or unquoted.
 *
 * Both spellings are accepted: the quoted form `name="x"`, and the unquoted
 * token form `name=x`, whose value runs to the next `;` or the end of the
 * header and is then trimmed — measured against the platform,
 * `name=hello world` → `hello world`, `name=x` → `x`, `name=x;` → `x`. The
 * parameter NAME is matched case-insensitively (RFC 2183 header-parameter
 * semantics, and what Node does); the header FIELD name above is
 * case-insensitive as it always was. Where the runtimes disagree — Deno drops
 * an uppercase `NAME=x` part, Node delivers it — this parser delivers, the
 * side that loses no data (M95c §3.4).
 *
 * A quoted empty value is a DEFINED empty string: `name=""` is a legitimate
 * empty-named field and `filename=""` is the empty file input the web
 * standard's file-versus-text discriminator depends on. An ABSENT parameter
 * yields `undefined`, which is what makes {@linkcode parseMultipart} drop a
 * part rather than rename it.
 *
 * @param value - The header value after the colon
 * @param parameter - The parameter name to read, lower-case
 * @returns The parameter's value, or `undefined` when the parameter is absent
 */
function dispositionParameter(value: string, parameter: string): string | undefined {
  let index = 0;
  const length = value.length;

  while (index < length) {
    // Skip whitespace and the semicolons separating parameters.
    const char = value[index];
    if (char === ' ' || char === '\t' || char === ';') {
      index++;
      continue;
    }

    // Read the parameter name up to `=`; a valueless token is skipped.
    const nameStart = index;
    while (index < length && value[index] !== '=' && value[index] !== ';') index++;
    const name = value.slice(nameStart, index).trim().toLowerCase();
    if (index >= length || value[index] === ';') continue;

    index++; // the `=`

    if (value[index] === '"') {
      const closing = value.indexOf('"', index + 1);
      if (closing === -1) {
        // Unterminated quote: no usable value for THIS parameter; skip the
        // remainder rather than aborting the remaining parameters.
        index = length;
        continue;
      }
      if (name === parameter) return value.slice(index + 1, closing);
      index = closing + 1;
    } else {
      const stop = value.indexOf(';', index);
      const end = stop === -1 ? length : stop;
      if (name === parameter) return value.slice(index, end).trim();
      index = end;
    }
  }

  return undefined;
}

/**
 * Finds the next DELIMITER starting at `offset`.
 *
 * A multipart delimiter is not merely the byte sequence `--<boundary>`: RFC
 * 2046 §5.1.1 defines it as a line break FOLLOWED by `--<boundary>`, followed
 * in turn by a line break (another part) or `--` (the close). Matching the raw
 * byte sequence anywhere silently truncated any value containing it — measured
 * before this fix, the field value `prefix--AaB03xsuffix` came back as
 * `'pref'`, because the match also consumed the two bytes a real delimiter's
 * CRLF occupies. Real clients choose a boundary unlikely to appear in the data,
 * but "unlikely" is not "never", and the failure is silent corruption of a
 * CSRF token or uploaded file rather than a refusal.
 *
 * @param body - The whole request body
 * @param offset - Where to start scanning (always inside a part's data)
 * @param boundary - The `--<boundary>` bytes
 * @param lastBoundary - The `--<boundary>--` bytes
 * @returns The index of the delimiter's line break, or `-1` when none remains
 */
function findNextBoundary(
  body: Uint8Array,
  offset: number,
  boundary: Uint8Array,
  lastBoundary: Uint8Array,
): number {
  let pos = body.indexOf(boundary[0] as number, offset);
  while (pos !== -1) {
    if (isDelimiterAt(body, pos, boundary, lastBoundary)) return pos;
    pos = body.indexOf(boundary[0] as number, pos + 1);
  }
  return -1;
}

/**
 * Reports whether a real delimiter starts at `pos`, i.e. `--<boundary>`
 * followed by a line break or the closing `--`.
 *
 * The preceding line break is checked by the CALLER's arithmetic rather than
 * here: `parseMultipart` strips the two bytes before the returned index, so a
 * match is only accepted when those bytes are actually a CRLF (or a bare LF).
 */
function isDelimiterAt(
  body: Uint8Array,
  pos: number,
  boundary: Uint8Array,
  lastBoundary: Uint8Array,
): boolean {
  if (!tryMatch(body, pos, boundary)) return false;
  // Must be preceded by the line break that belongs to the delimiter.
  if (precedingLineBreakLength(body, pos) === 0) return false;
  // And followed by a line break (another part) or `--` (the close).
  // The CLOSING delimiter needs its trailing context checked too, or any
  // `--<boundary>--` inside part data ends the body: measured, file data
  // containing `\r\n--AaB03x--NOT-A-DELIMITER` truncated to its first line
  // while `Response.formData()` returned it whole. RFC 2046 §5.1.1 allows only
  // transport padding and a line break after the close (the epilogue then
  // follows), or the end of the body.
  if (tryMatch(body, pos, lastBoundary)) {
    let after = pos + lastBoundary.length;
    while (body[after] === 32 || body[after] === 9) after++; // transport padding
    if (after === body.length || body[after] === 10) return true;
    return body[after] === 13 && body[after + 1] === 10;
  }
  // An out-of-range read yields `undefined`, which equals neither byte, so a
  // delimiter running off the end of the body needs no separate length guard.
  const next = body[pos + boundary.length];
  if (next === 10) return true; // bare LF, which this parser accepts throughout
  return next === 13 && body[pos + boundary.length + 1] === 10; // CRLF
}

/**
 * Reports how many bytes the line break immediately before `pos` occupies:
 * `2` for CRLF, `1` for a bare LF, `0` when no line break ends there.
 *
 * The length is RETURNED rather than a boolean because the caller strips
 * exactly these bytes from the part's data; assuming a fixed 2 would truncate
 * the final byte of every part whenever the delimiter is preceded by a bare LF.
 *
 * A bare LF is accepted here even though a wholly bare-LF BODY does not parse
 * (measured, on this branch and before it: `dataStart` is `headerEnd + 4`, so
 * the `\n\n` header separator leaves the data offset two bytes past its start
 * and no part survives). The file's LF tolerance is partial and this function
 * does not complete it — it simply declines to hardcode an assumption the
 * caller would then have to share.
 *
 * No `pos < 1` guard is needed: a negative index reads `undefined`, which
 * equals neither byte, so the comparisons already answer `0`.
 */
function precedingLineBreakLength(body: Uint8Array, pos: number): number {
  if (body[pos - 1] !== 10) return 0;
  return body[pos - 2] === 13 ? 2 : 1;
}
