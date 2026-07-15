/**
 * Password hashing service using PBKDF2-SHA256.
 *
 * @module
 */

import type { IRuntimeServices } from '@hono-enterprise/common';
import { toBuffer } from '../utils/buffer.ts';

const PBKDF2_ITERATIONS = 100000;
const HASH_LENGTH = 32; // 256 bits
const SALT_LENGTH = 16; // 128 bits

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
   * @param stored - The stored hash string
   * @param secret - The password to verify
   * @returns `true` if the secret matches, `false` otherwise
   */
  async verify(stored: string, secret: string): Promise<boolean> {
    try {
      const parts = stored.split('$');
      if (parts.length !== 4 || parts[0] !== 'pbkdf2') {
        return false;
      }

      const iterations = parseInt(parts[1], 10);
      if (isNaN(iterations) || iterations <= 0) {
        return false;
      }

      const salt = this.base64UrlDecode(parts[2]);
      const expectedHash = this.base64UrlDecode(parts[3]);

      const actualHash = await this.deriveHash(secret, salt, iterations);

      // Constant-time comparison
      return this.constantTimeCompare(actualHash, expectedHash);
    } catch {
      return false;
    }
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
