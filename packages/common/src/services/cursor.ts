/**
 * Portable keyset-cursor codec and predicate, shared by every database backend.
 *
 * The lexicographic "row after this one" comparison that keyset paging needs is
 * expressible with the portable {@linkcode FilterExpression} the contract
 * already ships, so once every adapter translates a `FilterExpression` it gets
 * keyset paging with no new translation code — and the five adapters cannot
 * drift about what "the next page" means.
 *
 * The three functions here are pure: no driver, no runtime service, no I/O.
 * They live in `@setu-ts/common` because `cloudflare-plugin` needs the
 * identical encoding and AI_GUIDELINES §2.2 forbids a plugin importing another
 * plugin (the M47 frame-codec precedent) — this is the same shape, one copy.
 *
 * @module
 */
import type { FilterComparison, FilterExpression, OrderDirection } from './database.ts';

/**
 * The decoded contents of a cursor minted by {@linkcode encodeCursor}: the key
 * values plus a stable fingerprint of the resolved sort specification. The
 * fingerprint is what a fingerprint mismatch on decode detects.
 *
 * @since 0.1.0
 */
export interface CursorPayload {
  /** The primary-key column values in their resolved sort order. */
  readonly keyValues: ReadonlyArray<string | number>;
  /**
   * A stable fingerprint of the resolved sort specification: each ordered
   * field paired with its direction, in order. A cursor minted under one sort
   * and presented under another has a different fingerprint, so the caller is
   * refused by name rather than served a silently wrong page.
   */
  readonly sortFingerprint: string;
}

/**
 * Encode a {@linkcode CursorPayload} as a base64url-encoded JSON token.
 *
 * The token is opaque to the caller: they hand it back verbatim as the next
 * query's `cursor`, and the adapter decodes it.
 *
 * @param payload - The values and sort fingerprint to encode
 * @returns A base64url-encoded JSON string
 * @since 0.1.0
 */
export function encodeCursor(payload: CursorPayload): string {
  return base64Url(JSON.stringify(payload));
}

/**
 * Decode a cursor token to its {@linkcode CursorPayload}, or `null` when the
 * token is malformed.
 *
 * A malformed token decodes to `null` and never throws — the caller branches on
 * `null` and refuses by name, which keeps a corrupt cursor a refused request
 * rather than an uncaught rejection off the public surface.
 *
 * @param token - A token previously returned by {@linkcode encodeCursor}
 * @returns The decoded payload, or `null` when the token is not well-formed JSON
 * @since 0.1.0
 */
export function decodeCursor(token: string): CursorPayload | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(base64UrlDecode(token));
  } catch {
    return null;
  }
  if (!isPayload(parsed)) return null;
  return {
    keyValues: [...parsed.keyValues],
    sortFingerprint: parsed.sortFingerprint,
  };
}

/**
 * Build the "row after this one" keyset comparison as a portable
 * {@linkcode FilterExpression}.
 *
 * For a `desc` sort on a single key column `key` the tree is
 * `or(lt(key), and(eq(key), gt(key)))` — rows before the cursor's value, plus
 * rows equal to it. The `asc` mirror swaps the comparison directions.
 *
 * The primary key columns (`keyColumns`) are always appended as the final sort
 * term: this is the tiebreaker that makes a walk over a non-unique sort
 * correct — over rows carrying only two distinct sort values, a walk that
 * omitted it returned 4 of 6 and reported success. A caller-supplied `orderBy`
 * that already ends in the key columns is not duplicated: the term is appended
 * only when it is not already the last term.
 *
 * @param cursorValues - The key values in their resolved sort order
 * @param orderBy - The resolved sort specification (field → direction)
 * @param keyColumns - The primary-key columns, as the final tiebreaker term
 * @returns The keyset comparison, conjoinable with the caller's own filter
 * @since 0.1.0
 */
export function keysetPredicate(
  cursorValues: ReadonlyArray<string | number>,
  orderBy: Readonly<Record<string, OrderDirection>>,
  keyColumns: ReadonlyArray<string>,
): FilterExpression {
  const entries = Object.entries(orderBy);
  const lastField = entries.length > 0 ? entries[entries.length - 1][0] : undefined;
  const lastKey = keyColumns.length > 0 ? keyColumns[keyColumns.length - 1] : undefined;
  // The key tiebreaker is the final sort term. When the caller's orderBy
  // already ends in the last key column, appending it would duplicate the term,
  // so the guard is the *last* key column against the *last* ordered field.
  const hasTiebreaker = keyColumns.length > 0 && lastField !== lastKey;

  // A value is looked up by the position its column occupies in the sort: the
  // sort field's value at that position. A key column absent from the sort
  // (a pure tiebreaker) takes the first cursor value.
  const valueOf = (field: string): string | number => {
    const index = entries.findIndex(([name]) => name === field);
    return index === -1 ? cursorValues[0] : cursorValues[index];
  };

  const comparisons: FilterComparison[] = entries.map(
    ([field, direction]): FilterComparison => ({
      type: 'comparison',
      field,
      operator: direction === 'desc' ? 'lt' : 'gt',
      value: valueOf(field),
    }),
  );

  const or: FilterExpression = { type: 'or', filters: comparisons };
  if (!hasTiebreaker) return or;

  // A multi-column key is an `or` of `eq(column, value)` under the `and`, so a
  // row equal to the cursor on any key column is carried forward; the outer
  // `and` then narrows it by the tiebreaker's own direction.
  const eqOr: FilterComparison[] = keyColumns.map((column) => ({
    type: 'comparison',
    field: column,
    operator: 'eq',
    value: valueOf(column),
  }));
  return {
    type: 'and',
    filters: [or, { type: 'or', filters: eqOr }],
  };
}

