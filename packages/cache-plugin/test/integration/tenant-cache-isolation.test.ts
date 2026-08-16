/**
 * Integration test — the cross-tenant cache disclosure (X4-1) through a REAL
 * kernel app.
 *
 * This is the test that would have caught the defect: `cacheMiddleware` keyed
 * on `method:url` alone, so a tenant served another tenant's cached body. It
 * registers `MultiTenancyPlugin` (which writes `ctx.request.tenant`) and
 * `CachePlugin`, then drives two tenants over one route through the real
 * pipeline. Neither package's existing suite can host it, because the fix is
 * only observable when both plugins compose.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { IPluginContext, IRequestContext } from '@setu-ts/common';

import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MultiTenancyPlugin } from '@setu-ts/multi-tenancy-plugin';

import { cacheMiddleware, CachePlugin } from '../../src/index.ts';

describe('tenant cache isolation (X4-1) — real kernel app', () => {
  it('serves each tenant its own cached body on one route', async () => {
    let handlerCallCount = 0;

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MultiTenancyPlugin({ resolver: 'header' }),
        CachePlugin({ store: 'memory' }),
        {
          name: 'test-tenant-route',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.middleware.add(cacheMiddleware({ ttlSeconds: 60 }));
            ctx.router.get('/data', (c: IRequestContext) => {
              handlerCallCount++;
              const tenant = c.request.tenant?.id ?? 'none';
              return c.response.json({ tenant, count: handlerCallCount });
            });
          },
        },
      ],
    });

    await app.start();

    // acme goes first — a MISS, the handler records acme's body.
    const acme1 = await app.inject({
      method: 'GET',
      url: 'http://localhost/data',
      headers: { 'x-tenant-id': 'acme' },
    });
    expect(acme1.statusCode).toBe(200);
    expect(acme1.headers.get('x-cache')).toBe('MISS');
    expect(acme1.json<{ tenant: string }>().tenant).toBe('acme');

    // globex must NOT receive acme's cached body — its own MISS.
    const globex1 = await app.inject({
      method: 'GET',
      url: 'http://localhost/data',
      headers: { 'x-tenant-id': 'globex' },
    });
    expect(globex1.statusCode).toBe(200);
    expect(globex1.headers.get('x-cache')).toBe('MISS');
    expect(globex1.json<{ tenant: string }>().tenant).toBe('globex');

    // Both tenants now have their own entries — repeating is a HIT for each,
    // and the body is still the tenant's own.
    const acme2 = await app.inject({
      method: 'GET',
      url: 'http://localhost/data',
      headers: { 'x-tenant-id': 'acme' },
    });
    expect(acme2.headers.get('x-cache')).toBe('HIT');
    expect(acme2.json<{ tenant: string }>().tenant).toBe('acme');

    const globex2 = await app.inject({
      method: 'GET',
      url: 'http://localhost/data',
      headers: { 'x-tenant-id': 'globex' },
    });
    expect(globex2.headers.get('x-cache')).toBe('HIT');
    expect(globex2.json<{ tenant: string }>().tenant).toBe('globex');

    // Reversing the order changes nothing: both still see their own body.
    const acme3 = await app.inject({
      method: 'GET',
      url: 'http://localhost/data',
      headers: { 'x-tenant-id': 'acme' },
    });
    expect(acme3.json<{ tenant: string }>().tenant).toBe('acme');

    // The handler ran exactly twice — once per tenant — proving the two
    // entries are distinct rather than one shared entry replayed.
    expect(handlerCallCount).toBe(2);

    await app.stop();
  });

  it('is inert for a request with no tenant (byte-identical key)', async () => {
    let handlerCallCount = 0;

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        // No MultiTenancyPlugin — ctx.request.tenant stays undefined.
        CachePlugin({ store: 'memory' }),
        {
          name: 'test-no-tenant-route',
          version: '1.0.0',
          register(ctx: IPluginContext): void {
            ctx.middleware.add(cacheMiddleware({ ttlSeconds: 60 }));
            ctx.router.get('/data', (c: IRequestContext) => {
              handlerCallCount++;
              return c.response.json({ tenant: c.request.tenant?.id ?? 'none' });
            });
          },
        },
      ],
    });

    await app.start();

    const res1 = await app.inject({ method: 'GET', url: 'http://localhost/data' });
    expect(res1.headers.get('x-cache')).toBe('MISS');
    expect(res1.json<{ tenant: string }>().tenant).toBe('none');

    // A second request is a HIT — the key is the plain method:url key, so an
    // application without tenancy is unchanged.
    const res2 = await app.inject({ method: 'GET', url: 'http://localhost/data' });
    expect(res2.headers.get('x-cache')).toBe('HIT');
    expect(res2.json<{ tenant: string }>().tenant).toBe('none');
    expect(handlerCallCount).toBe(1);

    await app.stop();
  });
});
