/**
 * Access-token revocation storage contracts.
 *
 * @module
 */

import type { IRuntimeServices } from '@setu-ts/common';

/**
 * Store for access-token identifiers revoked before their JWT expiry.
 *
 * Applications that run on more than one process must supply one shared
 * implementation to both `AuthPlugin` and `RefreshTokenService`.
 */
export interface AccessTokenRevocationStore {
  /** Record an access-token identifier as revoked until its expiry timestamp. */
  revoke(jti: string, expiresAt: number): Promise<void>;
  /** Return whether an access-token identifier is currently revoked. */
  isRevoked(jti: string): Promise<boolean>;
}

/**
 * Single-process access-token revocation store with lazy expiry.
 */
export class MemoryAccessTokenRevocationStore implements AccessTokenRevocationStore {
  readonly #revokedUntil = new Map<string, number>();
  readonly #runtime: IRuntimeServices;

  /** Create a store using the supplied runtime clock for lazy expiry. */
  constructor(runtime: IRuntimeServices) {
    this.#runtime = runtime;
  }

  revoke(jti: string, expiresAt: number): Promise<void> {
    if (!Number.isFinite(expiresAt)) {
      return Promise.reject(new Error('Access-token revocation expiry must be finite'));
    }
    const now = this.#runtime.now();
    this.#sweepExpired(now);
    if (expiresAt > now) {
      this.#revokedUntil.set(jti, expiresAt);
    }
    return Promise.resolve();
  }

  isRevoked(jti: string): Promise<boolean> {
    const now = this.#runtime.now();
    this.#sweepExpired(now);
    const expiresAt = this.#revokedUntil.get(jti);
    if (expiresAt === undefined) {
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }

  /** Remove every expired entry whenever the store is used. */
  #sweepExpired(now: number): void {
    for (const [jti, expiresAt] of this.#revokedUntil) {
      if (now >= expiresAt) {
        this.#revokedUntil.delete(jti);
      }
    }
  }
}
