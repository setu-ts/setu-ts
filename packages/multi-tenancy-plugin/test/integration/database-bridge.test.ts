/**
 * Integration test — the tenant data-store bridge over a REAL database
 * (M101c, V8-8).
 *
 * Boots a real kernel app with `DatabasePlugin({ type: 'memory' })` and
 * `MultiTenancyPlugin({ dataStore: createDatabaseTenantDataStore() })`. The
 * `dataStore` is a `RegistryFactory`, so it is resolved in `onInit` — the
 * first phase at which the registry holds `CAPABILITIES.DATABASE` — which is
 * what lets `DatabasePlugin` be registered in ANY order relative to the tenancy
 * plugin. The repository is then driven over HTTP under two tenant headers:
 * a row written under tenant `a` is read back under `a` and is invisible to
 * every read under `b`.
 *
 * This is the end-to-end proof the bridge actually isolates: the unit test
 * (`database-tenant-data-store.test.ts`) pins each translated `IRepository`
 * call over a recording fake; this one proves the calls reach a real
 * `DatabaseService` over `MemoryAdapter` and that the tenant column is what
 * partitions the rows.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMultiTenancyService } from '@setu-ts/common';
import { createDatabaseTenantDataStore, DatabasePlugin } from '@setu-ts/database-plugin';
import { MultiTenancyPlugin } from '../../src/index.ts';

interface Patient {
  id: string;
  name: string;
  tenant_id?: string;
}

/**
 * Boots the real kernel app. `DatabasePlugin` is registered AFTER the tenancy
 * plugin on purpose: the `RegistryFactory` is only resolved in `onInit`, so the
 * registration order must not matter. If the factory were (wrongly) resolved in
 * `register()`, this order would throw — the §3.3 negative control (3).
 */
async function bootApp(): Promise<IKernelApplication> {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      MultiTenancyPlugin({
        resolver: 'header',
        database: 'column-per-tenant',
        dataStore: createDatabaseTenantDataStore(),
      }),
      DatabasePlugin({ type: 'memory' }),
    ],
  });

  app.router.post('/patients', async (ctx) => {
    const tenancy = ctx.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
    const body = await ctx.request.json<{ name: string }>();
    const created = await tenancy.getRepository<Patient>(ctx, 'Patient').create({
      name: body.name,
    });
    return ctx.response.json({ created });
  });

  app.router.get('/patients', async (ctx) => {
    const tenancy = ctx.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
    const tenant = tenancy.getCurrentTenant(ctx)?.id ?? null;
    const all = await tenancy.getRepository<Patient>(ctx, 'Patient').findAll();
    return ctx.response.json({ tenant, patients: all });
  });

  app.router.get('/patients/:id', async (ctx) => {
    const tenancy = ctx.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
    const found = await tenancy.getRepository<Patient>(ctx, 'Patient').findById(ctx.params.id);
    return ctx.response.json({ patient: found });
  });

  await app.start();
  return app;
}

describe('tenant data-store bridge — real DatabasePlugin + createDatabaseTenantDataStore', () => {
  it('writes under `a`, reads back under `a`, and is invisible under `b`', async () => {
    const app = await bootApp();
    try {
      // Write a patient as tenant `a`. The bridge stamps `tenant_id: 'a'`.
      const createRes = await app.inject({
        method: 'POST',
        url: 'http://localhost/patients',
        headers: { 'x-tenant-id': 'a', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Ada' }),
      });
      expect(createRes.statusCode).toBe(200);
      const created = (JSON.parse(createRes.body ?? '{}').created) as Patient;
      expect(created.name).toEqual('Ada');
      expect(created.tenant_id).toEqual('a'); // the column strategy reached the store
      const id = created.id;
      expect(id).toBeTruthy();

      // Read back under `a` — the row is there, scoped to `a`.
      const readA = await app.inject({
        method: 'GET',
        url: 'http://localhost/patients',
        headers: { 'x-tenant-id': 'a' },
      });
      expect(readA.statusCode).toBe(200);
      const a = JSON.parse(readA.body ?? '{}') as { tenant: string; patients: Patient[] };
      expect(a.tenant).toEqual('a');
      expect(a.patients).toHaveLength(1);
      expect(a.patients[0].id).toEqual(id);
      expect(a.patients[0].name).toEqual('Ada');

      // `findById` under `a` reaches the same row.
      const byIdA = await app.inject({
        method: 'GET',
        url: `http://localhost/patients/${id}`,
        headers: { 'x-tenant-id': 'a' },
      });
      const aById = JSON.parse(byIdA.body ?? '{}') as { patient: Patient | null };
      expect(aById.patient?.id).toEqual(id);

      // Under `b` the row is invisible to every read: `findAll` and `findById`.
      const readB = await app.inject({
        method: 'GET',
        url: 'http://localhost/patients',
        headers: { 'x-tenant-id': 'b' },
      });
      const b = JSON.parse(readB.body ?? '{}') as { tenant: string; patients: Patient[] };
      expect(b.tenant).toEqual('b');
      expect(b.patients).toEqual([]);

      const byIdB = await app.inject({
        method: 'GET',
        url: `http://localhost/patients/${id}`,
        headers: { 'x-tenant-id': 'b' },
      });
      const bById = JSON.parse(byIdB.body ?? '{}') as { patient: Patient | null };
      expect(bById.patient).toBeNull();
    } finally {
      await app.stop();
    }
  });
});
