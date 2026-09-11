import type { IRuntimeServices } from '@setu-ts/common';

/**
 * A runtime double for tests in this package.
 *
 * `@setu-ts/testing` depends on `common` and `kernel` only, so its own tests
 * cannot import `RuntimePlugin` — the kernel nevertheless requires the
 * `runtime` capability at `start()`. Values are inert on purpose: a test that
 * needs a real clock or real randomness should say so explicitly rather than
 * inherit one here.
 */
export function createFakeRuntime(): IRuntimeServices {
  return {
    platform: () => 'deno',
    version: () => '0.0.0',
    hostname: () => 'localhost',
    uuid: () => 'test-uuid',
    randomBytes: (_length: number) => new Uint8Array(0),
    subtle: null as unknown as SubtleCrypto,
    now: () => 0,
    hrtime: () => 0,
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: clearTimeout.bind(globalThis),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: clearInterval.bind(globalThis),
    env: {} as Readonly<Record<string, string | undefined>>,
    exit: () => {
      throw new Error('exit');
    },
  };
}
