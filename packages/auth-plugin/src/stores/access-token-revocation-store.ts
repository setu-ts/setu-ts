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
export interface IAccessTokenRevocationStore {
  /** Record an access-token identifier as revoked until its expiry timestamp. */
  revoke(jti: string, expiresAt: number): Promise<void>;
  /** Return whether an access-token identifier is currently revoked. */
  isRevoked(jti: string): Promise<boolean>;
}

/**
 * Single-process access-token revocation store with bounded lazy expiry work.
 */
export class MemoryAccessTokenRevocationStore implements IAccessTokenRevocationStore {
  readonly #revokedUntil = new Map<string, number>();
  #expiryHeap: IExpiryEntry[] = [];
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
      this.#pushExpiry({ jti, expiresAt });
    }
    return Promise.resolve();
  }

  isRevoked(jti: string): Promise<boolean> {
    const now = this.#runtime.now();
    this.#sweepExpired(now);
    const expiresAt = this.#revokedUntil.get(jti);
    if (expiresAt === undefined || now >= expiresAt) {
      this.#revokedUntil.delete(jti);
      return Promise.resolve(false);
    }
    return Promise.resolve(true);
  }

  /** Remove a bounded number of expired entries whenever the store is used. */
  #sweepExpired(now: number): void {
    for (let count = 0; count < MAXIMUM_EXPIRY_CLEANUP_PER_OPERATION; count++) {
      const entry = this.#expiryHeap[0];
      if (entry === undefined || now < entry.expiresAt) {
        return;
      }
      this.#popExpiry();
      if (this.#revokedUntil.get(entry.jti) === entry.expiresAt) {
        this.#revokedUntil.delete(entry.jti);
      }
    }
  }

  /** Add one expiry to the min-heap used for incremental cleanup. */
  #pushExpiry(entry: IExpiryEntry): void {
    this.#expiryHeap.push(entry);
    let index = this.#expiryHeap.length - 1;
    while (index > 0) {
      const parent = Math.floor((index - 1) / 2);
      if (this.#expiryHeap[parent]!.expiresAt <= entry.expiresAt) {
        return;
      }
      this.#expiryHeap[index] = this.#expiryHeap[parent]!;
      index = parent;
    }
    this.#expiryHeap[index] = entry;
  }

  /** Remove the earliest expiry from the min-heap. */
  #popExpiry(): void {
    const first = this.#expiryHeap[0];
    const last = this.#expiryHeap.pop();
    if (first === undefined || last === undefined || this.#expiryHeap.length === 0) {
      return;
    }

    let index = 0;
    while (true) {
      const left = (index * 2) + 1;
      const right = left + 1;
      if (left >= this.#expiryHeap.length) {
        break;
      }
      const smallerChild = right < this.#expiryHeap.length &&
          this.#expiryHeap[right]!.expiresAt < this.#expiryHeap[left]!.expiresAt
        ? right
        : left;
      if (this.#expiryHeap[smallerChild]!.expiresAt >= last.expiresAt) {
        break;
      }
      this.#expiryHeap[index] = this.#expiryHeap[smallerChild]!;
      index = smallerChild;
    }
    this.#expiryHeap[index] = last;
  }
}

/** One access-token identifier paired with its absolute revocation expiry. */
interface IExpiryEntry {
  readonly jti: string;
  readonly expiresAt: number;
}

/** Upper bound on expired entries removed by one store operation. */
const MAXIMUM_EXPIRY_CLEANUP_PER_OPERATION = 64;
