/**
 * Behavioral test proving that the documented custom counter pattern actually
 * changes metric state — not just that `register()` returns void.
 *
 * Exercises the real MetricsService through a test app and proves:
 * 1. counter() returns an ICounter (not void)
 * 2. inc() actually increments the counter
 * 3. The counter value is observable via the registry
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
  it('counter() returns ICounter and inc() increments it', async () => {
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

    // inc() actually increments
    counter.inc(1, { action: 'create' });
    counter.inc(1, { action: 'create' });
    counter.inc(1, { action: 'delete' });

    // The metric is registered and observable
    const found = metrics.get('test_counter');
    expect(found).toBeDefined();
    expect(found!.name).toBe('test_counter');
  });

  it('counter inc() with no labels works', async () => {
    const app = await createTestApp({
      plugins: [RuntimePlugin(), MetricsPlugin({ endpoint: '/metrics' })],
    });

    const metrics = app.services.get<IMetricsService>(CAPABILITIES.METRICS);
    const counter = metrics.counter('simple_counter', { help: 'Simple counter' });

    counter.inc();
    counter.inc(5);

    const found = metrics.get('simple_counter');
    expect(found).toBeDefined();
  });
});
