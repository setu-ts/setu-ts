import { describe, expect, it, vi } from 'vitest';
import { envelope, sqsHarness } from '../fixtures/sqs-harness.ts';
import { QueueService } from '../../src/services/queue-service.ts';

const policy = {
  RedrivePolicy: JSON.stringify({
    deadLetterTargetArn: 'arn:aws:sqs:r:123:dead',
    maxReceiveCount: '5',
  }),
};
async function flush(): Promise<void> {
  for (let i = 0; i < 100; i++) await Promise.resolve();
}

describe('SQS reserve and preparation boundaries', () => {
  it('rechecks the generation before returning when a retirement transport disconnects synchronously', async () => {
    const { queue, transport } = await sqsHarness();
    await transport.send('source', '{unreadable');
    await transport.send('source', envelope());
    let shutdown: Promise<void> | undefined;
    vi.spyOn(transport, 'send').mockImplementationOnce(() => {
      shutdown = queue.disconnect();
      return Promise.resolve();
    });
    await expect(queue.reserve('build', 2, 0)).rejects.toThrow('not connected');
    await shutdown;
    expect(transport.closed).toBe(true);
  });
  it('absorbs throwing diagnostics from detached unreadable retirement', async () => {
    const { queue, transport, logger } = await sqsHarness();
    await queue.prepareConsumer('build');
    logger.warn.mockImplementation(() => {
      throw new Error('logger');
    });
    await transport.send('source', '{unreadable');
    expect(await queue.reserve('build', 1, 0)).toEqual([]);
    await queue.disconnect();
    expect(transport.depth('source')).toBe(0);
  });
  it('backs off repeated transient failures and resets the delay after recovery', async () => {
    const read = vi.fn().mockRejectedValue(new Error('unavailable'));
    const { queue, runtime, transport } = await sqsHarness(
      { deadLetterQueues: {} },
      { getQueueAttributes: read, getQueueUrl: () => Promise.resolve('dead') },
    );
    const logger = { error: vi.fn() };
    const service = new QueueService(queue, runtime, { logger, pollIntervalMs: 100 });
    const receive = vi.spyOn(transport, 'receive');
    await service.connect();
    service.process('build', vi.fn());
    await flush();
    expect(read).toHaveBeenCalledTimes(1);
    for (const delay of [1000, 2000, 5000, 10000, 30000, 30000]) {
      const calls = read.mock.calls.length;
      await runtime.advanceMs(delay - 100);
      expect(read).toHaveBeenCalledTimes(calls);
      await runtime.advanceMs(100);
      await flush();
      expect(read).toHaveBeenCalledTimes(calls + 1);
    }
    expect(receive).not.toHaveBeenCalled();
    expect(logger.error).toHaveBeenCalledOnce();
    read.mockResolvedValue(policy);
    await runtime.advanceMs(30000);
    await flush();
    expect(receive).toHaveBeenCalled();
    await service.disconnect();
    expect(runtime.timerCount).toBe(0);
  });

  it.each([{}, { RedrivePolicy: '{broken' }])(
    'keeps definite preparation refusal cached: %j',
    async (attributes) => {
      const read = vi.fn(() => Promise.resolve(attributes));
      const { queue, runtime } = await sqsHarness(
        { deadLetterQueues: {} },
        { getQueueAttributes: read },
      );
      const logger = { error: vi.fn() };
      const service = new QueueService(queue, runtime, { logger, pollIntervalMs: 100 });
      await service.connect();
      service.process('build', vi.fn());
      await runtime.advanceMs(60000);
      expect(read).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledOnce();
      await service.disconnect();
    },
  );
  it('returns batch claims while unreadable retirement is pending and drains retirement on disconnect', async () => {
    const { queue, transport, runtime } = await sqsHarness();
    await transport.send('source', '{unreadable');
    await transport.send('source', envelope());
    const gate = Promise.withResolvers<void>();
    const send = transport.send.bind(transport);
    vi.spyOn(transport, 'send').mockImplementation(async (...args) => {
      await gate.promise;
      return send(...args);
    });
    let returned = false;
    const reserve = queue.reserve('build', 2, 0).then((jobs) => {
      returned = true;
      return jobs;
    });
    await flush();
    expect(returned).toBe(true);
    const [job] = await reserve;
    await runtime.advanceMs(1000);
    expect(await queue.claimRenewal.extend('build', job!.id, job!.claimToken!)).toBe(true);
    let disconnected = false;
    const shutdown = queue.disconnect().then(() => {
      disconnected = true;
    });
    await flush();
    expect(disconnected).toBe(false);
    gate.resolve();
    await shutdown;
    expect(transport.depth('source')).toBe(1);
    expect(transport.depth('dead')).toBe(1);
    expect(transport.closed).toBe(true);
  });

  it('rejects a receive from an earlier connection even with the same injected transport', async () => {
    const { queue, transport, runtime } = await sqsHarness();
    vi.spyOn(runtime, 'uuid').mockReturnValue('old-claim');
    const receive = Promise.withResolvers<Awaited<ReturnType<typeof transport.receive>>>();
    vi.spyOn(transport, 'receive').mockReturnValueOnce(receive.promise);
    const pending = queue.reserve('build', 1, 0);
    await flush();
    await queue.disconnect();
    await queue.connect();
    receive.resolve([{ body: envelope(), receiptHandle: 'old', approximateReceiveCount: '1' }]);
    await expect(pending).rejects.toThrow('not connected');
    await expect(queue.ack('build', 'j1', 'old-claim')).rejects.toThrow('claim is stale');
    await queue.disconnect();
  });

  it.each(['attributes-unavailable', 'target-unresolvable'] as const)(
    'retries transient %s preparation on later polls with backoff',
    async (reason) => {
      const attributes = vi.fn().mockRejectedValueOnce(new Error('read')).mockResolvedValue(policy);
      const url = vi.fn().mockRejectedValueOnce(new Error('lookup')).mockResolvedValue('dead');
      if (reason === 'target-unresolvable') attributes.mockReset().mockResolvedValue(policy);
      else url.mockReset().mockResolvedValue('dead');
      const { queue, runtime, transport } = await sqsHarness(
        { deadLetterQueues: {} },
        { getQueueAttributes: attributes, getQueueUrl: url },
      );
      const logger = { error: vi.fn() };
      const service = new QueueService(queue, runtime, { logger, pollIntervalMs: 100 });
      const handler = vi.fn();
      const receive = vi.spyOn(transport, 'receive');
      await service.connect();
      await transport.send('source', envelope());
      service.process('build', handler);
      await runtime.advanceMs(500);
      expect(receive).not.toHaveBeenCalled();
      expect(attributes).toHaveBeenCalledTimes(1);
      await runtime.advanceMs(2000);
      expect(handler).toHaveBeenCalledOnce();
      expect(logger.error).toHaveBeenCalledTimes(1);
      await service.disconnect();
      expect(runtime.timerCount).toBe(0);
    },
  );

  it('evicts only transient adapter preparation failures', async () => {
    const read = vi.fn().mockRejectedValueOnce(new Error('transient')).mockResolvedValue(policy);
    const { queue } = await sqsHarness(
      { deadLetterQueues: {} },
      { getQueueAttributes: read, getQueueUrl: () => Promise.resolve('dead') },
    );
    await expect(queue.prepareConsumer('build')).rejects.toMatchObject({
      reason: 'attributes-unavailable',
    });
    await expect(queue.prepareConsumer('build')).resolves.toBeUndefined();
    expect(read).toHaveBeenCalledTimes(2);
    await queue.disconnect();
  });
});
