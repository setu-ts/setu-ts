/**
 * Tests for PasswordHasher.
 */

import { describe, expect, it } from 'vitest';
import { MalformedPasswordHashError, PasswordHasher } from '../../src/services/password-hasher.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('PasswordHasher', () => {
  describe('iteration bounds (PR #183 review)', () => {
    it('rejects a digit run that saturates parseInt to Infinity', async () => {
      const hasher = new PasswordHasher(createFakeRuntime());
      // 400 nines parses to Infinity, which passes every `<=` bound and would
      // reach deriveBits — the disabled-bound case.
      const stored = `pbkdf2$${'9'.repeat(400)}$c2FsdA$aGFzaA`;
      await expect(hasher.verify(stored, 'pw')).rejects.toThrow(MalformedPasswordHashError);
    });

    it('rejects an iteration count above the supported work factor', async () => {
      const hasher = new PasswordHasher(createFakeRuntime());
      await expect(hasher.verify('pbkdf2$10000001$c2FsdA$aGFzaA', 'pw')).rejects.toThrow(
        /exceeds the maximum supported work factor/,
      );
    });

    it('accepts a real work factor at the cap', async () => {
      const hasher = new PasswordHasher(createFakeRuntime());
      // Not a valid hash, but it must fail on the HASH, never on the bound.
      await expect(hasher.verify('pbkdf2$10000000$c2FsdA$aGFzaA', 'pw')).resolves.toBe(false);
    });
  });
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

  it('throws MalformedPasswordHashError for a plaintext password in the stored position (reversed arguments)', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    await expect(hasher.verify('plaintext-password', 'password')).rejects.toThrow(
      MalformedPasswordHashError,
    );
  });

  it('throws MalformedPasswordHashError for a malformed stored string', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    await expect(hasher.verify('not-a-valid-hash', 'password')).rejects.toThrow(
      MalformedPasswordHashError,
    );
  });

  it('throws MalformedPasswordHashError for a stored string with wrong prefix', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    await expect(hasher.verify('bcrypt$1000$salt$hash', 'password')).rejects.toThrow(
      MalformedPasswordHashError,
    );
  });

  it('throws MalformedPasswordHashError for a stored string with too few parts', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    await expect(hasher.verify('pbkdf2$1000$salt', 'password')).rejects.toThrow(
      MalformedPasswordHashError,
    );
  });

  it('throws MalformedPasswordHashError for a stored string with invalid iterations', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    await expect(hasher.verify('pbkdf2$notanumber$salt$hash', 'password')).rejects.toThrow(
      MalformedPasswordHashError,
    );
  });

  it('throws MalformedPasswordHashError for iterations with trailing junk', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    // `parseInt` would silently accept `100000junk` as `100000` and verify a
    // corrupted hash; the strict parse must reject it instead.
    await expect(hasher.verify('pbkdf2$100000junk$salt$hash', 'password')).rejects.toThrow(
      MalformedPasswordHashError,
    );
  });

  it('still verifies a genuinely valid hash', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    const stored = await hasher.hash('mypassword123');
    expect(await hasher.verify(stored, 'mypassword123')).toBe(true);
  });

  it('throws MalformedPasswordHashError for a stored string with zero iterations', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    await expect(hasher.verify('pbkdf2$0$salt$hash', 'password')).rejects.toThrow(
      MalformedPasswordHashError,
    );
  });

  it('throws MalformedPasswordHashError for a stored string with negative iterations', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    await expect(hasher.verify('pbkdf2$-1$salt$hash', 'password')).rejects.toThrow(
      MalformedPasswordHashError,
    );
  });

  it('names both parameter positions when the stored value is not a hash', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    let error: unknown;
    try {
      await hasher.verify('plaintext-password', 'password');
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(MalformedPasswordHashError);
    expect((error as MalformedPasswordHashError).message).toContain('STORED HASH');
    expect((error as MalformedPasswordHashError).message).toContain('SECRET');
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
    expect(parts[1]).toBe('600000');

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

  it('throws MalformedPasswordHashError for a stored string with invalid base64 hash', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    // Valid prefix and iterations, but invalid base64 in salt/hash that throws
    await expect(hasher.verify('pbkdf2$1000$!!!$@@@', 'password')).rejects.toThrow(
      MalformedPasswordHashError,
    );
  });

  it('returns false when derived hash length differs from stored', async () => {
    const hasher = new PasswordHasher(createFakeRuntime());
    // Valid format but hash is only a few bytes (mismatched length triggers
    // constantTimeCompare length-check branch)
    const shortHash = btoa('ab').replace(/=/g, '');
    const salt = btoa('salt1234salt1234').replace(/=/g, '');
    expect(await hasher.verify(`pbkdf2$100000$${salt}$${shortHash}`, 'password')).toBe(false);
  });

  describe('work factor (M113e, V9-50)', () => {
    it('hashes at 600,000 iterations by default', async () => {
      const stored = await new PasswordHasher(createFakeRuntime()).hash('pw');
      expect(stored.split('$')[1]).toBe('600000');
    });

    it('hashes at a configured count', async () => {
      const hasher = new PasswordHasher(createFakeRuntime(), { iterations: 100_000 });
      const stored = await hasher.hash('pw');
      expect(stored.split('$')[1]).toBe('100000');
      expect(await hasher.verify(stored, 'pw')).toBe(true);
    });

    it.each([
      ['below the floor', 99_999],
      ['above the cap', 10_000_001],
      ['NaN', Number.NaN],
      ['a fraction', 100_000.5],
      ['infinity', Number.POSITIVE_INFINITY],
    ])('refuses %s at construction, naming the bounds and not the value', (_label, iterations) => {
      let error: unknown;
      try {
        new PasswordHasher(createFakeRuntime(), { iterations });
      } catch (e) {
        error = e;
      }
      expect(error).toBeInstanceOf(TypeError);
      const message = (error as TypeError).message;
      expect(message).toContain('from 100000 to 10000000');
      expect(message).not.toContain(String(iterations));
    });

    it('verifies a hash made at the previous default under the new one', async () => {
      const old = await new PasswordHasher(createFakeRuntime(), { iterations: 100_000 }).hash('pw');
      expect(await new PasswordHasher(createFakeRuntime()).verify(old, 'pw')).toBe(true);
    });

    it('reports a hash below the configured count as needing a rehash', async () => {
      const old = await new PasswordHasher(createFakeRuntime(), { iterations: 100_000 }).hash('pw');
      expect(new PasswordHasher(createFakeRuntime()).needsRehash(old)).toBe(true);
    });

    it('does not ask to rehash a hash at the configured count', async () => {
      const hasher = new PasswordHasher(createFakeRuntime(), { iterations: 200_000 });
      expect(hasher.needsRehash(await hasher.hash('pw'))).toBe(false);
    });

    it('never downgrades a hash above the configured count', async () => {
      const strong = await new PasswordHasher(createFakeRuntime(), {
        iterations: 300_000,
      }).hash('pw');
      const lowered = new PasswordHasher(createFakeRuntime(), { iterations: 100_000 });
      expect(lowered.needsRehash(strong)).toBe(false);
    });

    it.each([
      ['plaintext', 'plaintext-password'],
      ['trailing junk', 'pbkdf2$100000junk$salt$hash'],
      ['zero iterations', 'pbkdf2$0$c2FsdA$aGFzaA'],
      ['over the cap', 'pbkdf2$10000001$c2FsdA$aGFzaA'],
      ['bad base64', 'pbkdf2$1000$!!!$@@@'],
    ])('refuses %s exactly as verify does', async (_label, stored) => {
      const hasher = new PasswordHasher(createFakeRuntime());
      expect(() => hasher.needsRehash(stored)).toThrow(MalformedPasswordHashError);
      await expect(hasher.verify(stored, 'pw')).rejects.toThrow(MalformedPasswordHashError);
    });

    it('drives the sign-in upgrade loop: verify, rehash, verify at the new count', async () => {
      const runtime = createFakeRuntime();
      let stored = await new PasswordHasher(runtime, { iterations: 100_000 }).hash('pw');
      const hasher = new PasswordHasher(runtime);
      if ((await hasher.verify(stored, 'pw')) && hasher.needsRehash(stored)) {
        stored = await hasher.hash('pw');
      }
      expect(stored.split('$')[1]).toBe('600000');
      expect(hasher.needsRehash(stored)).toBe(false);
      expect(await hasher.verify(stored, 'pw')).toBe(true);
    });
  });
});
