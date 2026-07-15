/**
 * Refresh token store interface and memory implementation.
 *
 * @module
 */

import type { IPrincipal } from '@hono-enterprise/common';

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
 * presented token, issue a new pair) and revoke (logout).
 */
export interface RefreshTokenStore {
  /** Store or update a refresh token record. */
  save(record: RefreshTokenRecord): void;
  /** Retrieve a record by jti; returns null if missing or expired. */
  get(jti: string): RefreshTokenRecord | null;
  /** Revoke a token by jti. */
  revoke(jti: string): void;
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
  #runtime: { now(): number };

  constructor(runtime: { now(): number }) {
    this.#runtime = runtime;
  }

  save(record: RefreshTokenRecord): void {
    this.#map.set(record.jti, record);
  }

  get(jti: string): RefreshTokenRecord | null {
    const record = this.#map.get(jti);
    if (record === undefined) {
      return null;
    }
    // Lazy expiry check
    if (this.#runtime.now() >= record.expiresAt) {
      this.#map.delete(jti);
      return null;
    }
    if (record.revoked) {
      return null;
    }
    return record;
  }

  revoke(jti: string): void {
    const record = this.#map.get(jti);
    if (record !== undefined) {
      record.revoked = true;
    }
  }
}
