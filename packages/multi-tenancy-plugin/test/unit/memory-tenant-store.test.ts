/**
 * MemoryTenantDataStore tests.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { MemoryTenantDataStore } from '../../src/stores/memory-tenant-store.ts';
import { ColumnPerTenant } from '../../src/strategies/column-strategy.ts';
import { DatabasePerTenant } from '../../src/strategies/database-strategy.ts';
import { SchemaPerTenant } from '../../src/strategies/schema-strategy.ts';

describe('memory tenant store', () => {
  it('MemoryTenantDataStore — create and findAll', async () => {
    const store = new MemoryTenantDataStore();
    const result = await store.create('t1', 'User', { name: 'Ada' });
    expect((result as Record<string, unknown>).name).toEqual('Ada');
    const all = await store.findAll('t1', 'User');
    expect(all.length).toEqual(1);
    expect((all[0] as Record<string, unknown>).name).toEqual('Ada');
  });

  it('MemoryTenantDataStore — findById', async () => {
    const store = new MemoryTenantDataStore();
    const created = await store.create('t1', 'User', { id: 'u1', name: 'Ada' });
    expect((created as Record<string, unknown>).id).toEqual('u1');
    const found = await store.findById('t1', 'User', 'u1');
    expect(found != null).toBeTruthy();
    expect((found as Record<string, unknown>).name).toEqual('Ada');
  });

  it('MemoryTenantDataStore — findById returns null for unknown id', async () => {
    const store = new MemoryTenantDataStore();
    const found = await store.findById('t1', 'User', 'unknown');
    expect(found).toEqual(null);
  });

  it('MemoryTenantDataStore — find with filter', async () => {
    const store = new MemoryTenantDataStore();
    await store.create('t1', 'User', { id: 'u1', role: 'admin' });
    await store.create('t1', 'User', { id: 'u2', role: 'user' });
    const results = await store.find('t1', 'User', { role: 'admin' });
    expect(results.length).toEqual(1);
    expect((results[0] as Record<string, unknown>).id).toEqual('u1');
  });

  it('MemoryTenantDataStore — update returns updated entity', async () => {
    const store = new MemoryTenantDataStore();
    await store.create('t1', 'User', { id: 'u1', name: 'Ada' });
    const updated = await store.update('t1', 'User', 'u1', { name: 'Ada Updated' });
    expect(updated != null).toBeTruthy();
    expect((updated as Record<string, unknown>).name).toEqual('Ada Updated');
  });

  it('MemoryTenantDataStore — update returns null for unknown id', async () => {
    const store = new MemoryTenantDataStore();
    const updated = await store.update('t1', 'User', 'u99', { name: 'X' });
    expect(updated).toEqual(null);
  });

  it('MemoryTenantDataStore — delete returns true/false', async () => {
    const store = new MemoryTenantDataStore();
    await store.create('t1', 'User', { id: 'u1', name: 'Ada' });
    expect(await store.delete('t1', 'User', 'u1')).toEqual(true);
    expect(await store.delete('t1', 'User', 'u1')).toEqual(false);
  });

  it('MemoryTenantDataStore — close clears data', async () => {
    const store = new MemoryTenantDataStore();
    await store.create('t1', 'User', { id: 'u1' });
    await store.close();
    const all = await store.findAll('t1', 'User');
    expect(all.length).toEqual(0);
  });

  it('MemoryTenantDataStore — cross-tenant isolation', async () => {
    const store = new MemoryTenantDataStore();
    await store.create('t1', 'User', { id: 'u1', tenant: 'A' });
    await store.create('t2', 'User', { id: 'u2', tenant: 'B' });
    const aUsers = await store.findAll('t1', 'User');
    const bUsers = await store.findAll('t2', 'User');
    expect(aUsers.length).toEqual(1);
    expect(bUsers.length).toEqual(1);
    expect((aUsers[0] as Record<string, unknown>).tenant).toEqual('A');
    expect((bUsers[0] as Record<string, unknown>).tenant).toEqual('B');
  });

  it('MemoryTenantDataStore — string id is preserved', async () => {
    const store = new MemoryTenantDataStore();
    const result = await store.create('t1', 'User', { id: 'custom-123', name: 'X' });
    expect((result as Record<string, unknown>).id).toEqual('custom-123');
  });

  it('MemoryTenantDataStore — number id is preserved', async () => {
    const store = new MemoryTenantDataStore();
    const result = await store.create('t1', 'User', { id: 42, name: 'X' });
    expect((result as Record<string, unknown>).id).toEqual(42);
  });

  it('MemoryTenantDataStore — missing id uses default counter', async () => {
    const store = new MemoryTenantDataStore();
    const r1 = await store.create('t1', 'User', { name: 'A' });
    const r2 = await store.create('t1', 'User', { name: 'B' });
    expect((r1 as Record<string, unknown>).id).toEqual('1');
    expect((r2 as Record<string, unknown>).id).toEqual('2');
  });

  it('MemoryTenantDataStore — injected generateId', async () => {
    let counter = 100;
    const store = new MemoryTenantDataStore({
      generateId: () => `gen-${counter++}`,
    });
    const result = await store.create('t1', 'User', { name: 'X' });
    expect((result as Record<string, unknown>).id).toEqual('gen-100');
  });

  it('MemoryTenantDataStore — column strategy stamps tenant column', async () => {
    const store = new MemoryTenantDataStore();
    const strategy = new ColumnPerTenant('org_id');
    store.useIsolation(strategy);
    await store.create('t1', 'User', { name: 'Ada' });
    const results = await store.find('t1', 'User', { org_id: 't1' });
    expect(results.length).toEqual(1);
  });

  it('MemoryTenantDataStore — schema strategy derives scope', async () => {
    const store = new MemoryTenantDataStore();
    const strategy = new SchemaPerTenant('schema_');
    store.useIsolation(strategy);
    // With schema strategy, deriveScope maps tenantId to schema name.
    // Creating via 't1' actually stores under 'schema_t1'.
    await store.create('t1', 'User', { id: 'u1' });
    // Reading back via 't1' also maps to 'schema_t1'.
    const all = await store.findAll('t1', 'User');
    expect(all.length).toEqual(1);
    expect((all[0] as { id: string }).id).toEqual('u1');
  });

  it('MemoryTenantDataStore — database strategy derives scope', async () => {
    const store = new MemoryTenantDataStore();
    const strategy = new DatabasePerTenant('db_');
    store.useIsolation(strategy);
    await store.create('t1', 'User', { id: 'u1' });
    const all = await store.findAll('t1', 'User');
    expect(all.length).toEqual(1);
  });

  it('MemoryTenantDataStore — strategy partitions differ by tenant', async () => {
    const store = new MemoryTenantDataStore();
    const schemaStrategy = new SchemaPerTenant('s_');
    store.useIsolation(schemaStrategy);
    // Tenant A stores under 's_a', tenant B under 's_b'
    await store.create('a', 'Item', { id: 'i-a' });
    await store.create('b', 'Item', { id: 'i-b' });
    // Both are accessible via their respective tenantIds
    const aItems = await store.findAll('a', 'Item');
    const bItems = await store.findAll('b', 'Item');
    expect(aItems.length).toEqual(1);
    expect(bItems.length).toEqual(1);
    expect((aItems[0] as { id: string }).id).toEqual('i-a');
    expect((bItems[0] as { id: string }).id).toEqual('i-b');
  });

  // A6: update(id, { id: 'other' }) must NOT create a key/field split.
  it('MemoryTenantDataStore — update ignores id in payload (key is authoritative)', async () => {
    const store = new MemoryTenantDataStore();
    await store.create('t1', 'User', { id: 'u1', name: 'Original' });
    // Attempt to change the id field via update — must be ignored.
    await store.update('t1', 'User', 'u1', { id: 'u999', name: 'Modified' });
    const found = await store.findById('t1', 'User', 'u1');
    expect(found != null).toBeTruthy();
    expect((found as Record<string, unknown>).id).toEqual('u1');
    expect((found as Record<string, unknown>).name).toEqual('Modified');
    // The orphaned key 'u999' must NOT exist.
    const orphaned = await store.findById('t1', 'User', 'u999');
    expect(orphaned).toEqual(null);
  });

  describe('rows are handed out as detached snapshots', () => {
    it('mutating the entity returned by create does not rewrite the store', async () => {
      const store = new MemoryTenantDataStore();
      const created = await store.create<Record<string, unknown>>('t1', 'User', { name: 'Orig' });
      created.name = 'MUTATED';

      const reread = await store.findById<Record<string, unknown>, string>(
        't1',
        'User',
        String(created.id),
      );
      expect(reread?.name).toEqual('Orig');
    });

    it('mutating an entity returned by findAll/find/findById does not rewrite the store', async () => {
      const store = new MemoryTenantDataStore();
      await store.create('t1', 'User', { id: 'u1', name: 'Orig', role: 'admin' });

      (await store.findAll<Record<string, unknown>>('t1', 'User'))[0]!.name = 'X';
      (await store.find<Record<string, unknown>>('t1', 'User', { role: 'admin' }))[0]!.name = 'Y';
      const byId = await store.findById<Record<string, unknown>, string>('t1', 'User', 'u1');
      byId!.name = 'Z';

      const reread = await store.findById<Record<string, unknown>, string>('t1', 'User', 'u1');
      expect(reread?.name).toEqual('Orig');
    });

    it('mutating the entity returned by update does not rewrite the store', async () => {
      const store = new MemoryTenantDataStore();
      await store.create('t1', 'User', { id: 'u1', name: 'Orig' });
      const updated = await store.update<Record<string, unknown>, string>('t1', 'User', 'u1', {
        name: 'Updated',
      });
      updated!.name = 'MUTATED';

      const reread = await store.findById<Record<string, unknown>, string>('t1', 'User', 'u1');
      expect(reread?.name).toEqual('Updated');
    });
  });

  describe('read paths never allocate a partition', () => {
    // Regression: reads used to create the scope/entity maps on demand, so a
    // stream of requests carrying arbitrary `x-tenant-id` values grew the store
    // without a single write.
    const partitionCount = (store: MemoryTenantDataStore): number =>
      (store as unknown as { store: Map<string, unknown> }).store.size;

    it('findAll/find/findById/delete on unknown tenants allocate nothing', async () => {
      const store = new MemoryTenantDataStore();
      for (let i = 0; i < 5; i++) {
        expect(await store.findAll(`ghost-${i}`, 'User')).toEqual([]);
        expect(await store.find(`ghost-${i}`, 'User', { any: 'thing' })).toEqual([]);
        expect(await store.findById(`ghost-${i}`, 'User', 'x')).toEqual(null);
        expect(await store.delete(`ghost-${i}`, 'User', 'x')).toBe(false);
      }
      expect(partitionCount(store)).toEqual(0);
    });

    it('update on an unknown tenant returns null and allocates nothing', async () => {
      const store = new MemoryTenantDataStore();
      expect(await store.update('ghost', 'User', 'x', { a: 1 })).toEqual(null);
      expect(partitionCount(store)).toEqual(0);
    });

    it('a write allocates exactly one partition, reads on it do not add more', async () => {
      const store = new MemoryTenantDataStore();
      await store.create('t1', 'User', { name: 'Ada' });
      expect(partitionCount(store)).toEqual(1);
      await store.findAll('t1', 'Order');
      await store.findAll('t2', 'User');
      expect(partitionCount(store)).toEqual(1);
    });
  });
});
