/**
 * TenantRepository tests.
 */
import { assert, assertEquals } from 'jsr:@std/assert';
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
  await repo.findById('item-42');
  assertEquals(capturedArgs[0], 't1');
  assertEquals(capturedArgs[1], 'Item');
  assertEquals(capturedArgs[2], 'item-42');
});

Deno.test('TenantRepository — write→read-back through store', async () => {
  const records: Record<string, unknown>[] = [];
  const fakeStore = {
    findAll() {
      return Promise.resolve(records as readonly unknown[]);
    },
    findById(_t: string, _e: string, id: string) {
      return Promise.resolve(records.find((r) => r.id === id) ?? null);
    },
    find(_t: string, _e: string, filter: Record<string, unknown>) {
      return Promise.resolve(
        records.filter((r) =>
          Object.entries(filter).every(([k, v]) => r[k] === v)
        ) as readonly unknown[],
      );
    },
    async create(_tenantId: string, _entity: string, data: Record<string, unknown>) {
      if (!data.id) data.id = `id-${records.length}`;
      records.push({ ...data });
      return data;
    },
    update() {
      return null;
    },
    delete() {
      return false;
    },
    close: () => {},
  } as unknown as ITenantDataStore;

  const repo = new TenantRepository(fakeStore, 'tenant-x', 'Product');
  const created = await repo.create({ name: 'Widget' }) as Record<string, unknown>;
  assertEquals((created as any).name, 'Widget');
  const found = await repo.findById(String((created as any).id)) as Record<string, unknown> | null;
  assert(found != null);
  assertEquals((found as any).name, 'Widget');
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
