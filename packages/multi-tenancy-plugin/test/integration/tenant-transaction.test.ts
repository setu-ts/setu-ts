import { describe, expect, it } from 'vitest';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMultiTenancyService } from '@setu-ts/common';
import { DatabasePlugin, createDatabaseTenantDataStore } from '@setu-ts/database-plugin';
import type { IDatabaseService } from '@setu-ts/database-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { ColumnPerTenant, MultiTenancyPlugin } from '../../src/index.ts';
import { createFakeContext } from '../fixtures/fake-context.ts';

describe('M139c tenant transaction', () => {
  it('M139c rolls back tenant writes and reads committed rows through both entry points', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        DatabasePlugin({ type: 'memory' }),
        MultiTenancyPlugin({
          resolver: 'header',
          database: new ColumnPerTenant('org_id'),
          dataStore: createDatabaseTenantDataStore(),
        }),
      ],
    });
    await app.start();
    try {
      const db = app.services.get<IDatabaseService>(CAPABILITIES.DATABASE);
      const tenancy = app.services.get<IMultiTenancyService>(CAPABILITIES.MULTI_TENANCY);
      const ctx = createFakeContext({ tenant: { id: 'acme' } });
      for (const entry of ['request', 'explicit']) {
        const repository = (uow?: import('@setu-ts/common').ITenantUnitOfWork) =>
          entry === 'request'
            ? tenancy.getRepository(ctx, 'Order', uow)
            : tenancy.getRepositoryFor('acme', 'Order', uow);
        await expect(
          db.transaction(async (uow) => {
            await repository(uow).create({ id: `${entry}-rollback`, org_id: 'foreign' });
            throw new Error('rollback');
          }),
        ).rejects.toThrow('rollback');
        expect(await repository().findById(`${entry}-rollback`)).toBeNull();
        expect(await db.getRepository('Order').findById(`${entry}-rollback`)).toBeNull();
        await db.transaction(async (uow) => {
          await repository(uow).create({ id: `${entry}-commit`, org_id: 'foreign' });
        });
        expect(await repository().findById(`${entry}-commit`)).toEqual({
          id: `${entry}-commit`,
          org_id: 'acme',
        });
        expect(
          await tenancy.getRepositoryFor('foreign', 'Order').findById(`${entry}-commit`),
        ).toBeNull();
      }
    } finally {
      await app.stop();
    }
  });
});
