/**
 * Integration tests for the metrics plugin — driven through a REAL kernel
 * application (`createApplication` + `app.inject`), so the middleware runs
 * inside the kernel's actual onion pipeline and error path. A fake plugin
 * context cannot prove the collector survives a thrown request or that it
 * sits outside a short-circuiting middleware — both are properties of the
 * real pipeline (§3.6 / C5).
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IHistogram, IPluginContext, IRequestContext } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';

import { MetricsPlugin } from '../../src/index.ts';
import type { MetricsService } from '../../src/services/metrics-service.ts';
import type { Counter } from '../../src/metrics/counter.ts';
import type { Gauge } from '../../src/metrics/gauge.ts';

/** Resolves the concrete service so tests can read metric values back. */
function metricsOf(app: ReturnType<typeof createApplication>): MetricsService {
  return app.services.get<MetricsService>(CAPABILITIES.METRICS);
}

describe('Metrics integration (through the real kernel pipeline)', () => {
  it('registers a resolvable IMetricsService under the metrics token', async () => {
    const app = createApplication({ plugins: [RuntimePlugin(), MetricsPlugin()] });
    await app.start();

    expect(app.services.has(CAPABILITIES.METRICS)).toBe(true);
    const service = metricsOf(app);
    expect(typeof service.counter).toBe('function');

    await app.stop();
  });

  it('GET /metrics returns Prometheus 0.0.4 text with the exposition body', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MetricsPlugin(),
        {
          name: 'seed-metric',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.lifecycle.onInit(() => {
              const service = ctx.services.get<MetricsService>(CAPABILITIES.METRICS);
              service.counter('users_total', { help: 'Total users' }).inc(3);
            });
          },
        },
      ],
    });
    await app.start();

    const res = await app.inject({ method: 'GET', url: 'http://localhost/metrics' });
    expect(res.statusCode).toBe(200);
    expect(res.headers.get('content-type')).toBe('text/plain; version=0.0.4; charset=utf-8');
    expect(res.body).toContain('# TYPE users_total counter');
    expect(res.body).toContain('users_total 3');

    await app.stop();
  });

  it('a successful request is counted and leaves the active gauge at 0', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MetricsPlugin(),
        {
          name: 'work-route',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.router.get(
              '/work',
              (c: IRequestContext) => c.response.status(200).json({ ok: true }),
            );
          },
        },
      ],
    });
    await app.start();

    const res = await app.inject({ method: 'GET', url: 'http://localhost/work' });
    expect(res.statusCode).toBe(200);

    const service = metricsOf(app);
    const requests = service.get('http_requests_total') as Counter;
    const active = service.get('http_active_requests') as Gauge;
    expect(requests.getValue({ method: 'GET', status: '200' })).toBe(1);
    expect(active.getValue()).toBe(0);

    await app.stop();
  });

  it('a thrown handler yields a 500 AND leaves the active gauge at 0 (no leak)', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MetricsPlugin(),
        {
          name: 'boom-route',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.router.get('/boom', (): never => {
              throw new Error('handler blew up');
            });
          },
        },
      ],
    });
    await app.start();

    const res = await app.inject({ method: 'GET', url: 'http://localhost/boom' });
    expect(res.statusCode).toBe(500);

    const service = metricsOf(app);
    const active = service.get('http_active_requests') as Gauge;
    const errors = service.get('http_request_errors_total') as Counter;
    const requests = service.get('http_requests_total') as Counter;

    // The blocker: the gauge must not be stuck at 1 after a thrown request.
    // (Read via the service rather than a /metrics scrape — a scrape is itself
    // an in-flight request, so the rendered gauge would legitimately read 1.)
    expect(active.getValue()).toBe(0);
    expect(errors.getValue({ method: 'GET', status: '500' })).toBe(1);
    expect(requests.getValue({ method: 'GET', status: '500' })).toBe(1);

    await app.stop();
  });

  it('counts a request short-circuited by an outer middleware — proving metrics is outermost', async () => {
    // A middleware at priority 300 responds 401 WITHOUT calling next(). Because
    // MetricsMiddleware registers at 20 (outermost), it still wraps this stage
    // and records the request. At the ARCHITECTURE table's mistaken 700 the
    // request would never reach metrics and this assertion would fail.
    let handlerCalls = 0;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MetricsPlugin(),
        {
          name: 'guard-route',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.middleware.add(
              (c: IRequestContext) => c.response.status(401).json({ error: 'unauthorized' }),
              { priority: 300, name: 'fake-auth' },
            );
            ctx.router.get('/guarded', (c: IRequestContext) => {
              handlerCalls++;
              return c.response.status(200).json({ ok: true });
            });
          },
        },
      ],
    });
    await app.start();

    const res = await app.inject({ method: 'GET', url: 'http://localhost/guarded' });

    // Short-circuit: the 401 stands and the route handler never ran.
    expect(res.statusCode).toBe(401);
    expect(handlerCalls).toBe(0);

    // Placement: the request was still counted by the outer metrics middleware.
    const requests = metricsOf(app).get('http_requests_total') as Counter;
    expect(requests.getValue({ method: 'GET', status: '401' })).toBe(1);

    await app.stop();
  });

  it('defaultBuckets governs the built-in HTTP duration histogram', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), MetricsPlugin({ defaultBuckets: [0.1, 0.2, 0.3] })],
    });
    await app.start();

    const duration = metricsOf(app).get('http_request_duration_seconds') as IHistogram;
    expect(duration.buckets).toContain(0.1);
    expect(duration.buckets).toContain(0.3);
    expect(duration.buckets).not.toContain(10);

    await app.stop();
  });

  it('custom metrics from options are materialized at onInit', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MetricsPlugin({
          customMetrics: [{ name: 'custom_counter', type: 'counter', help: 'Custom counter' }],
        }),
      ],
    });
    await app.start();

    const metric = metricsOf(app).get('custom_counter');
    expect(metric).toBeDefined();
    expect(metric?.type).toBe('counter');

    await app.stop();
  });
});
