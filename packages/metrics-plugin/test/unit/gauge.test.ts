/**
 * Unit tests for Gauge.
 *
 * @module
 */
import { assertEquals } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { Gauge } from '../../src/metrics/gauge.ts';

Deno.test('Gauge — set() sets the value', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.set(10);
  assertEquals(gauge.getValue(), 10);

  gauge.set(5);
  assertEquals(gauge.getValue(), 5);
});

Deno.test('Gauge — inc() adds to the value', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.set(10);
  gauge.inc(5);
  assertEquals(gauge.getValue(), 15);

  gauge.inc();
  assertEquals(gauge.getValue(), 16);
});

Deno.test('Gauge — dec() subtracts from the value', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.set(10);
  gauge.dec(3);
  assertEquals(gauge.getValue(), 7);

  gauge.dec();
  assertEquals(gauge.getValue(), 6);
});

Deno.test('Gauge — observe(v) sets the value', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.observe(42);
  assertEquals(gauge.getValue(), 42);
});

Deno.test('Gauge — negative deltas allowed', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.set(10);
  gauge.inc(-5);
  assertEquals(gauge.getValue(), 5);

  gauge.dec(-3);
  assertEquals(gauge.getValue(), 8);
});

Deno.test('Gauge — values per label-set', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
    labels: ['method'],
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.set(10, { method: 'GET' });
  gauge.set(20, { method: 'POST' });
  gauge.inc(5, { method: 'GET' });

  assertEquals(gauge.getValue({ method: 'GET' }), 15);
  assertEquals(gauge.getValue({ method: 'POST' }), 20);
});

Deno.test('Gauge — default value is 0', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
  };
  const gauge = new Gauge('test_gauge', config);

  assertEquals(gauge.getValue(), 0);
});

Deno.test('Gauge — requires labels when configured', () => {
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
    assertEquals(error.message.includes('requires labels'), true);
  }

  // Missing one required label
  try {
    gauge.set(10, { method: 'GET' });
    throw new Error('Should have thrown');
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    assertEquals(error.message.includes('missing required label'), true);
  }
});

Deno.test('Gauge — rejects unknown labels', () => {
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
    assertEquals(error.message.includes('does not have a label'), true);
  }
});

Deno.test('Gauge — values returns a copy', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.set(10);
  const values1 = gauge.values;
  gauge.set(20);
  const values2 = gauge.values;

  assertEquals(values1.get(''), 10);
  assertEquals(values2.get(''), 20);
});

Deno.test('Gauge — observe with labels', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
    labels: ['method'],
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.observe(10, { method: 'GET' });
  assertEquals(gauge.getValue({ method: 'GET' }), 10);

  gauge.observe(20, { method: 'POST' });
  assertEquals(gauge.getValue({ method: 'POST' }), 20);
});

Deno.test('Gauge — inc with default value', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.set(10);
  gauge.inc(); // Should increment by 1
  assertEquals(gauge.getValue(), 11);
});

Deno.test('Gauge — dec with default value', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.set(10);
  gauge.dec(); // Should decrement by 1
  assertEquals(gauge.getValue(), 9);
});

Deno.test('Gauge — N1: undefined ≡ {} for no-label metrics (single series)', () => {
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
  assertEquals(gauge.getValue(), 3);

  // The internal values map should have only ONE entry
  assertEquals(gauge.values.size, 1);
  assertEquals(gauge.values.get(''), 3);
});

Deno.test('Gauge — empty labels object when no labels configured', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
  };
  const gauge = new Gauge('test_gauge', config);

  // Empty labels object should work when no labels configured
  gauge.set(10, {});
  assertEquals(gauge.getValue({}), 10);
});

Deno.test('Gauge — inc with labels', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
    labels: ['method'],
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.set(10, { method: 'GET' });
  gauge.inc(5, { method: 'GET' });
  assertEquals(gauge.getValue({ method: 'GET' }), 15);
});

Deno.test('Gauge — dec with labels', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
    labels: ['method'],
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.set(10, { method: 'GET' });
  gauge.dec(3, { method: 'GET' });
  assertEquals(gauge.getValue({ method: 'GET' }), 7);
});

Deno.test('Gauge — observe with labels', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
    labels: ['method'],
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.observe(10, { method: 'GET' });
  assertEquals(gauge.getValue({ method: 'GET' }), 10);
});

Deno.test('Gauge — empty object labels throws when labels required', () => {
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
    assertEquals(error.message.includes('missing required label'), true);
  }
});

Deno.test('Gauge — inc with undefined value uses default', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.set(10);
  gauge.inc(undefined as unknown as number); // Should use default value of 1
  assertEquals(gauge.getValue(), 11);
});

Deno.test('Gauge — dec with undefined value uses default', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.set(10);
  gauge.dec(undefined as unknown as number); // Should use default value of 1
  assertEquals(gauge.getValue(), 9);
});

Deno.test('Gauge — dec with labels when no value exists uses default 0', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
    labels: ['method'],
  };
  const gauge = new Gauge('test_gauge', config);

  // dec with labels when no value exists should use default 0
  gauge.dec(5, { method: 'GET' });
  assertEquals(gauge.getValue({ method: 'GET' }), -5);
});

Deno.test('Gauge — dec with labels reduces value correctly', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
    labels: ['method'],
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.set(100, { method: 'GET' });
  gauge.dec(30, { method: 'GET' });
  assertEquals(gauge.getValue({ method: 'GET' }), 70);
});

Deno.test('Gauge — dec with negative value increases', () => {
  const config = {
    type: 'gauge' as const,
    help: 'Test gauge',
  };
  const gauge = new Gauge('test_gauge', config);

  gauge.set(10);
  gauge.dec(-5); // dec by -5 is same as inc by 5
  assertEquals(gauge.getValue(), 15);
});
