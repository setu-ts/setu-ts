/**
 * Every row of the M107 §3.3 method table on the outbox bridge, over a real
 * memory `DatabaseService`: the query each read issues, the status each
 * transition writes from, and every missing / unexpected-status branch — the
 * conditional writes that keep a late failure from regressing a `sent` row.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { EntityKey, OutboxRecord } from '@setu-ts/common';
import { OUTBOX_RECORD_KIND } from '@setu-ts/common';
import type { IDatabaseService } from '../../../src/interfaces/index.ts';
import { DatabaseOutboxStore } from '../../../src/outbox/database-outbox-store.ts';
import {
  allRows,
  ENTITY,
  memoryService,
  record,
  recordingService,
  seed,
} from '../../fixtures/outbox-store.ts';
import type { RecordedCall } from '../../fixtures/outbox-store.ts';

/** Appends records through the bridge in one transaction. */
async function append(
  service: IDatabaseService,
  store: DatabaseOutboxStore,
  records: readonly OutboxRecord[],
): Promise<void> {
  await service.transaction(async (uow) => {
    for (const r of records) await store.append(uow, r);
  });
}

/** The stored row with `id`, read without the bridge. */
async function rowOf(service: IDatabaseService, id: string): Promise<Record<string, unknown>> {
  const row = await service.getRepository<Record<string, unknown>, EntityKey>(ENTITY).findById(
    id,
  );
  if (row === null) throw new Error(`no row ${id}`);
  return row;
}

describe('DatabaseOutboxStore — reads', () => {
  let service: IDatabaseService;
  let store: DatabaseOutboxStore;
  let calls: RecordedCall[];

  beforeEach(async () => {
    const inner = await memoryService();
    ({ service, calls } = recordingService(inner));
    store = new DatabaseOutboxStore(service, ENTITY);
  });

  it('append rejects a duplicate id with the adapter refusal', async () => {
    await append(service, store, [record(1)]);
    const refusal = await append(service, store, [record(1)]).catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(Error);
    expect((await allRows(service)).length).toBe(1);
  });

  it('scanPending reads pending rows in position order, limited, with no availableAt filter', async () => {
    await append(service, store, [
      record(3, { availableAt: Number.MAX_SAFE_INTEGER }),
      record(1),
      record(2, { status: 'sent', settledAt: 5 }),
      record(4),
    ]);
    calls.length = 0;

    const rows = await store.scanPending(undefined, 2);

    expect(rows.map((row) => row.id)).toEqual(['row-1', 'row-3']);
    expect(calls).toEqual([{
      method: 'findAll',
      args: [{
        where: { kind: OUTBOX_RECORD_KIND, status: 'pending' },
        orderBy: { position: 'asc' },
        limit: 2,
      }],
    }]);
  });

  it('scanPending with a cursor reads strictly after it', async () => {
    await append(service, store, [record(1), record(2), record(3)]);
    calls.length = 0;

    const rows = await store.scanPending(record(1).position, 10);

    expect(rows.map((row) => row.id)).toEqual(['row-2', 'row-3']);
    expect(calls[0].args[0]).toEqual({
      where: { kind: OUTBOX_RECORD_KIND, status: 'pending' },
      filter: { type: 'comparison', field: 'position', operator: 'gt', value: record(1).position },
      orderBy: { position: 'asc' },
      limit: 10,
    });
  });

  it('failedKeys selects only tenantId and orderingKey from failed rows', async () => {
    await append(service, store, [
      record(1, { status: 'failed', tenantId: 'acme', orderingKey: 'a' }),
      record(2, { status: 'failed' }),
      record(3, { status: 'failed', orderingKey: 'b' }),
      record(4, { orderingKey: 'pending-key' }),
    ]);
    calls.length = 0;

    const keys = await store.failedKeys(10);

    expect(keys).toEqual([{ tenantId: 'acme', orderingKey: 'a' }, {}, { orderingKey: 'b' }]);
    expect(calls).toEqual([{
      method: 'findAll',
      args: [{
        where: { kind: OUTBOX_RECORD_KIND, status: 'failed' },
        select: ['tenantId', 'orderingKey'],
        limit: 10,
      }],
    }]);
  });

  it('failedKeys honours its limit', async () => {
    await append(service, store, [
      record(1, { status: 'failed' }),
      record(2, { status: 'failed' }),
    ]);
    expect((await store.failedKeys(1)).length).toBe(1);
  });

  it('stats counts pending and failed and reads the oldest pending createdAt', async () => {
    await append(service, store, [
      record(2, { createdAt: 50 }),
      record(1, { createdAt: 70 }),
      record(3, { status: 'failed' }),
      record(4, { status: 'sent', settledAt: 1 }),
    ]);

    // Oldest by POSITION, not by createdAt: row-1 sorts first.
    expect(await store.stats()).toEqual({ pending: 2, failed: 1, oldestPendingCreatedAt: 70 });
  });

  it('stats omits the oldest pending age when nothing is pending', async () => {
    await append(service, store, [record(1, { status: 'failed' })]);
    const stats = await store.stats();
    expect(stats).toEqual({ pending: 0, failed: 1 });
    expect(Object.hasOwn(stats, 'oldestPendingCreatedAt')).toBe(false);
  });
});

