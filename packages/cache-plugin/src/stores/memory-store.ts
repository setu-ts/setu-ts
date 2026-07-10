// deno-lint-ignore-file require-await -- interface requires Promise return types
/**
 * In-memory cache store with LRU eviction and per-entry TTL.
 *
 * Uses `runtime.hrtime()` (monotonic ms) for TTL expiry — never `Date.now()`.
 *
 * @module
 */
import type { CacheStore } from './cache-store.ts';

/** Internal entry stored in the Map. */
interface Entry<T = unknown> {
  /** The cached value. */
  value: T;
  /** Monotonic timestamp (ms) when this entry expires; `Infinity` = no expiry. */
  expiresAt: number;
}

/** Default maximum entry count before LRU eviction. */
const DEFAULT_MAX_SIZE = 1000;

/**
 * Monotonic clock function. Defaults to a bound `performance.now()` but
 * accepts an injected clock for deterministic testing.
 */
type ClockFn = () => number;

/**
 * In-memory cache implementation with LRU eviction and lazy TTL expiry.
 *
 * On `get` of a live entry, the entry is deleted and re-inserted (moves to
 * MRU position). On `set`, if the map exceeds `maxSize`, the oldest entry
 * (first Map key) is evicted. Expired entries are lazily deleted on read
 * (`get`/`has`).
 *
 * The constructor accepts a `prefix` for interface parity with other backends,
 * but MemoryStore intentionally does not use it: each plugin instance owns
 * its own Map, so emptying it in `clear()` naturally scopes to this instance.
 *
 * @since 0.1.0
 */
export class MemoryStore implements CacheStore {
  #map = new Map<string, Entry>();
  #maxSize: number;
  #clock: ClockFn;
  #ready = false;

  /**
   * @param prefix - Key prefix (accepted for interface parity; intentionally
   *   unused since each instance owns its own Map).
   * @param options - Configuration
   * @param options.maxSize - Maximum entry count (default 1000)
   * @param options.clock - Monotonic clock function (default bound `performance.now`)
   */
  constructor(
    _prefix: string,
    options?: { maxSize?: number | undefined; clock?: ClockFn | undefined },
  ) {
    this.#maxSize = options?.maxSize ?? DEFAULT_MAX_SIZE;
    this.#clock = options?.clock ?? (() => performance.now());
  }

  connect(): Promise<void> {
    this.#ready = true;
    return Promise.resolve();
  }

  disconnect(): Promise<void> {
    this.#ready = false;
    this.#map.clear();
    return Promise.resolve();
  }

  isReady(): boolean {
    return this.#ready;
  }

  async get<T>(key: string): Promise<T | null> {
    const entry = this.#map.get(key);
    if (entry === undefined) {
      return null;
    }
    // Lazy expiry check
    if (this.#clock() > entry.expiresAt) {
      this.#map.delete(key);
      return null;
    }
    // LRU: promote to MRU by delete + re-insert
    const value = entry.value;
    this.#map.delete(key);
    this.#map.set(key, { value, expiresAt: entry.expiresAt });
    return value as T;
  }

  async set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    // Evict if already at capacity (for new keys or overwrites)
    if (!this.#map.has(key) && this.#map.size >= this.#maxSize) {
      const oldestKey = this.#map.keys().next().value;
      if (oldestKey !== undefined) {
        this.#map.delete(oldestKey);
      }
    }
    const expiresAt = ttlSeconds !== undefined ? this.#clock() + ttlSeconds * 1000 : Infinity;
    this.#map.delete(key); // Ensure MRU position on overwrite
    this.#map.set(key, { value, expiresAt });
  }

  async delete(key: string): Promise<boolean> {
    return this.#map.delete(key);
  }

  async has(key: string): Promise<boolean> {
    const entry = this.#map.get(key);
    if (entry === undefined) {
      return false;
    }
    // Lazy expiry check
    if (this.#clock() > entry.expiresAt) {
      this.#map.delete(key);
      return false;
    }
    return true;
  }

  async clear(): Promise<void> {
    this.#map.clear();
  }
}
