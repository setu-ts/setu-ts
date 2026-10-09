import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { httpStatusHintOf } from '@setu-ts/common';
import { BaseRepository } from '../../src/repositories/base-repository.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import type { UnsupportedQueryFeatureError } from '../../src/errors.ts';

class TestRepo extends BaseRepository<Record<string, unknown>> {
  constructor(source: DataSource) {
    super(source);
  }
}
describe('BaseRepository conditional writes', () => {
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
    const { updateWhere: _u, deleteWhere: _d, ...legacy } = source;
    const repo = new TestRepo(legacy);
    for (
      const call of [
        () => repo.updateWhere('a', { n: 1 }, { n: 2 }),
        () => repo.deleteWhere('a', { n: 1 }),
      ]
    ) {
      let promise: Promise<unknown> | undefined;
      expect(() => {
        promise = call();
      }).not.toThrow();
      const error = await promise!.catch((error: unknown) => error) as UnsupportedQueryFeatureError;
      expect(error.feature).toBe('conditional-write');
      expect(httpStatusHintOf(error)?.status).toBe(501);
    }
    for (const promise of [repo.updateWhere('a', {}, { n: 2 }), repo.deleteWhere('a', {})]) {
      const error = await promise.catch((error: unknown) => error) as UnsupportedQueryFeatureError;
      expect(error.feature).toBe('write-precondition');
      expect(httpStatusHintOf(error)).toBeUndefined();
    }
    expect(await source.findById('a')).toBeNull();
  });
});
