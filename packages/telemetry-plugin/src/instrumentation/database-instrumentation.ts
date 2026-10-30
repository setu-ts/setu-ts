/**
 * Database instrumentation loaders for ioredis and node-redis.
 *
 * Loads the optional OTel Redis instrumentations via guarded dynamic imports.
 * Honors the inject-or-lazy seam.
 *
 * The default `importFn` keeps its package specifier as a **literal** at the
 * `import()` call — the only form static analysis (a bundler, the type
 * checker, the repository's import audit) can see (X7-3).
 *
 * @module
 * @since 0.2.0
 */

import { OptionalDependencyUnavailableError } from '@setu-ts/common';

/** The package specifier the ioredis loader resolves. */
const IOREDIS_SPECIFIER = '@opentelemetry/instrumentation-ioredis';
/** The package specifier the node-redis loader resolves. */
const REDIS_SPECIFIER = '@opentelemetry/instrumentation-redis';

/**
 * Constructs an ioredis instrumentation instance from a loaded module.
 *
 * @internal
 */
export function createIORedisInstrumentation(
  mod: Record<string, unknown>,
  configArg: unknown,
): unknown {
  const IORedisInstrumentation = mod.IORedisInstrumentation as unknown;
  return new (IORedisInstrumentation as new (config?: Record<string, unknown>) => unknown)(
    configArg as Record<string, unknown> | undefined,
  );
}

/**
 * Lazy-loads and constructs an ioredis instrumentation.
 *
 * @param configArg - Opaque config forwarded to the constructor (or `undefined` for defaults).
 * @param importFn - Zero-argument import seam; defaults to a real literal `import()`.
 * @returns A promise resolving to the constructed instrumentation.
 * @since 0.2.0
 */
export async function loadIORedisInstrumentation(
  configArg: unknown | undefined,
  importFn: () => Promise<Record<string, unknown>> = async () => {
    try {
      return await import('@opentelemetry/instrumentation-ioredis');
    } catch (error) {
      throw new OptionalDependencyUnavailableError('@opentelemetry/instrumentation-ioredis', {
        requiredBy: '@setu-ts/telemetry-plugin',
        cause: error,
      });
    }
  },
): Promise<{ instance: unknown; specifier: string }> {
  const mod = await importFn();
  const instance = createIORedisInstrumentation(mod, configArg);
  return { instance, specifier: IOREDIS_SPECIFIER };
}

/** Constructs a node-redis instrumentation from a loaded module. @internal */
export function createRedisInstrumentation(
  mod: Record<string, unknown>,
  configArg: unknown,
): unknown {
  const RedisInstrumentation = mod.RedisInstrumentation as new (
    config?: Record<string, unknown>,
  ) => unknown;
  return new RedisInstrumentation(configArg as Record<string, unknown> | undefined);
}

/**
 * Lazy-loads and constructs a node-redis instrumentation.
 * @param configArg - Opaque configuration forwarded to the constructor
 * @param importFn - Import seam; defaults to the guarded literal package import
 * @returns The instrumentation instance and its package specifier
 * @since 0.11.0
 */
export async function loadRedisInstrumentation(
  configArg: unknown | undefined,
  importFn: () => Promise<Record<string, unknown>> = async () => {
    try {
      return await import('@opentelemetry/instrumentation-redis');
    } catch (error) {
      throw new OptionalDependencyUnavailableError('@opentelemetry/instrumentation-redis', {
        requiredBy: '@setu-ts/telemetry-plugin',
        cause: error,
      });
    }
  },
): Promise<{ instance: unknown; specifier: string }> {
  const mod = await importFn();
  return { instance: createRedisInstrumentation(mod, configArg), specifier: REDIS_SPECIFIER };
}