describe('DatabaseOutboxStore — claims and invalid rows', () => {
  it('takes a version once, classifies lost, settled and missing claims, and preserves stale writes', async () => {
    const service = await memoryService();
    const store = new DatabaseOutboxStore(service, ENTITY);
    await append(service, store, [record(1), record(2, { status: 'sent' })]);
    expect(await store.claim('row-1', { claimVersion: 0, leaseUntil: 9000 })).toEqual({
      outcome: 'applied',
    });
    expect(await store.claim('row-1', { claimVersion: 0, leaseUntil: 10000 })).toEqual({
      outcome: 'claim-lost',
    });
    expect(await store.claim('row-2', { claimVersion: 0, leaseUntil: 9000 })).toEqual({
      outcome: 'not-pending',
      status: 'sent',
    });
    expect(await store.claim('missing', { claimVersion: 0, leaseUntil: 9000 })).toEqual({
      outcome: 'missing',
    });
    for (const deleteNow of [false, true]) {
      expect(
        await store.markSent('row-1', {
          claimVersion: 0,
          settledAt: 5,
          sentBy: 'stale',
          deleteNow,
        }),
      ).toEqual({ outcome: 'claim-lost' });
    }
    expect(
      await store.markFailure('row-1', {
        claimVersion: 0,
        attempts: 4,
        lastError: 'stale',
        availableAt: 5,
        status: 'failed',
      }),
    ).toEqual({ outcome: 'claim-lost' });
    expect(await rowOf(service, 'row-1')).toMatchObject({
      status: 'pending',
      claimVersion: 1,
      leaseUntil: 9000,
      attempts: 0,
    });
  });

  it('poisons malformed claim fields preserving attempts and clears the lease on retry', async () => {
    const service = await memoryService();
    const store = new DatabaseOutboxStore(service, ENTITY);
    await seed(service, [{ ...record(1), claimVersion: 'edited', attempts: 7, leaseUntil: 9000 }]);
    expect(await store.markInvalid('row-1', 5)).toEqual({ outcome: 'applied' });
    expect(await rowOf(service, 'row-1')).toMatchObject({
      status: 'failed',
      claimVersion: 'edited',
      attempts: 7,
      leaseUntil: 0,
      availableAt: 5,
      lastError: 'invalid-row',
    });
    expect(await store.markInvalid('row-1', 6)).toEqual({
      outcome: 'not-pending',
      status: 'failed',
    });
    expect(await store.markInvalid('missing', 6)).toEqual({ outcome: 'missing' });
    await store.release('row-1', 'retry', 7);
    expect(await rowOf(service, 'row-1')).toMatchObject({
      status: 'pending',
      claimVersion: 'edited',
      attempts: 0,
      leaseUntil: 0,
      availableAt: 7,
    });
  });
});

