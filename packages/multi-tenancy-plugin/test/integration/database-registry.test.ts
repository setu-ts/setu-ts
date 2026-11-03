/**
 * Integration test — `createDatabaseTenantRegistry()` as the `tenants` option
 * of a REAL kernel app (M127 §3.8, audit obligation O10).
 *
 * `DatabasePlugin` is registered AFTER `MultiTenancyPlugin` on purpose: the
 * registry is a `RegistryFactory` resolved in `onInit`, so the order must not
 * matter. Tenants are rows; a listed tenant is admitted with its canonical id,
 * a suspended or unknown one is refused, and a secret column on the tenant row
 * never reaches the handler.
 *
 * Lives in this package rather than in `database-plugin` because that package
 * may not depend on this one (this one already depends on it).
 *
 * @module
 */

import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { createDatabaseTenantRegistry, DatabasePlugin } from '@setu-ts/database-plugin';
import { MultiTenancyPlugin } from '../../src/index.ts';

describe('createDatabaseTenantRegistry inside MultiTenancyPlugin', () => {
  it('admits active rows, refuses suspended and unknown ids, with DatabasePlugin registered after', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MultiTenancyPlugin({
          resolver: 'header',
          required: true,
          tenants: createDatabaseTenantRegistry({ idField: 'slug', activeField: 'active' }),
          tenantCache: false,
        }),
        DatabasePlugin({ type: 'memory' }),
      ],
    });
    app.router.get('/whoami', (ctx) => ctx.response.json({ tenant: ctx.request.tenant ?? null }));
    await app.start();
    try {
      const tenants = app.services
        .get<IDatabaseService>(CAPABILITIES.DATABASE)
        .getRepository<Record<string, unknown>>('Tenant');
      await tenants.create({ slug: 'acme', name: 'Acme', active: true, apiKey: 'sk-secret' });
      await tenants.create({ slug: 'globex', name: 'Globex', active: false });

      const ask = (tenant: string) =>
        app.inject({
          method: 'GET',
          url: 'http://localhost/whoami',
          headers: { 'x-tenant-id': tenant },
        });

      const hit = await ask('acme');
      expect(hit.statusCode).toBe(200);
      expect(JSON.parse(hit.body ?? '{}')).toEqual({ tenant: { id: 'acme', name: 'Acme' } });
      expect(hit.body).not.toContain('sk-secret');

      expect((await ask('globex')).statusCode).toBe(404);
      expect((await ask('initech')).statusCode).toBe(404);

      // A tenant created after start is admitted on its next request (misses
      // are never cached).
      await tenants.create({ slug: 'initech', name: 'Initech', active: true });
      expect((await ask('initech')).statusCode).toBe(200);
    } finally {
      await app.stop();
    }
  });
});
