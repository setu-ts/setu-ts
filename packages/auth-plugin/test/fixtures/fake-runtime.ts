/**
 * Fake runtime services for testing.
 *
 * Provides real Web Crypto (via globalThis.crypto.subtle) so auth cryptographic
 * operations (JWT sign/verify, PBKDF2 hashing) are exercised directly with
 * deterministic inputs. The `now()` clock is controllable for testing token
 * expiry/not-before claims.
 *
 * @module
 */
import type { IRuntimeServices, TimerHandle } from '@hono-enterprise/common';

/**
 * Creates a fake `IRuntimeServices` with real Web Crypto and a controllable clock.
 *
 * @param startNow - Starting wall-clock time in milliseconds (default: Date.now())
 * @returns Fake runtime services with a mutable `setNow` attached
 */
export function createFakeRuntime(startNow?: number): IRuntimeServices & {
  setNow(ms: number): void;
} {
  let currentTime = startNow ?? Date.now();

  const runtime: IRuntimeServices & { setNow(ms: number): void } = {
    platform: () => 'deno' as const,
    version: () => 'test',
    hostname: () => 'localhost',
    now: () => currentTime,
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
    uuid: () => crypto.randomUUID(),
    randomBytes: (length: number) => {
      const bytes = new Uint8Array(length);
      crypto.getRandomValues(bytes);
      return bytes;
    },
    subtle: globalThis.crypto.subtle,
    env: {},
    exit: () => {
      throw new Error('exit called');
    },
    setNow: (ms: number) => {
      currentTime = ms;
    },
  };

  return runtime;
}
