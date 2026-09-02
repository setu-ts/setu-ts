/**
 * The Bigtable cell value codec.
 *
 * A Bigtable cell holds raw bytes with no type, so a portable adapter has to
 * choose an encoding. Two are offered, and each names a real consumer:
 *
 * - **`'tagged'`** (the default) writes `<tag>:<payload>`, so a `number`,
 *   `boolean`, `null`, `Date` or object comes back as itself rather than as
 *   its string form. Without it `findAll({ filter: gt('age', 30) })` would
 *   compare strings, and a `Date` column could never be a Date again.
 * - **`'raw'`** writes `String(value)` and reads every cell as a string. That
 *   is the shape a table written outside this framework already has, and
 *   choosing it removes the residual ambiguity the tagged decoder's interop
 *   fallback carries.
 *
 * **The interop fallback.** In tagged mode a cell whose text carries no
 * recognised tag decodes as the raw string. That is what lets this adapter
 * read a table it did not write — Bigtable's dominant deployment — instead of
 * refusing every foreign cell. The residual ambiguity is real and documented:
 * a foreign cell whose text happens to read `n:7` decodes as the number `7`.
 * An application whose table is entirely foreign selects `'raw'`.
 *
 * @module
 */
import type { BigtableValueEncoding } from './bigtable-mapping.ts';

/** The tag introducing a string payload. */
const TAG_STRING = 's:';
/** The tag introducing a decimal number payload. */
const TAG_NUMBER = 'n:';
/** The tag introducing a boolean payload (`true` or `false`). */
const TAG_BOOLEAN = 'b:';
/** The tag introducing `null`; the payload is empty. */
const TAG_NULL = 'z:';
/** The tag introducing an ISO-8601 Date payload. */
const TAG_DATE = 'd:';
/** The tag introducing a JSON payload, for anything the scalar tags cannot hold. */
const TAG_JSON = 'j:';

/**
 * Encodes one value into the text a cell stores.
 *
 * `undefined` is NOT encodable: an absent field is an absent cell, which is
 * what makes a sparse row cheap on a wide-column store. Callers therefore skip
 * an `undefined` value rather than asking for its encoding.
 *
 * @param value - The value to store (never `undefined`)
 * @param encoding - The entity's declared encoding
 * @returns The cell text
 * @since 0.2.0
 */
export function encodeCellValue(value: unknown, encoding: BigtableValueEncoding): string {
  if (encoding === 'raw') return value === null ? '' : String(value);
  if (value === null) return TAG_NULL;
  if (typeof value === 'string') return `${TAG_STRING}${value}`;
  if (typeof value === 'number') return `${TAG_NUMBER}${encodeNumber(value)}`;
  if (typeof value === 'boolean') return `${TAG_BOOLEAN}${value ? 'true' : 'false'}`;
  if (value instanceof Date) return `${TAG_DATE}${value.toISOString()}`;
  return `${TAG_JSON}${JSON.stringify(value)}`;
}

/**
 * Decodes one cell's text back into a value.
 *
 * In `'raw'` mode the text IS the value. In tagged mode a recognised, wholly
 * well-formed tag is honoured and anything else falls back to the raw string —
 * see the module note on interop. A tag whose payload is malformed (`n:abc`,
 * `d:nope`, `j:{`) also falls back rather than throwing: a foreign cell is
 * indistinguishable from a corrupt one, and refusing would make a table this
 * adapter did not write unreadable.
 *
 * @param text - The cell text
 * @param encoding - The entity's declared encoding
 * @returns The decoded value
 * @since 0.2.0
 */
export function decodeCellValue(text: string, encoding: BigtableValueEncoding): unknown {
  if (encoding === 'raw') return text;
  if (text === TAG_NULL) return null;
  const payload = text.slice(2);
  switch (text.slice(0, 2)) {
    case TAG_STRING:
      return payload;
    case TAG_NUMBER:
      return decodeNumber(payload) ?? text;
    case TAG_BOOLEAN:
      if (payload === 'true') return true;
      if (payload === 'false') return false;
      return text;
    case TAG_DATE: {
      const date = new Date(payload);
      return Number.isFinite(date.getTime()) ? date : text;
    }
    case TAG_JSON:
      try {
        return JSON.parse(payload);
      } catch {
        return text;
      }
    default:
      return text;
  }
}

/**
 * Encodes one number, including the values `String()` cannot round-trip.
 *
 * `NaN` and the infinities are written under reserved spellings and read back
 * as themselves. Encoding them as `String(value)` and letting the decoder
 * reject the result — which is what this used to do — turned a stored `NaN`
 * into the STRING `'n:NaN'` on the way out: a silent type change rather than a
 * refusal. `-0` gets its own spelling too, because `String(-0)` is `'0'`.
 *
 * @param value - The number to encode
 * @returns The payload text
 */
function encodeNumber(value: number): string {
  if (Number.isNaN(value)) return 'NaN';
  if (value === Number.POSITIVE_INFINITY) return 'Infinity';
  if (value === Number.NEGATIVE_INFINITY) return '-Infinity';
  if (Object.is(value, -0)) return '-0';
  return String(value);
}

/**
 * Decodes one number payload, or reports that the text is not one this codec
 * wrote.
 *
 * The round-trip is CHECKED rather than assumed: `Number('')` is `0` and
 * `Number(' 1 ')` is `1`, so only text that `encodeNumber` would itself have
 * produced is read as a number. Anything else is a foreign cell whose text
 * merely begins `n:`, and belongs to the interop fallback.
 *
 * @param payload - The text after the tag
 * @returns The number, or `null` when the text is not a number this codec wrote
 */
function decodeNumber(payload: string): number | null {
  if (payload === 'NaN') return Number.NaN;
  if (payload === 'Infinity') return Number.POSITIVE_INFINITY;
  if (payload === '-Infinity') return Number.NEGATIVE_INFINITY;
  if (payload === '-0') return -0;
  const parsed = Number(payload);
  return Number.isFinite(parsed) && String(parsed) === payload ? parsed : null;
}
