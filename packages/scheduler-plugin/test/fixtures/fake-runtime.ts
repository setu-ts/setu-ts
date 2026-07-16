/**
 * Fake IRuntimeServices for deterministic testing.
 *
 * Controls `now()` and `setTimeout`/`setInterval` so fire timing
 * is deterministic in tests.
 *
 * @module
 */
import type { IRuntimeServices, TimerHandle } from '@hono-enterprise/common';
import type { RuntimePlatform } from '@hono-enterprise/common';

/** Pending timer. */
export interface PendingTimer {
  /** Unique timer id. */
  id: number;
  /** Callback to invoke when the timer fires. */
  fn: () => void | Promise<void>;
  /** Delay in ms. */
  delay: number;
  /** Whether this is an interval. */
  interval: boolean;
}

/**
 * A fake runtime that lets tests control the clock and fire timers
 * on demand.
 */
export class FakeRuntime implements IRuntimeServices {
  /** Controlled epoch time (ms). */
  #time = 1_700_000_000_000;

  /** Pending timers. */
  #timers: Map<number, PendingTimer> = new Map();

  /** Next timer id. */
  #nextId = 1;

  /** Counter for UUID generation. */
  #uuidCount = 0;

  /** Controlled environment variables. */
  #env: Readonly<Record<string, string | undefined>>;

  /** Pending async timer callbacks to await. */
  #pendingAsync: Array<Promise<void>> = [];

  constructor(env: Readonly<Record<string, string | undefined>> = {}) {
    this.#env = env;
  }

  platform(): RuntimePlatform {
    return 'deno';
  }

  version(): string {
    return '2.0.0';
  }

  hostname(): string {
    return 'test-host';
  }

  uuid(): string {
    this.#uuidCount++;
    return `test-uuid-${this.#uuidCount}`;
  }

  randomBytes(length: number): Uint8Array {
    return new Uint8Array(length);
  }

  get subtle(): SubtleCrypto {
    // Return a no-op subtle for tests
    throw new Error('SubtleCrypto not implemented in FakeRuntime');
  }

  now(): number {
    return this.#time;
  }

  hrtime(): number {
    return this.#time;
  }

  /**
   * Advance the fake clock by the given ms.
   * Fires any timers whose delay has elapsed and awaits async callbacks.
   *
   * @param ms - Milliseconds to advance
   */
  async advance(ms: number): Promise<void> {
    this.#time += ms;

    // Fire timers whose delay has elapsed
    const fired: PendingTimer[] = [];
    for (const timer of this.#timers.values()) {
      if (timer.delay <= ms) {
        fired.push(timer);
      }
    }

    for (const timer of fired) {
      const result = timer.fn();
      if (result instanceof Promise) {
        this.#pendingAsync.push(result);
      }
      if (!timer.interval) {
        this.#timers.delete(timer.id);
      }
      // Note: interval timers are NOT auto-rearmed here - the scheduler
      // re-arms them after each fire via #armInterval().
    }

    // Await all async callbacks
    await Promise.all(this.#pendingAsync);
    this.#pendingAsync = [];
  }

  /**
   * Get the count of pending timers.
   */
  getPendingTimerCount(): number {
    return this.#timers.size;
  }

  /**
   * Get the next pending timer delay.
   */
  getNextTimerDelay(): number | null {
    let min: number | null = null;
    for (const timer of this.#timers.values()) {
      if (min === null || timer.delay < min) {
        min = timer.delay;
      }
    }
    return min;
  }

  /**
   * Clear all pending timers without firing them.
   */
  clearAllTimers(): void {
    this.#timers.clear();
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    this.#timers.set(id, { id, fn, delay: ms, interval: false });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = this.#nextId++;
    this.#timers.set(id, { id, fn, delay: ms, interval: true });
    return id;
  }

  clearInterval(handle: TimerHandle): void {
    this.#timers.delete(handle as number);
  }

  get env(): Readonly<Record<string, string | undefined>> {
    return this.#env;
  }

  exit(code?: number): never {
    throw new Error(`FakeRuntime.exit(${code ?? 0})`);
  }
}
