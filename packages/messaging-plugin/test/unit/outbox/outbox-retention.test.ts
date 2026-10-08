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

import { edit, outboxHarness, row, rows, WALL_START } from '../../fixtures/outbox.ts';

describe('outbox retention', () => {
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
});
