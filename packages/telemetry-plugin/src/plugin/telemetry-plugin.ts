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
  ITelemetryService,
  MiddlewareFunction,
  TelemetryContext,
} from '@hono-enterprise/common';
import { CAPABILITIES, TELEMETRY_CONTEXT_OPAQUE } from '@hono-enterprise/common';
import type { TelemetryPluginOptions, TracerHost } from '../interfaces/index.ts';
import { NoopTelemetryService, TelemetryService } from '../services/telemetry-service.ts';
import { telemetryMiddleware } from '../middleware/telemetry-middleware.ts';

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

      if (options.exporter) {
        // Real OTel mode
        if (options.tracerProviderFactory) {
          tracerHost = await options.tracerProviderFactory();
        } else {
          tracerHost = await loadOtelTracerProvider(options);
        }
        service = new TelemetryService(tracerHost);

        // Register shutdown hook to flush pending spans
        ctx.lifecycle.onShutdown(async () => {
          if (tracerHost) {
            await tracerHost.shutdown();
          }
        });
      } else {
        // Noop mode
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
 * @internal
/**
 * Creates a minimal TracerHost for noop mode — supports extractContext/injectContext
 * so the middleware can run even when the service is NoopTelemetryService.
 *
 * Exported for test seam coverage of inner methods (startSpan, shutdown, forceFlush).
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
      return extractTraceparentContext(headers);
    },
    injectContext(context: TelemetryContext) {
      return injectTraceparent(context);
    },
    shutdown: async () => {},
    forceFlush: async () => {},
  };
}

/**
 * Extracts traceparent/tracestate from headers and returns a TelemetryContext.
 *
 * @internal
 */
function extractTraceparentContext(headers: Headers): TelemetryContext {
  const header = headers.get('traceparent');
  const tracestate = headers.get('tracestate');
  const match = header?.match(
    /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/,
  );
  if (!match || match[1] !== '00') {
    return { _opaque: TELEMETRY_CONTEXT_OPAQUE };
  }
  const result: TelemetryContext = {
    _opaque: TELEMETRY_CONTEXT_OPAQUE,
    traceId: match[2],
    spanId: match[3],
    traceFlags: match[4],
  };
  if (tracestate) {
    return { ...result, tracestate };
  }
  return result;
}

/**
 * Serialises a TelemetryContext into a W3C traceparent header.
 *
 * @internal
 */
function injectTraceparent(context: TelemetryContext): Record<string, string> {
  if (!context.traceId || !context.spanId) {
    return {};
  }
  const flags = context.traceFlags ?? '01';
  return { traceparent: `00-${context.traceId}-${context.spanId}-${flags}` };
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
