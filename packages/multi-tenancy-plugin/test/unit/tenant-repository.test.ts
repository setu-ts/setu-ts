/**
 * TenantRepository tests.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { TenantRepository } from '../../src/repositories/tenant-repository.ts';
import type { ITenantDataStore } from '../../src/interfaces/index.ts';

describe('tenant repository', () => {
  it('TenantRepository — findAll delegates to store', async () => {
    let capturedTenantId = '';
    let capturedEntity = '';
    const fakeStore = {
      findAll<E>(tenantId: string, entity: string) {
        capturedTenantId = tenantId;
        capturedEntity = entity;
        return Promise.resolve([] as readonly E[]);
      },
      findById: () => null,
      find: () => [],
      create: (t: string, e: string, d: Record<string, unknown>) => {
        capturedTenantId = t;
        capturedEntity = e;
        return Promise.resolve(d);
      },
      update: () => null,
      delete: () => false,
      close: () => {},
    } as unknown as ITenantDataStore;

    const repo = new TenantRepository(fakeStore, 'tenant-a', 'User');
    await repo.findAll();
    expect(capturedTenantId).toEqual('tenant-a');
    expect(capturedEntity).toEqual('User');
  });

  it('TenantRepository — findById delegates correctly', async () => {
    let capturedArgs: [string, string, string] = ['', '', ''];
    const fakeStore = {
      findAll: () => [],
      findById<E, Id>(tenantId: string, entity: string, id: Id) {
        capturedArgs = [tenantId, entity, String(id)];
        return Promise.resolve({ id: String(id), name: 'Test' } as E);
      },
      find: () => [],
      create: () => ({}),
      update: () => null,
      delete: () => false,
      close: () => {},
    } as unknown as ITenantDataStore;

    const repo = new TenantRepository(fakeStore, 't1', 'Item');
    const found = await repo.findById('item-42');
    expect(capturedArgs).toEqual(['t1', 'Item', 'item-42']);
    expect(found != null).toBeTruthy();
    expect((found as Record<string, unknown>).id).toEqual('item-42');
  });

  it('TenantRepository — findById returns null for missing entity', async () => {
    const fakeStore = {
      findAll: () => [],
      findById: () => null,
      find: () => [],
      create: () => ({}),
      update: () => null,
      delete: () => false,
      close: () => {},
    } as unknown as ITenantDataStore;

    const repo = new TenantRepository(fakeStore, 't1', 'User');
    const found = await repo.findById('nonexistent');
    expect(found).toEqual(null);
  });

  it('TenantRepository — find with filter delegates correctly', async () => {
    let capturedFilter: Record<string, unknown> | null = null;
    const fakeStore = {
      findAll: () => [],
      findById: () => null,
      find<E>(_tenantId: string, _entity: string, filter: Record<string, unknown>) {
        capturedFilter = { ...filter };
        return Promise.resolve(
          [
            { id: 'u1', role: 'admin' },
          ] as unknown as readonly E[],
        );
      },
      create: () => ({}),
      update: () => null,
      delete: () => false,
      close: () => {},
    } as unknown as ITenantDataStore;

    const repo = new TenantRepository(fakeStore, 't1', 'User');
    const results = await repo.find({ role: 'admin' });
    expect(capturedFilter != null).toBeTruthy();
    expect((capturedFilter as unknown as Record<string, unknown>).role).toEqual('admin');
    expect(results.length).toEqual(1);
  });

  it('TenantRepository — create delegates correctly', async () => {
    let capturedData: Record<string, unknown> | null = null;
    const fakeStore = {
      findAll: () => [],
      findById: () => null,
      find: () => [],
      create<E>(_tenantId: string, _entity: string, data: Record<string, unknown>) {
        capturedData = { ...data };
        return Promise.resolve({ ...data } as unknown as E);
      },
      update: () => null,
      delete: () => false,
      close: () => {},
    } as unknown as ITenantDataStore;

    const repo = new TenantRepository(fakeStore, 't1', 'Product');
    const result = await repo.create({ name: 'Widget', price: 9.99 });
    expect(capturedData != null).toBeTruthy();
    expect((capturedData as unknown as Record<string, unknown>).name).toEqual('Widget');
    expect((capturedData as unknown as Record<string, unknown>).price).toEqual(9.99);
    expect((result as Record<string, unknown>).name).toEqual('Widget');
  });

  it('TenantRepository — update delegates and can return null', async () => {
    const fakeStore = {
      findAll: () => [],
      findById: () => null,
      find: () => [],
      create: () => ({}),
      update: () => null,
      delete: () => false,
      close: () => {},
    } as unknown as ITenantDataStore;

    const repo = new TenantRepository(fakeStore, 't1', 'User');
    const result = await repo.update('nonexistent', { name: 'Updated' });
    expect(result).toEqual(null);
  });

  it('TenantRepository — update delegates and returns entity on success', async () => {
    const fakeStore = {
      findAll: () => [],
      findById: () => null,
      find: () => [],
      create: () => ({}),
      update<E, Id>(_tenantId: string, _entity: string, _id: Id, data: Record<string, unknown>) {
        return Promise.resolve(data as E);
      },
      delete: () => false,
      close: () => {},
    } as unknown as ITenantDataStore;

    const repo = new TenantRepository(fakeStore, 't1', 'User');
    const result = await repo.update('u1', { name: 'Patched' });
    expect(result != null).toBeTruthy();
    expect((result as Record<string, unknown>).name).toEqual('Patched');
  });

  it('TenantRepository — delete returns false when not found', async () => {
    const fakeStore = {
      findAll: () => [],
      findById: () => null,
      find: () => [],
      create: () => ({}),
      update: () => null,
      delete: () => false,
      close: () => {},
    } as unknown as ITenantDataStore;

    const repo = new TenantRepository(fakeStore, 't1', 'User');
    const deleted = await repo.delete('missing');
    expect(deleted).toEqual(false);
  });

  it('TenantRepository — delete returns true when found', async () => {
    const fakeStore = {
      findAll: () => [],
      findById: () => null,
      find: () => [],
      create: () => ({}),
      update: () => null,
      delete: () => true,
      close: () => {},
    } as unknown as ITenantDataStore;

    const repo = new TenantRepository(fakeStore, 't1', 'User');
    const deleted = await repo.delete('existing');
    expect(deleted).toEqual(true);
  });

  it('TenantRepository — isolation: tenant A never sees tenant B', async () => {
    const fakeStore = {
      findAll<E>() {
        return Promise.resolve([] as readonly E[]);
      },
      findById() {
        return null;
      },
      find() {
        return [];
      },
      create() {
        return {};
      },
      update() {
        return null;
      },
      delete() {
        return false;
      },
      close: () => {},
    } as unknown as ITenantDataStore;

    let lastTenantId = '';
    const spyStore = {
      ...fakeStore,
      findAll<E>(tenantId: string) {
        lastTenantId = tenantId;
        return Promise.resolve([] as readonly E[]);
      },
    };

    const repoA = new TenantRepository(spyStore, 'tenant-a', 'User');
    await repoA.findAll();
    expect(lastTenantId).toEqual('tenant-a');

    const repoB = new TenantRepository(spyStore, 'tenant-b', 'User');
    await repoB.findAll();
    expect(lastTenantId).toEqual('tenant-b');
  });

  it('TenantRepository — findAll returns empty array', async () => {
    const fakeStore = {
      findAll<E>() {
        return Promise.resolve([] as readonly E[]);
      },
      findById: () => null,
      find: () => [],
      create: () => ({}),
      update: () => null,
      delete: () => false,
      close: () => {},
    } as unknown as ITenantDataStore;

    const repo = new TenantRepository(fakeStore, 't1', 'User');
    const results = await repo.findAll();
    expect(results).toEqual([]);
    expect(results.length).toEqual(0);
  });

  it('TenantRepository — find returns filtered results', async () => {
    const fakeStore = {
      findAll: () => [],
      findById: () => null,
      find<E>(_tenantId: string, _entity: string, filter: Record<string, unknown>) {
        const records = [
          { id: 'u1', role: 'admin' },
          { id: 'u2', role: 'user' },
        ];
        const filtered = records.filter((r) =>
          Object.entries(filter).every(([k, v]) => (r as Record<string, unknown>)[k] === v)
        );
        return Promise.resolve(filtered as unknown as readonly E[]);
      },
      create: () => ({}),
      update: () => null,
      delete: () => false,
      close: () => {},
    } as unknown as ITenantDataStore;

    const repo = new TenantRepository(fakeStore, 't1', 'User');
    const admins = await repo.find({ role: 'admin' });
    expect(admins.length).toEqual(1);
    expect((admins[0] as Record<string, unknown>).role).toEqual('admin');
  });

  it('TenantRepository — create and findById round-trip via recording store', async () => {
    let capturedId = '';
    const fakeStore = {
      findAll: () => [],
      findById<E>(_tenantId: string, _entity: string, id: string) {
        capturedId = id;
        return Promise.resolve({ id, name: 'Created' } as unknown as E);
      },
      find: () => [],
      create<E>(_tenantId: string, _entity: string, data: Record<string, unknown>) {
        return Promise.resolve({ id: 'prod-1', ...data } as unknown as E);
      },
      update: () => null,
      delete: () => false,
      close: () => {},
    } as unknown as ITenantDataStore;

    const repo = new TenantRepository(fakeStore, 'tenant-x', 'Product');
    const created = await repo.create({ name: 'Widget' });
    expect((created as Record<string, unknown>).name).toEqual('Widget');
    const found = await repo.findById('prod-1') as Record<string, unknown> | null;
    expect(found != null).toBeTruthy();
    expect(capturedId).toEqual('prod-1');
  });
});
