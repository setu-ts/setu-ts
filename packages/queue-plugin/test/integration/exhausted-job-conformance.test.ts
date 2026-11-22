import { describe, expect, it, vi } from 'vitest';
import type { QueueAdapterType, StoredJob } from '../../src/interfaces/index.ts';
import type { QueueAdapter } from '../../src/adapters/queue-adapter.ts';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import { RedisQueue } from '../../src/adapters/redis-queue.ts';
import { RabbitMqQueue } from '../../src/adapters/rabbitmq-queue.ts';
import { SqsQueue } from '../../src/adapters/sqs-queue.ts';
import { runJob } from '../../src/processors/job-processor.ts';
import { FakeRedisClient } from '../fixtures/fake-ioredis-client.ts';
import { createFakeAmqpConnection } from '../fixtures/fake-amqplib-client.ts';
import { FakeSqsTransport } from '../fixtures/fake-sqs-transport.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

const arms = ['memory', 'redis', 'rabbitmq', 'sqs'] as const satisfies readonly QueueAdapterType[];
// A newly added union arm makes this assignment fail until it joins the table.
const completeness: Record<QueueAdapterType, true> = {
  memory: true,
  redis: true,
  rabbitmq: true,
  sqs: true,
};
describe('exhausted work across all queue adapters', () => {
  it('covers the complete adapter inventory', () => {
    expect([...arms].sort()).toEqual(Object.keys(completeness).sort());
  });
  for (const arm of arms) {
    it(`${arm} retains terminal payload, calls onFailed once and counts only after settle`, async () => {
      const runtime = new FakeRuntimeServices(1000);
      const redis = new FakeRedisClient();
      const amqp = createFakeAmqpConnection();
      const sqs = new FakeSqsTransport(() => runtime.now());
      const memory = new MemoryQueue();
      const adapters: Record<QueueAdapterType, QueueAdapter> = {
        memory,
        redis: new RedisQueue({ client: redis }),
        rabbitmq: new RabbitMqQueue(runtime, { client: amqp }),
        sqs: new SqsQueue(runtime, {
          queues: { build: 'source' },
          deadLetterQueues: { build: 'dead' },
          client: sqs,
        }),
      };
      const adapter = adapters[arm];
      await adapter.connect();
      const job: StoredJob = {
        id: 'j1',
        name: 'build',
        data: { retained: 'payload' },
        attempts: 0,
        maxAttempts: 1,
        availableAtMs: 0,
      };
      await adapter.enqueue(job);
      const [reserved] = await adapter.reserve('build', 1, runtime.now());
      expect(reserved).toBeDefined();
      const failed = vi.fn();
      const counted = vi.fn();
      const gate = Promise.withResolvers<void>();
      const deadLetter = adapter.deadLetter.bind(adapter);
      vi.spyOn(adapter, 'deadLetter').mockImplementation(async (...args) => {
        await gate.promise;
        return deadLetter(...args);
      });
      const running = runJob(
        runtime,
        adapter,
        { ...reserved!, attempts: 1 },
        () => {
          throw new Error('failed');
        },
        undefined,
        { onFailed: failed, onProcessorOutcome: counted },
      );
      for (let tick = 0; tick < 10; tick++) await Promise.resolve();
      expect(failed).toHaveBeenCalledTimes(1);
      expect(counted).not.toHaveBeenCalled();
      gate.resolve();
      await running;
      expect(counted).toHaveBeenCalledExactlyOnceWith('build', 'dead_lettered');
      let retained: unknown;
      if (arm === 'memory') retained = memory.getDeadLetters('build')[0]!.data;
      if (arm === 'redis')
        retained = JSON.parse((await redis.hget('queue:build:jobs', 'j1'))!).data;
      if (arm === 'rabbitmq')
        retained = JSON.parse(
          (await amqp.createChannel()).getReadyBuffer('he.queue.build.dead')[0]!.content.toString(),
        ).data;
      if (arm === 'sqs')
        retained = JSON.parse(sqs.sent.find((s) => s.queueUrl === 'dead')!.body).data;
      expect(retained).toEqual(job.data);
      expect(await adapter.reserve('build', 1, runtime.now())).toEqual([]);
      await adapter.disconnect();
    });
  }
  it('SQS without a dead store refuses before receiving or deleting work', async () => {
    const runtime = new FakeRuntimeServices(0);
    const transport = new FakeSqsTransport(() => runtime.now());
    const adapter = new SqsQueue(runtime, { queues: { build: 'source' }, client: transport });
    await adapter.connect();
    await adapter.enqueue({
      id: 'j1',
      name: 'build',
      data: {},
      attempts: 0,
      maxAttempts: 1,
      availableAtMs: 0,
    });
    const terminalAttempt = async (): Promise<void> => {
      const [job] = await adapter.reserve('build', 1, 0);
      if (job)
        await runJob(runtime, adapter, job, () => {
          throw new Error('terminal');
        });
    };
    const [result] = await Promise.allSettled([terminalAttempt()]);
    expect({
      refused: result!.status === 'rejected',
      sourceDepth: transport.depth('source'),
      deletions: transport.deleted.length,
    }).toEqual({ refused: true, sourceDepth: 1, deletions: 0 });
    if (result!.status === 'rejected')
      expect(result.reason.message).toContain('dead-letter target');
    await adapter.disconnect();
  });
});
