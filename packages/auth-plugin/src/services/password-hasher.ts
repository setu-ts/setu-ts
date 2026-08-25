/**
 * Password hashing service using PBKDF2-SHA256.
 *
 * @module
 */

import type { IRuntimeServices } from '@setu-ts/common';
import { toBuffer } from '../utils/buffer.ts';

const PBKDF2_ITERATIONS = 100000;
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
 * Password hasher using PBKDF2-SHA256 via Web Crypto.
 */
export class PasswordHasher {
  private readonly runtime: IRuntimeServices;

  constructor(runtime: IRuntimeServices) {
    this.runtime = runtime;
  }

  /**
   * Hash a secret (password) with a random salt.
   *
   * @param secret - The password to hash
   * @returns Stored string in format `pbkdf2$<iterations>$<salt>$<hash>`
   */
  async hash(secret: string): Promise<string> {
    const salt = this.runtime.randomBytes(SALT_LENGTH);
    const hash = await this.deriveHash(secret, salt);

    const iterationsStr = String(PBKDF2_ITERATIONS);
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
    const iterations = parseInt(parts[1], 10);
    if (iterations <= 0) {
      throw new MalformedPasswordHashError(
        `the stored credential's iterations part '${parts[1]}' is not a positive integer`,
      );
    }

    let salt: Uint8Array;
    let expectedHash: Uint8Array;
    try {
      salt = this.base64UrlDecode(parts[2]);
      expectedHash = this.base64UrlDecode(parts[3]);
    } catch {
      throw new MalformedPasswordHashError(
        "the stored credential's salt/hash parts are not valid base64url",
      );
    }

    const actualHash = await this.deriveHash(secret, salt, iterations);

    // Constant-time comparison
    return this.constantTimeCompare(actualHash, expectedHash);
  }

  /**
   * Derive a hash using PBKDF2-SHA256.
   */
  private async deriveHash(
    secret: string,
    salt: Uint8Array,
    iterations: number = PBKDF2_ITERATIONS,
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
