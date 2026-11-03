/**
 * The tenant registry through a REAL kernel app (M127 §3.6, §3.9).
 *
 * - The two new refusals in both error formats: RFC 9457 Problem Details with
 *   `errorHandler` registered, the `{ error, detail }` fallback without.
 * - Both entry points — the middleware and `lookupTenant` — under a NON-default
 *   configuration (a factory registry with a cache, `unknownTenantStatus: 403`)
 *   agree on a hit, a miss, an over-long id and a throwing registry; the
 *   no-registry configuration admits on both (control).
 * - A write under an unknown tenant creates no row, read back through
 *   `getRepositoryFor`.
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
import type { IMultiTenancyService, ITenant, ITenantRegistry, Option } from '@setu-ts/common';
import { CAPABILITIES, none, some } from '@setu-ts/common';
import type { MultiTenancyPluginOptions } from '../../src/index.ts';
import { MultiTenancyPlugin, TenantRegistryUnavailableError } from '../../src/index.ts';

interface Note {
  id: string;
  text: string;
}

/** A registry admitting `acme`/`globex`, throwing for `explode`. */
const registry: ITenantRegistry = {
  lookup(id): Promise<Option<ITenant>> {
    if (id === 'explode') return Promise.reject(new Error('backend down'));
    return Promise.resolve(id === 'acme' || id === 'globex' ? some({ id, name: id }) : none());
  },
};

async function boot(
  extra: Partial<MultiTenancyPluginOptions>,
  withErrorHandler = false,
): Promise<{ app: IKernelApplication; handlerRuns: () => number }> {
  let runs = 0;
  const app = createApplication({
    plugins: [RuntimePlugin(), MultiTenancyPlugin({ resolver: 'header', ...extra })],
  });
  if (withErrorHandler)
    app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 0, name: 'errors' });
  app.router.post('/notes', async (ctx) => {
    runs++;
    const tenancy = ctx.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
    const body = await ctx.request.json<{ text: string }>();
    const note = await tenancy.getRepository<Note>(ctx, 'Note').create({ text: body.text });
    return ctx.response.json({ note, tenant: ctx.request.tenant ?? null });
  });
  await app.start();
  return { app, handlerRuns: () => runs };
}

function post(app: IKernelApplication, tenant: string) {
  return app.inject({
    method: 'POST',
    url: 'http://localhost/notes',
    headers: { 'x-tenant-id': tenant, 'content-type': 'application/json' },
    body: JSON.stringify({ text: 'hello' }),
  });
}

