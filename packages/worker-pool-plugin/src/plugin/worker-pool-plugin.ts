/**
 * WorkerPoolPlugin — registers a `WorkerPoolService` under
 * `CAPABILITIES.WORKER_POOL`.
 *
 * @module
 * @since 0.1.0
 */

import type {
  HealthCheckResult,
  IMetricsService,
  IPlugin,
  IPluginContext,
  IWorkerPool,
} from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { WorkerPoolPluginOptions } from '../interfaces/index.ts';
import { WorkerPoolService } from '../services/worker-pool-service.ts';
import { WorkerPoolCollector } from '../metrics/worker-pool-collector.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/** Plugin name. */
const PLUGIN_NAME = 'worker-pool-plugin';

/**
 * Creates the WorkerPoolPlugin.
 *
 * Registers an `IWorkerPool` under `CAPABILITIES.WORKER_POOL`. Single
 * instance only (duplicate registration throws at startup via the resolver).
 * On runtimes without worker threads (Cloudflare Workers) the plugin still
 * registers; `run()` then throws `WorkerPoolUnavailableError`.
 *
 * @example
 * ```typescript
 * import { WorkerPoolPlugin } from '@setu-ts/worker-pool-plugin';
 *
 * app.register(WorkerPoolPlugin({ taskTimeoutMs: 10_000 }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function WorkerPoolPlugin(options?: WorkerPoolPluginOptions): IPlugin {
  return {
    name: PLUGIN_NAME,
    version: denoJson.version,
    // `CAPABILITIES.METRICS` is optional: absent it nothing changes. Declaring
    // it here is what ORDERS MetricsPlugin's register() before this one when
    // it is present — the resolver turns an optional token whose provider
    // exists into a real dependency edge, so the instruments provably exist
    // before any pool can push to them.
    optionalDependencies: ['logger', CAPABILITIES.METRICS],
    provides: [CAPABILITIES.WORKER_POOL],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void {
      const collector = ctx.services.has(CAPABILITIES.METRICS)
        ? new WorkerPoolCollector(
          ctx.services.get<IMetricsService>(CAPABILITIES.METRICS),
          // Read through `ctx` at CALL time, never captured here: a logger
          // registered after this plugin would otherwise be missed for the
          // life of the application (the M52b `waitUntil` lesson).
          (error: Error): void => {
            ctx.logger?.warn('worker-pool metrics write failed', {
              error: error.message,
            });
          },
        )
        : undefined;
      const service = new WorkerPoolService(options, ctx.runtime, collector);
      ctx.services.register<IWorkerPool>(CAPABILITIES.WORKER_POOL, service);

      const available = options?.host !== undefined || ctx.runtime.workers !== undefined;
      ctx.health.register(
        'worker-pool',
        (): Promise<HealthCheckResult> =>
          Promise.resolve({
            status: 'up',
            data: { available, pools: service.stats() },
          }),
      );

      ctx.lifecycle.onClose(async () => {
        await service.shutdown();
      });
    },
  };
}
