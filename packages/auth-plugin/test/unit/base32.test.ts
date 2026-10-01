/**
 * Unit — RFC 4648 base32 codec.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { decodeBase32, encodeBase32 } from '../../src/mfa/base32.ts';

describe('base32', () => {
  it('encodes RFC 4648 §10 test vectors', () => {
    const vectors: Array<[string, string]> = [
      ['', ''],
      ['f', 'MY'],
      ['fo', 'MZXQ'],
      ['foo', 'MZXW6'],
      ['foob', 'MZXW6YQ'],
      ['fooba', 'MZXW6YTB'],
      ['foobar', 'MZXW6YTBOI'],
    ];
    for (const [input, expected] of vectors) {
      const bytes = new TextEncoder().encode(input);
      expect(encodeBase32(bytes)).toBe(expected);
    }
  });

  it('decodes RFC 4648 §10 test vectors', () => {
    const vectors: Array<[string, string]> = [
      ['', ''],
      ['MY', 'f'],
      ['MZXQ', 'fo'],
      ['MZXW6', 'foo'],
      ['MZXW6YQ', 'foob'],
      ['MZXW6YTB', 'fooba'],
      ['MZXW6YTBOI', 'foobar'],
    ];
    for (const [input, expected] of vectors) {
      const bytes = decodeBase32(input);
      expect(new TextDecoder().decode(bytes)).toBe(expected);
    }
  });

  it('round-trips arbitrary bytes', () => {
    const bytes = new Uint8Array([
      0,
      1,
      2,
      3,
      4,
      5,
      6,
      7,
      8,
      9,
      10,
      11,
      12,
      13,
      14,
      15,
      16,
      17,
      18,
      19,
    ]);
    const encoded = encodeBase32(bytes);
    const decoded = decodeBase32(encoded);
    expect(decoded).toEqual(bytes);
  });

  it('accepts lowercase input on decode', () => {
    const bytes = new TextEncoder().encode('foobar');
    const encoded = encodeBase32(bytes);
    const decoded = decodeBase32(encoded.toLowerCase());
    expect(new TextDecoder().decode(decoded)).toBe('foobar');
  });

  it('ignores whitespace on decode', () => {
    const bytes = new TextEncoder().encode('foobar');
    const encoded = encodeBase32(bytes);
    const withSpaces = encoded.slice(0, 4) + ' ' + encoded.slice(4);
    const decoded = decodeBase32(withSpaces);
    expect(new TextDecoder().decode(decoded)).toBe('foobar');
  });

  it('throws on invalid characters', () => {
    expect(() => decodeBase32('!')).toThrow('Invalid base32 character');
    expect(() => decodeBase32('1')).toThrow('Invalid base32 character');
  });
});
