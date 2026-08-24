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
import type { IRuntimeServices } from '@setu-ts/common';
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
   * Number of keys currently held (including not-yet-swept expired ones).
   *
   * Diagnostic surface for tests and health tooling; the scheduler's
   * never-released slot keys make "how many entries exist" observable, which
   * is what bounds the map.
   */
  get size(): number {
    return this.#held.size;
  }

  /**
   * Attempt to acquire the lock.
   *
   * Sweeps EVERY expired entry before its own lookup, not just the key being
   * acquired. The scheduler's fire-slot keys (M70l) are never released and
   * never reacquired, so a lazy per-key delete could never reclaim them and
   * the map would grow one entry per job per fire, forever. The map is bounded
   * by jobs × ttl ÷ interval, so a full sweep is cheap.
   *
   * @param key - The lock key
   * @param ttlMs - Time-to-live in milliseconds
   * @returns A unique token if acquired, or `null` if held
   */
  // deno-lint-ignore require-await
  async acquire(key: string, ttlMs: number): Promise<string | null> {
    const now = this.#runtime.now();

    for (const [expiredKey, held] of this.#held) {
      if (held.expiresAtMs <= now) {
        this.#held.delete(expiredKey);
      }
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
