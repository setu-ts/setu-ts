// deno-lint-ignore-file require-await no-unused-vars -- test fixtures must be async to satisfy IRuntimeServices
/**
 * Fake runtime services for testing.
 *
 * Mirrors the real `IRuntimeServices` contract but uses in-memory
 * implementations so tests run without external dependencies.
 *
 * @module
 */
import type { IRuntimeServices } from '@hono-enterprise/common';

/**
 * Creates a minimal fake runtime that satisfies `IRuntimeServices`.
 *
 * @returns A fake runtime instance
 */
export function createFakeRuntime(): IRuntimeServices {
  let counter = 0;

  return {
    async uuid(): Promise<string> {
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
    setTimeout(callback: () => void, ms: number): number {
      // Fake timer — just call synchronously for testing.
      callback();
      return 0;
    },
    clearTimeout(_id: number): void {
      // No-op for testing.
    },
    hrtime(): number {
      return performance.now();
    },
    now(): number {
      return Date.now();
    },
    env: {},
    platform: () => 'deno',
    fs: {
      exists: async () => false,
      readFile: async () => new TextEncoder().encode(''),
      writeFile: async () => {},
      mkdir: async () => {},
      readdir: async () => [],
      remove: async () => {},
    },
    crypto: {
      subtle: {
        generateKey: async () => ({}),
        exportKey: async () => new Uint8Array(),
        sign: async () => new Uint8Array(),
        verify: async () => true,
        digest: async () => new Uint8Array(),
      },
    },
  };
}
