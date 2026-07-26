/**
 * Unit tests for MetricsService.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MetricsService } from '../../src/services/metrics-service.ts';
import type { ICounter, IGauge, IHistogram, ISummary } from '@hono-enterprise/common';

describe('MetricsService', () => {
  it('counter() is get-or-create', () => {
    const service = new MetricsService();

    const counter1 = service.counter('test_counter');
    const counter2 = service.counter('test_counter');

    expect(counter1).toEqual(counter2);
  });

  it('gauge() is get-or-create', () => {
    const service = new MetricsService();

    const gauge1 = service.gauge('test_gauge');
    const gauge2 = service.gauge('test_gauge');

    expect(gauge1).toEqual(gauge2);
  });

  it('histogram() is get-or-create', () => {
    const service = new MetricsService();

    const histogram1 = service.histogram('test_histogram');
    const histogram2 = service.histogram('test_histogram');

    expect(histogram1).toEqual(histogram2);
  });

  it('summary() is get-or-create', () => {
    const service = new MetricsService();

    const summary1 = service.summary('test_summary');
    const summary2 = service.summary('test_summary');

    expect(summary1).toEqual(summary2);
  });

  it('type mismatch throws', () => {
    const service = new MetricsService();

    service.counter('test_metric');

    expect(() => service.gauge('test_metric')).toThrow(Error);
    expect(() => service.gauge('test_metric')).toThrow('already registered as "counter"');
  });

  it('help defaults to name', () => {
    const service = new MetricsService();

    const counter = service.counter('my_counter');
    expect(counter.help).toEqual('my_counter');
  });

  it('help can be overridden', () => {
    const service = new MetricsService();

    const counter = service.counter('my_counter', { help: 'Custom help text' });
    expect(counter.help).toEqual('Custom help text');
  });

  it('get(name) returns metric', () => {
    const service = new MetricsService();

    service.counter('test_counter');

    const metric = service.get('test_counter');
    expect(metric?.name).toEqual('test_counter');
  });

  it('get(name) returns undefined for unknown', () => {
    const service = new MetricsService();

    const metric = service.get('unknown_metric');
    expect(metric).toEqual(undefined);
  });

  it('counter() returns ICounter', () => {
    const service = new MetricsService();

    const counter = service.counter('test') as ICounter;

    expect(typeof counter.inc).toEqual('function');
    expect(typeof counter.observe).toEqual('function');
  });

  it('gauge() returns IGauge', () => {
    const service = new MetricsService();

    const gauge = service.gauge('test') as IGauge;

    expect(typeof gauge.set).toEqual('function');
    expect(typeof gauge.inc).toEqual('function');
    expect(typeof gauge.dec).toEqual('function');
  });

  it('histogram() returns IHistogram', () => {
    const service = new MetricsService();

    const histogram = service.histogram('test') as IHistogram;

    expect(typeof histogram.observe).toEqual('function');
    expect(Array.isArray(histogram.buckets)).toEqual(true);
  });

  it('summary() returns ISummary', () => {
    const service = new MetricsService();

    const summary = service.summary('test') as ISummary;

    expect(typeof summary.observe).toEqual('function');
    expect(Array.isArray(summary.quantiles)).toEqual(true);
  });

  it('names returns registered metric names', () => {
    const service = new MetricsService();

    service.counter('counter1');
    service.gauge('gauge1');

    const names = service.names;
    expect(names.includes('counter1')).toEqual(true);
    expect(names.includes('gauge1')).toEqual(true);
  });

  it('register() for declarative registration', () => {
    const service = new MetricsService();

    const metric = service.register('declared_metric', {
      type: 'counter',
      help: 'Declared metric',
    });

    expect(metric.name).toEqual('declared_metric');
    expect(metric.type).toEqual('counter');
  });

  it('register() for histogram', () => {
    const service = new MetricsService();

    const metric = service.register('histogram_metric', {
      type: 'histogram',
      help: 'Histogram metric',
      buckets: [1, 5, 10],
    });

    expect(metric.name).toEqual('histogram_metric');
    expect(metric.type).toEqual('histogram');
  });

  it('register() for summary', () => {
    const service = new MetricsService();

    const metric = service.register('summary_metric', {
      type: 'summary',
      help: 'Summary metric',
    });

    expect(metric.name).toEqual('summary_metric');
    expect(metric.type).toEqual('summary');
  });

  it('register() throws on type mismatch', () => {
    const service = new MetricsService();

    service.register('test_metric', {
      type: 'counter',
      help: 'Counter',
    });

    expect(() =>
      service.register('test_metric', {
        type: 'gauge',
        help: 'Gauge',
      })
    ).toThrow(Error);
    expect(() =>
      service.register('test_metric', {
        type: 'gauge',
        help: 'Gauge',
      })
    ).toThrow('already registered as "counter"');
  });

  it('snapshot() includes histogram data', () => {
    const service = new MetricsService();

    const histogram = service.histogram('test_histogram', {
      help: 'Test histogram',
      buckets: [1, 5],
    });

    histogram.observe(3);
    histogram.observe(10);

    const snapshot = service.snapshot();
    const histogramSnapshot = snapshot.find((s) => s.name === 'test_histogram');

    expect(histogramSnapshot !== undefined).toEqual(true);
    expect(histogramSnapshot?.type).toEqual('histogram');
    expect(histogramSnapshot?.values.size).toEqual(1);
  });

  it('snapshot() includes summary data', () => {
    const service = new MetricsService();

    const summary = service.summary('test_summary', {
      help: 'Test summary',
    });

    summary.observe(3);
    summary.observe(10);

    const snapshot = service.snapshot();
    const summarySnapshot = snapshot.find((s) => s.name === 'test_summary');

    expect(summarySnapshot !== undefined).toEqual(true);
    expect(summarySnapshot?.type).toEqual('summary');
    expect(summarySnapshot?.values.size).toEqual(1);
  });

  it('render() produces Prometheus format', () => {
    const service = new MetricsService();

    const counter = service.counter('test_counter', {
      help: 'Test counter',
    });

    counter.inc(10);

    const rendered = service.render();

    expect(rendered.includes('# HELP test_counter Test counter')).toEqual(true);
    expect(rendered.includes('# TYPE test_counter counter')).toEqual(true);
    expect(rendered.includes('test_counter 10')).toEqual(true);
  });

  it('defaultBuckets are used', () => {
    const service = new MetricsService({
      defaultBuckets: [0.1, 0.5, 1],
    });

    const histogram = service.histogram('test_histogram');

    expect(histogram.buckets.length).toEqual(3);
    expect(histogram.buckets[0]).toEqual(0.1);
  });

  it('defaultQuantiles are used', () => {
    const service = new MetricsService({
      defaultQuantiles: [0.25, 0.75],
    });

    const summary = service.summary('test_summary');
    expect(summary.quantiles.length).toEqual(2);
    expect(summary.quantiles[0]).toEqual(0.25);
  });

  it('counter type mismatch throws', () => {
    const service = new MetricsService();

    service.counter('test_metric');

    // Try to get it as gauge - should throw
    expect(() => service.gauge('test_metric')).toThrow(Error);
    expect(() => service.gauge('test_metric')).toThrow('already registered as "counter"');
  });

  it('gauge type mismatch throws', () => {
    const service = new MetricsService();

    service.gauge('test_metric');

    expect(() => service.histogram('test_metric')).toThrow(Error);
    expect(() => service.histogram('test_metric')).toThrow('already registered as "gauge"');
  });

  it('histogram type mismatch throws', () => {
    const service = new MetricsService();

    service.histogram('test_metric');

    expect(() => service.summary('test_metric')).toThrow(Error);
    expect(() => service.summary('test_metric')).toThrow('already registered as "histogram"');
  });

  it('summary type mismatch throws', () => {
    const service = new MetricsService();

    service.summary('test_metric');

    expect(() => service.counter('test_metric')).toThrow(Error);
    expect(() => service.counter('test_metric')).toThrow('already registered as "summary"');
  });

  it('register type mismatch throws', () => {
    const service = new MetricsService();

    service.register('test_metric', {
      type: 'counter',
      help: 'Counter',
    });

    expect(() =>
      service.register('test_metric', {
        type: 'gauge',
        help: 'Gauge',
      })
    ).toThrow(Error);
    expect(() =>
      service.register('test_metric', {
        type: 'gauge',
        help: 'Gauge',
      })
    ).toThrow('already registered as "counter"');
  });

  it('register unknown type throws', () => {
    const service = new MetricsService();

    expect(() =>
      service.register('test_metric', {
        type: 'unknown' as unknown as 'counter',
        help: 'Unknown',
      })
    ).toThrow(Error);
    expect(() =>
      service.register('test_metric', {
        type: 'unknown' as unknown as 'counter',
        help: 'Unknown',
      })
    ).toThrow('Unknown metric type');
  });

  it('snapshot with counter labels', () => {
    const service = new MetricsService();

    const counter = service.counter('test_counter', {
      labels: ['method'],
    });

    counter.inc(10, { method: 'GET' });
    counter.inc(5, { method: 'POST' });

    const snapshot = service.snapshot();
    const counterSnapshot = snapshot.find((s) => s.name === 'test_counter');

    expect(counterSnapshot !== undefined).toEqual(true);
    expect(counterSnapshot?.values.size).toEqual(2);

    // Check that labels are preserved
    const entries = Array.from(counterSnapshot!.values.entries());
    const firstEntry = entries[0][1];
    expect(firstEntry.labels !== undefined).toEqual(true);
  });

  it('snapshot with gauge labels', () => {
    const service = new MetricsService();

    const gauge = service.gauge('test_gauge', {
      labels: ['host'],
    });

    gauge.set(100, { host: 'server1' });
    gauge.set(200, { host: 'server2' });

    const snapshot = service.snapshot();
    const gaugeSnapshot = snapshot.find((s) => s.name === 'test_gauge');

    expect(gaugeSnapshot !== undefined).toEqual(true);
    expect(gaugeSnapshot?.values.size).toEqual(2);

    const entries = Array.from(gaugeSnapshot!.values.entries());
    const firstEntry = entries[0][1];
    expect(firstEntry.labels !== undefined).toEqual(true);
  });

  it('snapshot with histogram labels', () => {
    const service = new MetricsService();

    const histogram = service.histogram('test_histogram', {
      labels: ['method'],
      buckets: [1, 5],
    });

    histogram.observe(3, { method: 'GET' });
    histogram.observe(10, { method: 'GET' });

    const snapshot = service.snapshot();
    const histogramSnapshot = snapshot.find((s) => s.name === 'test_histogram');

    expect(histogramSnapshot !== undefined).toEqual(true);
    expect(histogramSnapshot?.values.size).toEqual(1);

    const entries = Array.from(histogramSnapshot!.values.entries());
    const firstEntry = entries[0][1];
    expect(firstEntry.labels !== undefined).toEqual(true);
    expect(firstEntry.buckets !== undefined).toEqual(true);
  });

  it('snapshot with summary labels', () => {
    const service = new MetricsService();

    const summary = service.summary('test_summary', {
      labels: ['endpoint'],
    });

    summary.observe(3, { endpoint: '/api/users' });
    summary.observe(10, { endpoint: '/api/users' });

    const snapshot = service.snapshot();
    const summarySnapshot = snapshot.find((s) => s.name === 'test_summary');

    expect(summarySnapshot !== undefined).toEqual(true);
    expect(summarySnapshot?.values.size).toEqual(1);

    const entries = Array.from(summarySnapshot!.values.entries());
    const firstEntry = entries[0][1];
    expect(firstEntry.labels !== undefined).toEqual(true);
    expect(firstEntry.quantiles !== undefined).toEqual(true);
  });

  it('F1: multi-label | values produce distinct series', () => {
    const service = new MetricsService();

    const counter = service.counter('test_counter', {
      labels: ['a', 'b'],
    }) as ICounter;

    // Two different label combinations with | characters in values
    counter.inc(1, { a: '1|b=2', b: '3' });
    counter.inc(1, { a: '1', b: '2|b=3' });

    const snapshot = service.snapshot();
    const counterSnapshot = snapshot.find((s) => s.name === 'test_counter');

    expect(counterSnapshot !== undefined).toEqual(true);
    // Should have 2 distinct series (different label key-value pairs)
    expect(counterSnapshot?.values.size).toEqual(2);

    const entries = Array.from(counterSnapshot!.values.entries());
    const labels1 = entries[0][0];
    const labels2 = entries[1][0];

    // Verify the two series have different label strings
    expect(labels1 !== labels2).toEqual(true);
  });

  it('declarative register() honors the service defaultBuckets (same as histogram())', () => {
    const service = new MetricsService({ defaultBuckets: [1, 5, 10] });

    const viaFactory = service.histogram('h_factory') as IHistogram;
    service.register('h_declarative', { type: 'histogram', help: 'd' });
    const viaDeclarative = service.get('h_declarative') as IHistogram;

    // Both entry points must reflect the configured defaultBuckets.
    expect([...viaFactory.buckets]).toEqual([1, 5, 10]);
    expect([...viaDeclarative.buckets]).toEqual([1, 5, 10]);
  });

  it('declarative register() honors the service defaultQuantiles (same as summary())', () => {
    const service = new MetricsService({ defaultQuantiles: [0.25, 0.75] });

    const viaFactory = service.summary('s_factory') as ISummary;
    service.register('s_declarative', { type: 'summary', help: 'd' });
    const viaDeclarative = service.get('s_declarative') as ISummary;

    expect([...viaFactory.quantiles]).toEqual([0.25, 0.75]);
    expect([...viaDeclarative.quantiles]).toEqual([0.25, 0.75]);
  });

  it('an explicit declarative bucket set still overrides the service default', () => {
    const service = new MetricsService({ defaultBuckets: [1, 5, 10] });
    service.register('h_explicit', { type: 'histogram', help: 'd', buckets: [0.1, 0.2] });
    const hist = service.get('h_explicit') as IHistogram;
    expect([...hist.buckets]).toEqual([0.1, 0.2]);
  });
});
