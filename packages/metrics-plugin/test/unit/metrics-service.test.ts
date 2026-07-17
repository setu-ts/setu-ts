/**
 * Unit tests for MetricsService.
 *
 * @module
 */
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { MetricsService } from '../../src/services/metrics-service.ts';
import type { ICounter, IGauge, IHistogram, ISummary } from '@hono-enterprise/common';

Deno.test('MetricsService — counter() is get-or-create', () => {
  const service = new MetricsService();

  const counter1 = service.counter('test_counter');
  const counter2 = service.counter('test_counter');

  assertEquals(counter1, counter2);
});

Deno.test('MetricsService — gauge() is get-or-create', () => {
  const service = new MetricsService();

  const gauge1 = service.gauge('test_gauge');
  const gauge2 = service.gauge('test_gauge');

  assertEquals(gauge1, gauge2);
});

Deno.test('MetricsService — histogram() is get-or-create', () => {
  const service = new MetricsService();

  const histogram1 = service.histogram('test_histogram');
  const histogram2 = service.histogram('test_histogram');

  assertEquals(histogram1, histogram2);
});

Deno.test('MetricsService — summary() is get-or-create', () => {
  const service = new MetricsService();

  const summary1 = service.summary('test_summary');
  const summary2 = service.summary('test_summary');

  assertEquals(summary1, summary2);
});

Deno.test('MetricsService — type mismatch throws', () => {
  const service = new MetricsService();

  service.counter('test_metric');

  assertThrows(
    () => service.gauge('test_metric'),
    Error,
    'already registered as "counter"',
  );
});

Deno.test('MetricsService — help defaults to name', () => {
  const service = new MetricsService();

  const counter = service.counter('my_counter');
  assertEquals(counter.help, 'my_counter');
});

Deno.test('MetricsService — help can be overridden', () => {
  const service = new MetricsService();

  const counter = service.counter('my_counter', { help: 'Custom help text' });
  assertEquals(counter.help, 'Custom help text');
});

Deno.test('MetricsService — get(name) returns metric', () => {
  const service = new MetricsService();

  service.counter('test_counter');

  const metric = service.get('test_counter');
  assertEquals(metric?.name, 'test_counter');
});

Deno.test('MetricsService — get(name) returns undefined for unknown', () => {
  const service = new MetricsService();

  const metric = service.get('unknown_metric');
  assertEquals(metric, undefined);
});

Deno.test('MetricsService — counter() returns ICounter', () => {
  const service = new MetricsService();

  const counter = service.counter('test') as ICounter;

  assertEquals(typeof counter.inc, 'function');
  assertEquals(typeof counter.observe, 'function');
});

Deno.test('MetricsService — gauge() returns IGauge', () => {
  const service = new MetricsService();

  const gauge = service.gauge('test') as IGauge;

  assertEquals(typeof gauge.set, 'function');
  assertEquals(typeof gauge.inc, 'function');
  assertEquals(typeof gauge.dec, 'function');
});

Deno.test('MetricsService — histogram() returns IHistogram', () => {
  const service = new MetricsService();

  const histogram = service.histogram('test') as IHistogram;

  assertEquals(typeof histogram.observe, 'function');
  assertEquals(Array.isArray(histogram.buckets), true);
});

Deno.test('MetricsService — summary() returns ISummary', () => {
  const service = new MetricsService();

  const summary = service.summary('test') as ISummary;

  assertEquals(typeof summary.observe, 'function');
  assertEquals(Array.isArray(summary.quantiles), true);
});

Deno.test('MetricsService — names returns registered metric names', () => {
  const service = new MetricsService();

  service.counter('counter1');
  service.gauge('gauge1');

  const names = service.names;
  assertEquals(names.includes('counter1'), true);
  assertEquals(names.includes('gauge1'), true);
});

Deno.test('MetricsService — register() for declarative registration', () => {
  const service = new MetricsService();

  const metric = service.register('declared_metric', {
    type: 'counter',
    help: 'Declared metric',
  });

  assertEquals(metric.name, 'declared_metric');
  assertEquals(metric.type, 'counter');
});
