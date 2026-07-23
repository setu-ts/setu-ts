/**
 * @module
 *
 * Resilience patterns plugin: circuit breaker, retry, timeout, and bulkhead
 * composed around an arbitrary `() => Promise<T>` under the
 * `CAPABILITIES.RESILIENCE` (`'resilience'`) capability.
 *
 * @example
 * ```typescript
 * import { ResiliencePlugin } from '@hono-enterprise/resilience-plugin';
 * import type { IResilienceService } from '@hono-enterprise/common';
 *
 * app.register(ResiliencePlugin({
 *   defaultRetry: { limit: 3, delay: 100, backoff: 'exponential' },
 * }));
 *
 * const resilience = ctx.services.get<IResilienceService>('resilience');
 * const guarded = resilience.wrap(() => externalApi.call(), { retry: true, timeout: 2000 });
 * ```
 */
export { ResiliencePlugin } from './plugin/resilience-plugin.ts';
export type { ResiliencePluginOptions } from './interfaces/index.ts';
export { BulkheadFullError, CircuitOpenError, TimeoutError } from './errors.ts';
