/**
 * Tests for base64url encoding/decoding utilities.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { decodeBase64Url, encodeBase64Url } from '../../src/utils/base64url.ts';

describe('encodeBase64Url', () => {
  it('encodes empty bytes to empty string', () => {
    expect(encodeBase64Url(new Uint8Array([]))).toBe('');
  });

  it('encodes ASCII string bytes', () => {
    const bytes = new TextEncoder().encode('Hello');
    expect(encodeBase64Url(bytes)).toBe('SGVsbG8');
  });

  it('encodes bytes with + to - (base64url conversion)', () => {
    // Find bytes that produce + in standard base64
    // '+' appears at position 62 in base64 alphabet
    // Testing with known input that would produce +
    const bytes = new Uint8Array([255, 255, 255]);
    const result = encodeBase64Url(bytes);
    expect(result).not.toContain('+');
    expect(result).not.toContain('/');
  });

  it('does not include padding', () => {
    const bytes = new Uint8Array([1, 2, 3, 4]);
    const result = encodeBase64Url(bytes);
    expect(result).not.toContain('=');
  });

  it('handles multi-byte UTF-8 characters', () => {
    const bytes = new TextEncoder().encode('Hello 世界');
    const encoded = encodeBase64Url(bytes);
    expect(encoded).not.toContain('+');
    expect(encoded).not.toContain('/');
    expect(encoded).not.toContain('=');
  });
});

describe('decodeBase64Url', () => {
  it('decodes empty string to empty bytes', () => {
    expect(decodeBase64Url('')).toEqual(new Uint8Array([]));
  });

  it('decodes base64url string', () => {
    const bytes = decodeBase64Url('SGVsbG8');
    expect(new TextDecoder().decode(bytes)).toBe('Hello');
  });

  it('handles missing padding', () => {
    const bytes = decodeBase64Url('SGVsbG8');
    expect(bytes.length).toBe(5);
  });

  it('round-trips with encodeBase64Url', () => {
    const original = new TextEncoder().encode('Hello 世界!');
    const encoded = encodeBase64Url(original);
    const decoded = decodeBase64Url(encoded);
    expect(decoded).toEqual(original);
  });

  it('round-trips arbitrary bytes', () => {
    const original = new Uint8Array([0, 1, 2, 253, 254, 255]);
    const encoded = encodeBase64Url(original);
    const decoded = decodeBase64Url(encoded);
    expect(decoded).toEqual(original);
  });
});

describe('encodeBase64Url and decodeBase64Url round-trip', () => {
  it('handles empty bytes', () => {
    const original = new Uint8Array([]);
    const encoded = encodeBase64Url(original);
    const decoded = decodeBase64Url(encoded);
    expect(decoded).toEqual(original);
  });

  it('handles single byte', () => {
    const original = new Uint8Array([42]);
    const encoded = encodeBase64Url(original);
    const decoded = decodeBase64Url(encoded);
    expect(decoded).toEqual(original);
  });

  it('handles various lengths', () => {
    for (const length of [1, 2, 3, 4, 16, 32, 64, 128]) {
      const original = new Uint8Array(length);
      crypto.getRandomValues(original);
      const encoded = encodeBase64Url(original);
      const decoded = decodeBase64Url(encoded);
      expect(decoded).toEqual(original);
    }
  });
});
