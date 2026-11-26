import { afterAll, describe, expect, it, vi } from 'vitest';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import type { QueueAdapter } from '../../src/adapters/queue-adapter.ts';
import { RedisQueue } from '../../src/adapters/redis-queue.ts';
import { SqsQueue } from '../../src/adapters/sqs-queue.ts';
import { QueueService } from '../../src/services/queue-service.ts';
import { FakeEvalRedisClient } from '../fixtures/fake-ioredis-client.ts';
import { FakeSqsTransport } from '../fixtures/fake-sqs-transport.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

describe('long job lease conformance', () => {
  for (const arm of ['redis', 'sqs'] as const) {
    it(`${arm} runs a job three leases long once and acknowledges once`, async () => {
      const runtime = new FakeRuntimeServices(0);
      const redis = new FakeEvalRedisClient();
      Object.defineProperty(redis, 'serverNowMs', { get: () => runtime.now() });
      const transport = new FakeSqsTransport(() => runtime.now());
      const adapter: QueueAdapter =
        arm === 'redis'
          ? new RedisQueue({ client: redis, visibilityTimeoutMs: 3000 })
          : new SqsQueue(runtime, {
              queues: { build: 'source' },
              deadLetterQueues: { build: 'dead' },
              visibilityTimeoutSeconds: 3,
              client: transport,
            });
      const ack = vi.spyOn(adapter, 'ack');
      const service = new QueueService(adapter, runtime, { pollIntervalMs: 100 });
      const held = Promise.withResolvers<void>();
      const processor = vi.fn(() => held.promise);
      const failed = vi.fn();
      await service.connect();
      const extend = vi.spyOn(adapter.claimRenewal!, 'extend');
      service.process('build', processor, { concurrency: 2, onFailed: failed });
      await service.add('build', { long: true });
      await runtime.advanceMs(10_000);
      expect(processor).toHaveBeenCalledTimes(1);
      expect(failed).not.toHaveBeenCalled();
      expect(extend.mock.calls.length).toBeGreaterThanOrEqual(9);
      held.resolve();
      await runtime.advanceMs(1000);
      expect(ack).toHaveBeenCalledTimes(1);
      expect(await adapter.reserve('build', 1, runtime.now())).toEqual([]);
      await service.disconnect();
      expect(runtime.timerCount).toBe(0);
    });
  }
});

const endpoint = process.env.SQS_ENDPOINT_URL;
describe('long job against ElasticMQ', { skip: !endpoint }, () => {
  const runtime = createNodeRuntimeServices();
  let service: QueueService | undefined;
  let cleanup: (() => Promise<void>) | undefined;
  afterAll(async () => {
    await service?.disconnect();
    await cleanup?.();
  });
  it('renews a two-second receipt throughout a seven-second job', async () => {
    const sdk = await import('@aws-sdk/client-sqs');
    const config = {
      endpoint: endpoint!,
      region: 'us-east-1',
      credentials: { accessKeyId: 'test', secretAccessKey: 'test' },
    };
    const client = new sdk.SQSClient(config);
    const { QueueUrl } = await client.send(
      new sdk.CreateQueueCommand({ QueueName: `m143p-long-${crypto.randomUUID()}` }),
    );
    cleanup = async () => {
      try {
        await client.send(new sdk.DeleteQueueCommand({ QueueUrl: QueueUrl! }));
      } finally {
        client.destroy();
      }
    };
    const adapter = new SqsQueue(runtime, {
      ...config,
      queues: { build: QueueUrl! },
      deadLetterQueues: { build: false },
      visibilityTimeoutSeconds: 2,
    });
    service = new QueueService(adapter, runtime, { pollIntervalMs: 100 });
    await service.connect();
    const processed = vi.fn(async () => {
      await new Promise<void>((resolve) => runtime.setTimeout(resolve, 7000));
    });
    const ack = vi.spyOn(adapter, 'ack');
    service.process('build', processed, { concurrency: 2 });
    await service.add('build', {});
    await vi.waitFor(() => expect(ack).toHaveBeenCalledTimes(1), {
      timeout: 12_000,
      interval: 100,
    });
    expect(processed).toHaveBeenCalledTimes(1);
  });
});
