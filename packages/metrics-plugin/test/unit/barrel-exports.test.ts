/**
 * Unit tests for barrel exports.
 *
 * @module
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import * as metricsPlugin from '../../src/index.ts';

Deno.test('barrel exports — MetricsPlugin is exported', () => {
  assertEquals(typeof metricsPlugin.MetricsPlugin, 'function');
});

Deno.test('barrel exports — MetricsService is exported', () => {
  assertEquals(typeof metricsPlugin.MetricsService, 'function');
});

Deno.test('barrel exports — Counter is exported', () => {
  assertEquals(typeof metricsPlugin.Counter, 'function');
});

Deno.test('barrel exports — Gauge is exported', () => {
  assertEquals(typeof metricsPlugin.Gauge, 'function');
});

Deno.test('barrel exports — Histogram is exported', () => {
  assertEquals(typeof metricsPlugin.Histogram, 'function');
});

Deno.test('barrel exports — Summary is exported', () => {
  assertEquals(typeof metricsPlugin.Summary, 'function');
});

Deno.test('barrel exports — MetricsPluginOptions type is exported', () => {
  // Type-only export, verified at compile time
  const _options: import('../../src/index.ts').MetricsPluginOptions = {
    endpoint: '/metrics',
    defaultMetrics: true,
  };
  assertEquals(_options.endpoint, '/metrics');
});

Deno.test('barrel exports — IMetricsService type is re-exported from common', () => {
  // Type-only export, verified at compile time
  const _service: import('../../src/index.ts').IMetricsService | undefined = undefined;
  assertEquals(_service, undefined);
});

Deno.test('barrel exports — ICounter type is re-exported from common', () => {
  // Type-only export, verified at compile time
  const _counter: import('../../src/index.ts').ICounter | undefined = undefined;
  assertEquals(_counter, undefined);
});

Deno.test('barrel exports — IGauge type is re-exported from common', () => {
  // Type-only export, verified at compile time
  const _gauge: import('../../src/index.ts').IGauge | undefined = undefined;
  assertEquals(_gauge, undefined);
});

Deno.test('barrel exports — IHistogram type is re-exported from common', () => {
  // Type-only export, verified at compile time
  const _histogram: import('../../src/index.ts').IHistogram | undefined = undefined;
  assertEquals(_histogram, undefined);
});

Deno.test('barrel exports — ISummary type is re-exported from common', () => {
  // Type-only export, verified at compile time
  const _summary: import('../../src/index.ts').ISummary | undefined = undefined;
  assertEquals(_summary, undefined);
});

Deno.test('barrel exports — IMetric type is re-exported from common', () => {
  // Type-only export, verified at compile time
  const _metric: import('../../src/index.ts').IMetric | undefined = undefined;
  assertEquals(_metric, undefined);
});

Deno.test('barrel exports — MetricConfig type is re-exported from common', () => {
  // Type-only export, verified at compile time
  const _config: import('../../src/index.ts').MetricConfig = {
    type: 'counter',
    help: 'Test',
  };
  assertEquals(_config.type, 'counter');
});

Deno.test('barrel exports — MetricOptions type is re-exported from common', () => {
  // Type-only export, verified at compile time
  const _options: import('../../src/index.ts').MetricOptions = {
    help: 'Test',
    labels: ['method'],
  };
  assertEquals(_options.help, 'Test');
});

Deno.test('barrel exports — internal modules are not leaked', () => {
  // Internal modules should NOT be exported from the public barrel
  assertEquals(
    'MetricsRegistry' in metricsPlugin,
    false,
    'MetricsRegistry should not be exported',
  );
  assertEquals(
    'MetricBase' in metricsPlugin,
    false,
    'MetricBase should not be exported',
  );
  assertEquals(
    'renderPrometheus' in metricsPlugin,
    false,
    'renderPrometheus should not be exported',
  );
  assertEquals(
    'HttpCollector' in metricsPlugin,
    false,
    'HttpCollector should not be exported',
  );
});
