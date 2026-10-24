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
  HealthDiagnosticsSnapshot,
  HealthReport,
  IHealthDiagnosticsSource,
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
import {
  COLLECTOR_ERRORS,
  compileHealthDiagnosticsPolicy,
  HealthObservationCollector,
} from '../diagnostics/health-observation-collector.ts';
import {
  attachHealthObservation,
  compileReadiness,
  HealthService,
  isIndicatorRegistered,
  resolveIndicatorTimeout,
  runIndicatorRaw,
} from '../services/health-service.ts';
import { createSelfIndicator } from '../indicators/self-indicator.ts';
import { VERSION } from '../version.ts';

/**
 * The inert, disabled health-diagnostics source (M98d). Registered when the
 * plugin's `diagnostics` option is absent: it reports `disabled` and performs
 * no capture — no buffer, no timer, no callback wrapper, no registration
 * observer. It still validates the instance argument with the same fixed,
 * value-free error as the active source, so a connector never sees a
 * differently-shaped failure for the disabled path.
 *
 * @internal
 */
function createDisabledHealthSource(): IHealthDiagnosticsSource {
  return {
    snapshot(instanceId: string): HealthDiagnosticsSnapshot {
      if (typeof instanceId !== 'string' || instanceId === '') {
        throw new RangeError(COLLECTOR_ERRORS.badInstanceId);
      }
      return Object.freeze({
        version: 1,
        instanceId,
        state: 'disabled',
        observations: Object.freeze([]),
        truncated: false,
        droppedObservations: 0,
      });
    },
  };
}

