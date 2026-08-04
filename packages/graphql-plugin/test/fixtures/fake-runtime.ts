/**
 * A minimal `IRuntimeServices` double for the transport unit tests.
 *
 * The timers are DRIVABLE rather than real: a test advances them by calling
 * {@linkcode FakeRuntime.runTimer}, so an init-timeout or a heartbeat tick is
 * exercised deterministically instead of by waiting on the clock. That is the
 * reason the transports take runtime services at all rather than reaching for
 * the global `setTimeout` — the global one cannot be driven, and a plugin
 * reaching for a runtime API directly is banned outside `packages/runtime`.
 */

import type { IRuntimeServices, TimerHandle } from '@hono-enterprise/common';

interface ScheduledTimer {
  readonly fn: () => void;
  readonly ms: number;
  readonly repeating: boolean;
  cancelled: boolean;
}

/** A drivable runtime double exposing just what the transports use. */
export class FakeRuntime {
  #next = 1;
  readonly timers = new Map<number, ScheduledTimer>();

  /** The `IRuntimeServices`-shaped view handed to production code. */
  get services(): IRuntimeServices {
    return this as unknown as IRuntimeServices;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.#next++;
    this.timers.set(id, { fn, ms, repeating: false, cancelled: false });
    return id as unknown as TimerHandle;
  }

  clearTimeout(handle: TimerHandle): void {
    this.#cancel(handle);
  }

  setInterval(fn: () => void, ms: number): TimerHandle {
    const id = this.#next++;
    this.timers.set(id, { fn, ms, repeating: true, cancelled: false });
    return id as unknown as TimerHandle;
  }

  clearInterval(handle: TimerHandle): void {
    this.#cancel(handle);
  }

  #cancel(handle: TimerHandle): void {
    const timer = this.timers.get(handle as unknown as number);
    if (timer) {
      timer.cancelled = true;
      this.timers.delete(handle as unknown as number);
    }
  }

  /** Number of timers still armed — a leak check for close/cleanup paths. */
  get activeTimerCount(): number {
    return this.timers.size;
  }

  /** Fire every armed timer once, in registration order. */
  runTimers(): void {
    for (const [id, timer] of [...this.timers]) {
      if (timer.cancelled) continue;
      if (!timer.repeating) {
        this.timers.delete(id);
      }
      timer.fn();
    }
  }
}

/** Convenience: a fresh fake plus its `IRuntimeServices` view. */
export function createFakeRuntime(): { fake: FakeRuntime; runtime: IRuntimeServices } {
  const fake = new FakeRuntime();
  return { fake, runtime: fake.services };
}
