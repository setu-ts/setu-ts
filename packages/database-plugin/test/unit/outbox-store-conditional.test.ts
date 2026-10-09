import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ENTITY, record } from '../fixtures/outbox-store.ts';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import { DatabaseService } from '../../src/services/database-service.ts';
import { DatabaseOutboxStore } from '../../src/outbox/database-outbox-store.ts';

describe('outbox conditional transitions', () => {
  for (const operation of ['sent', 'failure', 'release', 'delete'] as const) {
    it(`${operation}: rechecks status after an atomic miss and preserves a concurrent winner`, async () => {
      const adapter = new MemoryAdapter();
      const source = adapter.createDataSource(ENTITY);
      await source.create({
        ...record(1, { status: operation === 'release' ? 'failed' : 'pending' }),
      });
      const race = async () => {
        await source.update('row-1', { status: 'sent', sentBy: 'winner' });
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
      const store = new DatabaseOutboxStore(service, ENTITY);
      const result = operation === 'release'
        ? await store.release('row-1', 'retry', 99)
        : operation === 'failure'
        ? await store.markFailure('row-1', {
          attempts: 1,
          lastError: 'late',
          availableAt: 99,
          status: 'failed',
        })
        : await store.markSent('row-1', {
          settledAt: 99,
          sentBy: 'loser',
          deleteNow: operation === 'delete',
        });
      expect(result).toMatchObject({
        outcome: operation === 'release' ? 'not-failed' : 'not-pending',
        status: 'sent',
      });
      expect(await source.findById('row-1')).toMatchObject({
        status: 'sent',
        sentBy: 'winner',
        attempts: 0,
      });
    });
  }
  it('retries an unexplained miss at most three rounds and reports a vanished row', async () => {
    for (const vanished of [false, true]) {
      const adapter = new MemoryAdapter();
      const source = adapter.createDataSource(ENTITY);
      await source.create({ ...record(1) });
      let calls = 0;
      const service = new DatabaseService(adapter, () => ({
        ...source,
        updateWhere: async (id) => {
          calls++;
          if (vanished) await source.delete(id);
          return null;
        },
      }), 'memory');
      const result = new DatabaseOutboxStore(service, ENTITY).markSent('row-1', {
        settledAt: 99,
        sentBy: 'r',
        deleteNow: false,
      });
      if (vanished) expect(await result).toEqual({ outcome: 'missing' });
      else await expect(result).rejects.toThrow(/contention/);
      expect(calls).toBe(vanished ? 1 : 3);
    }
  });
});
