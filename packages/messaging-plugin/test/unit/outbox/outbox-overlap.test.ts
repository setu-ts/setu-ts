/**
 * Conditional transitions and overlap detection (M107 §3.7, §3.8), with two
 * relays over ONE real memory-backed table: a late failure write after the
 * other relay's `markSent` leaves the row `sent`; a `markSent` finding the row
 * already sent is reported as a duplicate after a pause beyond the fence; a scheduled
 * overlap degrades this instance's signal only inside `overlapWindowMs`; a
 * row another relay failed meanwhile blocks its key; and `retainSentMs: 0`
 * reports no overlap.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { OutboxHarness } from '../../fixtures/outbox.ts';
import {
  countingObserver,
  edit,
  flush,
  outboxClock,
  outboxHarness,
  row,
} from '../../fixtures/outbox.ts';

/** A promise whose settlement the test controls. */
function deferred(): { promise: Promise<void>; resolve: () => void; reject: (e: Error) => void } {
  let resolve!: () => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<void>((ok, fail) => {
    resolve = ok;
    reject = fail;
  });
  return { promise, resolve, reject };
}

/** A second relay over the same table, with its own broker. */
function expiredClock(base: number) {
  const clock = outboxClock(base);
  clock.advanceWall(35000);
  return clock;
}

function second(h: OutboxHarness, observer = countingObserver()) {
  return outboxHarness({
    shared: { db: h.db, store: h.store },
    clock: expiredClock(0x300000),
    observer,
  });
}

describe('overlapping relays', () => {
  for (const retainSentMs of [0, 604800000]) {
    for (const failure of [false, true]) {
      it(`a lost held claim reports overlap after ${failure ? 'failure' : 'success'} with retention ${retainSentMs}`, async () => {
        const observer = countingObserver();
        const h = await outboxHarness({ observer, options: { retainSentMs } });
        const id = await h.write({ n: 1 });
        h.broker.behaviour = async () => {
          await edit(h.db, id, { claimVersion: 2 });
          if (failure) throw new Error('broker down');
        };
        await h.sweep();
        expect(observer.counts['overlap-claim-lost']).toBe(1);
        expect(await row(h.db, id)).toMatchObject({
          status: 'pending',
          attempts: 0,
          claimVersion: 2,
        });
        expect(h.service.instanceSignals().relayOverlap).toBe(true);
      });
    }
    it(`fencing remains visible with retention ${retainSentMs}`, async () => {
      const observer = countingObserver();
      const h = await outboxHarness({ observer, options: { retainSentMs } });
      await h.write({ n: 1 });
      h.store.claim = async (id, update) => {
        const result = await h.store.inner.claim(id, update);
        h.clock.setWall(update.leaseUntil + 1);
        return result;
      };
      await h.sweep();
      expect(observer.counts['overlap-fenced']).toBe(1);
      expect(h.service.instanceSignals().relayOverlap).toBe(true);
      expect(h.broker.calls).toEqual([]);
    });
  }
  it('a late failure write after the other relay marked the row sent leaves it sent', async () => {
    const a = await outboxHarness({ options: { health: { overlapWindowMs: 1000 } } });
    const id = await a.write({ n: 1 });
    const slow = deferred();
    a.broker.behaviour = () => slow.promise;
    const sweepA = a.sweep();
    await flush();
    const b = await second(a);
    await b.sweep();
    expect((await row(a.db, id))!.status).toBe('sent');
    slow.reject(new Error('late failure'));
    const result = await sweepA;
    expect(result.failures).toBe(1);
    const stored = await row(a.db, id);
    expect(stored!.status).toBe('sent');
    expect(stored!.attempts).toBe(0);
    expect(stored!.sentBy).toBe(`${b.service.instanceId}/scheduled`);
  });

  it('a pause after the fence lets two scheduled sweeps send one row: an overlap that degrades only inside the window', async () => {
    const observer = countingObserver();
    const a = await outboxHarness({ observer, options: { health: { overlapWindowMs: 1000 } } });
    await a.write({ n: 1 });
    const slow = deferred();
    a.broker.behaviour = () => slow.promise;
    const sweepA = a.sweep();
    await flush();
    await (await second(a)).sweep();
    slow.resolve();
    await sweepA;
    expect(observer.counts['overlap-duplicate']).toBe(1);
    expect(a.service.instanceSignals().relayOverlap).toBe(true);
    await a.clock.advance(1001);
    expect(a.service.instanceSignals().relayOverlap).toBe(false);
  });

  it('an overlap involving a dispatch sweep degrades relay health too', async () => {
    const observer = countingObserver();
    const a = await outboxHarness({ observer });
    await a.write({ n: 1 });
    const slow = deferred();
    a.broker.behaviour = () => slow.promise;
    const sweepA = a.sweep();
    await flush();
    const b = await second(a);
    b.service.dispatch();
    await flush();
    slow.resolve();
    await sweepA;
    expect(observer.counts['overlap-duplicate']).toBe(1);
    expect(a.service.instanceSignals().relayOverlap).toBe(true);
  });

  it('a publish whose status write finds sent reports duplicate', async () => {
    const observer = countingObserver();
    const a = await outboxHarness({ observer });
    const id = await a.write({ n: 1 });
    a.broker.behaviour = async () => {
      await edit(a.db, id, { status: 'sent', sentBy: `${a.service.instanceId}/dispatch` });
    };
    await a.sweep();
    expect(observer.counts).toEqual({ published: 1, 'overlap-duplicate': 1 });
  });

  it('a row another relay failed meanwhile blocks its key for the rest of the lap', async () => {
    const a = await outboxHarness();
    const id = await a.write({ key: 'K', n: 1 });
    await a.write({ key: 'K', n: 2 });
    let first = true;
    a.broker.behaviour = async () => {
      if (!first) return;
      first = false;
      await edit(a.db, id, { status: 'failed' });
    };
    await a.sweep();
    expect(a.broker.sequence()).toEqual([1]);
  });

  it('retainSentMs: 0 reports no overlap — a deleted row reads as missing', async () => {
    const observer = countingObserver();
    const a = await outboxHarness({ observer, options: { retainSentMs: 0 } });
    await a.write({ n: 1 });
    const slow = deferred();
    a.broker.behaviour = () => slow.promise;
    const sweepA = a.sweep();
    await flush();
    await (await outboxHarness({
      shared: { db: a.db, store: a.store },
      clock: expiredClock(0x400000),
      options: { retainSentMs: 0 },
    })).sweep();
    slow.resolve();
    await sweepA;
    expect(observer.counts).toEqual({ published: 1 });
  });
});
