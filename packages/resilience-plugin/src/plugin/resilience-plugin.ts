/**
 * Resilience plugin factory.
 *
 * Creates a plugin that registers a {@link ResilienceService} under
 * `CAPABILITIES.RESILIENCE` (`'resilience'`).
 *
 * @module
 */
import type { IPlugin, IResilienceService } from '@hono-enterprise/common';
import type { ResiliencePluginOptions } from '../interfaces/index.ts';
import { ResilienceService } from '../services/resilience-service.ts';

/**
 * Creates a resilience plugin.
 *
 * The plugin is pure and stateless at the plugin level: it holds no timers,
 * connections, or global state, so it registers no health indicator and no
 * `onClose` hook. Per-`wrap` breaker/bulkhead state lives in the returned
 * closures and is garbage-collected with them.
 *
 * @param options - Default policies for `true`-valued `wrap` fields
 * @returns A plugin registering an `IResilienceService` under `'resilience'`
 *
 * @example
 * ```typescript
 * app.register(ResiliencePlugin({
 *   defaultCircuitBreaker: { threshold: 5, timeout: 10_000, resetTimeout: 30_000 },
 *   defaultRetry: { limit: 3, delay: 100, backoff: 'exponential' },
 *   defaultBulkhead: { maxConcurrent: 10, maxQueue: 20 },
 * }));
 * ```
 * @since 0.1.0
 */
export function ResiliencePlugin(options?: ResiliencePluginOptions): IPlugin {
  return {
    name: 'resilience-plugin',
    version: '0.1.0',
    provides: ['resilience'],
    priority: 500,

    register(ctx) {
      const service = options === undefined
        ? new ResilienceService(ctx.runtime)
        : new ResilienceService(ctx.runtime, options);
      ctx.services.register<IResilienceService>('resilience', service);
    },
  };
}
