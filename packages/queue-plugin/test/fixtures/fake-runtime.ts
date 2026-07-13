/**
 * Fake runtime services for testing.
 *
 * Provides a controllable clock, manually-advanced timers, and sequenced UUIDs.
 *
 * @module
 */

import type { IRuntimeServices } from '@hono-enterprise/common';

/**
 * A controllable timer handle.
 */
interface FakeTimerHandle {
  id: number;
  callback: () => void | Promise<void>;
  intervalMs: number;
  fired: number;
}

// Global set to track pending promises for testing
const pendingPromises = new Set<Promise<unknown>>();

/**
 * Fake runtime services implementation.
 */
export class FakeRuntimeServices implements IRuntimeServices {
  #now: number;
  #uuidCounter: number;
  #timers: Map<number, FakeTimerHandle>;
  #nextTimerId: number;

  constructor(startMs: number = Date.now()) {
    this.#now = startMs;
    this.#uuidCounter = 0;
    this.#timers = new Map();
    this.#nextTimerId = 1;
  }

  platform(): 'deno' | 'node' | 'bun' | 'cloudflare-workers' {
    return 'deno';
  }

  version(): string {
    return '1.0.0';
  }

  hostname(): string {
    return 'localhost';
  }

  randomBytes(_length: number): Uint8Array {
    return new Uint8Array(0);
  }

  get subtle(): SubtleCrypto {
    throw new Error('Not implemented in fake runtime');
  }

  hrtime(): number {
    return this.#now;
  }

  setTimeout(fn: () => void, ms: number): number {
    const id = this.#nextTimerId++;
    const handle: FakeTimerHandle = {
      id,
      callback: fn,
      intervalMs: ms,
      fired: 0,
    };
    this.#timers.set(id, handle);
    return id;
  }

  clearTimeout(_handle: number): void {
    // No-op in fake
  }

  get env(): Readonly<Record<string, string | undefined>> {
    return {};
  }

  exit(_code?: number): never {
    throw new Error('Exit called in fake runtime');
  }

  /**
   * Current timestamp.
   */
  now(): number {
    return this.#now;
  }

  /**
   * Advance the fake clock.
   */
  async advanceMs(ms: number): Promise<void> {
    this.#now += ms;

    // Fire any timers that should have fired
    const toFire: FakeTimerHandle[] = [];
    for (const timer of this.#timers.values()) {
      // Check if timer should fire based on elapsed time
      if (timer.fired * timer.intervalMs < this.#now) {
        toFire.push(timer);
      }
    }

    // Fire timers and await async callbacks
    const promises: Promise<void>[] = [];
    for (const timer of toFire) {
      timer.fired++;
      const result = timer.callback();
      if (result instanceof Promise) {
        promises.push(result);
      }
    }

    // Wait for all async callbacks to complete
    await Promise.all(promises);

    // Wait for any nested promises (e.g., job processing)
    // Keep waiting until no new promises are created
    let iterations = 0;
    const maxIterations = 10;
    while (pendingPromises.size > 0 && iterations < maxIterations) {
      const currentPromises = Array.from(pendingPromises);
      pendingPromises.clear();
      await Promise.all(currentPromises);
      iterations++;
    }
  }

  /**
   * Generate a UUID.
   */
  uuid(): string {
    const id = this.#uuidCounter++;
    return `fake-uuid-${id}`;
  }

  setInterval(fn: () => void, ms: number): number {
    const id = this.#nextTimerId++;
    const handle: FakeTimerHandle = {
      id,
      callback: fn,
      intervalMs: ms,
      fired: 0,
    };
    this.#timers.set(id, handle);
    return id;
  }

  clearInterval(handle: number): void {
    this.#timers.delete(handle);
  }

  /**
   * Get the number of active timers.
   */
  get timerCount(): number {
    return this.#timers.size;
  }

  /**
   * Clear all timers.
   */
  clearAllTimers(): void {
    this.#timers.clear();
  }

  /**
   * Track a promise for later awaiting (used by job processing).
   */
  trackPromise<T>(promise: Promise<T>): Promise<T> {
    pendingPromises.add(promise);
    return promise.finally(() => pendingPromises.delete(promise));
  }
}
