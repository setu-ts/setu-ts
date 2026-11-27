import { describe, expect, it } from 'vitest';
import { httpStatusHintOf } from '@setu-ts/common';
import { BaseRepository } from '../../src/repositories/base-repository.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import type { UnsupportedQueryFeatureError } from '../../src/errors.ts';
import { DatabaseService, DrizzleRepository, PrismaRepository } from '../../src/index.ts';
import type { DatabaseAdapterType } from '../../src/interfaces/index.ts';
import type { IDatabaseAdapter } from '@setu-ts/common';

class TestRepo extends BaseRepository<Record<string, unknown>> {
  constructor(source: DataSource, adapterType?: DatabaseAdapterType) {
    super(source, adapterType);
  }
}
describe('BaseRepository conditional writes', () => {
  it('names the bound adapter on direct, service and transaction repositories, with a standalone fallback', async () => {
    const source = { ...new MemoryAdapter().createDataSource('Item') };
    delete source.updateWhere;
    delete source.deleteWhere;
    const adapter: IDatabaseAdapter = {
      connect: () => Promise.resolve(),
      disconnect: () => Promise.resolve(),
      isReady: () => true,
      createDataSource: () => source,
      rawQuery: () => Promise.resolve([]),
      beginTransaction: () =>
        Promise.resolve({
          createDataSource: () => source,
          commit: () => Promise.resolve(),
          rollback: () => Promise.resolve(),
        }),
    };
    const assert = async (repo: BaseRepository<Record<string, unknown>>, name: string) => {
      for (const call of [
        () => repo.updateWhere('key', { version: 1 }, { value: 2 }),
        () => repo.deleteWhere('key', { version: 1 }),
      ]) {
        const error = await call().catch((error: unknown) => error);
        expect(error).toHaveProperty('adapter', name);
        expect(httpStatusHintOf(error)?.detail).toContain(`'${name}'`);
      }
    };
    await assert(new TestRepo(source), 'database-plugin');
    await assert(new PrismaRepository(source), 'prisma');
    await assert(new DrizzleRepository(source), 'drizzle');
    await assert(new PrismaRepository(source, 'custom'), 'custom');
    await assert(new DrizzleRepository(source, 'custom'), 'custom');
    for (const type of [
      'custom',
      'memory',
      'prisma',
      'drizzle',
      'mongodb',
      'dynamodb',
      'cosmos',
      'bigtable',
    ] as const) {
      const db = new DatabaseService(adapter, () => source, type);
      await assert(db.getRepository('Item') as BaseRepository<Record<string, unknown>>, type);
      await db.transaction((uow) =>
        assert(uow.getRepository('Item') as BaseRepository<Record<string, unknown>>, type),
      );
    }
  });
  it('delegates matches and misses', async () => {
    const repo = new TestRepo(new MemoryAdapter().createDataSource('User'));
    await repo.create({ id: 'a', n: 1 });
    expect(await repo.updateWhere('a', { n: 1 }, { n: 2 })).toEqual({ id: 'a', n: 2 });
    expect(await repo.updateWhere('a', { n: 1 }, { n: 3 })).toBeNull();
    expect(await repo.deleteWhere('a', { n: 1 })).toBe(false);
    expect(await repo.deleteWhere('a', { n: 2 })).toBe(true);
  });
  it('rejects before I/O with distinct validation and unsupported brands', async () => {
    const source = new MemoryAdapter().createDataSource('User');
    const legacy = { ...source };
    delete legacy.updateWhere;
    delete legacy.deleteWhere;
    let io = 0;
    legacy.findById = () => {
      io++;
      return Promise.resolve(null);
    };
    legacy.update = () => {
      io++;
      return Promise.reject(new Error('unexpected write'));
    };
    legacy.delete = () => {
      io++;
      return Promise.resolve(false);
    };
    const repo = new TestRepo(legacy);
    for (const call of [
      () => repo.updateWhere('a', { n: 1 }, { n: 2 }),
      () => repo.deleteWhere('a', { n: 1 }),
    ]) {
      let promise: Promise<unknown> | undefined;
      expect(() => {
        promise = call();
      }).not.toThrow();
      const error = (await promise!.catch(
        (error: unknown) => error,
      )) as UnsupportedQueryFeatureError;
      expect(error.feature).toBe('conditional-write');
      expect(httpStatusHintOf(error)?.status).toBe(501);
    }
    for (const promise of [repo.updateWhere('a', {}, { n: 2 }), repo.deleteWhere('a', {})]) {
      const error = (await promise.catch(
        (error: unknown) => error,
      )) as UnsupportedQueryFeatureError;
      expect(error.feature).toBe('write-precondition');
      // Caller input since M128: 400 with a fixed detail, never the masked 500.
      expect(httpStatusHintOf(error)).toEqual({
        status: 400,
        title: 'Bad Request',
        detail: 'The write precondition or its payload is invalid.',
      });
    }
    expect(await source.findById('a')).toBeNull();
    expect(io).toBe(0);
  });
});
