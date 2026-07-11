/**
 * Fake runtime services for testing.
 *
 * @module
 */
import type { IRuntimeServices, TimerHandle } from '@hono-enterprise/common';

/**
 * Creates a fake `IRuntimeServices` with deterministic uuid/timestamp.
 *
 * @param opts - Optional configuration
 * @returns Fake runtime services
 */
export function createFakeRuntime(opts?: {
  uuidPrefix?: string;
  startTimestamp?: number;
}): IRuntimeServices {
  let uuidCounter = 0;
  const timestamp = opts?.startTimestamp ?? Date.now();

  return {
    platform: () => 'deno' as const,
    version: () => 'test',
    now: () => timestamp,
    hrtime: () => 0,
    setTimeout: (fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      return { id } as TimerHandle;
    },
    clearTimeout: (handle: TimerHandle) => clearTimeout((handle as { id: number }).id),
    setInterval: (fn: () => void, ms: number) => {
      const id = setInterval(fn, ms);
      return { id } as TimerHandle;
    },
    clearInterval: (handle: TimerHandle) => clearInterval((handle as { id: number }).id),
    uuid: () => `${opts?.uuidPrefix ?? 'fake-uuid'}-${uuidCounter++}`,
    randomBytes: (length: number) => new Uint8Array(length),
    subtle: {} as SubtleCrypto,
    env: {},
    exit: () => {
      throw new Error('exit called');
    },
    hostname: () => 'localhost',
  };
}
