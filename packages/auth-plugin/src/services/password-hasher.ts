/**
 * Password hashing service using PBKDF2-SHA256.
 *
 * @module
 */

import type { IRuntimeServices } from '@setu-ts/common';
import { toBuffer } from '../utils/buffer.ts';

/**
 * Default PBKDF2-SHA256 work factor: OWASP's 2023 password-storage guidance
 * (M113e, V9-50). Raised from 100,000; existing hashes keep verifying because
 * `verify` reads the count stored in each hash, and `needsRehash` tells the
 * application when to upgrade one.
 */
const DEFAULT_ITERATIONS = 600_000;
/**
 * Lowest configurable work factor — the previous default, so no configuration
 * is weaker than what shipped before. It is also the most a deployed
 * Cloudflare Worker is reported to accept.
 */
const MIN_ITERATIONS = 100_000;
const HASH_LENGTH = 32; // 256 bits
const SALT_LENGTH = 16; // 128 bits

/**
 * Thrown by {@linkcode PasswordHasher.verify} when the stored value is not a
 * well-formed `pbkdf2$<iterations>$<salt>$<hash>` string.
 *
 * This usually means the arguments were passed in reverse order — a plaintext
 * password in the `stored` position makes every correct verification fail, so
 * it is reported loudly here instead of indistinguishably as `false`.
 *
 * @example
 * ```typescript
 * try {
 *   const ok = await hasher.verify(stored, password);
 * } catch (error) {
 *   if (error instanceof MalformedPasswordHashError) {
 *     // The stored credential is corrupt, or verify's arguments are swapped
 *   }
 * }
 * ```
 * @since 0.3.0
 */
export class MalformedPasswordHashError extends Error {
  /** Discriminant for consumers that cannot use `instanceof` across realms. */
  override readonly name = 'MalformedPasswordHashError';
}

/**
 * Largest PBKDF2 iteration count `verify` will accept from a stored credential,
 * and the largest a hasher may be configured with. A sanity cap, not a policy:
 * it exists so a corrupted or hostile hash cannot drive an unbounded key
 * derivation.
 */
const MAX_ITERATIONS = 10_000_000;

/**
 * Options for {@linkcode PasswordHasher}.
 *
 * @since 0.10.0
 */
export interface PasswordHasherOptions {
  /**
   * PBKDF2-SHA256 iterations for NEW hashes: an integer from 100,000 to
   * 10,000,000, default 600,000. `verify` ignores it — every hash records its
   * own count — so changing it never breaks a stored credential.
   *
   * A deployed Cloudflare Worker is reported to refuse counts above 100,000;
   * a Workers application passes `iterations: 100_000`.
   */
  readonly iterations?: number;
}

/** A parsed `pbkdf2$<iterations>$<salt>$<hash>` credential. */
interface StoredHash {
  readonly iterations: number;
  readonly salt: Uint8Array;
  readonly hash: Uint8Array;
}

/**
 * Password hasher using PBKDF2-SHA256 via Web Crypto.
 *
 * @example
 * ```typescript
 * const hasher = new PasswordHasher(runtime); // 600,000 iterations
 * if (await hasher.verify(user.passwordHash, password)) {
 *   if (hasher.needsRehash(user.passwordHash)) {
 *     await users.update(user.id, { passwordHash: await hasher.hash(password) });
 *   }
 * }
 * ```
 */
export class PasswordHasher {
  private readonly runtime: IRuntimeServices;
  private readonly iterations: number;

  /**
   * @param runtime - Runtime services supplying `subtle` and `randomBytes`
   * @param options - Work factor for new hashes
   * @throws {TypeError} If `options.iterations` is not an integer from 100,000 to 10,000,000
   */
  constructor(runtime: IRuntimeServices, options: PasswordHasherOptions = {}) {
    const iterations = options.iterations ?? DEFAULT_ITERATIONS;
    // `Number.isInteger` refuses NaN, infinities and fractions: an unset
    // environment variable read through `Number(...)` is NaN, and a work
    // factor that silently fell back would weaken every new hash.
    if (
      !Number.isInteger(iterations) ||
      iterations < MIN_ITERATIONS ||
      iterations > MAX_ITERATIONS
    ) {
      throw new TypeError(
        `PasswordHasher option 'iterations' must be an integer from ${MIN_ITERATIONS} to ` +
          `${MAX_ITERATIONS}.`,
      );
    }
    this.runtime = runtime;
    this.iterations = iterations;
  }

  /**
   * Hash a secret (password) with a random salt.
   *
   * @param secret - The password to hash
   * @returns Stored string in format `pbkdf2$<iterations>$<salt>$<hash>`
   */
  async hash(secret: string): Promise<string> {
    const salt = this.runtime.randomBytes(SALT_LENGTH);
    const hash = await this.deriveHash(secret, salt, this.iterations);

    const iterationsStr = String(this.iterations);
    const saltStr = this.base64UrlEncode(salt);
    const hashStr = this.base64UrlEncode(hash);

    return `pbkdf2$${iterationsStr}$${saltStr}$${hashStr}`;
  }

