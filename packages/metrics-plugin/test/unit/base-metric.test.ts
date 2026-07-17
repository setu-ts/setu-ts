/**
 * Unit tests for MetricBase.
 *
 * @module
 */
import {
  assertEquals,
  assertNotEquals,
  assertThrows,
} from 'https://deno.land/std@0.224.0/assert/mod.ts';
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
  // New JSON.stringify-based format: sorted entries as JSON
  assertEquals(key1, '[["method","GET"],["status","200"]]');
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
  // but labelKey itself now returns '' (N1 fix: {} ≡ undefined for no-label metrics)
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
  // New JSON.stringify-based format: sorted entries as JSON
  assertEquals(key, '[["method","GET"],["status","200"]]');
});

Deno.test('MetricBase — labelKey is injective: multi-label values with | do not collide', () => {
  // Regression test for F1: old key scheme (k=v|k2=v2) allowed collision when
  // label values contained | or = characters.
  // Example collision under old scheme:
  //   {a:'1|b=2', b:'3'} → key "a=1|b=2|b=3"
  //   {a:'1', b:'2|b=3'} → SAME key "a=1|b=2|b=3" (collision!)
  // New scheme uses JSON.stringify(sorted entries) which is injective.
  const config = {
    type: 'counter' as const,
    help: 'Test',
    labels: ['a', 'b'],
  };
  const metric = new TestMetric('test_metric', config);

  const labels1 = { a: '1|b=2', b: '3' };
  const labels2 = { a: '1', b: '2|b=3' };

  const key1 = metric.getLabelKey(labels1);
  const key2 = metric.getLabelKey(labels2);

  // Keys must be distinct (no collision)
  assertNotEquals(key1, key2);

  // Each key must uniquely encode its label set
  // key1 should encode [["a","1|b=2"],["b","3"]]
  assertEquals(key1, '[["a","1|b=2"],["b","3"]]');
  // key2 should encode [["a","1"],["b","2|b=3"]]
  assertEquals(key2, '[["a","1"],["b","2|b=3"]]');
});

Deno.test('MetricBase — labelKey is order-independent (same labels, different order → same key)', () => {
  const config = {
    type: 'counter' as const,
    help: 'Test',
    labels: ['a', 'b'],
  };
  const metric = new TestMetric('test_metric', config);

  const labels1 = { a: '1', b: '2' };
  const labels2 = { b: '2', a: '1' }; // Same labels, different order

  const key1 = metric.getLabelKey(labels1);
  const key2 = metric.getLabelKey(labels2);

  assertEquals(key1, key2);
  assertEquals(key1, '[["a","1"],["b","2"]]');
});

Deno.test('MetricBase — labelKey handles special characters in label values correctly', () => {
  const config = {
    type: 'counter' as const,
    help: 'Test',
    labels: ['x'],
  };
  const metric = new TestMetric('test_metric', config);

  // Single label with | character
  const key1 = metric.getLabelKey({ x: 'a|b' });
  assertEquals(key1, '[["x","a|b"]]');

  // Single label with = character
  const key2 = metric.getLabelKey({ x: 'a=b' });
  assertEquals(key2, '[["x","a=b"]]');

  // Single label with \ character
  const key3 = metric.getLabelKey({ x: 'a\\b' });
  assertEquals(key3, '[["x","a\\\\b"]]');
});

Deno.test('MetricBase — labelKey normalizes undefined and {} to empty string (N1 fix)', () => {
  // N1: no-label metrics with undefined and {} must map to the SAME key ('')
  // to avoid creating duplicate series.
  const config = {
    type: 'counter' as const,
    help: 'Test',
  };
  const metric = new TestMetric('test_metric', config);

  const keyUndefined = metric.getLabelKey(undefined);
  const keyEmptyObj = metric.getLabelKey({});

  // Both must be '' (the empty key for no-label metrics)
  assertEquals(keyUndefined, '');
  assertEquals(keyEmptyObj, '');
  assertEquals(keyUndefined, keyEmptyObj);
});

Deno.test('MetricBase — labelKey preserves F1 injectivity for non-empty labels', () => {
  // F1: distinct label-sets must produce distinct keys (no collision from |, =, \ in values)
  const config = {
    type: 'counter' as const,
    help: 'Test',
    labels: ['a', 'b'],
  };
  const metric = new TestMetric('test_metric', config);

  // These two label-sets would collide under old k=v|k2=v2 scheme
  const labels1 = { a: '1|b=2', b: '3' };
  const labels2 = { a: '1', b: '2|b=3' };

  const key1 = metric.getLabelKey(labels1);
  const key2 = metric.getLabelKey(labels2);

  // Keys must be distinct (no collision)
  assertNotEquals(key1, key2);
  assertEquals(key1, '[["a","1|b=2"],["b","3"]]');
  assertEquals(key2, '[["a","1"],["b","2|b=3"]]');
});

Deno.test('MetricBase — labelKey is order-independent for non-empty labels', () => {
  // Same label-set in different order must produce same key
  const config = {
    type: 'counter' as const,
    help: 'Test',
    labels: ['a', 'b'],
  };
  const metric = new TestMetric('test_metric', config);

  const labels1 = { a: '1', b: '2' };
  const labels2 = { b: '2', a: '1' };

  const key1 = metric.getLabelKey(labels1);
  const key2 = metric.getLabelKey(labels2);

  assertEquals(key1, key2);
  assertEquals(key1, '[["a","1"],["b","2"]]');
});

Deno.test('MetricBase — labelKey handles special characters (B1)', () => {
  // B1: single-label special chars must be properly encoded
  const config = {
    type: 'counter' as const,
    help: 'Test',
    labels: ['x'],
  };
  const metric = new TestMetric('test_metric', config);

  const key1 = metric.getLabelKey({ x: 'a|b' });
  assertEquals(key1, '[["x","a|b"]]');

  const key2 = metric.getLabelKey({ x: 'c=d' });
  assertEquals(key2, '[["x","c=d"]]');

  const key3 = metric.getLabelKey({ x: 'e"f' });
  assertEquals(key3, '[["x","e\\"f"]]');
});