describe('DatabaseOutboxStore — markSent', () => {
  let service: IDatabaseService;
  let store: DatabaseOutboxStore;

  beforeEach(async () => {
    service = await memoryService();
    store = new DatabaseOutboxStore(service, ENTITY);
    await append(service, store, [
      record(1),
      record(2, { status: 'sent', settledAt: 3, sentBy: 'relay-a/dispatch' }),
      record(3, { status: 'failed' }),
      record(4, { status: 'discarded', settledAt: 3 }),
    ]);
  });

  it('marks a pending row sent', async () => {
    expect(
      await store.markSent('row-1', {
        claimVersion: 0,
        settledAt: 9,
        sentBy: 'r/scheduled',
        deleteNow: false,
      }),
    )
      .toEqual({ outcome: 'applied' });
    const row = await rowOf(service, 'row-1');
    expect(row).toMatchObject({ status: 'sent', settledAt: 9, sentBy: 'r/scheduled' });
  });

  it('deletes a pending row when deleteNow is set', async () => {
    expect(
      await store.markSent('row-1', {
        claimVersion: 0,
        settledAt: 9,
        sentBy: 'r/scheduled',
        deleteNow: true,
      }),
    )
      .toEqual({ outcome: 'applied' });
    expect((await allRows(service)).map((row) => row.id)).not.toContain('row-1');
  });

  it('answers missing for an absent row and writes nothing', async () => {
    const before = await allRows(service);
    expect(
      await store.markSent('nope', {
        claimVersion: 0,
        settledAt: 9,
        sentBy: 'r/scheduled',
        deleteNow: false,
      }),
    )
      .toEqual({ outcome: 'missing' });
    expect(await allRows(service)).toEqual(before);
  });

  it('answers not-pending for a sent row and preserves its diagnostic and leaves it sent', async () => {
    expect(
      await store.markSent('row-2', {
        claimVersion: 0,
        settledAt: 9,
        sentBy: 'r/scheduled',
        deleteNow: false,
      }),
    )
      .toEqual({ outcome: 'not-pending', status: 'sent' });
    expect(await rowOf(service, 'row-2')).toMatchObject({
      settledAt: 3,
      sentBy: 'relay-a/dispatch',
    });
  });

  it('answers not-pending without sentBy for failed and discarded rows', async () => {
    for (const [id, status] of [['row-3', 'failed'], ['row-4', 'discarded']] as const) {
      const outcome = await store.markSent(id, {
        claimVersion: 0,
        settledAt: 9,
        sentBy: 'r',
        deleteNow: true,
      });
      expect(outcome).toEqual({ outcome: 'not-pending', status });
      expect(Object.hasOwn(outcome, 'sentBy')).toBe(false);
      expect((await rowOf(service, id)).status).toBe(status);
    }
  });

  it('answers missing when the row vanishes between the read and the delete', async () => {
    const vanishing: IDatabaseService = {
      ...service,
      getRepository: <E, Id extends EntityKey = string>(entity: string) => {
        const repo = service.getRepository<E, Id>(entity);
        return {
          ...repo,
          findById: repo.findById.bind(repo),
          deleteWhere: async (id: Id) => {
            await repo.delete(id);
            return false;
          },
        };
      },
    };
    const racing = new DatabaseOutboxStore(vanishing, ENTITY);
    expect(
      await racing.markSent('row-1', {
        claimVersion: 0,
        settledAt: 9,
        sentBy: 'r',
        deleteNow: true,
      }),
    )
      .toEqual({ outcome: 'missing' });
  });
});

describe('DatabaseOutboxStore — markFailure', () => {
  let service: IDatabaseService;
  let store: DatabaseOutboxStore;

  beforeEach(async () => {
    service = await memoryService();
    store = new DatabaseOutboxStore(service, ENTITY);
    await append(service, store, [
      record(1),
      record(2, { status: 'sent', settledAt: 3, sentBy: 'relay-a/scheduled' }),
    ]);
  });

  for (const status of ['pending', 'failed'] as const) {
    it(`records a failure on a pending row and sets status ${status}`, async () => {
      expect(
        await store.markFailure('row-1', {
          claimVersion: 0,
          attempts: 2,
          lastError: 'broker down',
          availableAt: 77,
          status,
        }),
      ).toEqual({ outcome: 'applied' });
      expect(await rowOf(service, 'row-1')).toMatchObject({
        attempts: 2,
        lastError: 'broker down',
        availableAt: 77,
        status,
      });
    });
  }

  it('never regresses a sent row: a late failure writes nothing', async () => {
    expect(
      await store.markFailure('row-2', {
        claimVersion: 0,
        attempts: 1,
        lastError: 'late',
        availableAt: 77,
        status: 'pending',
      }),
    ).toEqual({ outcome: 'not-pending', status: 'sent' });
    const row = await rowOf(service, 'row-2');
    expect(row.status).toBe('sent');
    expect(row.lastError).toBeNull();
  });

  it('answers missing for an absent row', async () => {
    expect(
      await store.markFailure('nope', {
        claimVersion: 0,
        attempts: 1,
        lastError: 'x',
        availableAt: 1,
        status: 'pending',
      }),
    ).toEqual({ outcome: 'missing' });
  });
});

