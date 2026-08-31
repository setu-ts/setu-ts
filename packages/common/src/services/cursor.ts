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
 * The decoded contents of a cursor minted by {@linkcode encodeCursor}: the
 * values of every ordered field (in `orderBy` order) plus the primary-key
 * column values (for tiebreaker lookups) plus a stable fingerprint of the
 * sort specification. The fingerprint is what a fingerprint mismatch on decode
 * detects.
 *
 * The i-th element of {@linkcode orderedValues} is the value of
 * `Object.entries(orderBy)[i]` from the row the cursor was minted against.
 * This is what {@linkcode keysetPredicate} indexes to build the "row after
 * this one" comparison — a cursor that carried only key-column values would
 * be wrong whenever `orderBy` contains non-key fields.
 *
 * {@linkcode keyValues} carries the same information but indexed by key
 * column name rather than by `orderBy` position. It is used by
 * {@linkcode keysetPredicate} as the tiebreaker fallback when a key column is
 * absent from `orderBy` — using `orderedValues[0]` there would be wrong
 * because the first ordered-value may belong to a non-key field.
 *
 * @since 0.1.0
 */
export interface CursorPayload {
  /**
   * The value of every ordered field (in `orderBy` declaration order), from
   * the row the cursor was minted against. Index `i` is the value of the
   * i-th entry of `Object.entries(orderBy)`.
   */
  readonly orderedValues: ReadonlyArray<string | number>;
  /**
   * The primary-key column values (in key-column order), from the row the
   * cursor was minted against. Used by {@linkcode keysetPredicate} as the
   * tiebreaker fallback when a key column is absent from `orderBy`.
   */
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
    orderedValues: [...parsed.orderedValues],
    keyValues: [...parsed.keyValues],
    sortFingerprint: parsed.sortFingerprint,
  };
}

/**
 * Build the "row after this one" keyset comparison as a portable
 * {@linkcode FilterExpression}.
 *
 * The comparison is the lexicographic expansion of
 * `(resolved sort) > (cursor values)`: one `or` leg per position of the
 * resolved sort, where each leg pins every earlier field to its cursor value
 * (`eq`) and compares the leg's own field strictly in its own direction. For
 * a sort `(a asc, b desc, k asc)` over cursor values `(a0, b0, k0)` the tree
 * is `or(gt(a, a0), and(eq(a, a0), lt(b, b0)), and(eq(a, a0), eq(b, b0),
 * gt(k, k0)))` — for the plan §3.8 case, `createdAt desc` with an `id asc`
 * tiebreaker, exactly `or(lt(createdAt), and(eq(createdAt), gt(id)))`. A flat
 * `or` of per-field strict comparisons is NOT this tree: it matches rows
 * before the cursor whenever any single field sorts beyond its cursor value.
 *
 * The resolved sort is the caller's `orderBy` followed by every key column
 * not already ordered (each as `asc`): the primary-key tiebreaker is a
 * correctness requirement, not a refinement — over rows carrying only two
 * distinct sort values, a walk that omitted it returned 4 of 6 and reported
 * success. A key column already present in `orderBy` is a sort position
 * already and is never appended twice.
 *
 * **Cursor values layout:** `orderedValues` carries the value of each
 * `orderBy` field, in order, from the row the cursor was minted against;
 * `keyValues` carries the primary-key column values in key-column order. An
 * `orderBy` field is indexed by its `orderBy` position; a pure-tiebreaker key
 * column by its own key-column position — never a shared `orderedValues[0]`,
 * which may belong to a non-key field.
 *
 * @param orderedValues - Value of each ordered field from the cursor row, in
 *   `orderBy` order — the i-th element is the value of
 *   `Object.entries(orderBy)[i]`
 * @param keyValues - Primary-key column values in key-column order; a key
 *   column absent from `orderBy` is indexed by its position here
 * @param orderBy - The resolved sort specification (field → direction)
 * @param keyColumns - The primary-key columns, appended as ascending
 *   tiebreakers when `orderBy` does not already carry them
 * @returns The keyset comparison, conjoinable with the caller's own filter
 * @since 0.1.0
 */
