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
  HealthIndicatorFn,
  HealthReport,
  IHealthIndicator,
  IHealthService,
  IPlugin,
  IPluginContext,
  IRequestContext,
  RegistryFactory,
  RouteHandler,
} from '@setu-ts/common';
import { CAPABILITIES, resolveRegistryEntry } from '@setu-ts/common';
import type { HealthIndicatorEntry, HealthPluginOptions } from '../interfaces/index.ts';
import { HealthService } from '../services/health-service.ts';
import { createSelfIndicator } from '../indicators/self-indicator.ts';
import denoJson from '../../deno.json' with { type: 'json' };

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
 *     (services) => createDatabaseIndicator(services),
 *   ],
 * }));
 * ```
 *
 * `indicators` accepts an instance or a `RegistryFactory`
 * (`(services: IServiceRegistry) => IHealthIndicator`). A factory is resolved at
 * `onInit` — the first phase at which the registry holds every capability — and,
 * because `HealthPlugin` registers at priority 100, before the database and every
 * other ordinary capability plugin. Instance indicators keep their `register()` timing.
 *
 * @since 0.2.0
 */
export function HealthPlugin(options?: HealthPluginOptions): IPlugin {
  const endpoints = options?.endpoints ?? {
    health: '/health',
    live: '/live',
    ready: '/ready',
  };
  const indicators: readonly HealthIndicatorEntry[] = options?.indicators ?? [];

  // Split the two arms once, at plugin construction, so `register` and the
  // `onInit` hook each read a single list. Instances keep their pre-factory
  // timing; factories are resolved at `onInit`, the first phase at which the
  // registry holds every capability — this plugin registers at priority 100,
  // before the database and every other ordinary capability plugin.
  //
  // Each factory carries the index it holds in the DECLARED array, not its
  // position among the factories: the index is the only thing the error label
  // has to point a developer at the failing entry, and filtering first made it
  // name a different — working — entry whenever the two arms were mixed.
  const instances = indicators.filter((entry): entry is IHealthIndicator =>
    typeof entry !== 'function'
  );
  const factories = indicators
    .map((entry, index) => ({ entry, index }))
    .filter((slot): slot is { entry: RegistryFactory<IHealthIndicator>; index: number } =>
      typeof slot.entry === 'function'
    );

  return {
    name: 'health-plugin',
    version: denoJson.version,
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

      // Register any app-supplied indicator INSTANCES, exactly as before the
      // factory arm existed.
      for (const indicator of instances) {
        service.registerIndicator(indicator.name, indicator.check.bind(indicator));
      }

      // Register the health endpoints
      registerHealthEndpoints(ctx, service, endpoints);

      // At onInit: resolve the factory entries FIRST, then drain
      // HEALTH_INDICATOR contributions. Factories precede contributions so
      // the existing invariant — application-supplied indicators before plugin
      // contributions — decides which side of a duplicate name is reported.
      // A factory that throws rejects start(), naming the option and entry.
      ctx.lifecycle.onInit(() => {
        for (const slot of factories) {
          const indicator = resolveRegistryEntry(
            slot.entry,
            ctx.services,
            `HealthPlugin({ indicators })[${slot.index}]`,
          );
          service.registerIndicator(indicator.name, indicator.check.bind(indicator));
        }

        const contributions = ctx.services.getAll<{
          name: string;
          check: HealthIndicatorFn;
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
    ctx.router.get(endpoints.health, createHealthHandler(service, 'check'));
  }

  // Register /live endpoint
  if (endpoints.live !== undefined) {
    ctx.router.get(endpoints.live, createHealthHandler(service, 'checkLive'));
  }

  // Register /ready endpoint
  if (endpoints.ready !== undefined) {
    ctx.router.get(endpoints.ready, createHealthHandler(service, 'checkReady'));
  }
}

/**
 * Creates a route handler for a health endpoint.
 *
 * @param service - Health service instance
 * @param method - The method to call on the service
 * @returns A route handler that serializes the report with the right status code
 */
function createHealthHandler(
  service: HealthService,
  method: 'check' | 'checkLive' | 'checkReady',
): RouteHandler {
  return async (ctx: IRequestContext): Promise<HandlerResult> => {
    const report = await service[method]();
    const statusCode = determineStatusCode(report, method);
    return ctx.response.status(statusCode).json(report);
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
