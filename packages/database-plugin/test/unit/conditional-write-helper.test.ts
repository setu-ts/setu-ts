import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { conditionalDelete, conditionalUpdate } from '../../src/repositories/conditional-write.ts';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import { UnsupportedQueryFeatureError } from '../../src/errors.ts';
import { BaseRepository } from '../../src/repositories/base-repository.ts';
import type { DataSource } from '../../src/repositories/base-repository.ts';
class Repo extends BaseRepository<Record<string, unknown>> {
  constructor(ds: DataSource) {
    super(ds);
  }
}
describe('conditional fallback helper', () => {
  it('maps both outcomes and both forms of unsupported', async () => {
    const source = new MemoryAdapter().createDataSource('User');
    const repo = new Repo(source);
    await repo.create({ id: 'a', n: 1 });
    expect(await conditionalUpdate(repo, 'a', { n: 1 }, { n: 2 })).toEqual({
      outcome: 'applied',
      row: { id: 'a', n: 2 },
    });
    expect(await conditionalUpdate(repo, 'a', { n: 1 }, { n: 3 })).toEqual({
      outcome: 'not-matched',
    });
    expect(await conditionalDelete(repo, 'a', { n: 1 })).toEqual({ outcome: 'not-matched' });
    expect(await conditionalDelete(repo, 'a', { n: 2 })).toEqual({ outcome: 'applied' });
    for (const absent of [false, true]) {
      const error = new UnsupportedQueryFeatureError(
        'conditional-write',
        'database-plugin',
        'missing member',
      );
      const legacy = new Repo(source);
      Object.defineProperty(legacy, 'updateWhere', {
        value: absent ? undefined : () => Promise.reject(error),
      });
      Object.defineProperty(legacy, 'deleteWhere', {
        value: absent ? undefined : () => Promise.reject(error),
      });
      expect(await conditionalUpdate(legacy, 'a', { n: 1 }, { n: 2 })).toEqual({
        outcome: 'unsupported',
      });
      expect(await conditionalDelete(legacy, 'a', { n: 1 })).toEqual({ outcome: 'unsupported' });
    }
  });
  it('propagates write-precondition and every other rejection without falling back', async () => {
    for (
      const error of [
        new UnsupportedQueryFeatureError('write-precondition', 'database-plugin', 'invalid'),
        new Error('driver'),
      ]
    ) {
      const repo = new Repo(new MemoryAdapter().createDataSource('User'));
      repo.updateWhere = () => Promise.reject(error);
      repo.deleteWhere = () => Promise.reject(error);
      await expect(conditionalUpdate(repo, 'a', { n: 1 }, { n: 2 })).rejects.toBe(error);
      await expect(conditionalDelete(repo, 'a', { n: 1 })).rejects.toBe(error);
    }
  });
});
