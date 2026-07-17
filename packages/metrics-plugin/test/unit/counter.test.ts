/**
 * Unit tests for Counter.
 *
 * @module
 */
import { assertEquals, assertThrows } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { Counter } from '../../src/metrics/counter.ts';

Deno.test('Counter — inc() defaults to 1', () => {
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

Deno.test('Counter — inc(n, labels) adds per label-set', () => {
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

Deno.test('Counter — observe(v, labels) equals inc(v, labels)', () => {
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

Deno.test('Counter — counts are monotonic', () => {
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

Deno.test('Counter — negative inc is rejected', () => {
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

Deno.test('Counter — values are stored per label-set', () => {
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

Deno.test('Counter — values Map is readonly', () => {
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
