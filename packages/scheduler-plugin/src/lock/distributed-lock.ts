/**
 * Distributed lock seam and factory.
 *
 * Defines the `IDistributedLock` interface consumed by the scheduler
 * service and the `resolveLock` factory that selects the appropriate
 * implementation based on plugin options.
 *
 * @module
 */
import type { ConnectionErrorReporter, IRuntimeServices } from '@setu-ts/common';
import type {
  DistributedLockOptions,
  IDistributedLock,
  SchedulerPluginOptions,
} from '../interfaces/index.ts';
import { checkLockTimeout, DEFAULT_REDIS_COMMAND_TIMEOUT_MS, RedisLock } from './redis-lock.ts';

// Re-export the interface as the public-facing name
export type { IDistributedLock } from '../interfaces/index.ts';

/**
 * Lifecycle-aware lock that can optionally connect/disconnect.
 *
 * Used by the scheduler plugin to call `connect()` on Redis-backed locks
 * before use and `disconnect()` on shutdown, without fragile `as` casts.
 */
export interface ILifecyclableLock extends IDistributedLock {
  connect?(): Promise<void>;
  disconnect?(): Promise<void>;
}

/** The default bound on one lock acquire (M101a V8-24). */
export const DEFAULT_ACQUIRE_TIMEOUT_MS = 5000;

/** The resolved lock bounds (M101a V8-24). */
export interface LockTimeouts {
  /** Bound on one acquire call; `0` disables it. */
  readonly acquireTimeoutMs: number;
  /** ioredis `commandTimeout` for a BUILT Redis lock client; `0` omits it. */
  readonly commandTimeoutMs: number;
}

/**
 * Resolves and validates the two lock bounds.
 *
 * `commandTimeoutMs` defaults to the resolved `acquireTimeoutMs` (to the
 * 15 s ioredis default only when the acquire bound is disabled), and is
 * refused when it would outlast a non-zero acquire bound.
 *
 * @param options - The `distributedLock` options, if any
 * @returns The resolved bounds
 * @throws {RangeError} If either value is out of range, or `commandTimeoutMs`
 *   exceeds a non-zero `acquireTimeoutMs`
 */
export function resolveLockTimeouts(options: DistributedLockOptions | undefined): LockTimeouts {
  const acquireTimeoutMs = checkLockTimeout(
    'distributedLock.acquireTimeoutMs',
    options?.acquireTimeoutMs ?? DEFAULT_ACQUIRE_TIMEOUT_MS,
  );
  const commandTimeoutMs = checkLockTimeout(
    'distributedLock.commandTimeoutMs',
    options?.commandTimeoutMs ??
      (acquireTimeoutMs === 0 ? DEFAULT_REDIS_COMMAND_TIMEOUT_MS : acquireTimeoutMs),
  );
  if (acquireTimeoutMs !== 0 && commandTimeoutMs > acquireTimeoutMs) {
    throw new RangeError(
      `scheduler-plugin: distributedLock.commandTimeoutMs (${commandTimeoutMs}) must not ` +
        `exceed distributedLock.acquireTimeoutMs (${acquireTimeoutMs})`,
    );
  }
  return { acquireTimeoutMs, commandTimeoutMs };
}

/**
 * Resolves a distributed lock implementation based on plugin options.
 *
 * Priority: injected `lock` > `storage: 'redis'` > `MemoryLock` (default).
 *
 * @param options - Plugin options containing lock configuration
 * @param runtime - Runtime services (needed for MemoryLock clock)
 * @param connectionErrorReporter - Receives a BUILT Redis lock client's
 *   connection errors; unused for an injected lock or client and for
 *   `MemoryLock`
 * @returns The resolved lock implementation
 * @throws {Error} If `distributedLock.storage` is not `'redis'` and no lock is injected
 */
export async function resolveLock(
  options: SchedulerPluginOptions | undefined,
  runtime: IRuntimeServices,
  connectionErrorReporter?: ConnectionErrorReporter,
): Promise<IDistributedLock> {
  const distOpts = options?.distributedLock;

  // Injected custom lock takes priority
  if (distOpts?.lock !== undefined) {
    return distOpts.lock;
  }

  // Redis lock when explicitly selected
  if (distOpts?.enabled && distOpts.storage === 'redis') {
    return new RedisLock({
      url: distOpts.url ?? 'redis://localhost:6379',
      commandTimeoutMs: resolveLockTimeouts(distOpts).commandTimeoutMs,
      ...(distOpts.client !== undefined
        ? { client: distOpts.client as import('../interfaces/index.ts').IRedisLockClient }
        : {}),
      ...(connectionErrorReporter !== undefined ? { connectionErrorReporter } : {}),
    });
  }

  // Default: MemoryLock
  const { MemoryLock } = await import('./memory-lock.ts');
  return new MemoryLock(runtime);
}
