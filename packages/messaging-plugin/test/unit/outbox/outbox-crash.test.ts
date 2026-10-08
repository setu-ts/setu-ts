/**
 * The unit-testable rows of the §3.13 crash table, over the real memory-backed
 * bridge: a fault is injected at a named call, then a NEW outbox instance over
 * the same table — a restarted process — runs the relay. The plugin-level
 * shutdown row and the real-backend repeats are separate suites.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { EntityKey } from '@setu-ts/common';

import {
  countingObserver,
  ENTITY,
  flush,
  orderPlaced,
  outboxClock,
  outboxHarness,
  row,
  rows,
} from '../../fixtures/outbox.ts';
import type { OutboxHarness } from '../../fixtures/outbox.ts';

/** A restarted process: a fresh outbox over the same table and broker. */
function restart(h: OutboxHarness, observer = countingObserver()): Promise<OutboxHarness> {
  return outboxHarness({
    shared: { db: h.db, store: h.store },
    broker: h.broker,
    clock: outboxClock(0x200000),
    observer,
  });
}

describe('the crash table', () => {
  it('before commit: nothing written, nothing published', async () => {
    const h = await outboxHarness();
    await expect(
      h.db.transaction(async (uow) => {
        await h.service.write(uow, orderPlaced, { n: 1 });
        throw new Error('crash before commit');
      }),
    ).rejects.toThrow('crash before commit');
    await h.sweep();
    expect(await rows(h.db)).toEqual([]);
    expect(h.broker.calls).toEqual([]);
  });

  it('after commit, before any sweep: a new process publishes it', async () => {
    const h = await outboxHarness();
    await h.write({ n: 1 });
    const next = await restart(h);
    await next.sweep();
    expect(h.broker.sequence()).toEqual([1]);
  });

  it('stop after the second publish: marked rows stay sent, the unmarked one is republished, the rest follow in order', async () => {
    const h = await outboxHarness();
    for (let n = 1; n <= 4; n++) await h.write({ key: 'K', n });
    let marks = 0;
    h.store.faults.markSent = () => {
      marks += 1;
      // The process dies while marking the second published row.
      return marks === 2 ? new Promise<void>(() => {}) : undefined;
    };
    void h.sweep();
    await flush();
    expect(h.broker.sequence()).toEqual([1, 2]);
    delete h.store.faults.markSent;
    const next = await restart(h);
    await next.sweep();
    expect(h.broker.sequence()).toEqual([1, 2, 2, 3, 4]);
    expect((await rows(h.db)).every((r) => r.status === 'sent')).toBe(true);
  });

  it('markSent never runs: the next lap publishes it again with the same envelope id', async () => {
    const h = await outboxHarness();
    const id = await h.write({ n: 1 });
    h.store.faults.markSent = () => new Promise<void>(() => {});
    void h.sweep();
    await flush();
    delete h.store.faults.markSent;
    const next = await restart(h);
    await next.sweep();
    expect(h.broker.published.map((p) => p.message.id)).toEqual([id, id]);
    expect(h.broker.published.map((p) => p.options?.deduplicationId)).toEqual([id, id]);
    expect((await row(h.db, id))!.status).toBe('sent');
  });

  it('markSent on a row already deleted: missing, nothing written, not an overlap', async () => {
    const observer = countingObserver();
    const h = await outboxHarness({ observer });
    const id = await h.write({ n: 1 });
    h.store.faults.markSent = async () => {
      await h.db.getRepository<Record<string, unknown>, EntityKey>(ENTITY).delete(id);
    };
    const result = await h.sweep();
    expect(result.published).toBe(1);
    expect(result.endedBy).toBe('complete');
    expect(await rows(h.db)).toEqual([]);
    expect(observer.counts).toEqual({ published: 1 });
  });

  it('purge rejects midway: rows deleted so far stay deleted, the rest go next run', async () => {
    const h = await outboxHarness({ options: { retainSentMs: 1 } });
    for (let n = 1; n <= 3; n++) await h.write({ n });
    await h.sweep();
    h.clock.advanceWall(10);
    // Interpose on the database the bridge reads through: its second delete
    // rejects, as a store failing midway would.
    let deletes = 0;
    const database = h.db as { getRepository: typeof h.db.getRepository };
    const getRepository = database.getRepository.bind(h.db);
    database.getRepository = (<E, Id extends EntityKey>(entity: string) => {
      const inner = getRepository<E, Id>(entity);
      return Object.assign(Object.create(inner), {
        delete: (key: Id) => {
          deletes += 1;
          return deletes === 2 ? Promise.reject(new Error('store down')) : inner.delete(key);
        },
      });
    }) as typeof h.db.getRepository;
    await expect(h.service.purge()).rejects.toThrow('store down');
    database.getRepository = getRepository;
    expect(await rows(h.db)).toHaveLength(2);
    expect(await h.service.purge()).toBe(2);
    expect(await rows(h.db)).toEqual([]);
  });
});
