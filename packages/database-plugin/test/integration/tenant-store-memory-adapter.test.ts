/**
 * Integration test — the tenant data-store bridge over a REAL `DatabaseService`
 * and `MemoryAdapter` (M101c, V8-8).
 *
 * The unit test pins each translated `IRepository` call over a recording fake.
 * This one drives the SAME bridge over the real `DatabaseService` +
 * `MemoryAdapter`, so the tenant column actually reaches the in-memory store:
 * a row written under tenant `a` is read back under `a` and is invisible to
 * `findAll`/`findById`/`find`/`update`/`delete` under tenant `b`.
 *
 * @module
 */

import { afterEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ITenantDataStore, ITenantIsolationStrategy } from '@setu-ts/common';

import { DatabaseService, DatabaseTenantDataStore, MemoryAdapter } from '../../src/index.ts';
import type { IDatabaseService } from '../../src/index.ts';

const COLUMN_STRATEGY: ITenantIsolationStrategy = {
  kind: 'column',
  getTenantColumn: () => 'tenant_id',
};

interface Row {
  id: string;
  name: string;
  tenant_id?: string;
}

async function makeStore(): Promise<DatabaseTenantDataStore> {
  const adapter = new MemoryAdapter();
  await adapter.connect();
  const service = new DatabaseService(
    adapter,
    (entity) => adapter.createDataSource(entity),
    'memory',
  );
  const store = new DatabaseTenantDataStore(service as IDatabaseService);
  store.useIsolation(COLUMN_STRATEGY);
  return store;
}

describe('DatabaseTenantDataStore — real DatabaseService over MemoryAdapter', () => {
  let store: ITenantDataStore;

  afterEach(async () => {
    await store.close?.();
  });

  it('a row written under `a` is invisible to every read under `b`', async () => {
    store = await makeStore();

    const created = await store.create<Row>('a', 'Patient', { name: 'Ada' });
    expect(created.tenant_id).toEqual('a'); // stamped last, un-overridable
    const id = created.id;
    expect(id).toBeTruthy();

    // Read back under `a`.
    const allA = await store.findAll<Row>('a', 'Patient');
    expect(allA).toHaveLength(1);
    expect(allA[0].id).toEqual(id);
    const byIdA = await store.findById<Row, string>('a', 'Patient', id);
    expect(byIdA?.name).toEqual('Ada');
    const foundA = await store.find<Row>('a', 'Patient', { name: 'Ada' });
    expect(foundA).toHaveLength(1);

    // Invisible under `b` to every read.
    const allB = await store.findAll<Row>('b', 'Patient');
    expect(allB).toEqual([]);
    const byIdB = await store.findById<Row, string>('b', 'Patient', id);
    expect(byIdB).toBeNull();
    // A filter that names `a`'s column cannot override the tenant conjoin:
    // the tenant column is spread LAST, so this still reads under `b`.
    const foundB = await store.find<Row>('b', 'Patient', { tenant_id: 'a' });
    expect(foundB).toEqual([]);
  });

  it('update and delete under a foreign tenant are no-ops, not cross-tenant mutations', async () => {
    store = await makeStore();

    const created = await store.create<Row>('a', 'Patient', { name: 'Ada' });
    const id = created.id;

    // `b` cannot update or delete `a`'s row: the lookup under `b` finds nothing.
    const updatedB = await store.update<Row, string>('b', 'Patient', id, { name: 'Mallory' });
    expect(updatedB).toBeNull();
    const deletedB = await store.delete<string>('b', 'Patient', id);
    expect(deletedB).toBe(false);

    // The row is intact under `a` …
    const intact = await store.findById<Row, string>('a', 'Patient', id);
    expect(intact?.name).toEqual('Ada');

    // … and `a` CAN update it. The tenant column is STRIPPED from the payload,
    // so the update cannot move the row between tenants.
    const updatedA = await store.update<Row, string>('a', 'Patient', id, { name: 'Grace' });
    expect(updatedA?.name).toEqual('Grace');
    const after = await store.findById<Row, string>('a', 'Patient', id);
    expect(after?.tenant_id).toEqual('a'); // still under `a`

    // And `a` CAN delete it.
    const deletedA = await store.delete<string>('a', 'Patient', id);
    expect(deletedA).toBe(true);
    expect(await store.findById<Row, string>('a', 'Patient', id)).toBeNull();
  });
});