describe('DatabaseOutboxStore — release', () => {
  let service: IDatabaseService;
  let store: DatabaseOutboxStore;

  beforeEach(async () => {
    service = await memoryService();
    store = new DatabaseOutboxStore(service, ENTITY);
    await append(service, store, [
      record(1, { status: 'failed', attempts: 10, lastError: 'gave up' }),
      record(2, { status: 'failed', attempts: 10 }),
      record(3),
    ]);
  });

  it('retry returns a failed row to pending with attempts reset and availableAt now', async () => {
    expect(await store.release('row-1', 'retry', 500)).toEqual({ outcome: 'applied' });
    expect(await rowOf(service, 'row-1')).toMatchObject({
      status: 'pending',
      attempts: 0,
      availableAt: 500,
    });
  });

  it('discard settles a failed row as discarded at now', async () => {
    expect(await store.release('row-2', 'discard', 600)).toEqual({ outcome: 'applied' });
    expect(await rowOf(service, 'row-2')).toMatchObject({ status: 'discarded', settledAt: 600 });
  });

  it('answers not-failed for a row that is not failed and writes nothing', async () => {
    expect(await store.release('row-3', 'discard', 600)).toEqual({
      outcome: 'not-failed',
      status: 'pending',
    });
    expect((await rowOf(service, 'row-3')).status).toBe('pending');
  });

  it('answers missing for an absent row', async () => {
    expect(await store.release('nope', 'retry', 1)).toEqual({ outcome: 'missing' });
  });
});

describe('DatabaseOutboxStore — purge', () => {
  let service: IDatabaseService;
  let store: DatabaseOutboxStore;

  beforeEach(async () => {
    service = await memoryService();
    store = new DatabaseOutboxStore(service, ENTITY);
    await append(service, store, [
      record(1, { status: 'sent', settledAt: 10 }),
      record(2, { status: 'sent', settledAt: 20 }),
      record(3, { status: 'sent', settledAt: 500 }),
      record(4, { status: 'discarded', settledAt: 10 }),
      record(5, { status: 'failed' }),
      record(6),
    ]);
  });

  it('deletes sent and discarded rows settled before the cut-off; never failed or pending', async () => {
    expect(await store.purge(100, 10)).toBe(3);
    expect((await allRows(service)).map((row) => row.id).sort()).toEqual([
      'row-3',
      'row-5',
      'row-6',
    ]);
  });

  it('bounds deletes per status by limit', async () => {
    expect(await store.purge(100, 1)).toBe(2);
    const ids = (await allRows(service)).map((row) => row.id);
    expect(ids).not.toContain('row-4');
    expect(ids.filter((id) => id === 'row-1' || id === 'row-2').length).toBe(1);
  });

  it('counts a row already gone as zero', async () => {
    const gone: IDatabaseService = {
      ...service,
      getRepository: <E, Id extends EntityKey = string>(entity: string) => {
        const repo = service.getRepository<E, Id>(entity);
        return { ...repo, findAll: repo.findAll.bind(repo), delete: () => Promise.resolve(false) };
      },
    };
    expect(await new DatabaseOutboxStore(gone, ENTITY).purge(100, 10)).toBe(0);
  });

  it('a delete rejecting midway keeps the rows already deleted', async () => {
    let deletes = 0;
    const failing: IDatabaseService = {
      ...service,
      getRepository: <E, Id extends EntityKey = string>(entity: string) => {
        const repo = service.getRepository<E, Id>(entity);
        return {
          ...repo,
          findAll: repo.findAll.bind(repo),
          delete: (id: Id) => {
            deletes += 1;
            return deletes === 2 ? Promise.reject(new Error('store down')) : repo.delete(id);
          },
        };
      },
    };
    const refusal = await new DatabaseOutboxStore(failing, ENTITY).purge(100, 10).catch((
      e: unknown,
    ) => e);
    expect((refusal as Error).message).toBe('store down');
    expect((await allRows(service)).length).toBe(5);
  });
});

describe('DatabaseOutboxStore — a status outside the vocabulary', () => {
  it('rejects every transition rather than throwing, and does not quote the value', async () => {
    const service = await memoryService();
    const store = new DatabaseOutboxStore(service, ENTITY);
    await seed(service, [{ ...record(1), status: 'secret-status' }]);

    const pending = store.markSent('row-1', {
      claimVersion: 0,
      settledAt: 1,
      sentBy: 'r',
      deleteNow: false,
    });
    expect(pending).toBeInstanceOf(Promise);
    const refusal = await pending.catch((e: unknown) => e);
    expect(refusal).toBeInstanceOf(TypeError);
    expect((refusal as Error).message).not.toContain('secret-status');
    await expect(store.release('row-1', 'retry', 1)).rejects.toThrow(TypeError);
    await expect(
      store.markFailure('row-1', {
        claimVersion: 0,
        attempts: 1,
        lastError: 'x',
        availableAt: 1,
        status: 'failed',
      }),
    ).rejects.toThrow(TypeError);
  });

  it('treats a non-string status as unrecognized too', async () => {
    const service = await memoryService();
    const store = new DatabaseOutboxStore(service, ENTITY);
    await seed(service, [{ ...record(1), status: 7 }]);
    await expect(store.release('row-1', 'retry', 1)).rejects.toThrow('unrecognized status');
  });
});
