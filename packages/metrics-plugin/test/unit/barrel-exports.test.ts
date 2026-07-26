/**
 * Unit tests for barrel exports.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as metricsPlugin from '../../src/index.ts';

describe('barrel exports', () => {
  it('MetricsPlugin is exported', () => {
    expect(typeof metricsPlugin.MetricsPlugin).toEqual('function');
  });

  it('MetricsService is exported', () => {
    expect(typeof metricsPlugin.MetricsService).toEqual('function');
  });

  it('Counter is exported', () => {
    expect(typeof metricsPlugin.Counter).toEqual('function');
  });

  it('Gauge is exported', () => {
    expect(typeof metricsPlugin.Gauge).toEqual('function');
  });

  it('Histogram is exported', () => {
    expect(typeof metricsPlugin.Histogram).toEqual('function');
  });

  it('Summary is exported', () => {
    expect(typeof metricsPlugin.Summary).toEqual('function');
  });

  it('MetricsPluginOptions type is exported', () => {
    // Type-only export, verified at compile time
    const _options: import('../../src/index.ts').MetricsPluginOptions = {
      endpoint: '/metrics',
      defaultMetrics: true,
    };
    expect(_options.endpoint).toEqual('/metrics');
  });

  it('IMetricsService type is re-exported from common', () => {
    // Type-only export, verified at compile time
    const _service: import('../../src/index.ts').IMetricsService | undefined = undefined;
    expect(_service).toEqual(undefined);
  });

  it('ICounter type is re-exported from common', () => {
    // Type-only export, verified at compile time
    const _counter: import('../../src/index.ts').ICounter | undefined = undefined;
    expect(_counter).toEqual(undefined);
  });

  it('IGauge type is re-exported from common', () => {
    // Type-only export, verified at compile time
    const _gauge: import('../../src/index.ts').IGauge | undefined = undefined;
    expect(_gauge).toEqual(undefined);
  });

  it('IHistogram type is re-exported from common', () => {
    // Type-only export, verified at compile time
    const _histogram: import('../../src/index.ts').IHistogram | undefined = undefined;
    expect(_histogram).toEqual(undefined);
  });

  it('ISummary type is re-exported from common', () => {
    // Type-only export, verified at compile time
    const _summary: import('../../src/index.ts').ISummary | undefined = undefined;
    expect(_summary).toEqual(undefined);
  });

  it('IMetric type is re-exported from common', () => {
    // Type-only export, verified at compile time
    const _metric: import('../../src/index.ts').IMetric | undefined = undefined;
    expect(_metric).toEqual(undefined);
  });

  it('MetricConfig type is re-exported from common', () => {
    // Type-only export, verified at compile time
    const _config: import('../../src/index.ts').MetricConfig = {
      type: 'counter',
      help: 'Test',
    };
    expect(_config.type).toEqual('counter');
  });

  it('MetricOptions type is re-exported from common', () => {
    // Type-only export, verified at compile time
    const _options: import('../../src/index.ts').MetricOptions = {
      help: 'Test',
      labels: ['method'],
    };
    expect(_options.help).toEqual('Test');
  });

  it('internal modules are not leaked', () => {
    // Internal modules should NOT be exported from the public barrel
    expect('MetricsRegistry' in metricsPlugin).toEqual(false);
    expect('MetricBase' in metricsPlugin).toEqual(false);
    expect('renderPrometheus' in metricsPlugin).toEqual(false);
    expect('HttpCollector' in metricsPlugin).toEqual(false);
  });
});
