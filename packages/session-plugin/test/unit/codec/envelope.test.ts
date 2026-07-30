/**
 * Unit tests for the envelope wire format and its base64url helpers.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  decodeEnvelope,
  encodeEnvelope,
  fromBase64Url,
  fromUtf8,
  IV_LENGTH,
  toBase64Url,
  toBuffer,
  utf8,
} from '../../../src/codec/envelope.ts';

const iv = new Uint8Array(IV_LENGTH).fill(7);
const sealed = new Uint8Array([1, 2, 3, 4]);

describe('base64url helpers', () => {
  it('round-trips bytes without padding', () => {
    const bytes = new Uint8Array([0, 1, 250, 255, 128]);
    const text = toBase64Url(bytes);
    expect(text).not.toContain('=');
    expect(text).not.toContain('+');
    expect(text).not.toContain('/');
    expect(fromBase64Url(text)).toEqual(bytes);
  });

  it('round-trips a payload larger than one chunk', () => {
    // Guards the chunked String.fromCharCode path, which throws on a spread
    // of a very large array.
    const big = new Uint8Array(100_000).map((_v, i) => i % 256);
    expect(fromBase64Url(toBase64Url(big))).toEqual(big);
  });

  it('rejects non-base64url input', () => {
    expect(fromBase64Url('')).toBe(null);
    expect(fromBase64Url('has space')).toBe(null);
    expect(fromBase64Url('plus+char')).toBe(null);
    expect(fromBase64Url('slash/char')).toBe(null);
    expect(fromBase64Url('pad=ding')).toBe(null);
  });

  it('encodes and decodes UTF-8 text', () => {
    expect(fromUtf8(utf8('héllo ☕'))).toBe('héllo ☕');
  });

  it('copies bytes into a detached ArrayBuffer', () => {
    const source = new Uint8Array([9, 8, 7]);
    const buffer = toBuffer(source);
    expect(buffer.byteLength).toBe(3);
    expect(new Uint8Array(buffer)).toEqual(source);
    // Detached: mutating the source must not change the copy.
    source[0] = 0;
    expect(new Uint8Array(buffer)[0]).toBe(9);
  });
});

describe('encodeEnvelope / decodeEnvelope', () => {
  it('round-trips a well-formed envelope', () => {
    const raw = encodeEnvelope('kid12345', iv, sealed);
    expect(raw.split('.').length).toBe(4);
    expect(raw.startsWith('v1.kid12345.')).toBe(true);

    const decoded = decodeEnvelope(raw, IV_LENGTH);
    expect(decoded).not.toBe(null);
    expect(decoded?.kid).toBe('kid12345');
    expect(decoded?.first).toEqual(iv);
    expect(decoded?.second).toEqual(sealed);
  });

  it('decodes without an IV-length constraint for sign mode', () => {
    const raw = encodeEnvelope('k', utf8('{"a":1}'), sealed);
    const decoded = decodeEnvelope(raw);
    expect(fromUtf8(decoded!.first)).toBe('{"a":1}');
  });

  it('returns null for every malformed shape', () => {
    const valid = encodeEnvelope('kid12345', iv, sealed);
    const cases: readonly (readonly [string, string])[] = [
      ['too few segments', 'v1.kid.abc'],
      ['too many segments', `${valid}.extra`],
      ['unknown version', valid.replace(/^v1/, 'v2')],
      ['empty version', valid.replace(/^v1/, '')],
      ['empty kid', valid.replace('.kid12345.', '..')],
      ['non-base64url first', 'v1.kid.not valid.AQID'],
      ['non-base64url second', 'v1.kid.AQID.not valid'],
      ['empty first', 'v1.kid..AQID'],
      ['empty second', 'v1.kid.AQID.'],
      ['garbage', 'not-a-cookie'],
      ['empty string', ''],
    ];

    for (const [label, raw] of cases) {
      expect(decodeEnvelope(raw, IV_LENGTH), label).toBe(null);
    }
  });

  it('rejects a first segment of the wrong length when an IV length is required', () => {
    const shortIv = encodeEnvelope('kid', new Uint8Array(4).fill(1), sealed);
    expect(decodeEnvelope(shortIv, IV_LENGTH)).toBe(null);
    // The same envelope is fine when no length is demanded (sign mode).
    expect(decodeEnvelope(shortIv)).not.toBe(null);
  });
});
