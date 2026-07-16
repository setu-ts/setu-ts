/**
 * Distributed lock seam and factory.
 *
 * Defines the `IDistributedLock` interface consumed by the scheduler
 * service and the `resolveLock` factory that selects the appropriate
 * implementation based on plugin options.
 *
 * @module
 */
import type { IRuntimeServices } from '@hono-enterprise/common';
import type { IDistributedLock, SchedulerPluginOptions } from '../interfaces/index.ts';

// Re-export the interface as the public-facing name
export type { IDistributedLock } from '../interfaces/index.ts';

/**
 * Resolves a distributed lock implementation based on plugin options.
 *
 * Priority: injected `lock` > `storage: 'redis'` > `MemoryLock` (default).
 *
 * @param options - Plugin options containing lock configuration
 * @param runtime - Runtime services (needed for MemoryLock clock)
 * @returns The resolved lock implementation
 * @throws {Error} If `distributedLock.storage` is not `'redis'` and no lock is injected
 */
export async function resolveLock(
  options: SchedulerPluginOptions | undefined,
  runtime: IRuntimeServices,
): Promise<IDistributedLock> {
  const distOpts = options?.distributedLock;

  // Injected custom lock takes priority
  if (distOpts?.lock !== undefined) {
    return distOpts.lock;
  }

  // Redis lock when explicitly selected
  if (distOpts?.enabled && distOpts.storage === 'redis') {
    const { RedisLock } = await import('./redis-lock.ts');
    return new RedisLock({
      url: distOpts.url ?? 'redis://localhost:6379',
      ...(distOpts.client !== undefined
        ? { client: distOpts.client as import('../interfaces/index.ts').IRedisLockClient }
        : {}),
    });
  }

  // Default: MemoryLock
  const { MemoryLock } = await import('./memory-lock.ts');
  return new MemoryLock(runtime);
}
