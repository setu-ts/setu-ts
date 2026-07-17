/**
 * Unit tests for Prometheus renderer.
 *
 * @module
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { renderPrometheus } from '../../src/renderers/prometheus-renderer.ts';
import type { MetricSnapshot } from '../../src/interfaces/index.ts';

Deno.test('renderPrometheus — empty snapshots returns empty string', () => {
  const result = renderPrometheus([]);
  assertEquals(result, '');
});

Deno.test('renderPrometheus — counter emits # HELP / # TYPE / value', () => {
  const snapshot: MetricSnapshot = {
    name: 'test_counter',
    type: 'counter',
    help: 'Test counter help',
    labels: [],
    values: new Map([['', { value: 42 }]]),
  };

  const result = renderPrometheus([snapshot]);

  assertEquals(result.includes('# HELP test_counter Test counter help'), true);
  assertEquals(result.includes('# TYPE test_counter counter'), true);
  assertEquals(result.includes('test_counter 42'), true);
});

Deno.test('renderPrometheus — gauge emits # HELP / # TYPE / value', () => {
  const snapshot: MetricSnapshot = {
    name: 'test_gauge',
    type: 'gauge',
    help: 'Test gauge help',
    labels: [],
    values: new Map([['', { value: 10 }]]),
  };

  const result = renderPrometheus([snapshot]);

  assertEquals(result.includes('# HELP test_gauge Test gauge help'), true);
  assertEquals(result.includes('# TYPE test_gauge gauge'), true);
  assertEquals(result.includes('test_gauge 10'), true);
});

Deno.test('renderPrometheus — histogram emits buckets + sum + count', () => {
  const snapshot: MetricSnapshot = {
    name: 'test_histogram',
    type: 'histogram',
    help: 'Test histogram help',
    labels: [],
    values: new Map([
      [
        '',
        {
          value: 10,
          sum: 100,
          buckets: new Map([
            [1, 3],
            [5, 7],
            [Number.POSITIVE_INFINITY, 10],
          ]),
        },
      ],
    ]),
  };

  const result = renderPrometheus([snapshot]);

  assertEquals(result.includes('# HELP test_histogram Test histogram help'), true);
  assertEquals(result.includes('# TYPE test_histogram histogram'), true);
  assertEquals(result.includes('_bucket{'), true);
  assertEquals(result.includes('le="1"'), true);
  assertEquals(result.includes('le="+Inf"'), true);
  assertEquals(result.includes('_sum'), true);
  assertEquals(result.includes('_count'), true);
});

Deno.test('renderPrometheus — summary emits quantiles + sum + count', () => {
  const snapshot: MetricSnapshot = {
    name: 'test_summary',
    type: 'summary',
    help: 'Test summary help',
    labels: [],
    values: new Map([
      [
        '',
        {
          value: 10,
          sum: 100,
          quantiles: new Map([
            [0.5, 5],
            [0.9, 9],
            [0.99, 9.9],
          ]),
        },
      ],
    ]),
  };

  const result = renderPrometheus([snapshot]);

  assertEquals(result.includes('# HELP test_summary Test summary help'), true);
  assertEquals(result.includes('# TYPE test_summary summary'), true);
  assertEquals(result.includes('quantile="0.5"'), true);
  assertEquals(result.includes('quantile="0.9"'), true);
  assertEquals(result.includes('quantile="0.99"'), true);
  assertEquals(result.includes('_sum'), true);
  assertEquals(result.includes('_count'), true);
});

Deno.test('renderPrometheus — label escaping handles backslash and newline', () => {
  const snapshot: MetricSnapshot = {
    name: 'test_counter',
    type: 'counter',
    help: 'Test',
    labels: ['method'],
    values: new Map([['method=GET', { value: 1 }]]),
  };

  const result = renderPrometheus([snapshot]);

  // Should contain the label
  assertEquals(result.includes('method="GET"'), true);
});

Deno.test('renderPrometheus — multiple metrics are separated', () => {
  const counter: MetricSnapshot = {
    name: 'counter1',
    type: 'counter',
    help: 'Counter 1',
    labels: [],
    values: new Map([['', { value: 1 }]]),
  };

  const gauge: MetricSnapshot = {
    name: 'gauge1',
    type: 'gauge',
    help: 'Gauge 1',
    labels: [],
    values: new Map([['', { value: 2 }]]),
  };

  const result = renderPrometheus([counter, gauge]);

  assertEquals(result.includes('counter1'), true);
  assertEquals(result.includes('gauge1'), true);
  // Metrics should be separated by blank lines
  assertEquals(result.match(/\n\n/g)?.length, 1);
});
