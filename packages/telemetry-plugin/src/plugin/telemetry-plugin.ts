/**
 * Telemetry plugin factory.
 *
 * Creates a plugin that registers an `ITelemetryService` under
 * `CAPABILITIES.TELEMETRY` (`'telemetry'`).
 *
 * @module
 * @since 0.24.0
 */

import type { IPlugin, ITelemetryService, MiddlewareFunction } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
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
        const middleware: MiddlewareFunction = telemetryMiddleware(service);
        ctx.middleware.add(middleware, {
          priority: MIDDLEWARE_PRIORITY.TELEMETRY,
          name: 'telemetry-middleware',
        });
      }
    },
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
