/**
 * Fake runtime services for testing.
 *
 * @module
 */
import type { IRuntimeServices } from '@hono-enterprise/common';

/**
 * Creates a fake runtime services implementation for testing.
 *
 * @param overrides - Partial overrides for specific methods
 * @returns A fake IRuntimeServices implementation
 */
export function createFakeRuntime(
  overrides?: Partial<IRuntimeServices>,
): IRuntimeServices {
  const base: IRuntimeServices = {
    now: () => 1_000_000_000_000,
    hrtime: () => 0,
    platform: () =>
      (overrides?.platform?.() ?? 'node') as import('@hono-enterprise/common').RuntimePlatform,
    version: () => overrides?.version?.() ?? '18.0.0',
    hostname: () => overrides?.hostname?.() ?? 'test-host',
    uuid: () => '00000000-0000-0000-0000-000000000000',
    randomBytes: () => new Uint8Array(32),
    subtle: {} as Crypto['subtle'],
    setTimeout: globalThis.setTimeout.bind(globalThis),
    clearTimeout: globalThis.clearTimeout.bind(globalThis),
    setInterval: globalThis.setInterval.bind(globalThis),
    clearInterval: globalThis.clearInterval.bind(globalThis),
    env: (overrides?.env ?? {}) as Record<string, string | undefined>,
    exit: (() => {
      throw new Error('exit called');
    }) as () => never,
  };

  // Build result with fs conditionally included
  const result = {
    ...base,
    ...(overrides?.fs !== undefined ? { fs: overrides.fs } : {}),
  } as IRuntimeServices;

  return result;
}
