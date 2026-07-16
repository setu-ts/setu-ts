/**
 * In-memory distributed lock implementation.
 *
 * Provides process-local locking with the same contract as RedisLock,
 * making single-instance semantics identical to the distributed path:
 * a fire that overlaps a still-running previous fire of the same job
 * is skipped, and the lock self-heals via TTL if a handler dies without
 * releasing.
 *
 * Uses the runtime clock — never `Date.now()`.
 *
 * @module
 */
import type { IRuntimeServices } from '@hono-enterprise/common';
import type { IDistributedLock } from '../interfaces/index.ts';

/** Internal state for a held lock key. */
interface HeldKey {
  token: string;
  expiresAtMs: number;
}

/**
 * Process-local distributed lock.
 *
 * Keeps a `Map<key, { token, expiresAtMs }>` and checks expiry via
 * the provided runtime clock (`runtime.now()`).
 */
export class MemoryLock implements IDistributedLock {
  #held: Map<string, HeldKey>;
  #runtime: IRuntimeServices;

  constructor(runtime: IRuntimeServices) {
    this.#held = new Map();
    this.#runtime = runtime;
  }

  /**
   * Attempt to acquire the lock.
   *
   * @param key - The lock key
   * @param ttlMs - Time-to-live in milliseconds
   * @returns A unique token if acquired, or `null` if held
   */
  // deno-lint-ignore require-await
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const now = this.#runtime.now();
    const existing = this.#held.get(key);

    if (existing !== undefined && existing.expiresAtMs <= now) {
      this.#held.delete(key);
    }

    if (this.#held.has(key)) {
      return null;
    }

    const token = this.#runtime.uuid();
    this.#held.set(key, { token, expiresAtMs: now + ttlMs });
    return token;
  }

  /**
   * Release a previously acquired lock.
   *
   * @param key - The lock key
   * @param token - The token returned by `acquire`
   */
  // deno-lint-ignore require-await
  async release(key: string, token: string): Promise<void> {
    const existing = this.#held.get(key);
    if (existing === undefined || existing.token !== token) {
      return;
    }
    this.#held.delete(key);
  }
}
