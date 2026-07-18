/**
 * Fake runtime services for testing.
 *
 * @module
 */
import type { IRuntimeServices, RuntimePlatform } from '@hono-enterprise/common';

/**
 * Options for configuring the fake runtime.
 *
 * @since 0.20.0
 */
export interface FakeRuntimeOptions {
  /** Initial wall-clock time in ms since epoch. Defaults to a fixed value. */
  now?: number;

  /** Initial monotonic time in ms. Defaults to 0. */
  hrtime?: number;

  /** Platform to report. Defaults to 'node'. */
  platform?: string;

  /** Version to report. Defaults to '18.0.0'. */
  version?: string;

  /** Hostname to report. Defaults to 'test-host'. */
  hostname?: string;
}

/**
 * Creates a fake `IRuntimeServices` for testing.
 *
 * @param options - Configuration options
 * @returns A fake runtime implementation
 *
 * @example
 * ```typescript
 * const runtime = createFakeRuntime({ now: 1000, hrtime: 0 });
 * const healthService = new HealthService(runtime);
 * ```
 *
 * @since 0.20.0
 */
export function createFakeRuntime(options?: FakeRuntimeOptions): IRuntimeServices {
  const nowValue = options?.now ?? 1_000_000_000_000;
  const hrtimeValue = options?.hrtime ?? 0;

  return {
    now() {
      return nowValue;
    },

    hrtime() {
      return hrtimeValue;
    },

    platform(): RuntimePlatform {
      return (options?.platform ?? 'node') as RuntimePlatform;
    },

    version() {
      return options?.version ?? '18.0.0';
    },

    hostname() {
      return options?.hostname ?? 'test-host';
    },

    uuid() {
      return '00000000-0000-0000-0000-000000000000';
    },

    randomBytes(_length: number): Uint8Array {
      return new Uint8Array(32);
    },

    subtle: {} as Crypto['subtle'],

    setTimeout: globalThis.setTimeout.bind(globalThis),

    clearTimeout: globalThis.clearTimeout.bind(globalThis),

    setInterval: globalThis.setInterval.bind(globalThis),

    clearInterval: globalThis.clearInterval.bind(globalThis),

    env: {} as Record<string, string | undefined>,

    exit(_code?: number): never {
      throw new Error('exit called in test');
    },

    fs: {} as IRuntimeServices['fs'],
  } as IRuntimeServices;
}
