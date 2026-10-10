import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import { DatabaseService } from '../../src/services/database-service.ts';
import { DatabaseTenantDataStore } from '../../src/tenancy/database-tenant-data-store.ts';

describe('tenant conditional write race', () => {
  for (const operation of ['update', 'delete'] as const) {
    it(`${operation}: state-based tenant swap is refused without an ownership read`, async () => {
      const adapter = new MemoryAdapter();
      const source = adapter.createDataSource('Row');
      await source.create({ id: 'key', tenant_id: 'a', name: 'old' });
      await source.delete('key');
      await source.create({ id: 'key', tenant_id: 'b', name: 'secret' });
      let reads = 0;
      const service = new DatabaseService(adapter, () => ({
        ...source,
        findById: (id) => {
          reads++;
          return source.findById(id);
        },
      }), 'memory');
      const store = new DatabaseTenantDataStore(service);
      expect(
        operation === 'update'
          ? await store.update('a', 'Row', 'key', { name: 'bad' })
          : await store.delete('a', 'Row', 'key'),
      ).toBe(operation === 'update' ? null : false);
      expect(reads).toBe(0);
      expect(await source.findById('key')).toEqual({ id: 'key', tenant_id: 'b', name: 'secret' });
    });
    it(`${operation}: injected ownership-read race demonstrates the fallback write`, async () => {
      const adapter = new MemoryAdapter();
      const source = adapter.createDataSource('Row');
      await source.create({ id: 'key', tenant_id: 'a', name: 'old' });
      const legacy = { ...source };
      delete legacy.updateWhere;
      delete legacy.deleteWhere;
      let swapped = false;
      const service = new DatabaseService(adapter, () => ({
        ...legacy,
        findById: async (id) => {
          const captured = await source.findById(id);
          if (!swapped) {
            swapped = true;
            await source.delete(id);
            await source.create({ id: 'key', tenant_id: 'b', name: 'secret' });
          }
          return captured;
        },
      }), 'memory');
      const store = new DatabaseTenantDataStore(service);
      if (operation === 'update') {
        await expect(store.update('a', 'Row', 'key', { name: 'bad' })).rejects.toThrow(
          /changed tenant/,
        );
        expect(await source.findById('key')).toMatchObject({ tenant_id: 'b', name: 'bad' });
      } else {
        expect(await store.delete('a', 'Row', 'key')).toBe(true);
        expect(await source.findById('key')).toBeNull();
      }
      expect(swapped).toBe(true);
    });
  }
  it('rejects a foreign tenant returned by conditional read-back', async () => {
    const adapter = new MemoryAdapter();
    const source = adapter.createDataSource('Row');
    const service = new DatabaseService(
      adapter,
      () => ({
        ...source,
        updateWhere: () => Promise.resolve({ id: 'key', tenant_id: 'b', name: 'secret' }),
      }),
      'memory',
    );
    await expect(new DatabaseTenantDataStore(service).update('a', 'Row', 'key', { name: 'new' }))
      .rejects.toThrow(/changed tenant/);
  });
});
