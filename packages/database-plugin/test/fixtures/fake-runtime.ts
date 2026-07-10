// deno-lint-ignore-file require-await -- test fixtures use sync methods that interface requires
/**
 * Fake runtime services for testing.
 *
 * Mirrors the real `IRuntimeServices` contract but uses in-memory
 * implementations so tests run without external dependencies.
 *
 * @module
 */
import type { IRuntimeServices, RuntimePlatform, TimerHandle } from '@hono-enterprise/common';

/**
 * Creates a minimal fake runtime that satisfies `IRuntimeServices`.
 *
 * @returns A fake runtime instance
 */
export function createFakeRuntime(): IRuntimeServices {
  let counter = 0;

  return {
    platform: (): RuntimePlatform => 'deno',
    version: () => '2.0.0-fake',
    hostname: () => 'test-host',
    uuid(): string {
      counter++;
      return `test-uuid-${counter}`;
    },
    randomBytes(length: number): Uint8Array {
      const bytes = new Uint8Array(length);
      for (let i = 0; i < length; i++) {
        bytes[i] = i % 256;
      }
      return bytes;
    },
    get subtle(): SubtleCrypto {
      throw new Error('SubtleCrypto not implemented in fake runtime');
    },
    now(): number {
      return Date.now();
    },
    hrtime(): number {
      return performance.now();
    },
    setTimeout(_callback: () => void, _ms: number): TimerHandle {
      return 0;
    },
    clearTimeout(_id: TimerHandle): void {
      // No-op for testing.
    },
    setInterval(_callback: () => void, _ms: number): TimerHandle {
      return 0;
    },
    clearInterval(_id: TimerHandle): void {
      // No-op for testing.
    },
    env: {},
    exit(_code?: number): never {
      throw new Error(`fake runtime exit called with code ${_code ?? 0}`);
    },
    fs: {
      stat: async () => ({ isFile: true, isDirectory: false, size: 0 }),
      readFile: async () => new TextEncoder().encode(''),
      writeFile: async () => {},
      mkdir: async () => {},
      readdir: async () => [],
      rm: async () => {},
    },
  };
}
