/**
 * Unit tests for HttpCollector.
 *
 * These tests read metric VALUES back through the instrument APIs
 * (`Gauge.getValue`, `Counter.getValue`, `Histogram.getSum`/`getCount`)
 * rather than asserting only that a metric exists — a metric registered by
 * `collector.register()` is non-undefined regardless of what the middleware
 * does, so an existence check cannot catch a no-op or a gauge leak. The
 * throw-path test in particular is the regression guard for the active-gauge
 * leak (§3.6 / C5): remove either `dec` in the collector and it fails.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { HttpCollector, MIDDLEWARE_PRIORITY } from '../../src/collectors/http-collector.ts';
import { MetricsService } from '../../src/services/metrics-service.ts';
import type { Counter } from '../../src/metrics/counter.ts';
import type { Gauge } from '../../src/metrics/gauge.ts';
import type { Histogram } from '../../src/metrics/histogram.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';
import { createFakeContext } from '../fixtures/fake-request-context.ts';

const BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

/** Wires a fresh service + registered collector over a fake runtime. */
function setup() {
  const service = new MetricsService();
  const runtime = new FakeRuntime();
  const collector = new HttpCollector(service, runtime, BUCKETS);
  collector.register();

  const active = service.get('http_active_requests') as Gauge;
  const requests = service.get('http_requests_total') as Counter;
  const errors = service.get('http_request_errors_total') as Counter;
  const duration = service.get('http_request_duration_seconds') as Histogram;
  return { service, runtime, collector, active, requests, errors, duration };
}

describe('HttpCollector', () => {
  it('middleware priority is 20 (outermost, just inside the error handler)', () => {
    expect(MIDDLEWARE_PRIORITY.METRICS).toBe(20);
  });

  it('registers exactly the four HTTP metrics', () => {
    const { service } = setup();
    expect(service.get('http_request_duration_seconds')).toBeDefined();
    expect(service.get('http_requests_total')).toBeDefined();
    expect(service.get('http_request_errors_total')).toBeDefined();
    expect(service.get('http_active_requests')).toBeDefined();
  });

  it('the duration histogram uses the buckets passed by the plugin (defaultBuckets)', () => {
    const service = new MetricsService();
    const collector = new HttpCollector(service, new FakeRuntime(), [1, 2, 3]);
    collector.register();
    const duration = service.get('http_request_duration_seconds') as Histogram;
    // +Inf is appended by the histogram; the configured bounds must be present.
    expect(duration.buckets).toContain(1);
    expect(duration.buckets).toContain(2);
    expect(duration.buckets).toContain(3);
    expect(duration.buckets).not.toContain(10); // not the hardcoded default set
  });

  it('a 200 records request + duration, leaves errors untouched, active back to 0', async () => {
    const { collector, runtime, active, requests, errors, duration } = setup();
    const ctx = createFakeContext({ method: 'GET', status: 200 });

    await collector.middleware(ctx, () => {
      runtime.advance(100); // 100ms handler
      return Promise.resolve();
    });

    // Request counted under method+status, duration recorded (100ms → 0.1s).
    expect(requests.getValue({ method: 'GET', status: '200' })).toBe(1);
    expect(duration.getCount({ method: 'GET', status: '200' })).toBe(1);
    expect(duration.getSum({ method: 'GET', status: '200' })).toBeCloseTo(0.1, 6);
    // A 2xx is not an error.
    expect(errors.getValue({ method: 'GET', status: '200' })).toBe(0);
    expect(errors.values.size).toBe(0);
    // Gauge returns to baseline.
    expect(active.getValue()).toBe(0);
  });

  it('a handler-set 500 increments the error counter and the request counter', async () => {
    const { collector, active, requests, errors } = setup();
    const ctx = createFakeContext({ method: 'POST', status: 500 });

    await collector.middleware(ctx, () => Promise.resolve());

    expect(requests.getValue({ method: 'POST', status: '500' })).toBe(1);
    expect(errors.getValue({ method: 'POST', status: '500' })).toBe(1);
    expect(active.getValue()).toBe(0);
  });

  it('active gauge rises to 1 during the request and returns to 0 after', async () => {
    const { collector, active } = setup();
    const ctx = createFakeContext({ method: 'GET', status: 200 });

    expect(active.getValue()).toBe(0);
    await collector.middleware(ctx, () => {
      // Inside next(), before the finally decrement, the gauge is up.
      expect(active.getValue()).toBe(1);
      return Promise.resolve();
    });
    expect(active.getValue()).toBe(0);
  });

  it('throw path: rethrows by identity, records a 500, and does NOT leak the active gauge', async () => {
    const { collector, runtime, active, requests, errors, duration } = setup();
    const ctx = createFakeContext({ method: 'GET', status: 200 });
    const boom = new Error('handler blew up');

    let caught: unknown;
    await collector
      .middleware(ctx, () => {
        runtime.advance(30);
        throw boom;
      })
      .catch((e) => {
        caught = e;
      });

    // Rethrown unchanged — by identity, not just by type.
    expect(caught).toBe(boom);
    // Observed as a 500 error even though the handler never set a status.
    expect(errors.getValue({ method: 'GET', status: '500' })).toBe(1);
    expect(requests.getValue({ method: 'GET', status: '500' })).toBe(1);
    expect(duration.getCount({ method: 'GET', status: '500' })).toBe(1);
    expect(duration.getSum({ method: 'GET', status: '500' })).toBeCloseTo(0.03, 6);
    // THE regression guard: the gauge must be back to 0, not stuck at 1.
    expect(active.getValue()).toBe(0);
  });

  it('two thrown requests do not accumulate the active gauge', async () => {
    const { collector, active } = setup();
    for (let i = 0; i < 2; i++) {
      await collector
        .middleware(createFakeContext({ method: 'GET' }), () => {
          throw new Error(`fail ${i}`);
        })
        .catch(() => {});
    }
    expect(active.getValue()).toBe(0);
  });

  it('never labels any series by path (only method + status)', async () => {
    const { collector, requests, duration } = setup();
    await collector.middleware(
      createFakeContext({ method: 'GET', status: 200 }),
      () => Promise.resolve(),
    );

    // The one recorded request series is keyed by method+status only.
    for (const [key] of requests.values) {
      expect(key).not.toContain('path');
      expect(key).not.toContain('/');
    }
    for (const [key] of duration.getAllBucketCounts()) {
      expect(key).not.toContain('path');
    }
  });

  it('duration is a monotonic hrtime delta, read back off the histogram', async () => {
    const { collector, runtime, duration } = setup();
    const ctx = createFakeContext({ method: 'GET', status: 200 });

    // Advance the fake monotonic clock by 250ms inside the handler.
    await collector.middleware(ctx, () => {
      runtime.advance(250);
      return Promise.resolve();
    });

    // 250ms → 0.25s, recorded on the histogram (not merely the fixture clock).
    expect(duration.getSum({ method: 'GET', status: '200' })).toBeCloseTo(0.25, 6);
  });
});
