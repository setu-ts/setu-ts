/**
 * Fake runtime services for testing.
 *
 * Provides controllable `setInterval`/`clearInterval` that records handles so
 * cleanup is assertable, mirroring the events-plugin fixture.
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
  const recordedIntervals = new Map<TimerHandle, { fn: () => void; ms: number }>();

  return {
    platform: () => 'node' as const,
    version: () => 'test',
    now: () => timestamp,
    hrtime: () => 0,
    setTimeout: (fn: () => void, ms: number) => {
      const id = setTimeout(fn, ms);
      return { id } as TimerHandle;
    },
    clearTimeout: (handle: TimerHandle) => clearTimeout((handle as { id: number }).id),
    setInterval: (fn: () => void, ms: number) => {
      const handle = { intervalId: Date.now() + Math.random() } as TimerHandle;
      recordedIntervals.set(handle, { fn, ms });
      // Also schedule it so real heartbeats fire during tests.
      const id = setInterval(fn, ms);
      return { handle, realId: id } as unknown as TimerHandle;
    },
    clearInterval: (handle: TimerHandle) => {
      // If the handle wraps both an internal key and a real timer ID.
      if (handle && typeof handle === 'object') {
        const typed = handle as { handle?: TimerHandle; realId?: number };
        if (typed.handle !== undefined) {
          recordedIntervals.delete(typed.handle);
        }
        if (typed.realId !== undefined) {
          clearInterval(typed.realId);
        }
      }
    },
    uuid: () => `${opts?.uuidPrefix ?? 'fake'}-${uuidCounter++}`,
    randomBytes: (length: number) => new Uint8Array(length),
    subtle: {} as SubtleCrypto,
    env: {},
    exit: () => {
      throw new Error('exit called');
    },
    hostname: () => 'localhost',
  };
}
