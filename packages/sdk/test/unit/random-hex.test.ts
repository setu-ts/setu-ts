/**
 * The shared random-hex draw (M109b §3.8, §11.1).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { drawHexBytes } from '../../src/http/random-hex.ts';

describe('drawHexBytes (M109b §3.8)', () => {
  it('draws the requested bytes as lower-case hex', () => {
    expect(drawHexBytes(16, 'unused')).toMatch(/^[0-9a-f]{32}$/);
    expect(drawHexBytes(4, 'unused')).toHaveLength(8);
  });

  it('draws different values on successive calls', () => {
    expect(drawHexBytes(16, 'unused')).not.toBe(drawHexBytes(16, 'unused'));
  });

  it('throws the supplied message when crypto.getRandomValues is unavailable', () => {
    const original = Object.getOwnPropertyDescriptor(globalThis, 'crypto');
    try {
      Object.defineProperty(globalThis, 'crypto', {
        value: undefined,
        configurable: true,
        writable: true,
      });
      expect(() => drawHexBytes(4, 'no crypto here')).toThrow('no crypto here');
    } finally {
      if (original !== undefined) {
        Object.defineProperty(globalThis, 'crypto', original);
      }
    }
  });
});
