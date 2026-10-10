/**
 * The tier-C result envelope: `{"v": <result>}` (M109b §3.3, §3.9).
 *
 * Decoding is a trust boundary: the row lives in a shared database and may be
 * corrupted or tampered with, so `decodeResult` accepts only the envelope and
 * refuses anything else — a `within` never re-runs the work on a row it cannot
 * read.
 *
 * @module
 */
import { IdempotencyWithinError } from '../errors.ts';

const encoder = new TextEncoder();

/**
 * Encodes a result into the stored envelope.
 *
 * `undefined` encodes to `{}` (the void envelope). A value `JSON.stringify`
 * throws on (a `BigInt`, a cycle) or omits (a function, a symbol) is refused,
 * as is one whose envelope exceeds `maxResultBytes` UTF-8 bytes.
 *
 * @param value - The work's result
 * @param maxResultBytes - The configured cap
 * @returns The stored envelope
 * @throws {IdempotencyWithinError} `'result-unserializable'` or `'result-too-large'`
 */
export function encodeResult(value: unknown, maxResultBytes: number): string {
  if (value === undefined) return '{}';
  let encoded: string;
  try {
    encoded = JSON.stringify({ v: value });
  } catch {
    throw new IdempotencyWithinError(
      'result-unserializable',
      'idempotency: the work result cannot be serialised',
    );
  }
  // A function or symbol value is OMITTED, leaving the bare envelope.
  if (encoded === '{}') {
    throw new IdempotencyWithinError(
      'result-unserializable',
      'idempotency: the work result cannot be serialised',
    );
  }
  if (encoder.encode(encoded).byteLength > maxResultBytes) {
    throw new IdempotencyWithinError(
      'result-too-large',
      'idempotency: the work result is too large',
    );
  }
  return encoded;
}

/**
 * Decodes a stored envelope back into its result.
 *
 * Accepts only a JSON object carrying at most the single `v` key.
 *
 * @param result - The stored envelope
 * @returns The decoded result, or `undefined` for the void envelope
 * @throws {IdempotencyWithinError} `'record-invalid'` when it is not the envelope
 */
export function decodeResult(result: string): unknown {
  let parsed: unknown;
  try {
    parsed = JSON.parse(result);
  } catch {
    throw new IdempotencyWithinError(
      'record-invalid',
      'idempotency: the stored record is not JSON',
    );
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new IdempotencyWithinError(
      'record-invalid',
      'idempotency: the stored record is not an envelope',
    );
  }
  const keys = Object.keys(parsed);
  if (keys.length > 1 || (keys.length === 1 && keys[0] !== 'v')) {
    throw new IdempotencyWithinError(
      'record-invalid',
      'idempotency: the stored record is not an envelope',
    );
  }
  return (parsed as { readonly v?: unknown }).v;
}
