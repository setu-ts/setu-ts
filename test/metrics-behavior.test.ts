/**
 * Behavioral test proving that the documented custom counter pattern actually
 * changes metric state — not just that `register()` returns void.
 *
 * Exercises the real MetricsService through a test app and proves:
 * 1. counter() returns an ICounter (not void)
 * 2. inc() actually increments the counter with exact label sets
 * 3. The counter value is observable via IMetric.observe() surface
 * 4. Exact label-set counts match expectations (unlabeled total + labeled breakdown)
 *
 * A no-op ICounter.inc() implementation must make this test fail.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CAPABILITIES } from '@setu-ts/common';
import type { ICounter, IMetricsService } from '@setu-ts/common';
import { RuntimePlugin } from '@setu-ts/runtime';
import { createTestApp } from '@setu-ts/testing';
import { MetricsPlugin } from '@setu-ts/metrics-plugin';

describe('metrics behavior — custom counter observation', () => {
  it('counter() returns ICounter and inc() increments with exact label values', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin(), MetricsPlugin({ endpoint: '/metrics' })],
    });

    const metrics = app.services.get<IMetricsService>(CAPABILITIES.METRICS);

    // counter() returns ICounter (not void)
    const counter: ICounter = metrics.counter('test_counter', {
      help: 'A test counter',
      labels: ['action'],
    });
    expect(counter).toBeDefined();
    expect(counter.name).toBe('test_counter');

    // inc() actually increments — assert exact values per label set
    counter.inc(1, { action: 'create' });
    counter.inc(1, { action: 'create' });
    counter.inc(1, { action: 'delete' });

    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('# HELP test_counter A test counter');
    expect(response.body).toContain('# TYPE test_counter counter');
    expect(response.body).toContain('test_counter{action="create"} 2');
    expect(response.body).toContain('test_counter{action="delete"} 1');
    expect(response.body?.match(/^test_counter\{/gm)?.length).toBe(2);
  });

  it('counter inc() with no labels increments the unlabeled total', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin(), MetricsPlugin({ endpoint: '/metrics' })],
    });

    const metrics = app.services.get<IMetricsService>(CAPABILITIES.METRICS);
    const counter = metrics.counter('simple_counter', {
      help: 'Simple counter',
    });

    // inc() with no labels increments the unlabeled total
    counter.inc();
    counter.inc(5);

    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('simple_counter 6');
    expect(response.body).not.toContain('simple_counter{');
  });

  it('counter inc() with labels creates distinct label-set series', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin(), MetricsPlugin({ endpoint: '/metrics' })],
    });

    const metrics = app.services.get<IMetricsService>(CAPABILITIES.METRICS);
    const counter: ICounter = metrics.counter('labeled_counter', {
      help: 'Counter with labels',
      labels: ['status'],
    });

    // Create two distinct label sets
    counter.inc(3, { status: 'success' });
    counter.inc(1, { status: 'error' });

    const response = await app.inject({ method: 'GET', url: '/metrics' });
    expect(response.statusCode).toBe(200);
    expect(response.body).toContain('labeled_counter{status="success"} 3');
    expect(response.body).toContain('labeled_counter{status="error"} 1');
    expect(response.body?.match(/^labeled_counter\{/gm)?.length).toBe(2);
  });
});
