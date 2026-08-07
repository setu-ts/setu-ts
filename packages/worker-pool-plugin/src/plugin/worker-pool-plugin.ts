/**
 * WorkerPoolPlugin — registers a `WorkerPoolService` under
 * `CAPABILITIES.WORKER_POOL`.
 *
 * @module
 * @since 0.1.0
 */

import type { HealthCheckResult, IPlugin, IPluginContext, IWorkerPool } from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { WorkerPoolPluginOptions } from '../interfaces/index.ts';
import { WorkerPoolService } from '../services/worker-pool-service.ts';

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
    version: '0.1.0',
    optionalDependencies: ['logger'],
    provides: [CAPABILITIES.WORKER_POOL],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void {
      const service = new WorkerPoolService(options, ctx.runtime);
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
