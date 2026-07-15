/**
 * Rate limit store interface and memory implementation.
 *
 * @module
 */

/**
 * Result of incrementing a rate limit counter.
 */
export interface RateLimitResult {
  /** Request count in the current window. */
  readonly count: number;
  /** Absolute timestamp (ms since epoch) when the window resets. */
  readonly resetTime: number;
}

/**
 * Store interface for rate limiting.
 */
export interface RateLimitStore {
  /**
   * Increment the counter for the given key within its window.
   * Creates the window if it does not exist.
   */
  increment(key: string, windowMs: number): RateLimitResult | Promise<RateLimitResult>;
  /** Reset the counter for the given key. */
  reset(key: string): void | Promise<void>;
}

/**
 * In-memory implementation of RateLimitStore.
 *
 * Uses a fixed-window algorithm: each key tracks a window start time and a
 * count. When the current time exceeds windowStart + windowMs, the window
 * resets.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  #map: Map<
    string,
    { count: number; windowStart: number }
  > = new Map();
  #runtime: { now(): number };

  constructor(runtime: { now(): number }) {
    this.#runtime = runtime;
  }

  increment(key: string, windowMs: number): RateLimitResult {
    const now = this.#runtime.now();
    const existing = this.#map.get(key);
    const windowStart = existing === undefined || existing.windowStart + windowMs <= now
      ? now
      : existing.windowStart;

    const count = existing === undefined || existing.windowStart + windowMs <= now
      ? 1
      : existing.count + 1;

    this.#map.set(key, { count, windowStart });

    return {
      count,
      resetTime: windowStart + windowMs,
    };
  }

  reset(key: string): void {
    this.#map.delete(key);
  }
}
