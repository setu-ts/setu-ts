/**
 * Health plugin factory.
 *
 * Creates a plugin that registers a HealthService under
 * `CAPABILITIES.HEALTH` (`'health'`).
 *
 * @module
 */
import type {
  HandlerResult,
  HealthReport,
  IHealthService,
  IPlugin,
  IPluginContext,
} from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { HealthPluginOptions } from '../interfaces/index.ts';
import { HealthService } from '../services/health-service.ts';
import { createSelfIndicator } from '../indicators/self-indicator.ts';
export { createHttpIndicator } from '../indicators/http-indicator.ts';
export type { HttpIndicatorOptions } from '../indicators/http-indicator.ts';

/**
 * Creates a health plugin.
 *
 * @param options - Plugin configuration options
 * @returns A plugin that registers an `IHealthService` under `'health'`
 *
 * @example
 * ```typescript
 * app.register(HealthPlugin());
 *
 * // Or with custom options
 * app.register(HealthPlugin({
 *   endpoints: {
 *     health: '/health',
 *     live: '/live',
 *     ready: '/ready',
 *   },
 *   indicators: [
 *     createHttpIndicator('external-api', { url: 'https://api.example.com/health' }),
 *   ],
 * }));
 * ```
 *
 * @since 0.20.0
 */
export function HealthPlugin(options?: HealthPluginOptions): IPlugin {
  const endpoints = options?.endpoints ?? {
    health: '/health',
    live: '/live',
    ready: '/ready',
  };
  const indicators = options?.indicators ?? [];

  return {
    name: 'health-plugin',
    version: '0.20.0',
    provides: [CAPABILITIES.HEALTH],
    priority: 100,

    register(ctx: IPluginContext): void {
      const runtime = ctx.runtime;

      // Create the health service
      const service = new HealthService(runtime);

      // Register the service
      ctx.services.register<IHealthService>(CAPABILITIES.HEALTH, service);

      // Register the built-in self indicator first
      const selfIndicator = createSelfIndicator(runtime);
      service.registerIndicator(selfIndicator.name, selfIndicator.check.bind(selfIndicator));

      // Register any app-supplied indicators
      for (const indicator of indicators) {
        service.registerIndicator(indicator.name, indicator.check.bind(indicator));
      }

      // Register the health endpoints
      registerHealthEndpoints(ctx, service, endpoints);

      // Drain HEALTH_INDICATOR contributions at onInit
      ctx.lifecycle.onInit(() => {
        const contributions = ctx.services.getAll<{
          name: string;
          check: import('@hono-enterprise/common').HealthIndicatorFn;
        }>(CAPABILITIES.HEALTH_INDICATOR);

        for (const contribution of contributions) {
          service.registerIndicator(contribution.name, contribution.check);
        }
      });
    },
  };
}

/**
 * Registers the health check endpoints.
 *
 * @param ctx - Plugin context
 * @param service - Health service instance
 * @param endpoints - Endpoint configuration
 */
function registerHealthEndpoints(
  ctx: IPluginContext,
  service: HealthService,
  endpoints: { health?: string; live?: string; ready?: string },
): void {
  // Register /health endpoint
  if (endpoints.health !== undefined) {
    ctx.router.get(endpoints.health, createHealthHandler(ctx, service, 'check'));
  }

  // Register /live endpoint
  if (endpoints.live !== undefined) {
    ctx.router.get(endpoints.live, createHealthHandler(ctx, service, 'checkLive'));
  }

  // Register /ready endpoint
  if (endpoints.ready !== undefined) {
    ctx.router.get(endpoints.ready, createHealthHandler(ctx, service, 'checkReady'));
  }
}

/**
 * Creates a handler for a health endpoint.
 *
 * @param ctx - Plugin context
 * @param service - Health service instance
 * @param method - The method to call on the service
 * @returns A route handler function
 */
function createHealthHandler(
  _ctx: IPluginContext,
  service: HealthService,
  method: 'check' | 'checkLive' | 'checkReady',
): (
  c: { response: { status: (code: number) => { json: <T>(body: T) => HandlerResult } } },
) => Promise<HandlerResult> {
  return async (
    c: { response: { status: (code: number) => { json: <T>(body: T) => HandlerResult } } },
  ): Promise<HandlerResult> => {
    const report = await service[method]();
    const statusCode = determineStatusCode(report, method);
    return c.response.status(statusCode).json(report);
  };
}

/**
 * Determines the HTTP status code for a health report.
 *
 * - `/live`: Always 200 (self indicator always returns up)
 * - `/ready`: 200 if all up, 503 otherwise
 * - `/health`: 200 if no down, 503 if any down (degraded is 200)
 *
 * @param report - The health report
 * @param method - The method that produced the report
 * @returns The HTTP status code
 */
function determineStatusCode(
  report: HealthReport,
  method: 'check' | 'checkLive' | 'checkReady',
): number {
  if (method === 'checkLive') {
    // Liveness is always 200 as long as the process responds
    return 200;
  }

  if (method === 'checkReady') {
    // Readiness is 503 if any indicator is not up
    return report.status === 'up' ? 200 : 503;
  }

  // Overall health: 503 only if any indicator is down
  // degraded stays 200 so operators can see details without hard alerts
  if (report.status === 'down') {
    return 503;
  }

  return 200;
}
