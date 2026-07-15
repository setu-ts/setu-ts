/**
 * Tests for the Web Crypto buffer helper.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { toBuffer } from '../../src/utils/buffer.ts';

describe('toBuffer', () => {
  it('returns an ArrayBuffer', () => {
    const input = new Uint8Array([1, 2, 3]);
    const result = toBuffer(input);
    expect(result instanceof ArrayBuffer).toBe(true);
  });

  it('copies the bytes correctly', () => {
    const input = new Uint8Array([10, 20, 30, 40, 50]);
    const result = toBuffer(input);
    const view = new Uint8Array(result);
    expect(Array.from(view)).toEqual([10, 20, 30, 40, 50]);
  });

  it('handles an empty input', () => {
    const result = toBuffer(new Uint8Array([]));
    expect(result.byteLength).toBe(0);
  });

  it('produces a fresh copy (mutating source does not affect result)', () => {
    const input = new Uint8Array([1, 2, 3]);
    const result = toBuffer(input);
    input[0] = 99;
    const view = new Uint8Array(result);
    expect(view[0]).toBe(1);
  });

  it('round-trips through subtle.importKey', async () => {
    const keyBytes = new TextEncoder().encode('test-hmac-secret');
    const key = await crypto.subtle.importKey(
      'raw',
      toBuffer(keyBytes),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign'],
    );
    expect(key).toBeDefined();
    expect(key.type).toBe('secret');
  });
});
