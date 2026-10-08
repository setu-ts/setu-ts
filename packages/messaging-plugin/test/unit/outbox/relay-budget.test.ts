/**
 * One deadline over the whole sweep (M107 §3.8): a hung `failedKeys`, a hung
 * publish and a hung status write each end the sweep — each asserted STILL
 * PENDING before the monotonic clock moves — no row starts below the
 * publish + store reserve, a late publish is a recorded failure the broker
 * still received, and concurrent sweep requests share one sweep.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import type { OutboxSweepResult } from '../../../src/interfaces/index.ts';
import { flush, outboxHarness, row } from '../../fixtures/outbox.ts';

const RELAY = { sweepDeadlineMs: 1000, publishTimeoutMs: 100, storeTimeoutMs: 100 };

/** Tracks whether a promise has settled. */
function track(promise: Promise<OutboxSweepResult>): { settled: () => boolean } {
  let settled = false;
  promise.then(() => (settled = true), () => (settled = true));
  return { settled: () => settled };
}

/** A promise that never settles. */
const hang = (): Promise<void> => new Promise<void>(() => {});

describe('relay deadline', () => {
  it('a hung failedKeys ends the sweep at its bound', async () => {
    const h = await outboxHarness({ options: { relay: RELAY } });
    await h.write({ n: 1 });
    h.store.faults.failedKeys = hang;
    const sweep = h.sweep();
    const state = track(sweep);
    await flush();
    expect(h.store.count('failedKeys')).toBe(1);
    expect(state.settled()).toBe(false);
    await h.clock.advance(100);
    expect((await sweep).endedBy).toBe('store-failure');
    expect(h.clock.timerCount()).toBe(0);
  });

  it('a hung publish is a recorded failure and ends the sweep', async () => {
    const h = await outboxHarness({ options: { relay: RELAY } });
    const id = await h.write({ key: 'K', n: 1 });
    await h.write({ n: 2 });
    h.broker.behaviour = hang;
    const sweep = h.sweep();
    const state = track(sweep);
    await flush();
    expect(h.broker.calls).toHaveLength(1);
    expect(state.settled()).toBe(false);
    await h.clock.advance(100);
    const result = await sweep;
    expect(result.endedBy).toBe('deadline');
    expect(result.failures).toBe(1);
    const stored = await row(h.db, id);
    expect(stored!.attempts).toBe(1);
    expect(stored!.lastError).toContain('did not settle');
    expect(h.broker.calls).toHaveLength(1); // row 2 was not started
  });

  it('a hung markSent blocks the key and ends the sweep as a store failure', async () => {
    const h = await outboxHarness({ options: { relay: RELAY } });
    await h.write({ key: 'K', n: 1 });
    await h.write({ key: 'K', n: 2 });
    h.store.faults.markSent = hang;
    const sweep = h.sweep();
    const state = track(sweep);
    await flush();
    expect(h.store.count('markSent')).toBe(1);
    expect(state.settled()).toBe(false);
    await h.clock.advance(100);
    expect((await sweep).endedBy).toBe('store-failure');
    expect(h.broker.sequence()).toEqual([1]);
  });

  it('starts no row once the deadline leaves less than publish + store', async () => {
    const h = await outboxHarness({ options: { relay: RELAY } });
    for (let n = 1; n <= 6; n++) await h.write({ n });
    h.broker.behaviour = () => {
      h.clock.step(300); // each publish takes 300 ms of the 1000 ms sweep
      return undefined;
    };
    const result = await h.sweep();
    // Rows start at 1000, 700 and 400 ms remaining; at 100 the 200 reserve is gone.
    expect(result.endedBy).toBe('deadline');
    expect(h.broker.sequence()).toEqual([1, 2, 3]);
    await h.sweep();
    expect(h.broker.sequence()).toEqual([1, 2, 3, 4, 5, 6]);
  });

  it('a publish that times out and is accepted late leaves two copies with one deduplication id', async () => {
    const h = await outboxHarness({ options: { relay: RELAY } });
    const id = await h.write({ n: 1 });
    let accept: (() => void) | undefined;
    h.broker.behaviour = () => new Promise<void>((resolve) => (accept = resolve));
    const sweep = h.sweep();
    await flush();
    await h.clock.advance(100);
    expect((await sweep).failures).toBe(1);
    accept!(); // the broker accepts the abandoned publish after the deadline
    await flush();
    expect(h.broker.published).toHaveLength(1);
    h.broker.behaviour = undefined;
    h.clock.advanceWall(1000);
    await h.sweep(); // finishes the lap the deadline interrupted
    await h.sweep(); // a new lap retries the row
    expect(h.broker.published).toHaveLength(2);
    expect(h.broker.published.map((p) => p.options?.deduplicationId)).toEqual([id, id]);
    expect((await row(h.db, id))!.status).toBe('sent');
  });
});

describe('single flight', () => {
  it('a sweep requested while one runs gets the running sweep', async () => {
    const h = await outboxHarness({ options: { relay: RELAY } });
    await h.write({ n: 1 });
    h.store.faults.failedKeys = () => flush();
    const first = h.sweep();
    const second = h.sweep();
    expect(second).toBe(first);
    await first;
    expect(h.store.count('failedKeys')).toBe(1);
    const third = h.sweep();
    expect(third).not.toBe(first);
    await third;
  });
});
