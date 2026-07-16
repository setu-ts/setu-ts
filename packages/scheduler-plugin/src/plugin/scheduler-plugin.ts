/**
 * Scheduler plugin factory.
 *
 * Creates a plugin that registers a SchedulerService under
 * `CAPABILITIES.SCHEDULER` (`'scheduler'`).
 *
 * @module
 */
import type { HealthIndicatorFn, IPlugin, IScheduler } from '@hono-enterprise/common';
import type { SchedulerPluginOptions } from '../interfaces/index.ts';
import { resolveLock } from '../lock/distributed-lock.ts';
import type { ILifecyclableLock } from '../lock/distributed-lock.ts';
import { SchedulerService } from '../services/scheduler-service.ts';

/**
 * Creates a scheduler plugin.
 *
 * @param options - Plugin configuration
 * @returns A plugin that registers an IScheduler under `'scheduler'`
 *
 * @example
 * ```typescript
 * app.register(SchedulerPlugin());
 *
 * // Or with distributed locking via Redis
 * app.register(SchedulerPlugin({
 *   distributedLock: { enabled: true, storage: 'redis', url: 'redis://localhost:6379' },
 * }));
 * ```
 * @since 0.1.0
 */
export function SchedulerPlugin(options?: SchedulerPluginOptions): IPlugin {
  // Enforce UTC-only timezone
  const timezone = options?.timezone ?? 'UTC';
  if (timezone !== 'UTC') {
    throw new Error('Non-UTC timezones are not supported in this release');
  }

  return {
    name: 'scheduler-plugin',
    version: '0.1.0',
    provides: ['scheduler'],
    priority: 100,

    async register(ctx) {
      // Resolve distributed lock
      const lock = await resolveLock(options, ctx.runtime);

      // Connect Redis lock if needed
      if (
        options?.distributedLock?.enabled &&
        options.distributedLock.storage === 'redis' &&
        options.distributedLock.lock === undefined
      ) {
        // RedisLock needs to be connected — use ILifecyclableLock seam
        const lifecycleLock = lock as ILifecyclableLock;
        if (typeof lifecycleLock.connect === 'function') {
          await lifecycleLock.connect();
        }
      }

      // Create scheduler service
      const service = new SchedulerService(ctx.runtime, lock, {
        logger: ctx.logger,
        ttlMs: options?.distributedLock?.ttlMs,
      });

      // Connect the service
      await service.connect();

      // Register the service
      ctx.services.register<IScheduler>('scheduler', service);

      // Register health indicator
      const healthIndicator: HealthIndicatorFn = service.createHealthIndicator();
      ctx.health.register('scheduler', healthIndicator);

      // Register lifecycle hook for cleanup
      ctx.lifecycle.onClose(async () => {
        await service.disconnect();

        // Disconnect Redis lock if needed
        const lifecycleLock = lock as ILifecyclableLock;
        if (typeof lifecycleLock.disconnect === 'function') {
          await lifecycleLock.disconnect();
        }
      });
    },
  };
}
