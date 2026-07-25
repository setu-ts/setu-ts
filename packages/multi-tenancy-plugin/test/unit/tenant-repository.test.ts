/**
 * TenantRepository tests.
 */
import { assert, assertEquals } from 'jsr:@std/assert@^1.0.19';
import { TenantRepository } from '../../src/repositories/tenant-repository.ts';
import type { ITenantDataStore } from '../../src/interfaces/index.ts';

Deno.test('TenantRepository — findAll delegates to store', async () => {
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
  assertEquals(capturedTenantId, 'tenant-a');
  assertEquals(capturedEntity, 'User');
});

Deno.test('TenantRepository — findById delegates correctly', async () => {
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
  assertEquals(capturedArgs, ['t1', 'Item', 'item-42']);
  assert(found != null);
  assertEquals((found as Record<string, unknown>).id, 'item-42');
});

Deno.test('TenantRepository — findById returns null for missing entity', async () => {
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
  assertEquals(found, null);
});

Deno.test('TenantRepository — find with filter delegates correctly', async () => {
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
  assert(capturedFilter != null);
  assertEquals((capturedFilter as Record<string, unknown>).role, 'admin');
  assertEquals(results.length, 1);
});

Deno.test('TenantRepository — create delegates correctly', async () => {
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
  assert(capturedData != null);
  assertEquals((capturedData as Record<string, unknown>).name, 'Widget');
  assertEquals((capturedData as Record<string, unknown>).price, 9.99);
  assertEquals((result as Record<string, unknown>).name, 'Widget');
});

Deno.test('TenantRepository — update delegates and can return null', async () => {
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
  assertEquals(result, null);
});

Deno.test('TenantRepository — update delegates and returns entity on success', async () => {
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
  assert(result != null);
  assertEquals((result as Record<string, unknown>).name, 'Patched');
});

Deno.test('TenantRepository — delete returns false when not found', async () => {
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
  assertEquals(deleted, false);
});

Deno.test('TenantRepository — delete returns true when found', async () => {
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
  assertEquals(deleted, true);
});

Deno.test('TenantRepository — isolation: tenant A never sees tenant B', async () => {
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
  assertEquals(lastTenantId, 'tenant-a');

  const repoB = new TenantRepository(spyStore, 'tenant-b', 'User');
  await repoB.findAll();
  assertEquals(lastTenantId, 'tenant-b');
});

Deno.test('TenantRepository — findAll returns empty array', async () => {
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
  assertEquals(results, []);
  assertEquals(results.length, 0);
});

Deno.test('TenantRepository — find returns filtered results', async () => {
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
  assertEquals(admins.length, 1);
  assertEquals((admins[0] as Record<string, unknown>).role, 'admin');
});

Deno.test('TenantRepository — create and findById round-trip via recording store', async () => {
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
  assertEquals((created as Record<string, unknown>).name, 'Widget');
  const found = await repo.findById('prod-1') as Record<string, unknown> | null;
  assert(found != null);
  assertEquals(capturedId, 'prod-1');
});
