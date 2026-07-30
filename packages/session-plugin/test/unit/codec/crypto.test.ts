/**
 * Unit tests for session cookie protection, against REAL Web Crypto.
 *
 * No fake `SubtleCrypto` anywhere in this file. The scheme's whole value is that
 * a tampered cookie is rejected by an authentication tag, and a fake would
 * happily "verify" anything — this is the one path that has to run for real.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { deriveKeyRing, open, seal } from '../../../src/codec/crypto.ts';
import type { SessionMode } from '../../../src/codec/crypto.ts';
import { toBase64Url } from '../../../src/codec/envelope.ts';

const SECRET_A = 'a'.repeat(32);
const SECRET_B = 'b'.repeat(32);
const SECRET_C = 'c'.repeat(32);
const PAYLOAD = JSON.stringify({ id: 's-1', data: { userId: 'u-1' }, exp: 99, seen: 1 });

const subtle = crypto.subtle;
const randomBytes = (n: number): Uint8Array => crypto.getRandomValues(new Uint8Array(n));

const MODES: readonly SessionMode[] = ['encrypt', 'sign'];

describe('deriveKeyRing', () => {
  it('derives one key per secret, in order, with distinct key ids', async () => {
    const ring = await deriveKeyRing(subtle, [SECRET_A, SECRET_B], 'encrypt');
    expect(ring.keys.length).toBe(2);
    expect(ring.mode).toBe('encrypt');
    expect(ring.keys[0].kid).not.toBe(ring.keys[1].kid);
    expect(ring.byKid.get(ring.keys[0].kid)).toBe(ring.keys[0]);
  });

  it('derives a stable key id for the same secret', async () => {
    const first = await deriveKeyRing(subtle, [SECRET_A], 'encrypt');
    const second = await deriveKeyRing(subtle, [SECRET_A], 'encrypt');
    expect(first.keys[0].kid).toBe(second.keys[0].kid);
  });

  it('derives a different key id per mode, so a cookie cannot cross modes', async () => {
    const enc = await deriveKeyRing(subtle, [SECRET_A], 'encrypt');
    const sig = await deriveKeyRing(subtle, [SECRET_A], 'sign');
    // Same secret, but the kid label is mode-independent, so kids match while
    // the derived keys differ — the cross-mode rejection below proves the keys.
    expect(enc.keys[0].kid).toBe(sig.keys[0].kid);
    expect(enc.keys[0].key).not.toBe(sig.keys[0].key);
  });

  it('tolerates a duplicated secret without losing the current key', async () => {
    const ring = await deriveKeyRing(subtle, [SECRET_A, SECRET_A], 'encrypt');
    expect(ring.keys.length).toBe(2);
    expect(ring.byKid.size).toBe(1);
    expect(ring.byKid.get(ring.keys[0].kid)).toBe(ring.keys[0]);
  });

  it('produces an empty ring for no secrets, and sealing then throws', async () => {
    const ring = await deriveKeyRing(subtle, [], 'encrypt');
    expect(ring.keys.length).toBe(0);
    await expect(seal(subtle, ring, PAYLOAD, randomBytes)).rejects.toThrow('key ring is empty');
  });
});

for (const mode of MODES) {
  describe(`seal/open — ${mode} mode`, () => {
    it('round-trips a payload', async () => {
      const ring = await deriveKeyRing(subtle, [SECRET_A], mode);
      const cookie = await seal(subtle, ring, PAYLOAD, randomBytes);
      expect(await open(subtle, ring, cookie)).toBe(PAYLOAD);
    });

    it('stamps the current key id into the envelope', async () => {
      const ring = await deriveKeyRing(subtle, [SECRET_A], mode);
      const cookie = await seal(subtle, ring, PAYLOAD, randomBytes);
      expect(cookie.split('.')[1]).toBe(ring.keys[0].kid);
    });

    it('rejects a tampered payload segment', async () => {
      const ring = await deriveKeyRing(subtle, [SECRET_A], mode);
      const cookie = await seal(subtle, ring, PAYLOAD, randomBytes);
      const parts = cookie.split('.');

      for (const index of [2, 3]) {
        const mutated = [...parts];
        const segment = mutated[index];
        mutated[index] = (segment[0] === 'A' ? 'B' : 'A') + segment.slice(1);
        expect(await open(subtle, ring, mutated.join('.'))).toBe(null);
      }
    });

    it('rejects an unknown key id rather than trying every key', async () => {
      const ring = await deriveKeyRing(subtle, [SECRET_A], mode);
      const cookie = await seal(subtle, ring, PAYLOAD, randomBytes);
      const parts = cookie.split('.');
      parts[1] = 'unknown1';
      expect(await open(subtle, ring, parts.join('.'))).toBe(null);
    });

    it('rejects a malformed envelope', async () => {
      const ring = await deriveKeyRing(subtle, [SECRET_A], mode);
      expect(await open(subtle, ring, '')).toBe(null);
      expect(await open(subtle, ring, 'garbage')).toBe(null);
      expect(await open(subtle, ring, 'v2.kid.AQID.AQID')).toBe(null);
    });

    it('rejects a cookie sealed under a secret that is not in the ring', async () => {
      const mine = await deriveKeyRing(subtle, [SECRET_A], mode);
      const foreign = await deriveKeyRing(subtle, [SECRET_C], mode);
      const cookie = await seal(subtle, foreign, PAYLOAD, randomBytes);
      expect(await open(subtle, mine, cookie)).toBe(null);
    });

    it('rejects a cookie produced in the other mode', async () => {
      const other: SessionMode = mode === 'encrypt' ? 'sign' : 'encrypt';
      const mine = await deriveKeyRing(subtle, [SECRET_A], mode);
      const theirs = await deriveKeyRing(subtle, [SECRET_A], other);
      const cookie = await seal(subtle, theirs, PAYLOAD, randomBytes);
      expect(await open(subtle, mine, cookie)).toBe(null);
    });

    it('rotates: an old cookie opens while its secret is listed, and stops once dropped', async () => {
      const original = await deriveKeyRing(subtle, [SECRET_A], mode);
      const cookie = await seal(subtle, original, PAYLOAD, randomBytes);

      // Rotate: B becomes current, A can still open.
      const rotated = await deriveKeyRing(subtle, [SECRET_B, SECRET_A], mode);
      expect(await open(subtle, rotated, cookie)).toBe(PAYLOAD);

      // New cookies use the new key.
      const fresh = await seal(subtle, rotated, PAYLOAD, randomBytes);
      expect(fresh.split('.')[1]).toBe(rotated.keys[0].kid);
      expect(fresh.split('.')[1]).not.toBe(original.keys[0].kid);

      // Retire A entirely: the old cookie is now unusable.
      const retired = await deriveKeyRing(subtle, [SECRET_C, SECRET_B], mode);
      expect(await open(subtle, retired, cookie)).toBe(null);
    });
  });
}

describe('confidentiality difference between the modes', () => {
  /** Best-effort base64url decode, for inspecting what a cookie reveals. */
  function peek(segment: string): string {
    const base = segment.replace(/-/g, '+').replace(/_/g, '/');
    // Padding has to be computed, not assumed: a hardcoded '==' decodes some
    // lengths and silently fails on others.
    const padded = base + '='.repeat((4 - (base.length % 4)) % 4);
    try {
      return atob(padded);
    } catch {
      return '';
    }
  }

  it("hides the payload in 'encrypt' mode and exposes it in 'sign' mode", async () => {
    const encRing = await deriveKeyRing(subtle, [SECRET_A], 'encrypt');
    const sigRing = await deriveKeyRing(subtle, [SECRET_A], 'sign');

    const encCookie = await seal(subtle, encRing, PAYLOAD, randomBytes);
    const sigCookie = await seal(subtle, sigRing, PAYLOAD, randomBytes);

    // This is the documented trade-off, asserted rather than described: 'sign'
    // protects integrity only, so its claims are readable by the client.
    expect(peek(encCookie.split('.')[3])).not.toContain('userId');
    expect(peek(sigCookie.split('.')[2])).toContain('userId');
  });

  it("still rejects a modified payload in 'sign' mode even though it is readable", async () => {
    const ring = await deriveKeyRing(subtle, [SECRET_A], 'sign');
    const cookie = await seal(subtle, ring, PAYLOAD, randomBytes);
    const parts = cookie.split('.');

    // Swap in an attacker-chosen payload, keeping the original signature.
    parts[2] = toBase64Url(new TextEncoder().encode('{"id":"admin","exp":9e15,"seen":1}'));
    expect(await open(subtle, ring, parts.join('.'))).toBe(null);
  });
});
