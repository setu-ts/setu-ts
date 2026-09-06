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
    if (expiresAt > this.#runtime.now()) {
      this.#revokedUntil.set(jti, expiresAt);
    }
    return Promise.resolve();
  }

  isRevoked(jti: string): Promise<boolean> {
    const expiresAt = this.#revokedUntil.get(jti);
    if (expiresAt === undefined) {
      return Promise.resolve(false);
    }
    if (this.#runtime.now() >= expiresAt) {
      this.#revokedUntil.delete(jti);
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }
}
