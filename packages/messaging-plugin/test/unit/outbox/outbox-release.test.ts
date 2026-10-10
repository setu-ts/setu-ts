/**
 * `IOutbox.release` (M107 §3.3, §3.7): `retry` returns a failed row to
 * `pending` and the relay publishes it at its next lap; `discard` settles it
 * without publishing; a missing or non-failed row rejects
 * `OutboxRowStateError` naming the outcome; every refusal is a rejection.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { OutboxRowStateError } from '../../../src/outbox/errors.ts';
import { edit, outboxHarness, row, WALL_START } from '../../fixtures/outbox.ts';

describe('IOutbox.release', () => {
  it('retry: the failed row and its key publish again, in order, from the next lap', async () => {
    const h = await outboxHarness();
    const failed = await h.write({ key: 'K', n: 1 });
    await h.write({ key: 'K', n: 2 });
    await edit(h.db, failed, {
      status: 'failed',
      attempts: 10,
      lastError: 'x',
      claimVersion: 7,
      leaseUntil: WALL_START + 30000,
    });
    await h.sweep();
    expect(h.broker.sequence()).toEqual([]);
    h.clock.advanceWall(5);
    await h.service.release(failed, 'retry');
    const stored = await row(h.db, failed);
    expect(stored!.status).toBe('pending');
    expect(stored!.attempts).toBe(0);
    expect(stored!.availableAt).toBe(WALL_START + 5);
    expect(stored!.leaseUntil).toBe(0);
    expect(stored!.claimVersion).toBe(7);
    await h.sweep();
    expect(h.broker.sequence()).toEqual([1, 2]);
    expect((await row(h.db, failed))!.claimVersion).toBe(8);
  });

  it('discard: the row settles without publishing and unblocks its key at the next lap', async () => {
    const h = await outboxHarness();
    const failed = await h.write({ key: 'K', n: 1 });
    await h.write({ key: 'K', n: 2 });
    await edit(h.db, failed, { status: 'failed' });
    await h.service.release(failed, 'discard');
    expect((await row(h.db, failed))!.status).toBe('discarded');
    expect((await row(h.db, failed))!.settledAt).toBe(WALL_START);
    await h.sweep();
    expect(h.broker.sequence()).toEqual([2]);
  });

  it('rejects a missing row and a row that is not failed, naming the outcome', async () => {
    const h = await outboxHarness();
    const pending = await h.write({ n: 1 });
    const missing = h.service.release('no-such-row', 'retry');
    await expect(missing).rejects.toBeInstanceOf(OutboxRowStateError);
    await expect(missing).rejects.toMatchObject({ outcome: 'missing' });
    await expect(h.service.release(pending, 'discard')).rejects.toMatchObject({
      outcome: 'not-failed',
      status: 'pending',
    });
    expect((await row(h.db, pending))!.status).toBe('pending');
  });

  it('rejects (never throws) a bad id, action or tenant id', async () => {
    const h = await outboxHarness();
    const calls = [
      () => h.service.release('', 'retry'),
      () => h.service.release(5 as unknown as string, 'retry'),
      () => h.service.release('id', 'purge' as unknown as 'retry'),
      () => h.service.release('id', 'retry', { tenantId: '' }),
    ];
    for (const call of calls) {
      let promise: Promise<void> | undefined;
      expect(() => (promise = call())).not.toThrow();
      await expect(promise!).rejects.toThrow();
    }
    expect(h.store.count('release')).toBe(0);
  });
});