/**
 * Creates a health plugin.
 *
 * @param options - Plugin configuration options
 * @returns A plugin that registers an `IHealthService` under `'health'`
 * @throws {TypeError} If details is not a boolean or readiness membership is invalid
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
  const readiness = compileReadiness(options?.readiness);
  if (options?.details !== undefined && typeof options.details !== 'boolean') {
    throw new TypeError('HealthPlugin details must be a boolean.');
  }
  const details = options?.details ?? false;
  const endpoints = options?.endpoints ?? {
    health: '/health',
    live: '/live',
    ready: '/ready',
  };
  const indicators: readonly HealthIndicatorEntry[] = options?.indicators ?? [];
  // Validated at CONSTRUCTION, not register: a bad deadline is a
  // configuration error the caller can fix before any plugin runs, and the
  // failure names the option (M90b).
  const indicatorTimeoutMs = resolveIndicatorTimeout(options?.indicatorTimeoutMs);
  // The health-observation policy (M98d) is validated at CONSTRUCTION for the
  // same reason: an invalid option — including `enabled: false` from a
  // caller the literal type cannot reach — refuses before any application
  // exists, with a fixed, value-free message.
  const diagnosticsPolicy =
    options?.diagnostics === undefined ? null : compileHealthDiagnosticsPolicy(options.diagnostics);

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
  const instances = indicators.filter(
    (entry): entry is IHealthIndicator => typeof entry !== 'function',
  );
  const factories = indicators
    .map((entry, index) => ({ entry, index }))
    .filter(
      (slot): slot is { entry: RegistryFactory<IHealthIndicator>; index: number } =>
        typeof slot.entry === 'function',
    );

  return {
    name: 'health-plugin',
    version: VERSION,
    provides: [CAPABILITIES.HEALTH, CAPABILITIES.HEALTH_DIAGNOSTICS],
    priority: 100,

    register(ctx: IPluginContext): void {
      const runtime = ctx.runtime;

      // Create the health service
      // The override is applied INSIDE the service, so a plugin that calls
      // `IHealthService.registerIndicator` directly is covered too.
      const service = new HealthService(runtime, {
        indicatorTimeoutMs,
        readiness: { include: [...readiness.include], exclude: [...readiness.exclude] },
      });

      // Every source passes its declared membership; the service applies the
      // operator's include/exclude once, at registration.
      const registerIndicator = (indicator: IHealthIndicator): void => {
        service.registerIndicator(
          indicator.name,
          indicator.check.bind(indicator),
          indicator.readiness === undefined ? undefined : { readiness: indicator.readiness },
        );
      };

      // Register the service
      ctx.services.register<IHealthService>(CAPABILITIES.HEALTH, service);

      // Register the built-in self indicator first
      const selfIndicator = createSelfIndicator(runtime);
      service.registerIndicator(selfIndicator.name, selfIndicator.check.bind(selfIndicator));

      // Register any app-supplied indicator INSTANCES, exactly as before the
      // factory arm existed.
      for (const indicator of instances) {
        registerIndicator(indicator);
      }

      // Register the health endpoints
      registerHealthEndpoints(ctx, service, endpoints, details);

      // Wire the health-observation source (M98d). An absent `diagnostics`
      // option registers an inert disabled source and performs no capture; a
      // present option builds the collector, attaches it to the service so the
      // runner reports each settled indicator, and registers the active source
      // under CAPABILITIES.HEALTH_DIAGNOSTICS.
      if (diagnosticsPolicy !== null) {
        const collector = new HealthObservationCollector(diagnosticsPolicy, runtime, {
          run: (name) => runIndicatorRaw(service, name),
        });
        attachHealthObservation(service, collector);
        ctx.services.register<IHealthDiagnosticsSource>(CAPABILITIES.HEALTH_DIAGNOSTICS, collector);
        ctx.lifecycle.onBootstrap(() => {
          // Every indicator — instance, factory, contribution — is registered
          // by now. An approved name no indicator carries would stay
          // `never-observed` forever; say so once, with a count rather than
          // the names (indicator names are treated as sensitive topology).
          let missing = 0;
          for (const name of diagnosticsPolicy.aliasBySourceName.keys()) {
            if (!isIndicatorRegistered(service, name)) {
              missing += 1;
            }
          }
          if (missing > 0) {
            ctx.logger?.warn(
              `Health diagnostics: ${missing} approved indicator name(s) match no registered ` +
                'indicator and will stay never-observed.',
            );
          }
          collector.startScheduled();
        });
        ctx.lifecycle.onClose(() => {
          collector.close();
        });
      } else {
        ctx.services.register<IHealthDiagnosticsSource>(
          CAPABILITIES.HEALTH_DIAGNOSTICS,
          createDisabledHealthSource(),
        );
      }

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
          registerIndicator(indicator);
        }

        const contributions = ctx.services.getAll<IHealthIndicator>(CAPABILITIES.HEALTH_INDICATOR);

        for (const contribution of contributions) {
          registerIndicator(contribution);
        }
      });

      // Names are sensitive topology: warn once, retaining only a count. Run at
      // bootstrap, after EVERY plugin's onInit, so an indicator another plugin
      // registers directly through IHealthService from its own onInit (which
      // runs after this plugin's, in registration order) is not miscounted.
      // Registered only when an override names something, so a plugin with no
      // readiness option adds no hook (the same rule the diagnostics wiring keeps).
      if (readiness.include.size + readiness.exclude.size > 0) {
        ctx.lifecycle.onBootstrap(() => {
          const missing = [...readiness.include, ...readiness.exclude].filter(
            (name) => !isIndicatorRegistered(service, name),
          ).length;
          if (missing > 0) {
            ctx.logger?.warn(
              `Health readiness: ${missing} indicator name(s) match no registered indicator.`,
            );
          }
        });
      }
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
  details: boolean,
): void {
  // Register /health endpoint
  if (endpoints.health !== undefined) {
    ctx.router.get(endpoints.health, createHealthHandler(service, 'check', details));
  }

  // Register /live endpoint
  if (endpoints.live !== undefined) {
    ctx.router.get(endpoints.live, createHealthHandler(service, 'checkLive', details));
  }

  // Register /ready endpoint
  if (endpoints.ready !== undefined) {
    ctx.router.get(endpoints.ready, createHealthHandler(service, 'checkReady', details));
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
  details: boolean,
): RouteHandler {
  return async (ctx: IRequestContext): Promise<HandlerResult> => {
    const report = await service[method]();
    const statusCode = determineStatusCode(report, method);
    const body = details
      ? report
      : {
          status: report.status,
          timestamp: report.timestamp,
          checks: Object.fromEntries(
            Object.entries(report.checks).map(([name, check]) => [name, { status: check.status }]),
          ),
        };
    return ctx.response.status(statusCode).json(body);
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
