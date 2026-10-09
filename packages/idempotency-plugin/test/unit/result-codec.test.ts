/**
 * The tier-C result envelope (M109b §3.3, §3.9): the round trip, `void`, a
 * first-call value equal to its replay, and each refusal.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { IdempotencyWithinError } from '../../src/errors.ts';
import { decodeResult, encodeResult } from '../../src/within/result-codec.ts';

/** The reason a call threw, or `undefined`. */
function reasonOf(fn: () => unknown): string | undefined {
  try {
    fn();
    return undefined;
  } catch (error) {
    return error instanceof IdempotencyWithinError ? error.reason : `other:${error}`;
  }
}

describe('result-codec round trip (M109b §3.3)', () => {
  it('round-trips an object, identical on the first call and the replay', () => {
    const first = encodeResult({ id: 'o-1', total: 3 }, 65_536);
    expect(first).toBe('{"v":{"id":"o-1","total":3}}');
    expect(decodeResult(first)).toEqual({ id: 'o-1', total: 3 });
    // A replay decodes the same stored bytes to the same value.
    expect(decodeResult(first)).toEqual(decodeResult(first));
  });

  it('encodes the void result to the empty envelope', () => {
    expect(encodeResult(undefined, 65_536)).toBe('{}');
    expect(decodeResult('{}')).toBeUndefined();
  });

  it('turns a Date into a string on BOTH paths', () => {
    const encoded = encodeResult(new Date(0), 65_536);
    expect(decodeResult(encoded)).toBe('1970-01-01T00:00:00.000Z');
  });

  it('accepts an envelope exactly at the byte cap', () => {
    const encoded = JSON.stringify({ v: 'x' });
    expect(encodeResult('x', new TextEncoder().encode(encoded).byteLength)).toBe(encoded);
  });
});

describe('result-codec refusals (M109b §3.3)', () => {
  it('refuses an oversized result', () => {
    expect(reasonOf(() => encodeResult('x'.repeat(100), 10))).toBe('result-too-large');
  });

  it('refuses a cyclic result', () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(reasonOf(() => encodeResult(cyclic, 65_536))).toBe('result-unserializable');
  });

  it('refuses a BigInt result', () => {
    expect(reasonOf(() => encodeResult({ n: 1n }, 65_536))).toBe('result-unserializable');
  });

  it('refuses a result JSON.stringify omits', () => {
    expect(reasonOf(() => encodeResult(() => 1, 65_536))).toBe('result-unserializable');
    expect(reasonOf(() => encodeResult(Symbol('s'), 65_536))).toBe('result-unserializable');
  });

  it('refuses a stored text that is not the envelope', () => {
    expect(reasonOf(() => decodeResult('not json'))).toBe('record-invalid');
    expect(reasonOf(() => decodeResult('[1]'))).toBe('record-invalid');
    expect(reasonOf(() => decodeResult('"s"'))).toBe('record-invalid');
    expect(reasonOf(() => decodeResult('null'))).toBe('record-invalid');
    expect(reasonOf(() => decodeResult('{"x":1}'))).toBe('record-invalid');
    expect(reasonOf(() => decodeResult('{"v":1,"x":2}'))).toBe('record-invalid');
  });
});
