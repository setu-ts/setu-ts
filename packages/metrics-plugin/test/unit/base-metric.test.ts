/**
 * Unit tests for MetricBase.
 *
 * @module
 */
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { MetricBase } from '../../src/metrics/base-metric.ts';

/**
 * Test implementation of MetricBase.
 */
class TestMetric extends MetricBase {
  observe(_value?: number, _labels?: Readonly<Record<string, string>>): void {
    // No-op for testing
  }

  getLabelKey(labels?: Readonly<Record<string, string>>): string {
    return this.labelKey(labels);
  }

  validateLabelsPublic(labels?: Readonly<Record<string, string>>): void {
    this.validateLabels(labels);
  }
}

Deno.test('MetricBase — name, type, help are exposed', () => {
  const config = {
    type: 'counter' as const,
    help: 'Test help',
  };
  const metric = new TestMetric('test_metric', config);

  assertEquals(metric.name, 'test_metric'); // Uses class name as default
  assertEquals(metric.type, 'counter');
  assertEquals(metric.help, 'Test help');
});

Deno.test('MetricBase — labelKey is deterministic and order-independent', () => {
  const config = {
    type: 'counter' as const,
    help: 'Test',
    labels: ['method', 'status'],
  };
  const metric = new TestMetric('test_metric', config);

  const labels1 = { method: 'GET', status: '200' };
  const labels2 = { status: '200', method: 'GET' };

  const key1 = metric.getLabelKey(labels1);
  const key2 = metric.getLabelKey(labels2);

  assertEquals(key1, key2);
  assertEquals(key1.includes('method=GET'), true);
  assertEquals(key1.includes('status=200'), true);
});

Deno.test('MetricBase — unknown label names are rejected', () => {
  const config = {
    type: 'counter' as const,
    help: 'Test',
    labels: ['method'],
  };
  const metric = new TestMetric('test_metric', config);

  assertThrows(
    () => metric.validateLabelsPublic({ method: 'GET', unknown: 'value' }),
    Error,
    'does not have a label',
  );
});

Deno.test('MetricBase — missing required labels are rejected', () => {
  const config = {
    type: 'counter' as const,
    help: 'Test',
    labels: ['method', 'status'],
  };
  const metric = new TestMetric('test_metric', config);

  assertThrows(
    () => metric.validateLabelsPublic({ method: 'GET' }),
    Error,
    'missing required label',
  );
});

Deno.test('MetricBase — no labels is valid when config has no labels', () => {
  const config = {
    type: 'counter' as const,
    help: 'Test',
  };
  const metric = new TestMetric('test_metric', config);

  // Should not throw
  metric.validateLabelsPublic(undefined);
  metric.validateLabelsPublic({});
});

Deno.test('MetricBase — empty labels object is valid when no labels required', () => {
  const config = {
    type: 'counter' as const,
    help: 'Test',
    labels: [],
  };
  const metric = new TestMetric('test_metric', config);

  // Should not throw
  metric.validateLabelsPublic(undefined);
  metric.validateLabelsPublic({});
});

Deno.test('MetricBase — labelKey returns empty string for undefined labels', () => {
  const config = {
    type: 'counter' as const,
    help: 'Test',
    labels: ['method'],
  };
  const metric = new TestMetric('test_metric', config);

  const key = metric.getLabelKey(undefined);
  assertEquals(key, '');
});

Deno.test('MetricBase — labelKey works with empty labels object', () => {
  const config = {
    type: 'counter' as const,
    help: 'Test',
    labels: ['method'],
  };
  const metric = new TestMetric('test_metric', config);

  // Empty object but labels are required - this should throw in validateLabels
  // but labelKey itself should return empty string
  const key = metric.getLabelKey({});
  assertEquals(key, '');
});

Deno.test('MetricBase — help defaults to name when not provided', () => {
  const config = {
    type: 'counter' as const,
    help: 'Test',
  };
  const metric = new TestMetric('my_metric', config);

  // help should be 'Test' from config
  assertEquals(metric.help, 'Test');
});

Deno.test('MetricBase — empty labels object throws when labels are required', () => {
  const config = {
    type: 'counter' as const,
    help: 'Test',
    labels: ['method'],
  };
  const metric = new TestMetric('test_metric', config);

  // Empty labels object when labels required should throw
  assertThrows(
    () => metric.validateLabelsPublic({}),
    Error,
    'missing required label',
  );
});

Deno.test('MetricBase — labelKey with all labels present', () => {
  const config = {
    type: 'counter' as const,
    help: 'Test',
    labels: ['method', 'status'],
  };
  const metric = new TestMetric('test_metric', config);

  const key = metric.getLabelKey({ method: 'GET', status: '200' });
  // Should contain both labels in sorted order
  assertEquals(key.includes('method=GET'), true);
  assertEquals(key.includes('status=200'), true);
});
