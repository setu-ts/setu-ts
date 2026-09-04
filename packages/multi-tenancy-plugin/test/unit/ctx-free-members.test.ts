/**
 * The ctx-free member on `IMultiTenancyService` (M89c plan §3.4):
 * `getRepositoryFor(tenantId, entity)` — modelled on the `prefixCacheKey`
 * precedent of a ctx-free, id-taking member.
 *
 * Proven against the REAL `MultiTenancyService` and `MemoryTenantDataStore`:
 * the returned repository scopes every write to the id it is GIVEN, and two
 * ids do not see each other's rows. No `IRequestContext` exists anywhere in
 * this file — that is the point.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMultiTenancyService, ITenantRepository } from '@setu-ts/common';
import { MultiTenancyService } from '../../src/services/multi-tenancy-service.ts';
import { MemoryTenantDataStore } from '../../src/stores/memory-tenant-store.ts';

describe('MultiTenancyService.getRepositoryFor (M89c §3.4)', () => {
  it('scopes a write to the id it is given — no request context involved', async () => {
    const service: IMultiTenancyService = new MultiTenancyService({
      store: new MemoryTenantDataStore(),
    });

    const repo = service.getRepositoryFor<{ id: string; label: string }>('acme', 'Widget');
    await repo.create({ id: 'w1', label: 'acme widget' });

    const rows = await repo.findAll();
    expect(rows).toEqual([{ id: 'w1', label: 'acme widget' }]);
    expect(await repo.findById('w1')).toEqual({ id: 'w1', label: 'acme widget' });
  });

  it('two ids do not see each other’s rows — same entity, disjoint partitions', async () => {
    const service: IMultiTenancyService = new MultiTenancyService({
      store: new MemoryTenantDataStore(),
    });

    const acme: ITenantRepository<{ id: string; label: string }> = service.getRepositoryFor(
      'acme',
      'Widget',
    );
    const globe: ITenantRepository<{ id: string; label: string }> = service.getRepositoryFor(
      'globe',
      'Widget',
    );

    await acme.create({ id: 'shared', label: 'acme row' });
    await globe.create({ id: 'shared', label: 'globe row' });

    // Same id, different tenants: each sees only its own row.
    expect((await acme.findAll()).map((r) => r.label)).toEqual(['acme row']);
    expect((await globe.findAll()).map((r) => r.label)).toEqual(['globe row']);
    expect((await acme.findById('shared'))?.label).toBe('acme row');
    expect((await globe.findById('shared'))?.label).toBe('globe row');

    // An id with no rows sees an empty entity — and reads allocate nothing.
    expect(await service.getRepositoryFor('ghost', 'Widget').findAll()).toEqual([]);
  });

  it('shares the data store with getRepository — the HTTP and non-HTTP paths agree', async () => {
    // Both entry points scope through the SAME injected store, so a row
    // written from background work is visible on the HTTP path of the same
    // tenant (and isolation is store-wide, not per member).
    const store = new MemoryTenantDataStore();
    const service: IMultiTenancyService = new MultiTenancyService({ store });

    await service.getRepositoryFor<{ id: string }>('acme', 'Audit').create({ id: 'a1' });

    const viaHttpPath = service.getRepository<{ id: string }>(
      {
        request: { tenant: { id: 'acme' } },
      } as unknown as Parameters<IMultiTenancyService['getRepository']>[0],
      'Audit',
    );
    expect(await viaHttpPath.findById('a1')).toEqual({ id: 'a1' });
    expect(await service.getRepositoryFor<{ id: string }>('other', 'Audit').findAll()).toEqual([]);
  });
});
