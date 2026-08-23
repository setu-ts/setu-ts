/**
 * X10-7 integration: a real kernel app with `MetricsPlugin` + `HealthPlugin`.
 *
 * The unit tests pin the collector's exclusion logic against fakes; this one
 * proves the composition the register complained about — a Prometheus scraping
 * `/metrics` on an app whose health probes run on `/live` and `/ready` — sees
 * a counter that moves only for application traffic. The scrape body is
 * compared byte-for-byte between scrapes, because "unchanged" is the property
 * under test.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IPluginContext, IRequestContext } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';

import { MetricsPlugin } from '../../src/index.ts';

describe('metrics excludes its own scrape and the health probes (X10-7)', () => {
  it('a probe and a scrape leave http_requests_total byte-identical; one app request moves it by one', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MetricsPlugin(),
        HealthPlugin(),
        {
          name: 'orders-route',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.router.get(
              '/orders',
              (c: IRequestContext) => c.response.status(200).json({ ok: true }),
            );
          },
        },
      ],
    });
    await app.start();

    const scrape = async (): Promise<string> => {
      const res = await app.inject({ method: 'GET', url: 'http://localhost/metrics' });
      expect(res.statusCode).toBe(200);
      return res.body ?? '';
    };

    const before = await scrape();
    expect(before).toContain('http_requests_total');

    // The traffic that used to pollute the series: a probe and the scrape
    // itself, twice around to be sure.
    await app.inject({ method: 'GET', url: 'http://localhost/live' });
    await app.inject({ method: 'GET', url: 'http://localhost/ready' });
    const between = await scrape();
    await app.inject({ method: 'GET', url: 'http://localhost/live' });
    await app.inject({ method: 'GET', url: 'http://localhost/ready' });
    const after = await scrape();

    expect(after).toBe(before);
    expect(between).toBe(before);

    // One application request moves the counter by exactly one — and the
    // probes and scrapes around it add nothing.
    const orders = await app.inject({ method: 'GET', url: 'http://localhost/orders' });
    expect(orders.statusCode).toBe(200);
    const moved = await scrape();
    expect(moved).toContain('http_requests_total{method="GET",status="200"} 1');

    await app.stop();
  });
});
