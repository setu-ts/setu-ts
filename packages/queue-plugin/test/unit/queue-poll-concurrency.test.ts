import { describe, expect, it, vi } from 'vitest';
import { QueueService } from '../../src/services/queue-service.ts';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import { RedisQueue } from '../../src/adapters/redis-queue.ts';
import { FakeRedisClient } from '../fixtures/fake-ioredis-client.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';
import type { StoredJob } from '../../src/interfaces/index.ts';

describe('Queue per-name polling', () => {
  it('drains reserve tasks even when adapter disconnect rejects', async () => {
    const runtime = new FakeRuntimeServices(0);
    const adapter = new MemoryQueue();
    const pending = Promise.withResolvers<readonly StoredJob[]>();
    vi.spyOn(adapter, 'reserve').mockReturnValue(pending.promise);
    const failure = new Error('disconnect failed');
    vi.spyOn(adapter, 'disconnect').mockRejectedValue(failure);
    const service = new QueueService(adapter, runtime, { pollIntervalMs: 100 });
    service.process('slow', vi.fn());
    await service.connect();
    await runtime.advanceMs(100);
    let settled = false;
    const stopped = service.disconnect().catch((error: unknown) => {
      settled = true;
      return error;
    });
    for (let i = 0; i < 20; i++) await Promise.resolve();
    expect(settled).toBe(false);
    pending.resolve([]);
    expect(await stopped).toBe(failure);
  });
  it.each(['memory', 'redis'] as const)(
    'does not serialize names, fences late work and drains tasks on %s',
    async (kind) => {
      const runtime = new FakeRuntimeServices(0);
      const adapter =
        kind === 'memory' ? new MemoryQueue() : new RedisQueue({ client: new FakeRedisClient() });
      const pending = Promise.withResolvers<readonly StoredJob[]>();
      const reserve = vi
        .spyOn(adapter, 'reserve')
        .mockImplementation((name) => (name === 'slow' ? pending.promise : Promise.resolve([])));
      const logger = { error: vi.fn(), warn: vi.fn(), info: vi.fn() };
      const service = new QueueService(adapter, runtime, { pollIntervalMs: 100, logger });
      const processor = vi.fn();
      service.process('slow', processor);
      service.process('fast', processor);
      await service.connect();
      await runtime.advanceMs(300);
      expect(reserve.mock.calls.filter(([name]) => name === 'slow')).toHaveLength(1);
      expect(reserve.mock.calls.filter(([name]) => name === 'fast')).toHaveLength(3);
      let stopped = false;
      const stop = service.disconnect().then(() => {
        stopped = true;
      });
      await Promise.resolve();
      expect(stopped).toBe(false);
      pending.resolve([
        { id: 'late', name: 'slow', data: {}, attempts: 1, maxAttempts: 3, availableAtMs: 0 },
      ]);
      await stop;
      expect(processor).not.toHaveBeenCalled();
      expect(logger.warn).not.toHaveBeenCalled();
      expect(logger.error).not.toHaveBeenCalled();
    },
  );
  it('does not report a reserve rejected by disconnect', async () => {
    const runtime = new FakeRuntimeServices(0);
    const adapter = new MemoryQueue();
    const pending = Promise.withResolvers<readonly StoredJob[]>();
    vi.spyOn(adapter, 'reserve').mockReturnValue(pending.promise);
    const warn = vi.fn();
    const service = new QueueService(adapter, runtime, {
      pollIntervalMs: 100,
      logger: { error: vi.fn(), warn },
    });
    service.process('slow', vi.fn());
    await service.connect();
    await runtime.advanceMs(100);
    const stopped = service.disconnect();
    pending.reject(new Error('aborted'));
    await stopped;
    expect(warn).not.toHaveBeenCalled();
  });
});
