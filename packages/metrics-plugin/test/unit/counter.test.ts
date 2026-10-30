/**
 * Unit tests for Counter.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { Counter } from '../../src/metrics/counter.ts';

describe('Counter', () => {
  it('inc() defaults to 1', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test counter',
    };
    const counter = new Counter('test_counter', config);

    counter.observe();
    expect(counter.getValue()).toEqual(1);

    counter.inc();
    expect(counter.getValue()).toEqual(2);
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

    expect(counter.getValue({ method: 'GET' })).toEqual(5);
    expect(counter.getValue({ method: 'POST' })).toEqual(3);
  });

  it('observe(v, labels) equals inc(v, labels)', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test counter',
    };
    const counter = new Counter('test_counter', config);

    counter.observe(10);
    expect(counter.getValue()).toEqual(10);

    counter.observe(5, { method: 'GET' });
    expect(counter.getValue({ method: 'GET' })).toEqual(5);
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

    expect(counter.getValue()).toEqual(18);
  });

  it('negative inc is rejected', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test counter',
    };
    const counter = new Counter('test_counter', config);

    expect(() => counter.inc(-1)).toThrow(Error);
    expect(() => counter.inc(-1)).toThrow('cannot be decremented');
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

    expect(counter.getValue({ method: 'GET', status: '200' })).toEqual(1);
    expect(counter.getValue({ method: 'GET', status: '404' })).toEqual(2);
    expect(counter.getValue({ method: 'POST', status: '200' })).toEqual(3);
    expect(counter.getValue({ method: 'DELETE', status: '200' })).toEqual(0);
  });

  it('values Map is readonly', () => {
    const config = {
      type: 'counter' as const,
      help: 'Test counter',
    };
    const counter = new Counter('test_counter', config);

    counter.inc(10);
    const values = counter.values;

    expect(values instanceof Map).toEqual(true);
    expect(values.get('')).toEqual(10);
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
    expect(counter.getValue()).toEqual(12);

    // The internal values map should have only ONE entry
    expect(counter.values.size).toEqual(1);
    expect(counter.values.get('')).toEqual(12);
  });
  it('refuses an extra label when the configured names repeat one', () => {
    const counter = new Counter('dup_labels', {
      type: 'counter',
      help: 'Duplicate label names',
      labels: ['a', 'a'],
    });
    expect(() => counter.inc(1, { a: 'x', b: 'y' })).toThrow('does not have a label "b"');
    expect(counter.values.size).toBe(0);
  });

  it('leaves no series behind for a label set it refuses', () => {
    const counter = new Counter('refused_labels', {
      type: 'counter',
      help: 'Refused labels',
      labels: ['method', 'status'],
    });
    expect(() => counter.inc(1, { method: 'GET', route: '/x' })).toThrow(
      'does not have a label "route"',
    );
    counter.inc(1, { method: 'GET', status: '200' });
    expect([...counter.values.keys()]).toEqual(['[["method","GET"],["status","200"]]']);
  });

  it('keys the same series whatever order the labels are given in', () => {
    const counter = new Counter('ordered_labels', {
      type: 'counter',
      help: 'Label order',
      labels: ['method', 'status'],
    });
    counter.inc(1, { method: 'GET', status: '200' });
    counter.inc(1, { status: '200', method: 'GET' });
    expect(counter.getValue({ method: 'GET', status: '200' })).toBe(2);
    expect(counter.values.size).toBe(1);
  });

  it('treats an empty label list as unlabeled', () => {
    const counter = new Counter('empty_labels', { type: 'counter', help: 'No labels', labels: [] });
    counter.inc(1, {});
    counter.inc(1);
    expect(counter.getValue()).toBe(2);
  });
});