export function keysetPredicate(
  orderedValues: ReadonlyArray<string | number>,
  keyValues: ReadonlyArray<string | number>,
  orderBy: Readonly<Record<string, OrderDirection>>,
  keyColumns: ReadonlyArray<string>,
): FilterExpression {
  const entries = Object.entries(orderBy);
  // The resolved sort: the caller's orderBy fields, then every key column not
  // already ordered as an ascending tiebreaker. A key column already present
  // in orderBy is a sort position already and must not be appended twice.
  const tiebreaker: ReadonlyArray<[string, OrderDirection]> = keyColumns
    .filter((column) => orderBy[column] === undefined)
    .map((column): [string, OrderDirection] => [column, 'asc']);
  const sort: ReadonlyArray<[string, OrderDirection]> = [...entries, ...tiebreaker];

  // An orderBy field's value sits at its orderBy position in `orderedValues`;
  // a pure-tiebreaker key column's value sits at its own key-column position
  // in `keyValues` — never `orderedValues[0]`, which may belong to a non-key
  // field.
  const valueOf = (field: string): string | number => {
    const orderByIndex = entries.findIndex(([name]) => name === field);
    if (orderByIndex !== -1) return orderedValues[orderByIndex];
    return keyValues[keyColumns.indexOf(field)];
  };

  // One leg per sort position: every earlier field pinned to its cursor value
  // (`eq`), the leg's own field compared strictly in its own direction. A
  // single-term leg stays a bare comparison; the legs combine under one `or`.
  const legs = sort.map(([field, direction], position): FilterExpression => {
    const terms: FilterComparison[] = [];
    for (let earlier = 0; earlier < position; earlier++) {
      const pinned = sort[earlier][0];
      terms.push({
        type: 'comparison',
        field: pinned,
        operator: 'eq',
        value: valueOf(pinned),
      });
    }
    terms.push({
      type: 'comparison',
      field,
      operator: direction === 'desc' ? 'lt' : 'gt',
      value: valueOf(field),
    });
    return terms.length === 1 ? terms[0] : { type: 'and', filters: terms };
  });
  return { type: 'or', filters: legs };
}

/**
 * Build the stable sort fingerprint embedded in every minted cursor.
 *
 * The fingerprint must be stable across all calls with the same sort — a
 * cursor minted under one sort and presented under another carries a
 * different fingerprint and is refused by name rather than served a silently
 * wrong page.
 *
 * @param orderBy - The resolved sort specification
 * @returns A stable fingerprint string (`'field:direction'` pairs joined by
 *   commas, in `orderBy` declaration order)
 * @since 0.2.0
 */
export function sortFingerprint(
  orderBy: Readonly<Record<string, OrderDirection>>,
): string {
  return Object.entries(orderBy).map(([field, direction]) => `${field}:${direction}`).join(',');
}

/**
 * Mint the next-page cursor from the last row of a non-terminal page.
 *
 * The cursor is only ever produced when {@linkcode hasMore} is true AND the
 * page is non-empty: on a terminal page there is no next row to continue to,
 * and reading the ordered/key values off an empty page would crash on the
 * missing last row.
 *
 * @param pageRows - The rows of the page about to be returned (empty is fine)
 * @param orderBy - The resolved sort specification
 * @param keyColumns - The primary-key columns for cursor minting
 * @param fingerprint - The sort fingerprint to embed in the cursor
 * @param hasMore - Whether a further page exists
 * @returns The encoded cursor, or `null` when the page is terminal
 * @since 0.2.0
 */
export function mintNextCursor(
  pageRows: readonly Record<string, unknown>[],
  orderBy: Readonly<Record<string, OrderDirection>>,
  keyColumns: readonly string[],
  fingerprint: string,
  hasMore: boolean,
): string | null {
  if (!hasMore || pageRows.length === 0) return null;
  const lastRow = pageRows[pageRows.length - 1];
  const orderedValues = Object.entries(orderBy).map(
    ([field]) => lastRow[field] as string | number,
  );
  const keyValues = keyColumns.map((col) => lastRow[col] as string | number);
  return encodeCursor({ orderedValues, keyValues, sortFingerprint: fingerprint });
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
    Array.isArray((value as CursorPayload).orderedValues) &&
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
