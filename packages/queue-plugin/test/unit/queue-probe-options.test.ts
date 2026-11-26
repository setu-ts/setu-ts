import { describe, expect, it, vi } from 'vitest';
import { QueueService } from '../../src/services/queue-service.ts';
import { QueuePlugin } from '../../src/index.ts';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { FakeSqsTransport } from '../fixtures/fake-sqs-transport.ts';

describe('Queue probe options', () => {
  it('forwards zero caching through the plugin into a kernel health endpoint', async () => {
    const isHealthy = vi.fn(() => Promise.resolve(true));
    const client = Object.assign(new FakeSqsTransport(() => 0), { isHealthy });
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        HealthPlugin({ details: true }),
        QueuePlugin({
          adapter: 'sqs',
          sqs: { queues: { build: 'source' }, client },
          health: { probeCacheMs: 0 },
        }),
      ],
    });
    await app.start();
    try {
      const first = await app.fetch(new Request('http://localhost/health'));
      expect(await first.json()).toMatchObject({ checks: { queue: { status: 'up' } } });
      isHealthy.mockResolvedValue(false);
      const second = await app.fetch(new Request('http://localhost/health'));
      expect(await second.json()).toMatchObject({ checks: { queue: { status: 'down' } } });
      expect(isHealthy).toHaveBeenCalledTimes(2);
    } finally {
      await app.stop();
    }
  });
  it.each([0, 300])(
    'caches failed answers for %s ms and probes again at expiry',
    async (probeCacheMs) => {
      const runtime = new FakeRuntimeServices(0);
      const adapter = Object.assign(new MemoryQueue(), {
        isHealthy: vi.fn(() => Promise.resolve(false)),
      });
      const service = new QueueService(adapter, runtime, { health: { probeCacheMs } });
      await service.connect();
      const read = service.createHealthIndicator();
      expect((await read()).status).toBe('down');
      adapter.isHealthy.mockResolvedValue(true);
      expect((await read()).status).toBe(probeCacheMs === 0 ? 'up' : 'down');
      if (probeCacheMs > 0) await runtime.advanceMs(probeCacheMs);
      expect((await read()).status).toBe('up');
      expect(adapter.isHealthy).toHaveBeenCalledTimes(probeCacheMs === 0 ? 3 : 2);
      await service.disconnect();
    },
  );
  it('uses the configured probe bound', async () => {
    const runtime = new FakeRuntimeServices(0);
    const adapter = Object.assign(new MemoryQueue(), {
      isHealthy: () => new Promise<boolean>(() => {}),
    });
    const service = new QueueService(adapter, runtime, { health: { probeTimeoutMs: 25 } });
    await service.connect();
    const result = service.createHealthIndicator()();
    await runtime.advanceMs(25);
    expect(await result).toMatchObject({ status: 'up', data: { reachable: 'unknown' } });
    await service.disconnect();
  });
  it.each([-1, 1.5, Infinity, NaN, 2147483648])('refuses invalid probe range %s', (value) => {
    expect(() => QueuePlugin({ health: { probeCacheMs: value } })).toThrow(RangeError);
    expect(() => QueuePlugin({ health: { probeTimeoutMs: value } })).toThrow(RangeError);
  });
  it('refuses a disabled timeout', () =>
    expect(() => QueuePlugin({ health: { probeTimeoutMs: 0 } })).toThrow(RangeError));
});
