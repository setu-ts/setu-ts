/**
 * Refresh token store interface and memory implementation.
 *
 * @module
 */

import type { IPrincipal, IRuntimeServices } from '@hono-enterprise/common';

/**
 * A refresh token record stored on the server.
 */
export interface RefreshTokenRecord {
  /** Unique token identifier (from JWT jti claim). */
  readonly jti: string;
  /** Principal ID the token belongs to. */
  readonly principalId: string;
  /** Snapshot of the principal at issue time. */
  readonly principal: IPrincipal;
  /** Absolute expiry timestamp (ms since epoch). */
  readonly expiresAt: number;
  /** Whether the token has been revoked. */
  revoked: boolean;
}

/**
 * Store interface for refresh tokens.
 *
 * Implementations must track each jti so the service can rotate (revoke the
 * presented token, issue a new pair) and revoke (logout). All methods are
 * async so remote backends (e.g. a future Redis store) can implement the
 * interface without a breaking change.
 */
export interface RefreshTokenStore {
  /** Store or update a refresh token record. */
  save(record: RefreshTokenRecord): Promise<void>;
  /**
   * Retrieve a record by jti; returns null if missing or expired. A revoked
   * record is still returned so the caller can distinguish replay of a
   * rotated token from an unknown token.
   */
  get(jti: string): Promise<RefreshTokenRecord | null>;
  /** Revoke a token by jti. */
  revoke(jti: string): Promise<void>;
}

/**
 * In-memory implementation of RefreshTokenStore.
 *
 * Entries are lazily expired on get() — when runtime.now() >= expiresAt the
 * entry is deleted and null is returned. This keeps the map bounded without
 * requiring a background cleanup job.
 */
export class MemoryRefreshTokenStore implements RefreshTokenStore {
  #map: Map<string, RefreshTokenRecord> = new Map();
  #runtime: IRuntimeServices;

  constructor(runtime: IRuntimeServices) {
    this.#runtime = runtime;
  }

  save(record: RefreshTokenRecord): Promise<void> {
    this.#map.set(record.jti, record);
    return Promise.resolve();
  }

  get(jti: string): Promise<RefreshTokenRecord | null> {
    const record = this.#map.get(jti);
    if (record === undefined) {
      return Promise.resolve(null);
    }
    // Lazy expiry check
    if (this.#runtime.now() >= record.expiresAt) {
      this.#map.delete(jti);
      return Promise.resolve(null);
    }
    return Promise.resolve(record);
  }

  revoke(jti: string): Promise<void> {
    const record = this.#map.get(jti);
    if (record !== undefined) {
      record.revoked = true;
    }
    return Promise.resolve();
  }
}
