/**
 * Integration test — `required: true` must not break operational probes
 * (X4-2), through a REAL kernel app.
 *
 * The defect: M39's generated Kubernetes manifests point liveness and
 * readiness at `/live` and `/ready` and send no tenant header. A
 * required-tenant deployment therefore never became ready. The default
 * `exclude` list exempts the framework's own probe paths so they answer `200`
 * with no header, while a business route still answers the rejection status.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IPluginContext, IRequestContext } from '@setu-ts/common';

import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';

import { MultiTenancyPlugin } from '../../src/index.ts';

describe('required tenant + operational probes (X4-2) — real kernel app', () => {
  it('answers /live and /ready with 200 and no header, while a business route rejects', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MultiTenancyPlugin({ resolver: 'header', required: true }),
        HealthPlugin(),
        {
          name: 'test-business-route',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.router.get(
              '/api/orders',
              (c: IRequestContext) =>
                c.response.json({ ok: true, tenant: c.request.tenant?.id ?? 'none' }),
            );
          },
        },
      ],
    });

    await app.start();

    // The operational probes carry no tenant header and must still answer 200.
    for (const url of ['http://localhost/live', 'http://localhost/ready']) {
      const res = await app.inject({ method: 'GET', url });
      expect(res.statusCode, `expected ${url} to be 200`).toBe(200);
    }

    // A business route with no tenant header is still rejected (default 400).
    const business = await app.inject({ method: 'GET', url: 'http://localhost/api/orders' });
    expect(business.statusCode).toBe(400);

    // And with a tenant header the business route proceeds.
    const withTenant = await app.inject({
      method: 'GET',
      url: 'http://localhost/api/orders',
      headers: { 'x-tenant-id': 'acme' },
    });
    expect(withTenant.statusCode).toBe(200);
    expect(withTenant.json<{ tenant: string }>().tenant).toBe('acme');
  });
});
