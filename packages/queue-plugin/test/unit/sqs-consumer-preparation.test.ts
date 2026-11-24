import { describe, expect, it, vi } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import type { IIngressBehavior, IMetricsService } from '@setu-ts/common';
import { QueuePlugin } from '../../src/plugin/queue-plugin.ts';
import { QueueService } from '../../src/services/queue-service.ts';
import { QueueCollector } from '../../src/metrics/queue-collector.ts';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import { SqsDeadLetterTargetMissingError, SqsQueue } from '../../src/index.ts';
import { sqsHarness, envelope } from '../fixtures/sqs-harness.ts';
import { FakeSqsTransport } from '../fixtures/fake-sqs-transport.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

describe('SQS consumer preparation', () => {
  it('prepares a processor registered before connect and honors the plugin consumer default', async () => {
    const runtime = new FakeRuntimeServices(0);
    const transport = new FakeSqsTransport(() => runtime.now());
    await transport.send('source', JSON.stringify({ v: 1, id: 'j1', name: 'build', data: {} }));
    const reserve = vi.spyOn(SqsQueue.prototype, 'reserve');
    const processor = vi.fn();
    const app = createApplication({
      plugins: [
        RuntimePlugin({ platform: 'node', adapters: { node: () => runtime } }),
        QueuePlugin({
          adapter: 'sqs',
          defaultMaxAttempts: 7,
          pollIntervalMs: 100,
          sqs: {
            queues: { build: 'source' },
            deadLetterQueues: { build: false },
            client: transport,
          },
          processors: [{ name: 'build', processor }],
        }),
      ],
    });
    try {
      await app.start();
      await runtime.advanceMs(500);
      expect(processor).toHaveBeenCalledTimes(1);
      const jobs = await reserve.mock.results[0]!.value;
      expect(jobs[0]!.maxAttempts).toBe(7);
    } finally {
      reserve.mockRestore();
      await app.stop();
    }

    const adapter = new SqsQueue(runtime, {
      queues: { build: 'source' },
      deadLetterQueues: { build: false },
      client: transport,
    });
    const service = new QueueService(adapter, runtime, { pollIntervalMs: 100 });
    const early = vi.fn();
    service.process('build', early);
    await service.connect();
    await service.add('build', {});
    await runtime.advanceMs(500);
    expect(early).toHaveBeenCalledTimes(1);
    await service.disconnect();
  });
  it.each(['instance', 'factory', 'behavior-factory'] as const)(
    'refuses a declared %s processor at app.start',
    async (arm) => {
      const transport = new FakeSqsTransport();
      const definition = { name: 'build', processor: () => {} };
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          QueuePlugin({
            adapter: 'sqs',
            sqs: { queues: { build: 'source' }, client: transport },
            processors: [arm === 'factory' ? () => definition : definition],
            ...(arm === 'behavior-factory'
              ? { behaviors: [() => ({ handle: (_ctx, next) => next() }) as IIngressBehavior] }
              : {}),
          }),
        ],
      });
      await expect(app.start()).rejects.toThrow(/dead-letter target|RedrivePolicy/);
      await app.stop();
      expect(transport.closed).toBe(true);
    },
  );
  it('starts an application which only produces without attributes rights', async () => {
    const transport = new FakeSqsTransport();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        QueuePlugin({
          adapter: 'sqs',
          sqs: { queues: { build: 'source' }, client: transport },
        }),
      ],
    });
    await app.start();
    await app.stop();
    expect(transport.closed).toBe(true);
  });
  it('reports an imperative refusal once at error and never polls that name', async () => {
    const { queue, runtime, transport } = await sqsHarness({ deadLetterQueues: { other: 'dead' } });
    const receive = vi.spyOn(transport, 'receive');
    const logger = { error: vi.fn() };
    const service = new QueueService(queue, runtime, { logger, pollIntervalMs: 100 });
    await service.connect();
    service.process('build', vi.fn());
    service.process('other', vi.fn());
    await transport.send('source', envelope());
    await runtime.advanceMs(3000);
    expect(logger.error).toHaveBeenCalledTimes(1);
    expect(logger.error.mock.calls[0]![0]).toBe('queue consumer preparation failed');
    expect(receive.mock.calls.some(([url]) => url === 'source')).toBe(false);
    expect(receive.mock.calls.some(([url]) => url === 'other-source')).toBe(true);
    expect(transport.depth('source')).toBe(1);
    await service.disconnect();
    expect(runtime.timerCount).toBe(0);
  });
  it('reports again when a transient preparation failure turns into a definite refusal', async () => {
    const getQueueAttributes = vi
      .fn<() => Promise<Readonly<Record<string, string>>>>()
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockResolvedValue({});
    const { queue, runtime, transport } = await sqsHarness(
      { deadLetterQueues: {} },
      { getQueueAttributes },
    );
    const receive = vi.spyOn(transport, 'receive');
    const logger = { error: vi.fn() };
    const service = new QueueService(queue, runtime, { logger, pollIntervalMs: 100 });
    await service.connect();
    service.process('build', vi.fn());
    await runtime.advanceMs(5000);
    expect(getQueueAttributes.mock.calls.length).toBeGreaterThanOrEqual(2);
    const texts = logger.error.mock.calls.map(([, meta]) =>
      String((meta as { error: string }).error),
    );
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("the queue's attributes (RedrivePolicy) could not be read");
    expect(texts[1]).toContain('no deadLetterQueues entry and the queue has no RedrivePolicy');
    await runtime.advanceMs(5000);
    expect(logger.error).toHaveBeenCalledTimes(2);
    expect(receive.mock.calls.some(([url]) => url === 'source')).toBe(false);
    await service.disconnect();
  });
  it('reports again when the transient preparation reason changes', async () => {
    const getQueueAttributes = vi
      .fn<() => Promise<Readonly<Record<string, string>>>>()
      .mockRejectedValueOnce(new Error('AccessDenied'))
      .mockResolvedValue({
        RedrivePolicy: JSON.stringify({
          deadLetterTargetArn: 'arn:aws:sqs:us-east-1:210987654321:dead',
          maxReceiveCount: 4,
        }),
      });
    const getQueueUrl = vi.fn(() => Promise.reject(new Error('AccessDenied')));
    const { queue, runtime } = await sqsHarness(
      { deadLetterQueues: {} },
      { getQueueAttributes, getQueueUrl },
    );
    const logger = { error: vi.fn() };
    const service = new QueueService(queue, runtime, { logger, pollIntervalMs: 100 });
    await service.connect();
    service.process('build', vi.fn());
    await runtime.advanceMs(10000);
    const texts = logger.error.mock.calls.map(([, meta]) =>
      String((meta as { error: string }).error),
    );
    expect(texts).toHaveLength(2);
    expect(texts[0]).toContain("the queue's attributes (RedrivePolicy) could not be read");
    expect(texts[1]).toContain("the RedrivePolicy target's queue URL could not be resolved");
    await service.disconnect();
  });
  it('reports an unconfigured SQS name once and never polls it', async () => {
    const { queue, runtime, transport } = await sqsHarness({ deadLetterQueues: { build: false } });
    const receive = vi.spyOn(transport, 'receive');
    const logger = { error: vi.fn() };
    const service = new QueueService(queue, runtime, { logger, pollIntervalMs: 100 });
    await service.connect();
    service.process('missing', vi.fn());
    await runtime.advanceMs(5000);
    expect(logger.error).toHaveBeenCalledOnce();
    expect(String((logger.error.mock.calls[0]![1] as { error: string }).error)).toContain(
      'is not configured',
    );
    expect(receive).not.toHaveBeenCalled();
    await service.disconnect();
  });
  it('clears a preparation in flight before shutdown and never polls after it completes', async () => {
    const read = Promise.withResolvers<Record<string, string>>();
    const { queue, runtime, transport } = await sqsHarness(
      { deadLetterQueues: {} },
      { getQueueAttributes: () => read.promise },
    );
    const receive = vi.spyOn(transport, 'receive');
    const logger = { error: vi.fn() };
    const service = new QueueService(queue, runtime, { logger, pollIntervalMs: 100 });
    await service.connect();
    service.process('build', vi.fn());
    await runtime.advanceMs(200);
    await service.disconnect();
    read.resolve({});
    await runtime.advanceMs(1000);
    expect(receive).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(runtime.timerCount).toBe(0);
  });
  it('adapters without preparation preserve their processing behavior', async () => {
    const runtime = new FakeRuntimeServices(0);
    const adapter = new MemoryQueue();
    expect(adapter).not.toHaveProperty('prepareConsumer');
    const service = new QueueService(adapter, runtime, { pollIntervalMs: 100 });
    const processor = vi.fn();
    await service.connect();
    service.process('build', processor);
    await service.add('build', { value: 1 });
    await runtime.advanceMs(500);
    expect(processor).toHaveBeenCalledTimes(1);
    await service.disconnect();
  });
  it.each([false, true])(
    'counts discarded only after deleting, including abandoned=%s',
    async (abandoned) => {
      const read = vi.fn(() => Promise.resolve({ RedrivePolicy: '{}' }));
      const { queue, runtime, transport, logger } = await sqsHarness(
        { deadLetterQueues: { build: false } },
        { getQueueAttributes: read },
      );
      const inc = vi.fn();
      const metrics = { counter: () => ({ inc }) } as unknown as IMetricsService;
      const collector = new QueueCollector(metrics, vi.fn());
      const observer = { begin: vi.fn(() => ({ settled: vi.fn(), abandon: vi.fn() })) };
      const service = new QueueService(queue, runtime, {
        collector,
        observer,
        pollIntervalMs: 100,
      });
      await service.connect();
      const failed = vi.fn();
      const processor = vi.fn(() => {
        throw new Error('failed');
      });
      await transport.send('source', envelope(1));
      if (abandoned) {
        await queue.reserve('build', 1, 0);
        await runtime.advanceMs(3000);
      }
      service.process('build', processor, { onFailed: failed });
      const gate = Promise.withResolvers<void>();
      const originalDelete = transport.delete.bind(transport);
      vi.spyOn(transport, 'delete').mockImplementationOnce(async (url, receipt) => {
        await gate.promise;
        return originalDelete(url, receipt);
      });
      await runtime.advanceMs(500);
      expect(failed).toHaveBeenCalledTimes(1);
      expect(inc).not.toHaveBeenCalled();
      gate.resolve();
      await runtime.advanceMs(1000);
      expect(inc).toHaveBeenCalledExactlyOnceWith(1, { name: 'build', outcome: 'discarded' });
      expect(observer.begin.mock.results.at(-1)!.value.settled).toHaveBeenCalledWith(
        'terminal-error',
        'discarded',
      );
      expect(processor).toHaveBeenCalledTimes(abandoned ? 0 : 1);
      expect(transport.depth('source')).toBe(0);
      expect(transport.sent.filter((s) => s.queueUrl === 'dead')).toHaveLength(0);
      expect(read).not.toHaveBeenCalled();
      expect(JSON.stringify(logger.warn.mock.calls)).toContain('discarded after');
      expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('payload-canary');
      await service.disconnect();
    },
  );
  it('exports a stable missing-target error type', () => {
    expect(new SqsDeadLetterTargetMissingError('build', 'source').name).toBe(
      'SqsDeadLetterTargetMissingError',
    );
  });
});
