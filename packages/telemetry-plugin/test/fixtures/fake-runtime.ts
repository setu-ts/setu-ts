/**
 * Fake IRuntimeServices for testing.
 *
 * @module
 */
import type { IRuntimeServices, RuntimePlatform } from '@hono-enterprise/common';

let uuidCounter = 0;

/**
 * Creates a fake IRuntimeServices implementation.
 */
export function createFakeRuntime(overrides?: Partial<IRuntimeServices>): IRuntimeServices {
  return {
    platform: () => 'deno' as RuntimePlatform,
    version: () => '1.0.0',
    hostname: () => 'localhost',
    uuid: () => {
      uuidCounter++;
      return `fake-uuid-${uuidCounter}`;
    },
    randomBytes: (length: number) => new Uint8Array(length),
    subtle: null as unknown as SubtleCrypto,
    now: () => Date.now(),
    hrtime: () => performance.now(),
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
