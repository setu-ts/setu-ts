import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ENTITY, record } from '../fixtures/outbox-store.ts';
import { MemoryAdapter } from '../../src/adapters/memory/memory-adapter.ts';
import { DatabaseService } from '../../src/services/database-service.ts';
import { DatabaseOutboxStore } from '../../src/outbox/database-outbox-store.ts';
import { OutboxStoreUnavailableError } from '../../src/outbox/errors.ts';

describe('outbox conditional transitions', () => {
  for (const deletion of [false, true]) {
    it(`classifies a native version miss without overwriting the claim (delete=${deletion})`, async () => {
      const adapter = new MemoryAdapter();
      const source = adapter.createDataSource(ENTITY);
      await source.create({ ...record(1) });
      const service = new DatabaseService(adapter, () => ({
        ...source,
        updateWhere: async (id, where, data) => {
          await source.update(id, { claimVersion: 2, leaseUntil: 999 });
          return source.updateWhere!(id, where, data);
        },
        deleteWhere: async (id, where) => {
          await source.update(id, { claimVersion: 2, leaseUntil: 999 });
          return source.deleteWhere!(id, where);
        },
      }), 'memory');
      expect(
        await new DatabaseOutboxStore(service, ENTITY).markSent('row-1', {
          claimVersion: 1,
          settledAt: 10,
          sentBy: 'stale',
          deleteNow: deletion,
        }),
      ).toEqual({ outcome: 'claim-lost' });
      expect(await source.findById('row-1')).toMatchObject({
        status: 'pending',
        claimVersion: 2,
        leaseUntil: 999,
      });
    });
  }

  it('refuses absent native writes before initialization instead of falling back', async () => {
    const adapter = new MemoryAdapter();
    const source = adapter.createDataSource(ENTITY);
    await source.create({ ...record(1) });
    const unsupported = { ...source };
    delete unsupported.updateWhere;
    delete unsupported.deleteWhere;
    const service = new DatabaseService(adapter, () => unsupported, 'memory');
    const store = new DatabaseOutboxStore(service, ENTITY);
    for (const deleteNow of [false, true]) {
      const refusal = await store.markSent('row-1', {
        claimVersion: 0,
        settledAt: 10,
        sentBy: 'r',
        deleteNow,
      }).catch((error: unknown) => error);
      expect(refusal).toBeInstanceOf(OutboxStoreUnavailableError);
      expect((refusal as OutboxStoreUnavailableError).reason).toBe(
        'conditional-writes-unsupported',
      );
      expect(await source.findById('row-1')).toMatchObject({ status: 'pending', claimVersion: 0 });
    }
  });
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
          claimVersion: 0,
          attempts: 1,
          lastError: 'late',
          availableAt: 99,
          status: 'failed',
        })
        : await store.markSent('row-1', {
          claimVersion: 0,
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
        claimVersion: 0,
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
