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
