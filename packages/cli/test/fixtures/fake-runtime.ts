/**
 * Fake IRuntimeServices for CLI tests.
 *
 * @module
 */
import type { IRuntimeServices, RuntimePlatform } from '@hono-enterprise/common';

let uuidCounter = 0;

/**
 * Creates a fake IRuntimeServices implementation suitable for schematic tests.
 * Schematics only need: platform(), version(), hostname(), uuid(), randomBytes(),
 * subtle, now(), hrtime(), setTimeout(), clearTimeout(), setInterval(), clearInterval(),
 * env, and exit(). They don't call fs or workers.
 */
export function createFakeRuntime(overrides?: Partial<IRuntimeServices>): IRuntimeServices {
  return {
    platform: () => 'deno' as RuntimePlatform,
    version: () => '0.1.0',
    hostname: () => 'localhost',
    uuid: () => {
      uuidCounter++;
      return `fake-uuid-${uuidCounter}`;
    },
    randomBytes: (length: number) => new Uint8Array(length),
    subtle: {} as unknown as SubtleCrypto,
    now: () => Date.now(),
    hrtime: () => performance.now() || Date.now(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (handle: unknown) => clearTimeout(handle as never),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms) as never,
    clearInterval: (handle: unknown) => clearInterval(handle as never),
    env: {},
    exit: () => {
      throw new Error('exit called');
    },
    ...overrides,
  };
}
