import { describe, it, expect, vi } from 'vitest';
import { harness, row } from '../fixtures/harness.ts';
import { claim } from '../../src/lease/lease.ts';
import { ChunkLog } from '../../src/log/chunk-log.ts';
describe('chunk log', () => {
  it('flushes by count, timer and explicit boundary; bounds deltas, retains structure', async () => {
    const h = await harness();
    try {
      await h.store.create(row());
      const lease = (await claim(h.store, h.runtime, row(), 'A', 30000, 0))!;
      const log = new ChunkLog(lease, { flushChunks: 2, flushIntervalMs: 100, maxLogBytes: 1 });
      const listener = vi.fn();
      log.listeners.add(listener);
      await log.emit({ type: 'start', messageId: 'run' });
      expect(log.snapshot()).toHaveLength(1);
      await log.emit({ type: 'text-delta', id: 't', delta: 'long' });
      expect(lease.row.chunkCount).toBe(1);
      await log.emit({ type: 'reasoning-delta', id: 'r', delta: 'long' });
      await log.emit({ type: 'finish' });
      h.fire(100);
      for (let i = 0; i < 30; i++) await Promise.resolve();
      await log.flush();
      const batches = await h.store.chunks(lease.row, 0);
      expect(JSON.stringify(batches).match(/data-setu-log-truncated/g)).toHaveLength(1);
      expect(JSON.stringify(batches)).not.toContain('long');
      expect(listener.mock.calls.some(([chunk]) => chunk.batch === -1)).toBe(true);
      const restored = new ChunkLog(lease, log.options);
      await restored.restore();
      expect(restored.truncated).toBe(true);
      expect(restored.bytes).toBeGreaterThan(0);
      lease.stop();
    } finally {
      await h.close();
    }
  });
  it('stops the lease on an asynchronous flush failure', async () => {
    const h = await harness();
    try {
      await h.store.create(row());
      const lease = (await claim(h.store, h.runtime, row(), 'A', 30000, 0))!;
      const log = new ChunkLog(lease, { flushChunks: 10, flushIntervalMs: 1, maxLogBytes: 1000 });
      await log.emit({ type: 'start' });
      vi.spyOn(h.store, 'appendChunks').mockRejectedValue(new Error());
      h.fire(1);
      for (let i = 0; i < 40; i++) await Promise.resolve();
      expect(lease.lost).toBe(true);
      log.closeTimer();
    } finally {
      await h.close();
    }
  });
});
