/**
 * Unit tests for the hash helpers (plan §3.6, §3.11).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { deriveHash, lengthPrefixed, sha256Hex } from '../../src/core/hash.ts';

describe('hash helpers (M109a §3.11)', () => {
  it('hashes to 64 lower-case hex characters', async () => {
    const digest = await sha256Hex(crypto.subtle, new TextEncoder().encode('abc'));
    expect(digest).toMatch(/^[0-9a-f]{64}$/);
    // The SHA-256 vector for "abc".
    expect(digest).toBe('ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
  });

  it('length-prefixes, so ["a:b","c"] differs from ["a","b:c"]', async () => {
    const left = await deriveHash(crypto.subtle, ['a:b', 'c']);
    const right = await deriveHash(crypto.subtle, ['a', 'b:c']);
    expect(left).not.toBe(right);
  });

  it('lengthPrefixed writes the UTF-8 byte length then the bytes', () => {
    // 'é' is two UTF-8 bytes, so the prefix is '2:'.
    expect(Array.from(lengthPrefixed(['é']))).toEqual([0x32, 0x3a, 0xc3, 0xa9]);
  });

  it('deriveHash is stable for the same segments', async () => {
    expect(await deriveHash(crypto.subtle, ['x', 'y'])).toBe(
      await deriveHash(crypto.subtle, ['x', 'y']),
    );
  });

  it('hashes an empty part list', async () => {
    expect(await sha256Hex(crypto.subtle)).toMatch(/^[0-9a-f]{64}$/);
  });
});
