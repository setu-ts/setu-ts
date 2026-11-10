import { describe, expect, it, vi } from 'vitest';
import { DatabaseTenantDataStore, DatabasePlugin } from '@setu-ts/database-plugin';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES, httpStatusHintOf } from '@setu-ts/common';
import type { ITenantUnitOfWork } from '@setu-ts/common';
import { TenantUnitOfWorkUnsupportedError } from '../../src/index.ts';
import { MultiTenancyService } from '../../src/services/multi-tenancy-service.ts';
import { MemoryTenantDataStore } from '../../src/stores/memory-tenant-store.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';

describe('M139c tenant unit of work entry points', () => {
  it('M139c binds both entry points under the same non-default tenant column', async () => {
    const app = createApplication({
      plugins: [RuntimePlugin(), DatabasePlugin({ type: 'memory' })],
    });
    await app.start();
    try {
      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const store = new DatabaseTenantDataStore(db);
      store.useIsolation({ kind: 'column', getTenantColumn: () => 'org_id' });
      const bind = vi.spyOn(store, 'withUnitOfWork');
      const service = new MultiTenancyService({ store });
      const ctx = createFakeContext({ tenant: { id: 'acme' } });
      await db.transaction(async (uow) => {
        for (const [i, entry] of ['request', 'explicit'].entries()) {
          const repo =
            entry === 'request'
              ? service.getRepository(ctx, 'Order', uow)
              : service.getRepositoryFor('acme', 'Order', uow);
          expect(await repo.create({ id: `o${i}`, org_id: 'foreign' })).toEqual({
            id: `o${i}`,
            org_id: 'acme',
          });
          expect(await uow.getRepository('Order').findById(`o${i}`)).toEqual({
            id: `o${i}`,
            org_id: 'acme',
          });
        }
        expect(bind.mock.calls.map((c) => c[0])).toEqual([uow, uow]);
      });
    } finally {
      await app.stop();
    }
  });
  it('M139c refuses both entry points on a store without transaction support', () => {
    const service = new MultiTenancyService({ store: new MemoryTenantDataStore() });
    const ctx = createFakeContext({ tenant: { id: 'acme' } });
    const uow: ITenantUnitOfWork = { getRepository: () => ({}) };
    for (const call of [
      () => service.getRepository(ctx, 'Order', uow),
      () => service.getRepositoryFor('acme', 'Order', uow),
    ]) {
      let caught: unknown;
      try {
        call();
      } catch (error) {
        caught = error;
      }
      expect(caught).toBeInstanceOf(TenantUnitOfWorkUnsupportedError);
      expect((caught as Error).message).toContain('MemoryTenantDataStore');
      expect(httpStatusHintOf(caught)?.status).toBe(500);
    }
  });
});
