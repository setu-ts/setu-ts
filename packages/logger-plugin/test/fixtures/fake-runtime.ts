/**
 * Fake runtime services fixture for logger-plugin tests — deterministic clock
 * and UUID counter, no real timers or crypto.
 *
 * @module
 */
import type { IRuntimeServices, RuntimePlatform, TimerHandle } from '@hono-enterprise/common';

/**
 * Options for {@linkcode createFakeRuntime}.
 */
export interface FakeRuntimeOptions {
  /** Initial clock time in milliseconds. */
  readonly clock?: number;
  /** Seed for UUID counter. */
  readonly uuidSeed?: number;
  /** Platform identifier. */
  readonly platform?: RuntimePlatform;
}

/**
 * Creates a fake runtime services implementation with a manual clock.
 *
 * @param options - Configuration
 * @returns The fake runtime and a `tick` function to advance the clock
 */
export function createFakeRuntime(options: FakeRuntimeOptions = {}): {
  runtime: IRuntimeServices;
  tick: (ms: number) => void;
} {
  let clock = options.clock ?? 1_000_000;
  let uuidCounter = options.uuidSeed ?? 0;

  return {
    runtime: {
      platform: () => options.platform ?? 'deno',
      version: () => '2.0.0-fake',
      hostname: () => 'test-host',
      uuid: () => {
        uuidCounter++;
        return `test-uuid-${uuidCounter}`;
      },
      randomBytes: (length: number) => new Uint8Array(length).fill(0),
      get subtle(): SubtleCrypto {
        throw new Error('SubtleCrypto not implemented in fake runtime');
      },
      now: () => clock,
      hrtime: () => clock,
      setTimeout: (_fn: () => void, _ms: number): TimerHandle => 0,
      clearTimeout: (_handle: TimerHandle): void => {},
      setInterval: (_fn: () => void, _ms: number): TimerHandle => 0,
      clearInterval: (_handle: TimerHandle): void => {},
      env: {},
      exit: () => {
        throw new Error('fake runtime exit called');
      },
    },
    tick: (ms: number) => {
      clock += ms;
    },
  };
}
