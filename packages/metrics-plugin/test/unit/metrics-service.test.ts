/**
 * Unit tests for MetricsService.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { MetricsService } from '../../src/services/metrics-service.ts';
import type { ICounter, IGauge, IHistogram, ISummary } from '@hono-enterprise/common';

describe('MetricsService', () => {
  it('counter() is get-or-create', () => {
    const service = new MetricsService();

    const counter1 = service.counter('test_counter');
    const counter2 = service.counter('test_counter');

    assertEquals(counter1, counter2);
  });

  it('gauge() is get-or-create', () => {
    const service = new MetricsService();

    const gauge1 = service.gauge('test_gauge');
    const gauge2 = service.gauge('test_gauge');

    assertEquals(gauge1, gauge2);
  });

  it('histogram() is get-or-create', () => {
    const service = new MetricsService();

    const histogram1 = service.histogram('test_histogram');
    const histogram2 = service.histogram('test_histogram');

    assertEquals(histogram1, histogram2);
  });

  it('summary() is get-or-create', () => {
    const service = new MetricsService();

    const summary1 = service.summary('test_summary');
    const summary2 = service.summary('test_summary');

    assertEquals(summary1, summary2);
  });

  it('type mismatch throws', () => {
    const service = new MetricsService();

    service.counter('test_metric');

    assertThrows(
      () => service.gauge('test_metric'),
      Error,
      'already registered as "counter"',
    );
  });

  it('help defaults to name', () => {
    const service = new MetricsService();

    const counter = service.counter('my_counter');
    assertEquals(counter.help, 'my_counter');
  });

  it('help can be overridden', () => {
    const service = new MetricsService();

    const counter = service.counter('my_counter', { help: 'Custom help text' });
    assertEquals(counter.help, 'Custom help text');
  });

  it('get(name) returns metric', () => {
    const service = new MetricsService();

    service.counter('test_counter');

    const metric = service.get('test_counter');
    assertEquals(metric?.name, 'test_counter');
  });

  it('get(name) returns undefined for unknown', () => {
    const service = new MetricsService();

    const metric = service.get('unknown_metric');
    assertEquals(metric, undefined);
  });

  it('counter() returns ICounter', () => {
    const service = new MetricsService();

    const counter = service.counter('test') as ICounter;

    assertEquals(typeof counter.inc, 'function');
    assertEquals(typeof counter.observe, 'function');
  });

  it('gauge() returns IGauge', () => {
    const service = new MetricsService();

    const gauge = service.gauge('test') as IGauge;

    assertEquals(typeof gauge.set, 'function');
    assertEquals(typeof gauge.inc, 'function');
    assertEquals(typeof gauge.dec, 'function');
  });

  it('histogram() returns IHistogram', () => {
    const service = new MetricsService();

    const histogram = service.histogram('test') as IHistogram;

    assertEquals(typeof histogram.observe, 'function');
    assertEquals(Array.isArray(histogram.buckets), true);
  });

  it('summary() returns ISummary', () => {
    const service = new MetricsService();

    const summary = service.summary('test') as ISummary;

    assertEquals(typeof summary.observe, 'function');
    assertEquals(Array.isArray(summary.quantiles), true);
  });

  it('names returns registered metric names', () => {
    const service = new MetricsService();

    service.counter('counter1');
    service.gauge('gauge1');

    const names = service.names;
    assertEquals(names.includes('counter1'), true);
    assertEquals(names.includes('gauge1'), true);
  });

  it('register() for declarative registration', () => {
    const service = new MetricsService();

    const metric = service.register('declared_metric', {
      type: 'counter',
      help: 'Declared metric',
    });

    assertEquals(metric.name, 'declared_metric');
    assertEquals(metric.type, 'counter');
  });

  it('register() for histogram', () => {
    const service = new MetricsService();

    const metric = service.register('histogram_metric', {
      type: 'histogram',
      help: 'Histogram metric',
      buckets: [1, 5, 10],
    });

    assertEquals(metric.name, 'histogram_metric');
    assertEquals(metric.type, 'histogram');
  });

  it('register() for summary', () => {
    const service = new MetricsService();

    const metric = service.register('summary_metric', {
      type: 'summary',
      help: 'Summary metric',
    });

    assertEquals(metric.name, 'summary_metric');
    assertEquals(metric.type, 'summary');
  });

  it('register() throws on type mismatch', () => {
    const service = new MetricsService();

    service.register('test_metric', {
      type: 'counter',
      help: 'Counter',
    });

    assertThrows(
      () =>
        service.register('test_metric', {
          type: 'gauge',
          help: 'Gauge',
        }),
      Error,
      'already registered as "counter"',
    );
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

    assertEquals(histogramSnapshot !== undefined, true);
    assertEquals(histogramSnapshot?.type, 'histogram');
    assertEquals(histogramSnapshot?.values.size, 1);
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

    assertEquals(summarySnapshot !== undefined, true);
    assertEquals(summarySnapshot?.type, 'summary');
    assertEquals(summarySnapshot?.values.size, 1);
  });

  it('render() produces Prometheus format', () => {
    const service = new MetricsService();

    const counter = service.counter('test_counter', {
      help: 'Test counter',
    });

    counter.inc(10);

    const rendered = service.render();

    assertEquals(rendered.includes('# HELP test_counter Test counter'), true);
    assertEquals(rendered.includes('# TYPE test_counter counter'), true);
    assertEquals(rendered.includes('test_counter 10'), true);
  });

  it('defaultBuckets are used', () => {
    const service = new MetricsService({
      defaultBuckets: [0.1, 0.5, 1],
    });

    const histogram = service.histogram('test_histogram');

    assertEquals(histogram.buckets.length, 3);
    assertEquals(histogram.buckets[0], 0.1);
  });

  it('defaultQuantiles are used', () => {
    const service = new MetricsService({
      defaultQuantiles: [0.25, 0.75],
    });

    const summary = service.summary('test_summary');
    assertEquals(summary.quantiles.length, 2);
    assertEquals(summary.quantiles[0], 0.25);
  });

  it('counter type mismatch throws', () => {
    const service = new MetricsService();

    service.counter('test_metric');

    // Try to get it as gauge - should throw
    assertThrows(
      () => service.gauge('test_metric'),
      Error,
      'already registered as "counter"',
    );
  });

  it('gauge type mismatch throws', () => {
    const service = new MetricsService();

    service.gauge('test_metric');

    assertThrows(
      () => service.histogram('test_metric'),
      Error,
      'already registered as "gauge"',
    );
  });

  it('histogram type mismatch throws', () => {
    const service = new MetricsService();

    service.histogram('test_metric');

    assertThrows(
      () => service.summary('test_metric'),
      Error,
      'already registered as "histogram"',
    );
  });

  it('summary type mismatch throws', () => {
    const service = new MetricsService();

    service.summary('test_metric');

    assertThrows(
      () => service.counter('test_metric'),
      Error,
      'already registered as "summary"',
    );
  });

  it('register type mismatch throws', () => {
    const service = new MetricsService();

    service.register('test_metric', {
      type: 'counter',
      help: 'Counter',
    });

    assertThrows(
      () =>
        service.register('test_metric', {
          type: 'gauge',
          help: 'Gauge',
        }),
      Error,
      'already registered as "counter"',
    );
  });

  it('register unknown type throws', () => {
    const service = new MetricsService();

    assertThrows(
      () =>
        service.register('test_metric', {
          type: 'unknown' as unknown as 'counter',
          help: 'Unknown',
        }),
      Error,
      'Unknown metric type',
    );
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

    assertEquals(counterSnapshot !== undefined, true);
    assertEquals(counterSnapshot?.values.size, 2);

    // Check that labels are preserved
    const entries = Array.from(counterSnapshot!.values.entries());
    const firstEntry = entries[0][1];
    assertEquals(firstEntry.labels !== undefined, true);
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

    assertEquals(gaugeSnapshot !== undefined, true);
    assertEquals(gaugeSnapshot?.values.size, 2);

    const entries = Array.from(gaugeSnapshot!.values.entries());
    const firstEntry = entries[0][1];
    assertEquals(firstEntry.labels !== undefined, true);
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

    assertEquals(histogramSnapshot !== undefined, true);
    assertEquals(histogramSnapshot?.values.size, 1);

    const entries = Array.from(histogramSnapshot!.values.entries());
    const firstEntry = entries[0][1];
    assertEquals(firstEntry.labels !== undefined, true);
    assertEquals(firstEntry.buckets !== undefined, true);
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

    assertEquals(summarySnapshot !== undefined, true);
    assertEquals(summarySnapshot?.values.size, 1);

    const entries = Array.from(summarySnapshot!.values.entries());
    const firstEntry = entries[0][1];
    assertEquals(firstEntry.labels !== undefined, true);
    assertEquals(firstEntry.quantiles !== undefined, true);
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

    assertEquals(counterSnapshot !== undefined, true);
    // Should have 2 distinct series (different label key-value pairs)
    assertEquals(counterSnapshot?.values.size, 2);

    const entries = Array.from(counterSnapshot!.values.entries());
    const labels1 = entries[0][0];
    const labels2 = entries[1][0];

    // Verify the two series have different label strings
    assertEquals(labels1 !== labels2, true);
  });

  it('declarative register() honors the service defaultBuckets (same as histogram())', () => {
    const service = new MetricsService({ defaultBuckets: [1, 5, 10] });

    const viaFactory = service.histogram('h_factory') as IHistogram;
    service.register('h_declarative', { type: 'histogram', help: 'd' });
    const viaDeclarative = service.get('h_declarative') as IHistogram;

    // Both entry points must reflect the configured defaultBuckets.
    assertEquals([...viaFactory.buckets], [1, 5, 10]);
    assertEquals([...viaDeclarative.buckets], [1, 5, 10]);
  });

  it('declarative register() honors the service defaultQuantiles (same as summary())', () => {
    const service = new MetricsService({ defaultQuantiles: [0.25, 0.75] });

    const viaFactory = service.summary('s_factory') as ISummary;
    service.register('s_declarative', { type: 'summary', help: 'd' });
    const viaDeclarative = service.get('s_declarative') as ISummary;

    assertEquals([...viaFactory.quantiles], [0.25, 0.75]);
    assertEquals([...viaDeclarative.quantiles], [0.25, 0.75]);
  });

  it('an explicit declarative bucket set still overrides the service default', () => {
    const service = new MetricsService({ defaultBuckets: [1, 5, 10] });
    service.register('h_explicit', { type: 'histogram', help: 'd', buckets: [0.1, 0.2] });
    const hist = service.get('h_explicit') as IHistogram;
    assertEquals([...hist.buckets], [0.1, 0.2]);
  });
});
