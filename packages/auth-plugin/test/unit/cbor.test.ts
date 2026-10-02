import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  decodeCbor,
  decodeCborItem,
  MAX_CBOR_BYTES,
  MAX_CBOR_DEPTH,
} from '../../src/passkeys/cbor.ts';
import type { CborValue } from '../../src/passkeys/cbor.ts';

/** Hex-decodes a string to bytes. */
function hex(input: string): Uint8Array {
  const bytes = new Uint8Array(input.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(input.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

describe('decodeCbor', () => {
  it('decodes the RFC 8949 Appendix A unsigned-integer vectors', () => {
    expect(decodeCbor(hex('00'))).toEqual({ ok: true, value: 0, bytesRead: 1 });
    expect(decodeCbor(hex('17'))).toEqual({ ok: true, value: 23, bytesRead: 1 });
    expect(decodeCbor(hex('1818'))).toEqual({ ok: true, value: 24, bytesRead: 2 });
    expect(decodeCbor(hex('1864'))).toEqual({ ok: true, value: 100, bytesRead: 2 });
    expect(decodeCbor(hex('1903e8'))).toEqual({ ok: true, value: 1000, bytesRead: 3 });
    expect(decodeCbor(hex('1a000f4240'))).toEqual({ ok: true, value: 1000000, bytesRead: 5 });
    expect(decodeCbor(hex('1b000000e8d4a51000'))).toEqual({
      ok: true,
      value: 1000000000000,
      bytesRead: 9,
    });
  });

  it('decodes the negative-integer vectors as -1 - n', () => {
    expect(decodeCbor(hex('20'))).toEqual({ ok: true, value: -1, bytesRead: 1 });
    expect(decodeCbor(hex('29'))).toEqual({ ok: true, value: -10, bytesRead: 1 });
    expect(decodeCbor(hex('3863'))).toEqual({ ok: true, value: -100, bytesRead: 2 });
    expect(decodeCbor(hex('3903e7'))).toEqual({ ok: true, value: -1000, bytesRead: 3 });
    expect(decodeCbor(hex('39c49e'))).toEqual({ ok: true, value: -50335, bytesRead: 3 });
  });

  it('decodes byte and text strings', () => {
    const empty = decodeCbor(hex('40'));
    expect(empty.ok && empty.value).toEqual(new Uint8Array(0));
    const bytes = decodeCbor(hex('43616161'));
    expect(bytes.ok && bytes.value instanceof Uint8Array).toBe(true);
    expect(bytes.ok && Array.from(bytes.value as Uint8Array)).toEqual([97, 97, 97]);
    expect(decodeCbor(hex('6161'))).toEqual({ ok: true, value: 'a', bytesRead: 2 });
    expect(decodeCbor(hex('6449455446'))).toEqual({ ok: true, value: 'IETF', bytesRead: 5 });
  });

  it('decodes arrays and maps', () => {
    expect(decodeCbor(hex('80'))).toEqual({ ok: true, value: [], bytesRead: 1 });
    expect(decodeCbor(hex('83010203'))).toEqual({ ok: true, value: [1, 2, 3], bytesRead: 4 });
    const emptyMap = decodeCbor(hex('a0'));
    expect(emptyMap.ok && emptyMap.value instanceof Map).toBe(true);
    const map = decodeCbor(hex('a26161016162820203'));
    expect(map.ok && map.value).toEqual(
      new Map<CborValue, CborValue>([['a', 1], ['b', [2, 3]]]),
    );
    const nested = decodeCbor(hex('826161a161626163'));
    expect(nested.ok && nested.value).toEqual(['a', new Map([['b', 'c']])]);
  });

  it('refuses an 8-byte integer beyond Number.MAX_SAFE_INTEGER', () => {
    const refused = decodeCbor(hex('1bffffffffffffffff'));
    expect(refused).toEqual({ ok: false, reason: 'integer-overflow' });
  });

  it('refuses indefinite lengths', () => {
    // [_ 1, 2] — an indefinite-length array
    expect(decodeCbor(hex('9f0102ff')).ok).toBe(false);
    // (_ h'0102') — an indefinite-length byte string
    expect(decodeCbor(hex('5fff0102ff')).ok).toBe(false);
  });

  it('refuses tags and floats', () => {
    // 0(cbor-serialised-data-item) — a tag
    expect(decodeCbor(hex('c074322e3236392e3132382e32342e343737')).ok).toBe(false);
    // 0.0 — a float
    expect(decodeCbor(hex('f90000')).ok).toBe(false);
    // true — a simple value
    expect(decodeCbor(hex('f5')).ok).toBe(false);
  });

  it('refuses truncated input', () => {
    expect(decodeCbor(hex('18'))).toEqual({ ok: false, reason: 'truncated' });
    expect(decodeCbor(hex('43ff'))).toEqual({ ok: false, reason: 'truncated' });
    expect(decodeCbor(hex(''))).toEqual({ ok: false, reason: 'truncated' });
  });

  it('refuses trailing bytes', () => {
    expect(decodeCbor(hex('0100'))).toEqual({ ok: false, reason: 'trailing-bytes' });
  });

  it('refuses input beyond the size bound', () => {
    const oversized = new Uint8Array(MAX_CBOR_BYTES + 1);
    oversized[0] = 0x40; // byte string header; the length check fires first
    expect(decodeCbor(oversized)).toEqual({ ok: false, reason: 'too-large' });
  });

  it('refuses nesting beyond the depth bound', () => {
    // Four nested arrays put the innermost value at depth 5.
    const refused = decodeCbor(hex('8181818100'));
    expect(refused.ok === false && refused.reason).toBe('too-deep');
    // Three nested arrays put the value at depth 4, which is accepted.
    expect(decodeCbor(hex('81818100')).ok).toBe(true);
    void MAX_CBOR_DEPTH;
  });

  it('decodes a prefix with decodeCborItem, reporting the bytes consumed', () => {
    const bytes = hex('83010203');
    const first = decodeCborItem(bytes, 0, 1);
    expect(first.ok && first.value).toEqual([1, 2, 3]);
    expect(first.ok && first.bytesRead).toBe(4);
    const second = decodeCborItem(bytes, 1, 1);
    expect(second.ok && second.value).toBe(1);
    expect(second.ok && second.bytesRead).toBe(1);
  });
});
