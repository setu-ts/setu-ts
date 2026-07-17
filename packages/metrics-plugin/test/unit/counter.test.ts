/**
 * Unit tests for Counter.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { Counter } from '../../src/metrics/counter.ts';

describe('Counter', () => {
  it('inc() defaults to 1', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test counter',
    };
    const counter = new Counter('test_counter', config);

    counter.observe();
    assertEquals(counter.getValue(), 1);

    counter.inc();
    assertEquals(counter.getValue(), 2);
  });

  it('inc(n, labels) adds per label-set', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test counter',
      labels: ['method'],
    };
    const counter = new Counter('test_counter', config);

    counter.inc(5, { method: 'GET' });
    counter.inc(3, { method: 'POST' });

    assertEquals(counter.getValue({ method: 'GET' }), 5);
    assertEquals(counter.getValue({ method: 'POST' }), 3);
  });

  it('observe(v, labels) equals inc(v, labels)', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test counter',
    };
    const counter = new Counter('test_counter', config);

    counter.observe(10);
    assertEquals(counter.getValue(), 10);

    counter.observe(5, { method: 'GET' });
    assertEquals(counter.getValue({ method: 'GET' }), 5);
  });

  it('counts are monotonic', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test counter',
    };
    const counter = new Counter('test_counter', config);

    counter.inc(10);
    counter.inc(5);
    counter.inc(3);

    assertEquals(counter.getValue(), 18);
  });

  it('negative inc is rejected', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test counter',
    };
    const counter = new Counter('test_counter', config);

    assertThrows(
      () => counter.inc(-1),
      Error,
      'cannot be decremented',
    );
  });

  it('values are stored per label-set', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test counter',
      labels: ['method', 'status'],
    };
    const counter = new Counter('test_counter', config);

    counter.inc(1, { method: 'GET', status: '200' });
    counter.inc(2, { method: 'GET', status: '404' });
    counter.inc(3, { method: 'POST', status: '200' });

    assertEquals(counter.getValue({ method: 'GET', status: '200' }), 1);
    assertEquals(counter.getValue({ method: 'GET', status: '404' }), 2);
    assertEquals(counter.getValue({ method: 'POST', status: '200' }), 3);
    assertEquals(counter.getValue({ method: 'DELETE', status: '200' }), 0);
  });

  it('values Map is readonly', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test counter',
    };
    const counter = new Counter('test_counter', config);

    counter.inc(10);
    const values = counter.values;

    assertEquals(values instanceof Map, true);
    assertEquals(values.get(''), 10);
  });

  it('N1: undefined ≡ {} for no-label metrics (sums correctly)', () => {
    // N1 behavioral test for counter: inc(5) and inc(7, {}) should sum to ONE series with value 12
    const config = {
      type: 'counter' as const,
      help: 'Test counter',
    };
    const counter = new Counter('test_counter', config);

    // Inc with undefined (no labels)
    counter.inc(5);
    // Inc with empty object
    counter.inc(7, {});

    // Both should access the same series (key = ''), values should sum
    assertEquals(counter.getValue(), 12);

    // The internal values map should have only ONE entry
    assertEquals(counter.values.size, 1);
    assertEquals(counter.values.get(''), 12);
  });
});
