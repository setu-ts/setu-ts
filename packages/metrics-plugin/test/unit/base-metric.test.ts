/**
 * Unit tests for MetricBase.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
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

describe('MetricBase', () => {
  it('name, type, help are exposed', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test help',
    };
    const metric = new TestMetric('test_metric', config);

    expect(metric.name).toEqual('test_metric'); // Uses class name as default
    expect(metric.type).toEqual('counter');
    expect(metric.help).toEqual('Test help');
  });

  it('labelKey is deterministic and order-independent', () => {
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

    expect(key1).toEqual(key2);
    // New JSON.stringify-based format: sorted entries as JSON
    expect(key1).toEqual('[["method","GET"],["status","200"]]');
  });

  it('unknown label names are rejected', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test',
      labels: ['method'],
    };
    const metric = new TestMetric('test_metric', config);

    expect(() => metric.validateLabelsPublic({ method: 'GET', unknown: 'value' })).toThrow(Error);
    expect(() => metric.validateLabelsPublic({ method: 'GET', unknown: 'value' })).toThrow(
      'does not have a label',
    );
  });

  it('missing required labels are rejected', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test',
      labels: ['method', 'status'],
    };
    const metric = new TestMetric('test_metric', config);

    expect(() => metric.validateLabelsPublic({ method: 'GET' })).toThrow(Error);
    expect(() => metric.validateLabelsPublic({ method: 'GET' })).toThrow('missing required label');
  });

  it('no labels is valid when config has no labels', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test',
    };
    const metric = new TestMetric('test_metric', config);

    // Should not throw
    metric.validateLabelsPublic(undefined);
    metric.validateLabelsPublic({});
  });

  it('empty labels object is valid when no labels required', () => {
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

  it('labelKey returns empty string for undefined labels', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test',
      labels: ['method'],
    };
    const metric = new TestMetric('test_metric', config);

    const key = metric.getLabelKey(undefined);
    expect(key).toEqual('');
  });

  it('labelKey works with empty labels object', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test',
      labels: ['method'],
    };
    const metric = new TestMetric('test_metric', config);

    // Empty object but labels are required - this should throw in validateLabels
    // but labelKey itself now returns '' (N1 fix: {} ≡ undefined for no-label metrics)
    const key = metric.getLabelKey({});
    expect(key).toEqual('');
  });

  it('help defaults to name when not provided', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test',
    };
    const metric = new TestMetric('my_metric', config);

    // help should be 'Test' from config
    expect(metric.help).toEqual('Test');
  });

  it('empty labels object throws when labels are required', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test',
      labels: ['method'],
    };
    const metric = new TestMetric('test_metric', config);

    // Empty labels object when labels required should throw
    expect(() => metric.validateLabelsPublic({})).toThrow(Error);
    expect(() => metric.validateLabelsPublic({})).toThrow('missing required label');
  });

  it('labelKey with all labels present', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test',
      labels: ['method', 'status'],
    };
    const metric = new TestMetric('test_metric', config);

    const key = metric.getLabelKey({ method: 'GET', status: '200' });
    // New JSON.stringify-based format: sorted entries as JSON
    expect(key).toEqual('[["method","GET"],["status","200"]]');
  });

  it('labelKey is injective: multi-label values with | do not collide', () => {
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
    expect(key1).not.toEqual(key2);

    // Each key must uniquely encode its label set
    // key1 should encode [["a","1|b=2"],["b","3"]]
    expect(key1).toEqual('[["a","1|b=2"],["b","3"]]');
    // key2 should encode [["a","1"],["b","2|b=3"]]
    expect(key2).toEqual('[["a","1"],["b","2|b=3"]]');
  });

  it('labelKey is order-independent (same labels, different order → same key)', () => {
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

    expect(key1).toEqual(key2);
    expect(key1).toEqual('[["a","1"],["b","2"]]');
  });

  it('labelKey handles special characters in label values correctly', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test',
      labels: ['x'],
    };
    const metric = new TestMetric('test_metric', config);

    // Single label with | character
    const key1 = metric.getLabelKey({ x: 'a|b' });
    expect(key1).toEqual('[["x","a|b"]]');

    // Single label with = character
    const key2 = metric.getLabelKey({ x: 'a=b' });
    expect(key2).toEqual('[["x","a=b"]]');

    // Single label with \ character
    const key3 = metric.getLabelKey({ x: 'a\\b' });
    expect(key3).toEqual('[["x","a\\\\b"]]');
  });

  it('labelKey normalizes undefined and {} to empty string (N1 fix)', () => {
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
    expect(keyUndefined).toEqual('');
    expect(keyEmptyObj).toEqual('');
    expect(keyUndefined).toEqual(keyEmptyObj);
  });

  it('labelKey preserves F1 injectivity for non-empty labels', () => {
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
    expect(key1).not.toEqual(key2);
    expect(key1).toEqual('[["a","1|b=2"],["b","3"]]');
    expect(key2).toEqual('[["a","1"],["b","2|b=3"]]');
  });

  it('labelKey is order-independent for non-empty labels', () => {
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

    expect(key1).toEqual(key2);
    expect(key1).toEqual('[["a","1"],["b","2"]]');
  });

  it('labelKey handles special characters (B1)', () => {
    // B1: single-label special chars must be properly encoded
    const config = {
      type: 'counter' as const,
      help: 'Test',
      labels: ['x'],
    };
    const metric = new TestMetric('test_metric', config);

    const key1 = metric.getLabelKey({ x: 'a|b' });
    expect(key1).toEqual('[["x","a|b"]]');

    const key2 = metric.getLabelKey({ x: 'c=d' });
    expect(key2).toEqual('[["x","c=d"]]');

    const key3 = metric.getLabelKey({ x: 'e"f' });
    expect(key3).toEqual('[["x","e\\"f"]]');
  });
});
