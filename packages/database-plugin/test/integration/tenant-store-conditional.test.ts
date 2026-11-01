/**
 * The tenant data-store bridge's conditional writes (M128, plan §3.7) over a
 * real `DatabaseService` and `MemoryAdapter`: the caller's precondition and
 * the tenant column form one precondition, a foreign row is never written,
 * and a precondition naming the tenant column is refused before any write.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { httpStatusHintOf } from '@setu-ts/common';
import type { ITenantIsolationStrategy, ITenantRepository } from '@setu-ts/common';
import {
  DatabaseService,
  DatabaseTenantDataStore,
  MemoryAdapter,
  updateVersioned,
  VersionConflictError,
  EntityNotFoundError,
  deleteVersioned,
} from '../../src/index.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';

const COLUMN_STRATEGY: ITenantIsolationStrategy = {
  kind: 'column',
  getTenantColumn: () => 'tenant_id',
};

interface Article {
  id: string;
  title: string;
  version: number;
  tenant_id?: string;
}

async function makeStore(
  wrap: (source: DataSource) => DataSource = (source) => source,
): Promise<{ store: DatabaseTenantDataStore; adapter: MemoryAdapter }> {
  const adapter = new MemoryAdapter();
  await adapter.connect();
  const service = new DatabaseService(
    adapter,
    (entity) => wrap(adapter.createDataSource(entity)),
    'memory',
  );
  const store = new DatabaseTenantDataStore(service);
  store.useIsolation(COLUMN_STRATEGY);
  return { store, adapter };
}

/** The tenant repository the multi-tenancy plugin builds, reduced to what the helper reads. */
function tenantRepo(
  store: DatabaseTenantDataStore,
  tenantId: string,
): ITenantRepository<Article, string> {
  return {
    findAll: () => store.findAll<Article>(tenantId, 'Article'),
    findById: (id) => store.findById<Article, string>(tenantId, 'Article', id),
    find: (filter) => store.find<Article>(tenantId, 'Article', filter),
    create: (data) => store.create<Article>(tenantId, 'Article', data),
    update: (id, data) => store.update<Article, string>(tenantId, 'Article', id, data),
    delete: (id) => store.delete(tenantId, 'Article', id),
    updateWhere: (id, where, data) =>
      store.updateWhere<Article, string>(tenantId, 'Article', id, where, data),
    deleteWhere: (id, where) => store.deleteWhere(tenantId, 'Article', id, where),
  };
}

describe('DatabaseTenantDataStore conditional writes', () => {
  it('merges the precondition with the tenant and leaves a foreign row alone', async () => {
    const { store } = await makeStore();
    const own = await store.create<Article>('a', 'Article', { title: 'mine', version: 1 });
    const foreign = await store.create<Article>('b', 'Article', { title: 'theirs', version: 1 });

    const updated = await store.updateWhere<Article, string>(
      'a',
      'Article',
      own.id,
      { version: 1 },
      { title: 'edited', tenant_id: 'b' },
    );
    expect(updated).toMatchObject({ title: 'edited', tenant_id: 'a' });
    // A matching version under another tenant is a miss, not a write.
    expect(
      await store.updateWhere('a', 'Article', foreign.id, { version: 1 }, { title: 'stolen' }),
    ).toBeNull();
    expect(await store.deleteWhere('a', 'Article', foreign.id, { version: 1 })).toBe(false);
    expect(await store.findById<Article, string>('b', 'Article', foreign.id)).toMatchObject({
      title: 'theirs',
    });
    expect(await store.deleteWhere('a', 'Article', own.id, { version: 2 })).toBe(false);
    expect(await store.deleteWhere('a', 'Article', own.id, { version: 1 })).toBe(true);
  });

  it('refuses a precondition naming the tenant column, without echoing it, before any write', async () => {
    const { store } = await makeStore();
    const own = await store.create<Article>('a', 'Article', { title: 'mine', version: 1 });
    for (const attempt of [
      () => store.updateWhere('a', 'Article', own.id, { tenant_id: 'b' }, { title: 'x' }),
      () => store.deleteWhere('a', 'Article', own.id, { tenant_id: 'a' }),
    ]) {
      const error = await attempt().catch((e: unknown) => e);
      expect(error).toMatchObject({
        name: 'UnsupportedQueryFeatureError',
        feature: 'write-precondition',
      });
      expect((error as Error).message).not.toContain('tenant_id');
    }
    expect(await store.findById<Article, string>('a', 'Article', own.id)).toMatchObject({
      title: 'mine',
    });
  });

  it('refuses an empty precondition rather than writing unconditionally (audit O2)', async () => {
    const { store } = await makeStore();
    const own = await store.create<Article>('a', 'Article', { title: 'mine', version: 1 });
    for (const attempt of [
      () => store.updateWhere('a', 'Article', own.id, {}, { title: 'x' }),
      () => store.deleteWhere('a', 'Article', own.id, {}),
    ]) {
      const error = await attempt().catch((e: unknown) => e);
      expect(error).toMatchObject({ feature: 'write-precondition' });
      expect(httpStatusHintOf(error)?.status).toBe(400);
    }
    expect(await store.findById<Article, string>('a', 'Article', own.id)).toMatchObject({
      title: 'mine',
    });
  });

  it('answers conditional-write (501) on a source without conditional writes, writing nothing', async () => {
    const { store } = await makeStore((source) => {
      const bare: Partial<DataSource> = { ...source };
      delete bare.updateWhere;
      delete bare.deleteWhere;
      return bare as DataSource;
    });
    const own = await store.create<Article>('a', 'Article', { title: 'mine', version: 1 });
    await expect(
      store.updateWhere('a', 'Article', own.id, { version: 1 }, { title: 'x' }),
    ).rejects.toMatchObject({ feature: 'conditional-write' });
    await expect(store.deleteWhere('a', 'Article', own.id, { version: 1 })).rejects.toMatchObject({
      feature: 'conditional-write',
    });
    expect(await store.findById<Article, string>('a', 'Article', own.id)).toMatchObject({
      title: 'mine',
    });
  });

  it('refuses a repository that has no conditional members by name', async () => {
    const bare = {
      getRepository: () => ({ findById: () => Promise.resolve(null) }),
    } as unknown as DatabaseService;
    const store = new DatabaseTenantDataStore(bare);
    await expect(
      store.updateWhere('a', 'Article', 'x', { version: 1 }, { t: 1 }),
    ).rejects.toMatchObject({
      feature: 'conditional-write',
    });
    await expect(store.deleteWhere('a', 'Article', 'x', { version: 1 })).rejects.toMatchObject({
      feature: 'conditional-write',
    });
  });

  it('serves updateVersioned and deleteVersioned through a tenant repository', async () => {
    const { store } = await makeStore();
    const repo = tenantRepo(store, 'a');
    const other = tenantRepo(store, 'b');
    const own = await repo.create({ title: 'draft', version: 1 });
    await expect(updateVersioned(repo, own.id, 1, { title: 'v2' })).resolves.toMatchObject({
      title: 'v2',
      version: 2,
    });
    await expect(updateVersioned(repo, own.id, 1, { title: 'late' })).rejects.toBeInstanceOf(
      VersionConflictError,
    );
    // Another tenant cannot see the row at all: not found, never a conflict.
    await expect(updateVersioned(other, own.id, 2, { title: 'x' })).rejects.toBeInstanceOf(
      EntityNotFoundError,
    );
    await deleteVersioned(repo, own.id, 2);
    expect(await repo.findById(own.id)).toBeNull();
  });
});
