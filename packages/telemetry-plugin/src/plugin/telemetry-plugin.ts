/**
 * Telemetry plugin factory.
 *
 * Creates a plugin that registers an `ITelemetryService` under
 * `CAPABILITIES.TELEMETRY` (`'telemetry'`).
 *
 * @module
 * @since 0.24.0
 */

import type {
  IPlugin,
  IRuntimeServices,
  ITelemetryService,
  MiddlewareFunction,
  TelemetryContext,
} from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { TelemetryPluginOptions, TracerHost } from '../interfaces/index.ts';
import { NoopTelemetryService, TelemetryService } from '../services/telemetry-service.ts';
import { telemetryMiddleware } from '../middleware/telemetry-middleware.ts';
import { contextToTraceparent, extractContextFromHeaders } from '../tracing/tracer.ts';
import { buildInstrumentationRegistry } from '../instrumentation/instrumentation-registry.ts';

/**
 * Middleware priority for telemetry (inside metrics at 20, outside auth at 300).
 *
 * @internal
 */
const MIDDLEWARE_PRIORITY = {
  TELEMETRY: 30,
} as const;

/**
 * Creates a telemetry plugin.
 *
 * Registers an `ITelemetryService` under `CAPABILITIES.TELEMETRY` and,
 * by default, adds request-span middleware at priority 30.
 *
 * When no `exporter` is configured, a `NoopTelemetryService` is registered
 * (zero dependencies). When `exporter` is `'otlp'` or `'console'`, the
 * plugin lazy-loads the OTel SDK and registers a real `TelemetryService`.
 *
 * @param options - Plugin configuration
 * @returns A plugin that registers `ITelemetryService` under `'telemetry'`
 *
 * @example
 * ```typescript
 * // Noop mode (zero deps)
 * app.register(TelemetryPlugin({ serviceName: 'my-app' }));
 *
 * // Real OTel mode with console exporter
 * app.register(TelemetryPlugin({
 *   serviceName: 'my-app',
 *   exporter: 'console',
 * }));
 *
 * // Real OTel mode with OTLP exporter
 * app.register(TelemetryPlugin({
 *   serviceName: 'my-app',
 *   exporter: 'otlp',
 *   endpoint: 'http://otel:4318/v1/traces',
 * }));
 * ```
 * @since 0.24.0
 */
export function TelemetryPlugin(options: TelemetryPluginOptions = {}): IPlugin {
  const middlewareEnabled = options.middleware !== false;

  return {
    name: 'telemetry-plugin',
    version: '0.1.0',
    provides: [CAPABILITIES.TELEMETRY],
    priority: MIDDLEWARE_PRIORITY.TELEMETRY,

    async register(ctx) {
      let service: ITelemetryService;
      let tracerHost: TracerHost | undefined;
      let instrumentationHandle: { shutdown(): Promise<void> } | null = null;

      if (options.exporter) {
        // Real OTel mode
        if (options.tracerProviderFactory) {
          tracerHost = await options.tracerProviderFactory();
        } else {
          tracerHost = await loadOtelTracerProvider(options);
        }
        service = new TelemetryService(tracerHost);

        // Build instrumentation registry after the host is obtained.
        // Only runs when all three conditions hold: instrumentations configured,
        // real mode (exporter set), and host exposes otelProvider.
        // Awaiting ensures all lazy loads complete BEFORE onShutdown is registered,
        // eliminating the shutdown-ordering race for the lazy path.
        if (options.instrumentations && tracerHost.otelProvider) {
          instrumentationHandle = await buildInstrumentationRegistry(
            options.instrumentations,
            ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME!),
            tracerHost.otelProvider,
          );
        }

        // Register shutdown hook: disable instrumentations first, then shut down the provider.
        ctx.lifecycle.onShutdown(async () => {
          if (instrumentationHandle) {
            await instrumentationHandle.shutdown();
          }
          if (tracerHost) {
            await tracerHost.shutdown();
          }
        });
      } else {
        // Noop mode — instrumentations are a no-op (no exporter = no provider).
        service = new NoopTelemetryService();
      }

      // Register the service
      ctx.services.register<ITelemetryService>(CAPABILITIES.TELEMETRY, service);

      // Register middleware if enabled
      if (middlewareEnabled) {
        // Pass tracerHost to middleware for context extraction/injection (C1/C2/R2).
        // In noop mode, create a minimal TracerHost that still supports extractContext/injectContext.
        const host = tracerHost ?? createNoopTracerHost();
        const middleware: MiddlewareFunction = telemetryMiddleware(service, host);
        ctx.middleware.add(middleware, {
          priority: MIDDLEWARE_PRIORITY.TELEMETRY,
          name: 'telemetry-middleware',
        });
      }
    },
  };
}

/**
 * Creates a minimal TracerHost for noop mode — supports extractContext/injectContext
 * so the middleware can run even when the service is NoopTelemetryService.
 *
 * Exported for test seam coverage of inner methods (startSpan, shutdown, forceFlush).
 *
 * N3 fix: reuses W3C helpers exported from `tracer.ts` instead of duplicating them.
 */
export function createNoopTracerHost(): TracerHost {
  return {
    startSpan(_name: string) {
      return {
        setAttribute: () => {},
        setStatus: () => {},
        recordException: () => {},
        end: () => {},
      };
    },
    extractContext(headers: Headers) {
      return extractContextFromHeaders(headers);
    },
    injectContext(context: TelemetryContext) {
      const header = contextToTraceparent(context);
      if (header) {
        return { traceparent: header };
      }
      return {};
    },
    shutdown: async () => {},
    forceFlush: async () => {},
  };
}

async function loadOtelTracerProvider(options: TelemetryPluginOptions): Promise<TracerHost> {
  const { loadOtelTracerProvider: loader } = await import('../tracing/tracer.ts');
  return loader(options);
}

export { telemetryMiddleware } from '../middleware/telemetry-middleware.ts';
export { NoopTelemetryService } from '../services/telemetry-service.ts';
export type { TracerHost } from '../interfaces/index.ts';
export type { SpanExporterKind, TelemetryPluginOptions } from '../interfaces/index.ts';
export { TELEMETRY_SPAN_KEY } from '../interfaces/index.ts';