describe('tenant registry — real kernel app', () => {
  it('a miss and a fault answer Problem Details field by field with errorHandler (§3.6)', async () => {
    const { app, handlerRuns } = await boot({ tenants: registry }, true);
    try {
      // RFC 9457: a status-only problem is `about:blank` with the status
      // phrase as its title (§4.2); the site's disclosure is `detail`.
      const miss = await post(app, 'initech');
      expect(miss.statusCode).toBe(404);
      expect(miss.headers.get('content-type')).toContain('application/problem+json');
      expect(JSON.parse(miss.body ?? '{}')).toEqual({
        type: 'about:blank',
        title: 'Not Found',
        status: 404,
        detail: 'The request names a tenant that does not exist',
        instance: '/notes',
      });
      expect(miss.body).not.toContain('initech');
      expect(miss.body).not.toContain('"message"');

      const fault = await post(app, 'explode');
      expect(fault.statusCode).toBe(503);
      expect(JSON.parse(fault.body ?? '{}')).toEqual({
        type: 'about:blank',
        title: 'Service Unavailable',
        status: 503,
        detail: 'The tenant could not be checked; try again later',
        instance: '/notes',
      });
      expect(fault.body).not.toContain('backend down');
      expect(fault.body).not.toContain('"message"');

      expect(handlerRuns()).toBe(0);
    } finally {
      await app.stop();
    }
  });

  it('without errorHandler the refusals use the fallback { error, detail } shape', async () => {
    const { app } = await boot({ tenants: registry });
    try {
      const miss = await post(app, 'initech');
      expect(miss.statusCode).toBe(404);
      expect(JSON.parse(miss.body ?? '{}')).toEqual({
        error: 'Unknown Tenant',
        detail: 'The request names a tenant that does not exist',
      });
      const fault = await post(app, 'explode');
      expect(fault.statusCode).toBe(503);
      expect(JSON.parse(fault.body ?? '{}')).toEqual({
        error: 'Tenant Registry Unavailable',
        detail: 'The tenant could not be checked; try again later',
      });
    } finally {
      await app.stop();
    }
  });

  it('a hit carries the registry tenant to the handler', async () => {
    const { app } = await boot({ tenants: registry });
    try {
      const res = await post(app, 'acme');
      expect(res.statusCode).toBe(200);
      expect(JSON.parse(res.body ?? '{}').tenant).toEqual({ id: 'acme', name: 'acme' });
    } finally {
      await app.stop();
    }
  });

  it('both entry points agree under a factory registry + cache + unknownTenantStatus 403 (§3.9, O8)', async () => {
    let factoryCalls = 0;
    const { app } = await boot({
      tenants: () => {
        factoryCalls++;
        return registry;
      },
      tenantCache: { ttlMs: 60_000, maxEntries: 10, maxBytes: 4_096 },
      unknownTenantStatus: 403,
    });
    try {
      expect(factoryCalls).toBe(1);
      const tenancy = app.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
      const cases: { id: string; http: number; lookup: 'hit' | 'miss' | 'fault' }[] = [
        { id: 'acme', http: 200, lookup: 'hit' },
        { id: 'initech', http: 403, lookup: 'miss' },
        { id: 'x'.repeat(10_000), http: 403, lookup: 'miss' },
        { id: 'explode', http: 503, lookup: 'fault' },
      ];
      for (const c of cases) {
        expect((await post(app, c.id)).statusCode).toBe(c.http);
        const outcome = await tenancy.lookupTenant(c.id).then(
          (r) => (r.present ? 'hit' : 'miss'),
          (e: unknown) => (e instanceof TenantRegistryUnavailableError ? 'fault' : 'other'),
        );
        expect(outcome).toBe(c.lookup);
      }
    } finally {
      await app.stop();
    }
  });

  it('control: with no registry both entry points admit any id', async () => {
    const { app } = await boot({});
    try {
      const tenancy = app.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
      for (const id of ['initech', 'explode']) {
        expect((await post(app, id)).statusCode).toBe(200);
        const result = await tenancy.lookupTenant(id);
        expect(result.present && result.value).toEqual({ id });
      }
    } finally {
      await app.stop();
    }
  });

  it('a write under an unknown tenant creates no row (read back through getRepositoryFor)', async () => {
    const { app, handlerRuns } = await boot({ tenants: ['acme'] });
    try {
      expect((await post(app, 'initech')).statusCode).toBe(404);
      expect(handlerRuns()).toBe(0);
      const tenancy = app.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
      expect(await tenancy.getRepositoryFor<Note>('initech', 'Note').findAll()).toEqual([]);
      // Control: a listed tenant's write is read back.
      expect((await post(app, 'acme')).statusCode).toBe(200);
      const rows = await tenancy.getRepositoryFor<Note>('acme', 'Note').findAll();
      expect(rows.map((r) => r.text)).toEqual(['hello']);
    } finally {
      await app.stop();
    }
  });

  it('a custom resolver returning an empty or non-string id is refused on HTTP, with or without a registry, as lookupTenant refuses it', async () => {
    for (const bad of ['', 42, undefined]) {
      for (const tenants of [undefined, registry]) {
        const resolver = {
          resolve: (): Promise<Option<ITenant>> =>
            Promise.resolve(some({ id: bad } as unknown as ITenant)),
        };
        const { app, handlerRuns } = await boot({
          resolver,
          required: false,
          ...(tenants !== undefined && { tenants }),
        });
        try {
          const res = await post(app, 'acme');
          expect(res.statusCode, `${String(bad)} / ${tenants ? 'registry' : 'none'}`).toBe(404);
          expect(handlerRuns()).toBe(0);
          const tenancy = app.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
          expect((await tenancy.lookupTenant(bad as string)).present).toBe(false);
        } finally {
          await app.stop();
        }
      }
    }
    // Control: a well-formed id from the same custom resolver is admitted without a registry.
    const good = { resolve: (): Promise<Option<ITenant>> => Promise.resolve(some({ id: 'acme' })) };
    const { app, handlerRuns } = await boot({ resolver: good });
    try {
      expect((await post(app, 'ignored')).statusCode).toBe(200);
      expect(handlerRuns()).toBe(1);
    } finally {
      await app.stop();
    }
  });
});
