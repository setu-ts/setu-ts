import { describe, it, expect, vi } from 'vitest';
import { harness, row } from '../fixtures/harness.ts';
import { claim } from '../../src/lease/lease.ts';
describe('fenced lease', () => {
  it('cannot take over a lease renewed after the claimant read it', async () => {
    const h = await harness();
    try {
      await h.store.create(row({ leaseOwner: 'A', leaseUntil: 1 }));
      const stale = (await h.store.get('run'))!;
      await h.store.update('run', { leaseVersion: 0 }, { leaseUntil: h.runtime.now() + 30000 });
      expect(await claim(h.store, h.runtime, stale, 'B', 30000, 0)).toBeUndefined();
    } finally {
      await h.close();
    }
  });
  it('bumps versions, renews and refuses stale holders (G2)', async () => {
    const h = await harness();
    try {
      await h.store.create(row());
      const first = (await claim(h.store, h.runtime, row(), 'A', 30000, 5000))!;
      expect(first.row.leaseVersion).toBe(1);
      expect(await claim(h.store, h.runtime, first.row, 'B', 30000, 5000)).toBeUndefined();
      h.advance(35000);
      expect(await claim(h.store, h.runtime, first.row, 'B', 30000, 5000)).toBeUndefined();
      h.advance(1);
      const second = (await claim(h.store, h.runtime, first.row, 'B', 30000, 5000))!;
      expect(second.row.leaseVersion).toBe(2);
      await expect(first.write({ error: 'stale' })).rejects.toMatchObject({
        name: 'AgentRunLeaseLostError',
      });
      expect(first.controller.signal.aborted).toBe(true);
      await expect(first.renew()).rejects.toThrow();
      await second.renew();
      expect((await h.store.get('run'))?.leaseOwner).toBe('B');
      second.stop();
    } finally {
      await h.close();
    }
  });
  it('handles lost claim, cancellation returned by renewal and timer failure', async () => {
    const h = await harness();
    try {
      await h.store.create(row());
      const update = vi.spyOn(h.store, 'update').mockResolvedValueOnce(null);
      expect(await claim(h.store, h.runtime, row(), 'A', 30000, 0)).toBeUndefined();
      update.mockRestore();
      const lease = (await claim(h.store, h.runtime, row(), 'A', 30000, 0))!;
      await h.store.update('run', { leaseVersion: 1 }, { cancelRequested: true });
      await expect(lease.renew()).rejects.toThrow();
      expect(lease.controller.signal.aborted).toBe(true);
      h.fire(10000);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      expect(lease.lost).toBe(false);
      lease.stop();
      expect(
        await claim(h.store, h.runtime, { ...row(), status: 'waiting' }, 'B', 30000, 0),
      ).toBeUndefined();
    } finally {
      await h.close();
    }
  });
});
