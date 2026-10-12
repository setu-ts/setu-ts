import type { IRuntimeServices, TimerHandle } from '@setu-ts/common';
import { createFakeRuntime } from './fake-runtime.ts';

/** Manual monotonic clock with opaque, identity-sensitive timer handles. */
export function clockRuntime(): {
  runtime: IRuntimeServices;
  advance: (ms: number) => Promise<void>;
  timerCount: () => number;
} {
  let now = 0;
  const timers = new Map<
    TimerHandle,
    { fn: () => void; ms: number; due: number; repeat: boolean }
  >();
  const set = (fn: () => void, ms: number, repeat: boolean): TimerHandle => {
    const handle = Object.freeze({ token: Symbol('timer') });
    timers.set(handle, { fn, ms, due: now + ms, repeat });
    return handle;
  };
  const runtime: IRuntimeServices = {
    ...createFakeRuntime(),
    now: () => now,
    hrtime: () => now,
    setInterval: (fn, ms) => set(fn, ms, true),
    clearInterval: (handle) => {
      timers.delete(handle);
    },
    setTimeout: (fn, ms) => set(fn, ms, false),
    clearTimeout: (handle) => {
      timers.delete(handle);
    },
  };
  return {
    runtime,
    timerCount: () => timers.size,
    advance: async (ms) => {
      const target = now + ms;
      while (now < target) {
        const next = Math.min(target, ...[...timers.values()].map((t) => t.due));
        now = next;
        for (const [handle, timer] of [...timers]) {
          if (timer.due > now) continue;
          if (timer.repeat) timer.due += timer.ms;
          else timers.delete(handle);
          timer.fn();
        }
        // Dispatch promises are deliberately not awaited: hung work must remain
        // observable while later ticks test the in-flight guard.
        for (let n = 0; n < 150; n++) await Promise.resolve();
      }
    },
  };
}
