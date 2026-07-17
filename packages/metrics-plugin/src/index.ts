/**
 * @module
 *
 * Prometheus metrics plugin for Hono Enterprise.
 *
 * This plugin provides:
 * - `MetricsPlugin` - The plugin factory
 * - `MetricsService` - The metrics service for recording metrics
 * - Counter, Gauge, Histogram, Summary - Metric instrument classes
 * - `IMetricsService`, `ICounter`, `IGauge`, `IHistogram`, `ISummary` - Type contracts from common
 *
 * @example
 * ```typescript
 * import { MetricsPlugin } from '@hono-enterprise/metrics-plugin';
 *
 * app.register(MetricsPlugin({
 *   endpoint: '/metrics',
 *   httpMetrics: true,
 * }));
 *
 * // Record metrics
 * const metrics = ctx.services.get<IMetricsService>('metrics');
 * const counter = metrics.counter('my_counter', { help: 'My counter' });
 * counter.inc(1);
 * ```
 */
export { MetricsPlugin } from './plugin/metrics-plugin.ts';
export type { MetricsPluginOptions } from './interfaces/index.ts';
export { MetricsService } from './services/metrics-service.ts';
export { Counter } from './metrics/counter.ts';
export { Gauge } from './metrics/gauge.ts';
export { Histogram } from './metrics/histogram.ts';
export { Summary } from './metrics/summary.ts';

// Re-export type contracts from common
export type {
  ICounter,
  IGauge,
  IHistogram,
  IMetric,
  IMetricsService,
  ISummary,
  MetricConfig,
  MetricOptions,
} from '@hono-enterprise/common';
