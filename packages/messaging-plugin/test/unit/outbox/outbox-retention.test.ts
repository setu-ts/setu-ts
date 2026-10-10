/**
 * Retention (M107 §3.14): `purge()` deletes `sent` and `discarded` rows
 * settled before `now - retainSentMs`, at most `purgeBatch` per status, and
 * never a `failed` or `pending` row; a sweep never purges; `retainSentMs: 0`
 * deletes a row at mark-sent.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { resolveOutboxOptions } from '../../../src/outbox/options.ts';
import { OutboxService } from '../../../src/outbox/outbox-service.ts';
import {
  edit,
  flush,
  memoryOutbox,
  outboxHarness,
  row,
  rows,
  WALL_START,
} from '../../fixtures/outbox.ts';

describe('outbox retention', () => {
  it('immediate retention deletes only at the held version', async () => {
    const h = await outboxHarness({ options: { retainSentMs: 0 } });
    const id = await h.write({ n: 1 });
    h.broker.behaviour = () => edit(h.db, id, { claimVersion: 2 });
    await h.sweep();
    expect(await row(h.db, id)).toMatchObject({ status: 'pending', claimVersion: 2 });
    expect(h.service.instanceSignals().relayOverlap).toBe(true);
  });
  it('purges settled sent and discarded rows older than retainSentMs, never failed or pending', async () => {
    const h = await outboxHarness({ options: { retainSentMs: 1000, purgeBatch: 10 } });
    const sentOld = await h.write({ n: 1 });
    const discardedOld = await h.write({ n: 2 });
    const failedOld = await h.write({ n: 3 });
    const sentFresh = await h.write({ n: 4 });
    const pending = await h.write({ n: 5 });
    await edit(h.db, sentOld, { status: 'sent', settledAt: WALL_START - 2000 });
    await edit(h.db, discardedOld, { status: 'discarded', settledAt: WALL_START - 2000 });
    await edit(h.db, failedOld, { status: 'failed', settledAt: WALL_START - 2000 });
    await edit(h.db, sentFresh, { status: 'sent', settledAt: WALL_START - 500 });
    expect(await h.service.purge()).toBe(2);
    expect((await rows(h.db)).map((r) => r.id).sort()).toEqual(
      [failedOld, sentFresh, pending].sort(),
    );
    expect(h.store.calls.find((c) => c.method === 'purge')!.args).toEqual([WALL_START - 1000, 10]);
  });

  it('a sweep never purges', async () => {
    const h = await outboxHarness({ options: { retainSentMs: 1000 } });
    await h.write({ n: 1 });
    h.clock.advanceWall(10_000);
    await h.sweep();
    expect(h.store.count('purge')).toBe(0);
    expect(await rows(h.db)).toHaveLength(1);
  });

  it('keeps a sent row by default, and deletes it at mark-sent with retainSentMs: 0', async () => {
    const kept = await outboxHarness();
    const id = await kept.write({ n: 1 });
    await kept.sweep();
    expect((await row(kept.db, id))!.status).toBe('sent');
    expect((await row(kept.db, id))!.sentBy).toBe(`${kept.service.instanceId}/scheduled`);
    const zero = await outboxHarness({ options: { retainSentMs: 0 } });
    await zero.write({ n: 1 });
    await zero.sweep();
    expect(zero.broker.sequence()).toEqual([1]);
    expect(await rows(zero.db)).toEqual([]);
  });

  it('rejects when the store purge rejects', async () => {
    const h = await outboxHarness();
    h.store.faults.purge = () => {
      throw new Error('store down');
    };
    await expect(h.service.purge()).rejects.toThrow('store down');
  });

  it('a hung store ends the purge at sweepDeadlineMs, one deadline over every store', async () => {
    // The scheduled purge holds the scheduler's handler mutex exactly as a
    // sweep does, so it is bounded by the same deadline. Proven still pending
    // before the clock reaches it, so the bound is what ends it.
    const h = await outboxHarness({
      options: {
        retainSentMs: 0,
        relay: { sweepDeadlineMs: 301, publishTimeoutMs: 100, storeTimeoutMs: 100 },
      },
    });
    h.store.faults.purge = () => new Promise<void>(() => {});
    let settled = false;
    const purge = h.service.purge();
    purge.then(() => (settled = true), () => (settled = true));
    await flush();
    expect(h.store.count('purge')).toBe(1);
    await h.clock.advance(300);
    expect(settled).toBe(false);
    await h.clock.advance(1);
    await expect(purge).rejects.toThrow('outbox: purge did not settle within its bound');
    expect(h.clock.timerCount()).toBe(0);
  });

  it("the purge deadline spans every store: time spent on one shrinks the next one's bound", async () => {
    const first = await outboxHarness({
      options: { relay: { sweepDeadlineMs: 301, publishTimeoutMs: 100, storeTimeoutMs: 100 } },
    });
    const second = await memoryOutbox();
    const service = new OutboxService({
      runtime: first.clock.runtime,
      broker: first.broker,
      options: resolveOutboxOptions({
        relay: { sweepDeadlineMs: 301, publishTimeoutMs: 100, storeTimeoutMs: 100 },
        stores: { a: first.store, b: second.store },
      }),
    });
    service.activate({
      kind: 'per-tenant',
      stores: new Map([['a', first.store], ['b', second.store]]),
    });
    // The first store spends 200 ms of the 301 ms budget before answering.
    first.store.faults.purge = () => first.clock.step(200);
    second.store.faults.purge = () => new Promise<void>(() => {});
    let settled = false;
    const purge = service.purge();
    purge.then(() => (settled = true), () => (settled = true));
    await flush();
    expect(second.store.count('purge')).toBe(1);
    await first.clock.advance(100);
    expect(settled).toBe(false);
    await first.clock.advance(1);
    await expect(purge).rejects.toThrow('outbox: purge did not settle within its bound');
  });
});
