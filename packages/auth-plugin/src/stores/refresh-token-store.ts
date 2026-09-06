/**
 * Refresh token store interface and memory implementation.
 *
 * @module
 */

import type { IPrincipal, IRuntimeServices } from '@setu-ts/common';

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
  /** Family identifier shared by a rotated refresh-token lineage. */
  readonly familyId?: string;
  /** Identifier of the paired access token, when issued by the current service. */
  readonly accessTokenJti?: string;
  /** Absolute expiry timestamp for the paired access token. */
  readonly accessTokenExpiresAt?: number;
}

/** Result of atomically rotating one refresh token into its successor. */
export interface RefreshTokenRotation {
  /** The presented record when it exists and has not expired, otherwise null. */
  readonly record: RefreshTokenRecord | null;
  /** Whether the presented token was live and the successor was stored. */
  readonly rotated: boolean;
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
  /**
   * Atomically consume a live refresh token and persist its successor.
   *
   * Remote implementations must make the conditional live-token check, parent
   * revocation, and successor write one atomic operation. This prevents two
   * concurrent refresh requests from minting independent descendants.
   */
  rotate(jti: string, successor: RefreshTokenRecord): Promise<RefreshTokenRotation>;
  /**
   * Revoke every refresh token in the requested token's family.
   *
   * Returns the affected records so the caller can also revoke their paired
   * access credentials through its separately configured store.
   */
  revokeFamily(jti: string): Promise<readonly RefreshTokenRecord[]>;
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

  rotate(jti: string, successor: RefreshTokenRecord): Promise<RefreshTokenRotation> {
    const record = this.#map.get(jti);
    if (record === undefined) {
      return Promise.resolve({ record: null, rotated: false });
    }
    if (this.#runtime.now() >= record.expiresAt) {
      this.#map.delete(jti);
      return Promise.resolve({ record: null, rotated: false });
    }
    if (record.revoked) {
      return Promise.resolve({ record, rotated: false });
    }

    record.revoked = true;
    this.#map.set(successor.jti, successor);
    return Promise.resolve({ record, rotated: true });
  }

  revokeFamily(jti: string): Promise<readonly RefreshTokenRecord[]> {
    const requested = this.#map.get(jti);
    if (requested === undefined) {
      return Promise.resolve([]);
    }
    if (this.#runtime.now() >= requested.expiresAt) {
      this.#map.delete(jti);
      return Promise.resolve([]);
    }

    const familyId = requested.familyId ?? requested.jti;
    const revoked: RefreshTokenRecord[] = [];
    for (const [candidateJti, candidate] of this.#map) {
      if (this.#runtime.now() >= candidate.expiresAt) {
        this.#map.delete(candidateJti);
        continue;
      }
      if ((candidate.familyId ?? candidate.jti) === familyId) {
        candidate.revoked = true;
        revoked.push(candidate);
      }
    }
    return Promise.resolve(revoked);
  }
}