/**
 * Type guard for a decoded {@linkcode CursorPayload}: the shape a well-formed
 * token must have, and the reason a corrupt token is refused rather than
 * coerced.
 *
 * @param value - The candidate value to test
 * @returns `true` when `value` is a payload
 * @since 0.1.0
 */
function isPayload(value: unknown): value is CursorPayload {
  return typeof value === 'object' && value !== null &&
    Array.isArray((value as CursorPayload).keyValues) &&
    typeof (value as CursorPayload).sortFingerprint === 'string';
}

/**
 * Encode a string as base64url: base64 with the `-`/`_` alphabet and padding
 * stripped. Self-contained (no `globalThis`, no runtime import) so it stays
 * within `common`'s zero-dependency, no-runtime-boundary rule.
 *
 * @param input - The UTF-8 string to encode
 * @returns The base64url representation
 * @since 0.1.0
 */
function base64Url(input: string): string {
  return base64FromBytes(utf8(input))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Decode a base64url token to the string it encoded.
 *
 * @param input - A base64url string
 * @returns The decoded UTF-8 string
 * @since 0.1.0
 */
function base64UrlDecode(input: string): string {
  return utf8FromBytes(base64ToBytes(input.replace(/-/g, '+').replace(/_/g, '/')));
}

const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/**
 * @param bytes - The raw bytes to encode
 * @returns The standard base64 string (with `+`/`/` and padding)
 * @since 0.1.0
 */
function base64FromBytes(bytes: number[]): string {
  let result = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const b0 = bytes[i] ?? 0;
    const b1 = bytes[i + 1] ?? 0;
    const b2 = bytes[i + 2] ?? 0;
    result += ALPHABET[b0 >> 2];
    result += ALPHABET[((b0 & 3) << 4) | (b1 >> 4)];
    result += i + 1 < bytes.length ? ALPHABET[((b1 & 15) << 2) | (b2 >> 6)] : '=';
    result += i + 2 < bytes.length ? ALPHABET[b2 & 63] : '=';
  }
  return result;
}

/**
 * @param input - The standard base64 string to decode
 * @returns The raw bytes
 * @since 0.1.0
 */
function base64ToBytes(input: string): number[] {
  const table = new Map<string, number>();
  for (let i = 0; i < ALPHABET.length; i++) table.set(ALPHABET[i], i);
  const values: number[] = [];
  for (const ch of input) {
    if (ch === '=') break;
    const code = table.get(ch);
    if (code !== undefined) values.push(code);
  }
  const bytes: number[] = [];
  for (let i = 0; i < values.length; i += 4) {
    const n0 = values[i] ?? 0;
    const n1 = values[i + 1] ?? 0;
    const n2 = values[i + 2] ?? 0;
    const n3 = values[i + 3] ?? 0;
    bytes.push((n0 << 2) | (n1 >> 4));
    if (i + 2 < values.length) bytes.push(((n1 & 15) << 4) | (n2 >> 2));
    if (i + 3 < values.length) bytes.push(((n2 & 3) << 6) | n3);
  }
  return bytes;
}

/**
 * @param input - A binary string (each char code 0–255)
 * @returns The UTF-8 bytes
 * @since 0.1.0
 */
function utf8(input: string): number[] {
  const bytes: number[] = [];
  for (let i = 0; i < input.length; i++) {
    const code = input.charCodeAt(i);
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0xd800 || code >= 0xe000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      // Surrogate pair — combine into a code point and encode as four bytes.
      i++;
      // Low surrogate base is 0xDC00; subtracting 0x400 would yield wrong bytes
      // for any character above BMP (U+10000), so emoji round-trips as garbage.
      const pair = 0x10000 + ((code & 0x7ff) << 10) + input.charCodeAt(i) - 0xdc00;
      bytes.push(
        0xf0 | (pair >> 18),
        0x80 | ((pair >> 12) & 0x3f),
        0x80 | ((pair >> 6) & 0x3f),
        0x80 | (pair & 0x3f),
      );
    }
  }
  return bytes;
}

/**
 * @param bytes - The raw bytes to decode
 * @returns The UTF-8 string
 * @since 0.1.0
 */
function utf8FromBytes(bytes: number[]): string {
  let result = '';
  for (let i = 0; i < bytes.length;) {
    const b0 = bytes[i] ?? 0;
    if (b0 < 0x80) {
      result += String.fromCharCode(b0);
      i += 1;
    } else if (b0 >> 5 === 0x06) {
      const b1 = bytes[i + 1] ?? 0;
      result += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
      i += 2;
    } else if (b0 >> 4 === 0x0e) {
      const b1 = bytes[i + 1] ?? 0;
      const b2 = bytes[i + 2] ?? 0;
      result += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
      i += 3;
    } else {
      const b1 = bytes[i + 1] ?? 0;
      const b2 = bytes[i + 2] ?? 0;
      const b3 = bytes[i + 3] ?? 0;
      const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      result += String.fromCharCode(
        0xd800 + ((cp - 0x10000) >> 10),
        0xdc00 + ((cp - 0x10000) & 0x3ff),
      );
      i += 4;
    }
  }
  return result;
}
