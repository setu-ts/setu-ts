/**
 * Unit tests for Gauge.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Gauge } from '../../src/metrics/gauge.ts';

describe('Gauge', () => {
  it('set() sets the value', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.set(10);
    expect(gauge.getValue()).toEqual(10);

    gauge.set(5);
    expect(gauge.getValue()).toEqual(5);
  });

  it('inc() adds to the value', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.set(10);
    gauge.inc(5);
    expect(gauge.getValue()).toEqual(15);

    gauge.inc();
    expect(gauge.getValue()).toEqual(16);
  });

  it('dec() subtracts from the value', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.set(10);
    gauge.dec(3);
    expect(gauge.getValue()).toEqual(7);

    gauge.dec();
    expect(gauge.getValue()).toEqual(6);
  });

  it('observe(v) sets the value', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.observe(42);
    expect(gauge.getValue()).toEqual(42);
  });

  it('negative deltas allowed', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.set(10);
    gauge.inc(-5);
    expect(gauge.getValue()).toEqual(5);

    gauge.dec(-3);
    expect(gauge.getValue()).toEqual(8);
  });

  it('values per label-set', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
      labels: ['method'],
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.set(10, { method: 'GET' });
    gauge.set(20, { method: 'POST' });
    gauge.inc(5, { method: 'GET' });

    expect(gauge.getValue({ method: 'GET' })).toEqual(15);
    expect(gauge.getValue({ method: 'POST' })).toEqual(20);
  });

  it('default value is 0', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
    };
    const gauge = new Gauge('test_gauge', config);

    expect(gauge.getValue()).toEqual(0);
  });

  it('requires labels when configured', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
      labels: ['method', 'status'],
    };
    const gauge = new Gauge('test_gauge', config);

    // Missing required labels
    try {
      gauge.set(10);
      throw new Error('Should have thrown');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message.includes('requires labels')).toEqual(true);
    }

    // Missing one required label
    try {
      gauge.set(10, { method: 'GET' });
      throw new Error('Should have thrown');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message.includes('missing required label')).toEqual(true);
    }
  });

  it('rejects unknown labels', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
      labels: ['method'],
    };
    const gauge = new Gauge('test_gauge', config);

    try {
      gauge.set(10, { method: 'GET', unknown: 'value' });
      throw new Error('Should have thrown');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message.includes('does not have a label')).toEqual(true);
    }
  });

  it('values returns a copy', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.set(10);
    const values1 = gauge.values;
    gauge.set(20);
    const values2 = gauge.values;

    expect(values1.get('')).toEqual(10);
    expect(values2.get('')).toEqual(20);
  });

  it('observe with labels', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
      labels: ['method'],
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.observe(10, { method: 'GET' });
    expect(gauge.getValue({ method: 'GET' })).toEqual(10);

    gauge.observe(20, { method: 'POST' });
    expect(gauge.getValue({ method: 'POST' })).toEqual(20);
  });

  it('inc with default value', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.set(10);
    gauge.inc(); // Should increment by 1
    expect(gauge.getValue()).toEqual(11);
  });

  it('dec with default value', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.set(10);
    gauge.dec(); // Should decrement by 1
    expect(gauge.getValue()).toEqual(9);
  });

  it('N1: undefined ≡ {} for no-label metrics (single series)', () => {
    // N1 behavioral test: a no-label metric where set(10) (undefined) and set(3, {}) (empty object)
    // are both used → the registry/snapshot holds ONE entry.
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
    };
    const gauge = new Gauge('test_gauge', config);

    // Set with undefined (no labels)
    gauge.set(10);
    // Set with empty object
    gauge.set(3, {});

    // Both should access the same series (key = '')
    // Last set wins for gauge, so value should be 3
    expect(gauge.getValue()).toEqual(3);

    // The internal values map should have only ONE entry
    expect(gauge.values.size).toEqual(1);
    expect(gauge.values.get('')).toEqual(3);
  });

  it('empty labels object when no labels configured', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
    };
    const gauge = new Gauge('test_gauge', config);

    // Empty labels object should work when no labels configured
    gauge.set(10, {});
    expect(gauge.getValue({})).toEqual(10);
  });

  it('inc with labels', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
      labels: ['method'],
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.set(10, { method: 'GET' });
    gauge.inc(5, { method: 'GET' });
    expect(gauge.getValue({ method: 'GET' })).toEqual(15);
  });

  it('dec with labels', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
      labels: ['method'],
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.set(10, { method: 'GET' });
    gauge.dec(3, { method: 'GET' });
    expect(gauge.getValue({ method: 'GET' })).toEqual(7);
  });

  it('observe with labels', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
      labels: ['method'],
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.observe(10, { method: 'GET' });
    expect(gauge.getValue({ method: 'GET' })).toEqual(10);
  });

  it('empty object labels throws when labels required', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
      labels: ['method'],
    };
    const gauge = new Gauge('test_gauge', config);

    // Empty object should throw when labels are required
    try {
      gauge.set(10, {});
      throw new Error('Should have thrown');
    } catch (error) {
      if (!(error instanceof Error)) throw error;
      expect(error.message.includes('missing required label')).toEqual(true);
    }
  });

  it('inc with undefined value uses default', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.set(10);
    gauge.inc(undefined as unknown as number); // Should use default value of 1
    expect(gauge.getValue()).toEqual(11);
  });

  it('dec with undefined value uses default', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.set(10);
    gauge.dec(undefined as unknown as number); // Should use default value of 1
    expect(gauge.getValue()).toEqual(9);
  });

  it('dec with labels when no value exists uses default 0', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
      labels: ['method'],
    };
    const gauge = new Gauge('test_gauge', config);

    // dec with labels when no value exists should use default 0
    gauge.dec(5, { method: 'GET' });
    expect(gauge.getValue({ method: 'GET' })).toEqual(-5);
  });

  it('dec with labels reduces value correctly', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
      labels: ['method'],
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.set(100, { method: 'GET' });
    gauge.dec(30, { method: 'GET' });
    expect(gauge.getValue({ method: 'GET' })).toEqual(70);
  });

  it('dec with negative value increases', () => {
    const config = {
      type: 'gauge' as const,
      help: 'Test gauge',
    };
    const gauge = new Gauge('test_gauge', config);

    gauge.set(10);
    gauge.dec(-5); // dec by -5 is same as inc by 5
    expect(gauge.getValue()).toEqual(15);
  });
});
