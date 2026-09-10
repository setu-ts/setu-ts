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

      const host = options?.host ?? ctx.runtime.workers;
      const available = host !== undefined;
      // Whether a dead worker is observable at all on this runtime. Reported so
      // an operator can see it without reading the source: where it is false,
      // a worker that ends itself is settled ONLY by the task timeout (X8-7).
      const exitDetection = host?.reportsExit?.() ?? false;

      warnIfDeathUndetectable(ctx, options, exitDetection, available);

      // H-70c-5: this hardcoded `status: 'up'` beside a live `available`
      // field that could read `false` — a pool with no `IWorkerHost` throws
      // `WorkerPoolUnavailableError` from every `run()`, so the indicator
      // reported healthy for a capability that could not execute one task.
      //
      // `degraded` rather than `down`, and the distinction is deliberate.
      // M45 registers this plugin on Cloudflare Workers ON PURPOSE — the
      // runtime has no threads, so the capability resolves and refuses — and
      // `degraded` keeps `/ready` at 200 (`health-plugin.ts:218`) while still
      // surfacing in the payload. Reporting `down` would 503 every Workers
      // deployment that registers the plugin, turning an observability fix
      // into an outage.
      //
      // The pool counters stay DATA, not policy: `TaskPoolStats.failed` is
      // cumulative, so any status derived from it would need a threshold this
      // plugin cannot choose for an application (the M45b/M90b rule that
      // saturation is published, never judged).
      ctx.health.register(
        'worker-pool',
        (): Promise<HealthCheckResult> =>
          Promise.resolve({
            status: available ? 'up' : 'degraded',
            data: {
              available,
              exitDetection,
              pools: service.stats(),
              ...(available ? {} : { reason: WORKERS_UNSUPPORTED_REASON }),
            },
          }),
      );

      ctx.lifecycle.onClose(async () => {
        await service.shutdown();
      });
    },
  };
}

/**
 * Reported beside `available: false` so the payload says why, rather than
 * leaving an operator to infer it from a boolean.
 */
const WORKERS_UNSUPPORTED_REASON =
  'this runtime provides no worker host, so every run() rejects with WorkerPoolUnavailableError';

/**
 * Warns ONCE, at registration, when this application has configured a pool with
 * no task timeout on a runtime that cannot report a worker's exit.
 *
 * That pairing is the X8-7 wedge: `taskTimeoutMs: 0` is documented as disabling
 * the per-task time budget, but where no exit signal exists it also disables the
 * only thing that ever settles a task whose worker is gone — so one
 * self-terminating worker holds its slot forever, and on a `size: 1` pool every
 * later task on that module queues behind it.
 *
 * A warning rather than a throw: `0` is released, documented behaviour and a
 * legitimate choice for long CPU-bound work, so refusing it would remove a
 * capability to fix an observability gap. Paired with the health payload's
 * `exitDetection`, it makes a silent permanent wedge into two signals an
 * operator already watches.
 *
 * @param ctx - The plugin context supplying the logger
 * @param options - The plugin's configuration, if any
 * @param exitDetection - Whether the resolved host reports worker exits
 * @param available - Whether a worker host exists at all
 */
function warnIfDeathUndetectable(
  ctx: IPluginContext,
  options: WorkerPoolPluginOptions | undefined,
  exitDetection: boolean,
  available: boolean,
): void {
  // Nothing to warn about with no host: `run()` already throws
  // WorkerPoolUnavailableError, so no worker can be leaked.
  if (exitDetection || !available) {
    return;
  }
  const disabled = collectDisabledTimeoutPools(options);
  if (disabled.length === 0) {
    return;
  }
  ctx.logger?.warn(
    'worker-pool: taskTimeoutMs is 0 on a runtime that cannot report a worker exit — ' +
      'a worker that ends itself will never settle its task and its pool slot leaks',
    { pools: disabled, runtime: ctx.runtime.platform() },
  );
}

/**
 * Names the pools this configuration leaves with no task timeout: `'*'` for the
 * plugin-wide default, plus any task module whose override sets it to `0`.
 *
 * A per-pool override of `0` matters even when the default is non-zero, and a
 * default of `0` matters for every module with no override — so both are
 * reported rather than only the coarser of the two.
 *
 * @param options - The plugin's configuration, if any
 * @returns The pool identifiers with the timeout disabled
 */
function collectDisabledTimeoutPools(
  options: WorkerPoolPluginOptions | undefined,
): readonly string[] {
  const disabled: string[] = [];
  if (options?.taskTimeoutMs === 0) {
    disabled.push('*');
  }
  for (const [specifier, pool] of Object.entries(options?.pools ?? {})) {
    if (pool.taskTimeoutMs === 0) {
      disabled.push(specifier);
    }
  }
  return disabled;
}