  /**
   * Verify a secret against a stored hash.
   *
   * A wrong secret returns `false`; a stored value that is not a well-formed
   * `pbkdf2$…` string throws {@linkcode MalformedPasswordHashError}, because
   * that shape of failure is a programming error (most often reversed
   * arguments) rather than a failed login.
   *
   * @param stored - The stored hash string in `pbkdf2$<iterations>$<salt>$<hash>` format
   * @param secret - The password to verify
   * @returns `true` if the secret matches, `false` otherwise
   * @throws {MalformedPasswordHashError} If `stored` is not a well-formed `pbkdf2$…` string
   */
  async verify(stored: string, secret: string): Promise<boolean> {
    const parsed = this.parseStoredHash(stored);
    const actualHash = await this.deriveHash(secret, parsed.salt, parsed.iterations);

    // Constant-time comparison
    return this.constantTimeCompare(actualHash, parsed.hash);
  }

  /**
   * Reports whether a stored hash was made with fewer iterations than this
   * hasher is configured for, so the application re-hashes it after the next
   * successful {@linkcode PasswordHasher.verify} — the only moment the
   * plaintext is available.
   *
   * A hash at or above the configured count reports `false`, so lowering the
   * configuration never downgrades a stored credential.
   *
   * @param stored - The stored hash string in `pbkdf2$<iterations>$<salt>$<hash>` format
   * @returns `true` when the hash should be replaced
   * @throws {MalformedPasswordHashError} On every input `verify` refuses
   * @since 0.10.0
   */
  needsRehash(stored: string): boolean {
    return this.parseStoredHash(stored).iterations < this.iterations;
  }

  /**
   * Parses a stored credential, refusing a malformed one. The single parse
   * `verify` and `needsRehash` share, so the two cannot disagree about which
   * inputs are well-formed.
   */
  private parseStoredHash(stored: string): StoredHash {
    const parts = stored.split('$');
    if (parts.length !== 4 || parts[0] !== 'pbkdf2') {
      throw new MalformedPasswordHashError(
        'the stored credential is not a pbkdf2$<iterations>$<salt>$<hash> string — ' +
          'check that the STORED HASH is passed first and the SECRET second to PasswordHasher.verify',
      );
    }

    // Strict digits-only parse: `parseInt` would accept trailing junk
    // (`100000junk` → `100000`) and treat a corrupted hash as well-formed.
    if (!/^\d+$/.test(parts[1])) {
      throw new MalformedPasswordHashError(
        `the stored credential's iterations part '${parts[1]}' is not a positive integer`,
      );
    }
    // `parseInt` saturates to Infinity past ~308 digits, and Infinity passes
    // every `<=` bound — the classic disabled-bound case — so a corrupted hash
    // carrying a long digit run would otherwise reach `deriveBits`. The upper
    // bound below catches it: every value `/^\d+$/` admits that is not a safe
    // integer also exceeds MAX_ITERATIONS, so no separate finiteness check is
    // reachable. The bound is a sanity cap, well above any real work factor.
    const iterations = parseInt(parts[1], 10);
    if (iterations <= 0) {
      throw new MalformedPasswordHashError(
        `the stored credential's iterations part '${parts[1]}' is not a positive integer`,
      );
    }
    if (iterations > MAX_ITERATIONS) {
      throw new MalformedPasswordHashError(
        `the stored credential's iterations part '${parts[1]}' exceeds the maximum supported ` +
          `work factor (${MAX_ITERATIONS})`,
      );
    }

    try {
      return {
        iterations,
        salt: this.base64UrlDecode(parts[2]),
        hash: this.base64UrlDecode(parts[3]),
      };
    } catch {
      throw new MalformedPasswordHashError(
        "the stored credential's salt/hash parts are not valid base64url",
      );
    }
  }

  /**
   * Derive a hash using PBKDF2-SHA256.
   */
  private async deriveHash(
    secret: string,
    salt: Uint8Array,
    iterations: number,
  ): Promise<Uint8Array> {
    const keyMaterial = await this.runtime.subtle.importKey(
      'raw',
      toBuffer(new TextEncoder().encode(secret)),
      { name: 'PBKDF2' },
      false,
      ['deriveBits'],
    );

    const derivedBits = await this.runtime.subtle.deriveBits(
      {
        name: 'PBKDF2',
        salt: toBuffer(salt),
        iterations,
        hash: 'SHA-256',
      },
      keyMaterial,
      HASH_LENGTH * 8, // bits
    );

    return new Uint8Array(derivedBits);
  }

  /**
   * Base64url encode bytes.
   */
  private base64UrlEncode(bytes: Uint8Array): string {
    const binary = String.fromCharCode(...bytes);
    const base64 = btoa(binary);
    return base64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  /**
   * Base64url decode to bytes.
   */
  private base64UrlDecode(input: string): Uint8Array {
    let base64 = input.replace(/-/g, '+').replace(/_/g, '/');
    while (base64.length % 4 !== 0) {
      base64 += '=';
    }
    const binary = atob(base64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
  }

  /**
   * Constant-time comparison to prevent timing attacks.
   */
  private constantTimeCompare(a: Uint8Array, b: Uint8Array): boolean {
    if (a.length !== b.length) {
      return false;
    }

    let result = 0;
    for (let i = 0; i < a.length; i++) {
      result |= a[i] ^ b[i];
    }

    return result === 0;
  }
}
