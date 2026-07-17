/**
 * Self liveness indicator.
 *
 * @module
 */
import type {
  HealthCheckResult,
  IHealthIndicator,
  IRuntimeServices,
} from '@hono-enterprise/common';

/**
 * Creates a self liveness indicator.
 *
 * This indicator always reports 'up' as long as the runtime is reachable.
 * It includes platform diagnostics in the response data.
 *
 * @param runtime - Runtime services for platform diagnostics
 * @returns An indicator that reports the runtime's health
 *
 * @example
 * ```typescript
 * const selfIndicator = createSelfIndicator(runtime);
 * const result = await selfIndicator.check();
 * // { status: 'up', data: { platform: 'node', version: '18.0.0', hostname: 'my-host' } }
 * ```
 *
 * @since 0.20.0
 */
export function createSelfIndicator(runtime: IRuntimeServices): IHealthIndicator {
  return {
    name: 'self',
    // deno-lint-ignore require-await
    async check(): Promise<HealthCheckResult> {
      return {
        status: 'up',
        data: {
          platform: runtime.platform(),
          version: runtime.version(),
          hostname: runtime.hostname(),
        } as Readonly<Record<string, unknown>>,
      };
    },
  };
}
