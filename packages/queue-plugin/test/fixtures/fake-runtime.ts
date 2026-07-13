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
  /** Fake-clock time at which this timer next fires. */
  nextFireAtMs: number;
  /** `true` for setInterval (reschedules), `false` for setTimeout (one-shot). */
  repeating: boolean;
}

/** How far the clock moves between timer sweeps inside {@linkcode FakeRuntimeServices.advanceMs}. */
const STEP_MS = 100;

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
      nextFireAtMs: this.#now + ms,
      repeating: false,
    };
    this.#timers.set(id, handle);
    return id;
  }

  clearTimeout(handle: number): void {
    this.#timers.delete(handle);
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
   * Advances the fake clock, firing every timer whose due time is crossed.
   *
   * The clock moves in {@linkcode STEP_MS} steps so an interval fires once per
   * elapsed period rather than once per call, which is what lets a test observe
   * a job that stays in flight across several poll ticks.
   */
  async advanceMs(ms: number): Promise<void> {
    const targetTime = this.#now + ms;

    while (this.#now < targetTime) {
      this.#now += Math.min(STEP_MS, targetTime - this.#now);

      const toFire = [...this.#timers.values()].filter((t) => this.#now >= t.nextFireAtMs);

      const settled: Promise<void>[] = [];
      for (const timer of toFire) {
        if (timer.repeating) {
          timer.nextFireAtMs += timer.intervalMs;
        } else {
          this.#timers.delete(timer.id);
        }
        const result = timer.callback();
        if (result instanceof Promise) {
          settled.push(result);
        }
      }

      await Promise.all(settled);

      // The service dispatches jobs as fire-and-forget promises the timer
      // callback does not return, so drain the microtask queue to let them run.
      await this.#drainMicrotasks();
    }
  }

  /**
   * Yields repeatedly so already-scheduled microtask chains (a dispatched job
   * running its processor, then acking) can settle before the clock moves on.
   */
  async #drainMicrotasks(): Promise<void> {
    for (let i = 0; i < 10; i++) {
      await Promise.resolve();
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
      nextFireAtMs: this.#now + ms,
      repeating: true,
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
}
