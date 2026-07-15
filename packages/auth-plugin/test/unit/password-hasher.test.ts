/**
 * Tests for PasswordHasher.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { PasswordHasher } from '../../src/services/password-hasher.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('PasswordHasher', () => {
  it('hashes and verifies a password round-trip', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    const stored = await hasher.hash('mypassword123');
    expect(stored).toBeTruthy();
    expect(stored.startsWith('pbkdf2$')).toBe(true);

    const isValid = await hasher.verify(stored, 'mypassword123');
    expect(isValid).toBe(true);
  });

  it('returns false for wrong password', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    const stored = await hasher.hash('correct-password');
    const isValid = await hasher.verify(stored, 'wrong-password');
    expect(isValid).toBe(false);
  });

  it('produces different hashes for same password (random salt)', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    const hash1 = await hasher.hash('samepassword');
    const hash2 = await hasher.hash('samepassword');
    expect(hash1).not.toBe(hash2);

    // Both should verify
    expect(await hasher.verify(hash1, 'samepassword')).toBe(true);
    expect(await hasher.verify(hash2, 'samepassword')).toBe(true);
  });

  it('returns false for a malformed stored string', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    expect(await hasher.verify('not-a-valid-hash', 'password')).toBe(false);
  });

  it('returns false for a stored string with wrong prefix', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    expect(await hasher.verify('bcrypt$1000$salt$hash', 'password')).toBe(false);
  });

  it('returns false for a stored string with too few parts', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    expect(await hasher.verify('pbkdf2$1000$salt', 'password')).toBe(false);
  });

  it('returns false for a stored string with invalid iterations', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    expect(await hasher.verify('pbkdf2$notanumber$salt$hash', 'password')).toBe(false);
  });

  it('returns false for a stored string with zero iterations', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    expect(await hasher.verify('pbkdf2$0$salt$hash', 'password')).toBe(false);
  });

  it('returns false for a stored string with negative iterations', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    expect(await hasher.verify('pbkdf2$-1$salt$hash', 'password')).toBe(false);
  });

  it('verifies against a manually constructed stored hash', async () => {
    const runtime = createFakeRuntime();
    const hasher = new PasswordHasher(runtime);

    // Hash a password, then verify the stored format
    const password = 'test-password';
    const stored = await hasher.hash(password);

    // The stored string should have 4 parts
    const parts = stored.split('$');
    expect(parts.length).toBe(4);
    expect(parts[0]).toBe('pbkdf2');
    expect(parts[1]).toBe('100000');

    // Verify works
    expect(await hasher.verify(stored, password)).toBe(true);
  });

  it('handles empty password', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    const stored = await hasher.hash('');
    expect(stored.startsWith('pbkdf2$')).toBe(true);
    expect(await hasher.verify(stored, '')).toBe(true);
    expect(await hasher.verify(stored, 'nonempty')).toBe(false);
  });

  it('handles unicode passwords', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    const password = '密码🔐password';
    const stored = await hasher.hash(password);
    expect(await hasher.verify(stored, password)).toBe(true);
    expect(await hasher.verify(stored, 'different')).toBe(false);
  });

  it('returns false for a stored string with invalid base64 hash', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    // Valid prefix and iterations, but invalid base64 in salt/hash that throws
    expect(await hasher.verify('pbkdf2$1000$!!!$@@@', 'password')).toBe(false);
  });

  it('returns false when derived hash length differs from stored', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    // Valid format but hash is only a few bytes (mismatched length triggers
    // constantTimeCompare length-check branch)
    const shortHash = btoa('ab').replace(/=/g, '');
    const salt = btoa('salt1234salt1234').replace(/=/g, '');
    expect(await hasher.verify(`pbkdf2$100000$${salt}$${shortHash}`, 'password')).toBe(false);
  });
});
