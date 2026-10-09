import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ENTITY, idsFor, marker, memoryService, storeOver } from '../fixtures/inbox-store.ts';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import { DatabaseService } from '../../src/services/database-service.ts';
const failure = { consumer: 'payroll', topic: 'people.hired.v1', lastError: 'boom', now: 50 };

describe('inbox conditional transitions', () => {
  it('two concurrent failures retain both increments through the attempts predicate', async () => {
    const service = await memoryService();
    const store = storeOver(service);
    const ids = idsFor('a');
    await store.recordFailure(ids, failure);
    expect(
      (await Promise.all([store.recordFailure(ids, failure), store.recordFailure(ids, failure)]))
        .sort(),
    ).toEqual([2, 3]);
    expect(await service.getRepository(ENTITY).findById(ids.attempts)).toMatchObject({
      attempts: 3,
    });
  });
  it('bounds attempts contention at five rounds, and refuses vanished attempts', async () => {
    for (const vanished of [false, true]) {
      const adapter = new MemoryAdapter();
      const source = adapter.createDataSource(ENTITY);
      let calls = 0;
      const service = new DatabaseService(adapter, () => ({
        ...source,
        updateWhere: async (id) => {
          calls++;
          if (vanished) await source.delete(id);
          return null;
        },
      }), 'memory');
      const ids = idsFor('a');
      await source.create({
        ...marker('a', { status: 'attempting', attempts: 1 }),
        id: ids.attempts,
      });
      await expect(storeOver(service).recordFailure(ids, failure)).rejects.toThrow(/contention/);
      expect(calls).toBe(vanished ? 1 : 5);
    }
  });
  for (const action of ['retry', 'discard'] as const) {
    it(`${action}: a concurrent release preserves the winner and the attempts row`, async () => {
      const adapter = new MemoryAdapter();
      const source = adapter.createDataSource(ENTITY);
      const ids = idsFor('a');
      await source.create({ ...marker('a', { status: 'parked' }) });
      await source.create({
        ...marker('a', { status: 'attempting', attempts: 2 }),
        id: ids.attempts,
      });
      const race = async () => {
        await source.update(ids.marker, { status: 'processed' });
      };
      const service = new DatabaseService(
        adapter,
        () => ({
          ...source,
          updateWhere: async (id, where, data) => {
            await race();
            return source.updateWhere!(id, where, data);
          },
          deleteWhere: async (id, where) => {
            await race();
            return source.deleteWhere!(id, where);
          },
        }),
        'memory',
      );
      expect(await storeOver(service).release(ids, action, 99)).toEqual({
        outcome: 'not-parked',
        status: 'processed',
      });
      expect(await source.findById(ids.attempts)).toMatchObject({ attempts: 2 });
      expect(await source.findById(ids.marker)).toMatchObject({ status: 'processed' });
    });
  }
  it('release reports disappearance and rejects unexplained contention', async () => {
    for (const vanished of [false, true]) {
      const adapter = new MemoryAdapter();
      const source = adapter.createDataSource(ENTITY);
      const ids = idsFor('a');
      await source.create({ ...marker('a', { status: 'parked' }) });
      const service = new DatabaseService(adapter, () => ({
        ...source,
        deleteWhere: async (id) => {
          if (vanished) await source.delete(id);
          return false;
        },
      }), 'memory');
      const result = storeOver(service).release(ids, 'retry', 99);
      if (vanished) expect(await result).toEqual({ outcome: 'missing' });
      else await expect(result).rejects.toThrow(/contention/);
    }
  });
});
