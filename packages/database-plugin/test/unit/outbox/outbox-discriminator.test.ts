/**
 * The discriminator rule (M107 §3.2, design finding D12, audit obligation 5):
 * business documents in the SAME entity as outbox rows — carrying
 * `status: 'pending'`, `'sent'` and `'failed'`, an old `settledAt`, and even an
 * outbox-shaped `position` — are never returned, counted, transitioned or
 * purged by any store method. Driven on a real memory `DatabaseService`.
 *
 * @module
 */
import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDatabaseService } from '../../../src/interfaces/index.ts';
import { DatabaseOutboxStore } from '../../../src/outbox/database-outbox-store.ts';
import { allRows, ENTITY, memoryService, record, seed } from '../../fixtures/outbox-store.ts';

/** Business documents shaped as closely to outbox rows as a collision allows. */
const BUSINESS = [
  // Sorts BEFORE every outbox row, so a missing discriminator would surface it first.
  { ...record(0), id: 'biz-pending', kind: 'order', status: 'pending', tenantId: 'acme' },
  { ...record(0), id: 'biz-sent', kind: 'order', status: 'sent', settledAt: 1 },
  { ...record(0), id: 'biz-failed', kind: 'order', status: 'failed', orderingKey: 'k' },
  { ...record(0), id: 'biz-discarded', kind: 'order', status: 'discarded', settledAt: 1 },
  // A document with no kind at all.
  { id: 'biz-plain', status: 'pending', position: '0', createdAt: 0, settledAt: 1 },
];

describe('DatabaseOutboxStore — the discriminator', () => {
  let service: IDatabaseService;
  let store: DatabaseOutboxStore;

  beforeEach(async () => {
    service = await memoryService();
    store = new DatabaseOutboxStore(service, ENTITY);
    await seed(service, BUSINESS);
    await service.transaction(async (uow) => {
      await store.append(uow, record(1));
      await store.append(uow, record(2, { status: 'failed', orderingKey: 'outbox-key' }));
    });
  });

  it('scanPending returns only outbox rows', async () => {
    const rows = await store.scanPending(undefined, 100);
    expect(rows.map((row) => row.id)).toEqual(['row-1']);
  });

  it('failedKeys returns only outbox rows', async () => {
    expect(await store.failedKeys(100)).toEqual([{ orderingKey: 'outbox-key' }]);
  });

  it('stats counts only outbox rows', async () => {
    expect(await store.stats()).toEqual({
      pending: 1,
      failed: 1,
      oldestPendingCreatedAt: record(1).createdAt,
    });
  });

  it('every transition treats a business document as missing and writes nothing', async () => {
    const before = await allRows(service);

    for (const id of ['biz-pending', 'biz-sent', 'biz-failed', 'biz-plain']) {
      expect(await store.claim(id, { claimVersion: 0, leaseUntil: 9 })).toEqual({
        outcome: 'missing',
      });
      expect(await store.markInvalid(id, 9)).toEqual({ outcome: 'missing' });
      expect(
        await store.markSent(id, {
          claimVersion: 0,
          settledAt: 9,
          sentBy: 'r/scheduled',
          deleteNow: false,
        }),
      )
        .toEqual({ outcome: 'missing' });
      expect(
        await store.markSent(id, {
          claimVersion: 0,
          settledAt: 9,
          sentBy: 'r/scheduled',
          deleteNow: true,
        }),
      )
        .toEqual({ outcome: 'missing' });
      expect(
        await store.markFailure(id, {
          claimVersion: 0,
          attempts: 1,
          lastError: 'x',
          availableAt: 9,
          status: 'failed',
        }),
      ).toEqual({ outcome: 'missing' });
      expect(await store.release(id, 'retry', 9)).toEqual({ outcome: 'missing' });
      expect(await store.release(id, 'discard', 9)).toEqual({ outcome: 'missing' });
    }

    expect(await allRows(service)).toEqual(before);
  });

  it('purge never deletes a business document, however old its settledAt', async () => {
    await store.markSent('row-1', {
      claimVersion: 0,
      settledAt: 5,
      sentBy: 'r/scheduled',
      deleteNow: false,
    });

    expect(await store.purge(Number.MAX_SAFE_INTEGER, 100)).toBe(1);

    const remaining = (await allRows(service)).map((row) => row.id).sort();
    expect(remaining).toEqual([
      'biz-discarded',
      'biz-failed',
      'biz-pending',
      'biz-plain',
      'biz-sent',
      'row-2',
    ]);
  });
});
