/**
 * Injection seam for `ioredis`, used by the Redis pub/sub transport.
 *
 * @module
 * @since 0.2.0
 */

import type { IRedisBackplaneClient, IRedisModule } from '../interfaces/index.ts';

/** Thrown when `ioredis` cannot be loaded or does not look like itself. */
export class RedisModuleError extends Error {
  /**
   * @param message - What was wrong
   */
  constructor(message: string) {
    super(message);
    this.name = 'RedisModuleError';
  }
}

/**
 * Narrows an `ioredis` module to the constructor facade this package uses.
 *
 * Pure and synchronous, so the transport's construction path is unit-testable
 * with a fake module and never needs the real driver installed.
 *
 * @param module - The module to adapt, typically `import('npm:ioredis@5.x')`
 * @returns A facade whose `create` builds a client
 * @throws {RedisModuleError} When the module exposes no constructor
 * @since 0.2.0
 */
export function adaptRedisModule(module: unknown): IRedisModule {
  if (typeof module !== 'object' || module === null) {
    throw new RedisModuleError(
      'ioredis module must be an object exposing a constructor; received ' + typeof module,
    );
  }
  // ioredis publishes the class as both a default export and (under Deno's npm
  // interop) the module namespace's `Redis` binding.
  const candidate = module as { readonly default?: unknown; readonly Redis?: unknown };
  const constructor = typeof candidate.default === 'function' ? candidate.default : candidate.Redis;

  if (typeof constructor !== 'function') {
    throw new RedisModuleError(
      'ioredis module exposes neither a default export nor a Redis constructor',
    );
  }

  const RedisCtor = constructor as new (url: string) => IRedisBackplaneClient;
  return {
    create: (url: string): IRedisBackplaneClient => new RedisCtor(url),
  };
}

/**
 * Decides how a load failure is reported.
 *
 * Extracted from {@linkcode loadRedisModule}'s `catch` so the branching is
 * unit-testable directly: the `import()` it guards only fails when the driver
 * is genuinely absent, which is not reproducible on a machine where it is
 * present.
 *
 * @param error - The thrown value
 * @returns The error to surface
 * @since 0.2.0
 */
export function toRedisLoadFailure(error: unknown): RedisModuleError {
  if (error instanceof RedisModuleError) {
    return error;
  }
  return new RedisModuleError(
    "Failed to load npm:ioredis@5.x. Install it to use the 'redis' realtime " +
      'backplane transport, or inject client and subscriber through options. ' +
      `Cause: ${error instanceof Error ? error.message : String(error)}`,
  );
}

/**
 * Lazily imports `ioredis`.
 *
 * Performs a real `import('npm:ioredis@5.x')`; the driver is resolved by the
 * runtime at call time and is not part of this package's dependency graph.
 *
 * @returns The adapted module facade
 * @throws {RedisModuleError} When the driver is absent or unrecognizable
 * @since 0.2.0
 */
export async function loadRedisModule(): Promise<IRedisModule> {
  try {
    const module = await import('npm:ioredis@5.x');
    return adaptRedisModule(module);
  } catch (error) {
    throw toRedisLoadFailure(error);
  }
}
