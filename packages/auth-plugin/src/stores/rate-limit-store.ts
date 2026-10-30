/**
 * Rate limit store interface and memory implementation.
 *
 * @module
 */

import type { IRuntimeServices } from '@setu-ts/common';
import { sweepExpired } from './sweep-expired.ts';

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
  increment(key: string, windowMs: number): Promise<RateLimitResult>;
  /** Reset the counter for the given key. */
  reset(key: string): Promise<void>;
}

/**
 * In-memory implementation of RateLimitStore.
 *
 * Uses a fixed-window algorithm: each key tracks a window start time and a
 * count. When the current time reaches windowStart + windowMs, the window
 * resets. Amortised sweeps on increment reclaim expired windows, keeping
 * memory proportional to distinct keys in live windows plus the doubling-threshold
 * sweep slack (minimum threshold 1,024). Live windows are never evicted for a cap.
 */
export class MemoryRateLimitStore implements RateLimitStore {
  #map: Map<string, { count: number; windowStart: number; windowMs: number }> = new Map();
  #runtime: IRuntimeServices;
  #sweepAt = 1_024;

  constructor(runtime: IRuntimeServices) {
    this.#runtime = runtime;
  }

  increment(key: string, windowMs: number): Promise<RateLimitResult> {
    const now = this.#runtime.now();
    this.#sweepAt = sweepExpired(
      this.#map,
      this.#sweepAt,
      (entry) => entry.windowStart + entry.windowMs <= now,
    );
    const existing = this.#map.get(key);
    const expired = existing === undefined || existing.windowStart + windowMs <= now;
    const windowStart = expired ? now : existing.windowStart;
    const count = expired ? 1 : existing.count + 1;

    this.#map.set(key, { count, windowStart, windowMs });

    return Promise.resolve({
      count,
      resetTime: windowStart + windowMs,
    });
  }

  reset(key: string): Promise<void> {
    this.#map.delete(key);
    return Promise.resolve();
  }
}
