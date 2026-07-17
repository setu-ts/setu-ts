/**
 * Metrics plugin factory.
 *
 * Creates a plugin that registers a MetricsService under
 * `CAPABILITIES.METRICS` (`'metrics'`).
 *
 * @module
 */
import type { IMetricsService, IPlugin } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { MetricsPluginOptions } from '../interfaces/index.ts';
import { MetricsService } from '../services/metrics-service.ts';
import { HttpCollector, MIDDLEWARE_PRIORITY } from '../collectors/http-collector.ts';

/**
 * Creates a metrics plugin.
 *
 * @param options - Plugin configuration
 * @returns A plugin that registers an IMetricsService under `'metrics'`
 *
 * @example
 * ```typescript
 * app.register(MetricsPlugin());
 *
 * // Or with custom options
 * app.register(MetricsPlugin({
 *   endpoint: '/metrics',
 *   httpMetrics: true,
 *   customMetrics: [...],
 * }));
 * ```
 * @since 0.19.0
 */
export function MetricsPlugin(options?: MetricsPluginOptions): IPlugin {
  const endpoint = options?.endpoint ?? '/metrics';
  const defaultMetrics = options?.defaultMetrics ?? true;
  const httpMetrics = options?.httpMetrics ?? true;
  const customMetrics = options?.customMetrics ?? [];
  const defaultBuckets = options?.defaultBuckets ?? [
    0.005,
    0.01,
    0.025,
    0.05,
    0.1,
    0.25,
    0.5,
    1,
    2.5,
    5,
    10,
  ];
  const defaultQuantiles = options?.defaultQuantiles ?? [0.5, 0.9, 0.99];

  return {
    name: 'metrics-plugin',
    version: '0.1.0',
    provides: [CAPABILITIES.METRICS],
    priority: 100,

    register(ctx) {
      // Create the metrics service
      const service = new MetricsService({
        defaultBuckets,
        defaultQuantiles,
      });

      // Register the service
      ctx.services.register<IMetricsService>(CAPABILITIES.METRICS, service);

      // Register HTTP metrics and middleware if enabled
      if (defaultMetrics) {
        if (httpMetrics) {
          const collector = new HttpCollector(service, ctx.runtime);
          collector.register();

          ctx.middleware.add(collector.middleware.bind(collector), {
            priority: MIDDLEWARE_PRIORITY.METRICS,
            name: 'metrics-middleware',
          });
        }
      }

      // Register the /metrics route
      ctx.router.get(endpoint, (ctx) => {
        return ctx.response
          .header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
          .status(200)
          .text(service.render());
      });

      // Drain METRIC_REGISTRATION contributions at onInit
      ctx.lifecycle.onInit(() => {
        // Get all metric registration contributions
        const registrations = ctx.services.getAll<{
          name: string;
          config: import('@hono-enterprise/common').MetricConfig;
        }>(CAPABILITIES.METRIC_REGISTRATION);

        // Materialize each registration
        for (const registration of registrations) {
          service.register(registration.name, registration.config);
        }

        // Materialize custom metrics from options
        for (const metric of customMetrics) {
          service.register(metric.name, metric);
        }
      });
    },
  };
}
