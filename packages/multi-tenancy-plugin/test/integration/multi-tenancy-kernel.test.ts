/**
 * Integration test — a REAL kernel app.
 *
 * The sibling `multi-tenancy-integration.test.ts` wires the service, store and
 * middleware together by hand. That proves the pieces compose, but it never
 * runs `MultiTenancyPlugin.register()` against the real `IPluginContext`,
 * never resolves the service through the real `IServiceRegistry`, and never
 * routes a request through the real middleware pipeline — so a broken
 * registration, a middleware that is never added, or a health indicator that
 * is never registered would all pass. This file drives the public surface:
 * `createApplication` → `app.register(MultiTenancyPlugin(...))` → `inject()`.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IHealthIndicator, IMultiTenancyService } from '@hono-enterprise/common';
import { getTenantCachePrefix, MultiTenancyPlugin } from '../../src/index.ts';

interface User {
  id: string;
  name: string;
  tenant_id?: string;
}

describe('multi-tenancy — real kernel app', () => {
  it('resolves the tenant, scopes writes, and isolates tenants end to end', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MultiTenancyPlugin({
          resolver: 'header',
          database: 'column-per-tenant',
          cache: { prefix: true, separator: '::' },
        }),
      ],
    });

    app.router.post('/users', async (ctx) => {
      const tenancy = ctx.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
      const body = await ctx.request.json<{ name: string }>();
      const created = await tenancy.getRepository<User>(ctx, 'User').create({ name: body.name });
      return ctx.response.json({ created });
    });

    app.router.get('/users', async (ctx) => {
      const tenancy = ctx.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
      return ctx.response.json({
        tenant: tenancy.getCurrentTenant(ctx)?.id ?? null,
        cachePrefix: getTenantCachePrefix(ctx) ?? null,
        prefixed: tenancy.prefixCacheKey('acme', 'users:list'),
        users: await tenancy.getRepository<User>(ctx, 'User').findAll(),
      });
    });

    await app.start();

    // Write as `acme` — the id must come from the kernel runtime's uuid(), not
    // the store's counter fallback, which is what `register()` wires in.
    const createRes = await app.inject({
      method: 'POST',
      url: 'http://localhost/users',
      headers: { 'x-tenant-id': 'acme', 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Ada' }),
    });
    expect(createRes.statusCode).toBe(200);
    const created = JSON.parse(createRes.body ?? '{}').created as User;
    expect(created.name).toEqual('Ada');
    expect(created.tenant_id).toEqual('acme'); // column strategy reached the store
    expect(created.id).toMatch(/^[0-9a-f-]{36}$/); // runtime.uuid(), not '1'

    // Read back through the same public surface.
    const readRes = await app.inject({
      method: 'GET',
      url: 'http://localhost/users',
      headers: { 'x-tenant-id': 'acme' },
    });
    expect(readRes.statusCode).toBe(200);
    const read = JSON.parse(readRes.body ?? '{}');
    expect(read.tenant).toEqual('acme');
    expect(read.users.length).toEqual(1);
    expect(read.users[0].name).toEqual('Ada');
    // Non-default separator, and both entry points agree on it.
    expect(read.cachePrefix).toEqual('acme::');
    expect(read.prefixed).toEqual('acme::users:list');

    // A second tenant must not see the first tenant's rows.
    const otherRes = await app.inject({
      method: 'GET',
      url: 'http://localhost/users',
      headers: { 'x-tenant-id': 'globex' },
    });
    const other = JSON.parse(otherRes.body ?? '{}');
    expect(other.tenant).toEqual('globex');
    expect(other.users).toEqual([]);

    await app.stop();
  });

  it('registers the health indicator through the real plugin context', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), MultiTenancyPlugin({ resolver: 'header' })],
    });
    await app.start();

    const indicators = app.services.getAll<IHealthIndicator>(CAPABILITIES.HEALTH_INDICATOR);
    const tenancy = indicators.find((i) => i.name === 'multi-tenancy');
    expect(tenancy).toBeDefined();

    const result = await tenancy!.check();
    expect(result.status).toEqual('up');
    expect(result.data).toEqual({ resolver: 'header', strategy: 'column', store: 'memory' });

    await app.stop();
  });

  it('short-circuits a required-tenant request before the handler runs', async () => {
    let handlerRan = false;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MultiTenancyPlugin({ resolver: 'header', required: true, rejectionStatus: 422 }),
      ],
    });
    app.router.get('/x', (ctx) => {
      handlerRan = true;
      return ctx.response.json({ ok: true });
    });
    await app.start();

    const rejected = await app.inject({ method: 'GET', url: 'http://localhost/x' });
    expect(rejected.statusCode).toBe(422);
    expect(JSON.parse(rejected.body ?? '{}')).toEqual({
      error: 'Tenant Required',
      message: 'No tenant could be resolved for this request',
    });
    expect(handlerRan).toBe(false);

    const accepted = await app.inject({
      method: 'GET',
      url: 'http://localhost/x',
      headers: { 'x-tenant-id': 't1' },
    });
    expect(accepted.statusCode).toBe(200);
    expect(handlerRan).toBe(true);

    await app.stop();
  });

  it('rejects an unusable configuration at startup, not per request', async () => {
    const emptyChain = createApplication({
      plugins: [RuntimePlugin(), MultiTenancyPlugin({ resolver: [] })],
    });
    await expect(emptyChain.start()).rejects.toThrow('empty resolver chain');

    const badStore = createApplication({
      plugins: [
        RuntimePlugin(),
        MultiTenancyPlugin({
          resolver: 'header',
          // A store missing most of ITenantDataStore — previously this
          // registered cleanly and threw `store.create is not a function` on
          // the first request that used it.
          dataStore: { findAll: () => Promise.resolve([]) } as never,
        }),
      ],
    });
    await expect(badStore.start()).rejects.toThrow('missing required ITenantDataStore');
  });

  it('closes the store through the kernel shutdown hook', async () => {
    let closed = false;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MultiTenancyPlugin({
          resolver: 'header',
          dataStore: {
            findAll: () => Promise.resolve([]),
            findById: () => Promise.resolve(null),
            find: () => Promise.resolve([]),
            create: <E>() => Promise.resolve({} as E),
            update: () => Promise.resolve(null),
            delete: () => Promise.resolve(false),
            close: () => {
              closed = true;
              return Promise.resolve();
            },
          },
        }),
      ],
    });
    await app.start();
    expect(closed).toBe(false);
    await app.stop();
    expect(closed).toBe(true);
  });
});
