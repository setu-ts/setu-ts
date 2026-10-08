/**
 * Rejected store calls end the sweep (M107 §3.7): a `markSent` that rejects
 * AFTER a successful publish blocks the key, so the next lap republishes that
 * row before any later row of its key; a rejected `markFailure` records no
 * attempt and the row is retried once at the next lap; a rejected read ends
 * the sweep without starting (or corrupting) a lap.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { outboxHarness, row } from '../../fixtures/outbox.ts';

/** A fault that rejects once, then lets calls through. */
function rejectOnce(): () => void {
  let done = false;
  return () => {
    if (done) return;
    done = true;
    throw new Error('store down');
  };
}

describe('relay store failures', () => {
  it('a markSent rejecting after publish blocks the key, ends the sweep, and republishes that row first', async () => {
    const h = await outboxHarness();
    const first = await h.write({ key: 'K', n: 1 });
    await h.write({ key: 'K', n: 2 });
    await h.write({ n: 3 });
    h.store.faults.markSent = rejectOnce();
    const result = await h.sweep();
    expect(result.endedBy).toBe('store-failure');
    expect(h.broker.sequence()).toEqual([1]); // row 2 NOT published; row 3 not reached
    expect((await row(h.db, first))!.status).toBe('pending');
    expect(h.service.instanceSignals().storeWriteFailing).toBe(true);
    // The lap resumes after row 1; K is blocked for the rest of it.
    await h.sweep();
    expect(h.broker.sequence()).toEqual([1, 3]);
    await h.sweep(); // new lap: row 1 again (a duplicate), then row 2
    expect(h.broker.sequence()).toEqual([1, 3, 1, 2]);
    expect(h.broker.published[0]!.message.id).toBe(h.broker.published[2]!.message.id);
    expect(h.service.instanceSignals().storeWriteFailing).toBe(false);
  });

  it('a rejected markFailure records no attempt; the row is retried once at the next lap', async () => {
    const h = await outboxHarness();
    let failPublish = true;
    h.broker.behaviour = () => (failPublish ? Promise.reject(new Error('broker down')) : undefined);
    const id = await h.write({ key: 'K', n: 1 });
    await h.write({ key: 'K', n: 2 });
    h.store.faults.markFailure = rejectOnce();
    expect((await h.sweep()).endedBy).toBe('store-failure');
    const stored = await row(h.db, id);
    expect(stored!.attempts).toBe(0);
    expect(stored!.status).toBe('pending');
    expect(h.broker.calls).toHaveLength(1); // one attempt this lap, not a spin
    failPublish = false;
    await h.sweep(); // the rest of the lap: K is blocked
    expect(h.broker.sequence()).toEqual([]);
    await h.sweep(); // next lap: retried once, then row 2
    expect(h.broker.sequence()).toEqual([1, 2]);
  });

  it('a rejected markFailure for an invalid row ends the sweep with the key blocked', async () => {
    const h = await outboxHarness();
    const id = await h.write({ key: 'K', n: 1 });
    await h.write({ key: 'K', n: 2 });
    await h.db.getRepository<Record<string, unknown>>('Outbox').update(id, { topic: '' });
    h.store.faults.markFailure = rejectOnce();
    expect((await h.sweep()).endedBy).toBe('store-failure');
    await h.sweep();
    expect(h.broker.calls).toEqual([]);
  });

  it('a rejected failedKeys starts no lap; the next sweep starts it', async () => {
    const h = await outboxHarness();
    await h.write({ n: 1 });
    h.store.faults.failedKeys = rejectOnce();
    expect((await h.sweep()).endedBy).toBe('store-failure');
    expect(h.store.count('scanPending')).toBe(0);
    await h.sweep();
    expect(h.broker.sequence()).toEqual([1]);
    expect(h.store.count('failedKeys')).toBe(2);
  });

  it('a rejected scanPending ends the sweep and the lap resumes where it was', async () => {
    const h = await outboxHarness({ options: { relay: { pageSize: 1, scanLimit: 1 } } });
    await h.write({ n: 1 });
    await h.write({ n: 2 });
    await h.sweep();
    h.store.faults.scanPending = rejectOnce();
    expect((await h.sweep()).endedBy).toBe('store-failure');
    await h.sweep();
    expect(h.broker.sequence()).toEqual([1, 2]);
    expect(h.store.count('failedKeys')).toBe(1);
  });
});
