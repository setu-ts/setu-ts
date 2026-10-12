/**
 * A controllable `IRuntimeServices` for the idempotency tests: a monotonic
 * clock advanced by `advance(ms)`, a deterministic uuid, and the real
 * `SubtleCrypto`.
 *
 * Written as an object literal (never a spread class) and honouring the
 * `randomBytes(n)` length contract, so a fake never shortens what it hands
 * back.
 *
 * @module
 */
import type { IRuntimeServices, TimerHandle } from '@setu-ts/common';

/** The test runtime, plus a way to move the clock. */
export interface ClockRuntime extends IRuntimeServices {
  /** Advances the monotonic clock by `ms`. */
  advance(ms: number): void;
}

/** Inert timer handle: a default fixture must never arm a real timer. */
const INERT_TIMER_HANDLE = 0 as unknown as TimerHandle;

/**
 * Creates a clock runtime.
 *
 * @returns The runtime
 */
export function createClockRuntime(): ClockRuntime {
  let clock = 0;
  let counter = 0;
  const base: IRuntimeServices = {
    platform: () => 'deno',
    version: () => '0.0.0',
    hostname: () => 'localhost',
    uuid: () => `uuid-${++counter}`,
    randomBytes: (length: number): Uint8Array => new Uint8Array(length),
    subtle: crypto.subtle,
    now: () => clock,
    hrtime: () => clock,
    setTimeout: (): TimerHandle => INERT_TIMER_HANDLE,
    clearTimeout: (): void => {},
    setInterval: (): TimerHandle => INERT_TIMER_HANDLE,
    clearInterval: (): void => {},
    env: {},
    exit: (): never => {
      throw new Error('exit called in test environment');
    },
  };
  return {
    ...base,
    advance(ms: number): void {
      clock += ms;
    },
  };
}
