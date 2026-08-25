/**
 * X10-7: the metrics middleware skips its own scrape and the health probes.
 *
 * `/metrics` counted its own scrapes and every probe, so a Prometheus polling
 * once per interval dominated `http_requests_total` with series about itself.
 * The guard runs BEFORE any instrument — an excluded request must not even
 * perturb `http_active_requests`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DEFAULT_EXCLUDED_PATHS, HttpCollector } from '../../src/collectors/http-collector.ts';
import { MetricsService } from '../../src/services/metrics-service.ts';
import type { Counter } from '../../src/metrics/counter.ts';
import type { Gauge } from '../../src/metrics/gauge.ts';
import type { Histogram } from '../../src/metrics/histogram.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';
import { createFakeContext } from '../fixtures/fake-request-context.ts';

const BUCKETS = [0.1];

/** Wires a collector with the given exclusion list and registers its metrics. */
function setup(excludedPaths?: readonly string[]) {
  const service = new MetricsService();
  const runtime = new FakeRuntime();
  const collector = new HttpCollector(service, runtime, BUCKETS, excludedPaths);
  collector.register();

  const active = service.get('http_active_requests') as Gauge;
  const requests = service.get('http_requests_total') as Counter;
  const duration = service.get('http_request_duration_seconds') as Histogram;
  return { collector, active, requests, duration };
}

/** Drives one request through the middleware; `next` records nothing. */
async function passThrough(
  collector: HttpCollector,
  path: string,
): Promise<void> {
  await collector.middleware(createFakeContext({ method: 'GET', path }), () => Promise.resolve());
}

describe('HttpCollector path exclusions (X10-7)', () => {
  it('excludes the default health literals', () => {
    expect(DEFAULT_EXCLUDED_PATHS).toEqual(['/health', '/live', '/ready']);
  });

  it('a scrape of the configured endpoint leaves EVERY instrument untouched', async () => {
    // The plugin always passes its own endpoint in the exclusion set.
    const { collector, requests, duration, active } = setup([
      '/metrics',
      ...DEFAULT_EXCLUDED_PATHS,
    ]);

    await passThrough(collector, '/metrics');

    expect(requests.values.size).toBe(0);
    expect(duration.getCount({ method: 'GET', status: '200' })).toBe(0);
    expect(active.getValue()).toBe(0);
  });

  it('a /ready probe leaves every instrument untouched', async () => {
    const { collector, requests, duration, active } = setup([
      '/metrics',
      ...DEFAULT_EXCLUDED_PATHS,
    ]);

    await passThrough(collector, '/ready');

    expect(requests.values.size).toBe(0);
    expect(duration.getCount({ method: 'GET', status: '200' })).toBe(0);
    expect(active.getValue()).toBe(0);
  });

  it('an application path still records', async () => {
    const { collector, requests, duration } = setup(['/metrics', ...DEFAULT_EXCLUDED_PATHS]);

    await passThrough(collector, '/orders');

    expect(requests.getValue({ method: 'GET', status: '200' })).toBe(1);
    expect(duration.getCount({ method: 'GET', status: '200' })).toBe(1);
  });

  it('excludePaths REPLACES the health defaults while the endpoint stays excluded', async () => {
    // What MetricsPlugin builds for excludePaths: ['/metrics', ...options].
    const { collector, requests } = setup(['/metrics', '/custom']);

    await passThrough(collector, '/custom'); // excluded by the replacement
    await passThrough(collector, '/metrics'); // endpoint: always excluded
    await passThrough(collector, '/health'); // NO LONGER defaulted away

    expect(requests.getValue({ method: 'GET', status: '200' })).toBe(1);
    // The one recorded request is the /health hit.
    expect(requests.values.size).toBe(1);
  });
});
