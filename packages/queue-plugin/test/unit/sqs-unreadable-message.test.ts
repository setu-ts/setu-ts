import { describe, expect, it, vi } from 'vitest';
import { sqsHarness, envelope } from '../fixtures/sqs-harness.ts';
import type { IMetricsService } from '@setu-ts/common';
import { QueueCollector } from '../../src/metrics/queue-collector.ts';
import { QueueService } from '../../src/services/queue-service.ts';

async function flushRetirement(): Promise<void> {
  for (let i = 0; i < 50; i++) await Promise.resolve();
}

describe('SQS unreadable messages', () => {
  it('never writes the unreadable payload into warnings or errors', async () => {
    const { queue, transport, logger } = await sqsHarness();
    await transport.send('source', JSON.stringify({ v: 2, secret: 'payload-canary' }));
    await queue.reserve('build', 1, 0);
    expect(JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls])).not.toContain(
      'payload-canary',
    );
    await queue.disconnect();
  });
  it.each([
    '{payload-canary',
    JSON.stringify({ v: 2, secret: 'payload-canary' }),
    JSON.stringify({ v: 1, id: 'j1', name: 'other', data: 'payload-canary' }),
    JSON.stringify({ Type: 'SubscriptionConfirmation', Token: 'payload-canary' }),
  ])(
    'retires unreadable bytes unchanged to the polled target without logging them',
    async (body) => {
      const { queue, transport, logger, runtime } = await sqsHarness();
      await transport.send('source', body);
      expect(await queue.reserve('build', 1, 0)).toEqual([]);
      await flushRetirement();
      expect(transport.sent.at(-1)).toMatchObject({
        queueUrl: 'dead',
        body,
        attributes: { 'setu-dead-letter-reason': { StringValue: 'unreadable' } },
      });
      expect(transport.depth('source')).toBe(0);
      await runtime.advanceMs(4000);
      expect(await queue.reserve('build', 1, runtime.now())).toEqual([]);
      await flushRetirement();
      expect(logger.warn).toHaveBeenCalledWith(expect.stringMatching(/build.*msg-1/));
      expect(JSON.stringify([logger.warn.mock.calls, logger.error.mock.calls])).not.toContain(
        'payload-canary',
      );
      await queue.disconnect();
    },
  );
  it.each(['NaN', 'Infinity', '-1', '0', '1.5', ''])(
    'retires invalid receive count %s without creating a job',
    async (count) => {
      const { queue, transport } = await sqsHarness(
        {},
        {
          receive: () =>
            Promise.resolve([
              {
                body: envelope(),
                receiptHandle: 'receipt',
                approximateReceiveCount: count,
                messageId: 'mid',
              },
            ]),
        },
      );
      expect(await queue.reserve('build', 1, 0)).toEqual([]);
      await flushRetirement();
      expect(transport.sent.at(-1)!.attributes!['setu-attempts']!.StringValue).toBe('0');
      expect(transport.deleted).toEqual([{ queueUrl: 'source', receiptHandle: 'receipt' }]);
      await queue.disconnect();
    },
  );
  it('leaves failed forwards for the visibility timeout and warns again on receive', async () => {
    const { queue, transport, logger, runtime } = await sqsHarness();
    await transport.send('source', '{payload-canary');
    const send = vi
      .spyOn(transport, 'send')
      .mockRejectedValueOnce(new Error('down'))
      .mockRejectedValueOnce(new Error('down'));
    expect(await queue.reserve('build', 1, 0)).toEqual([]);
    await flushRetirement();
    await runtime.advanceMs(3000);
    expect(await queue.reserve('build', 1, runtime.now())).toEqual([]);
    await flushRetirement();
    expect(send).toHaveBeenCalledTimes(2);
    expect(transport.depth('source')).toBe(1);
    expect(transport.deleted).toEqual([]);
    expect(
      logger.warn.mock.calls.filter(([m]) => m.includes('left for its visibility timeout')),
    ).toHaveLength(2);
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('payload-canary');
    await queue.disconnect();
  });
  it('discards unreadable opt-out work without onFailed or metrics', async () => {
    const read = vi.fn(() => Promise.resolve({}));
    const { queue, transport, logger, runtime } = await sqsHarness(
      { deadLetterQueues: { build: false } },
      { getQueueAttributes: read },
    );
    const failed = vi.fn();
    const counted = vi.fn();
    const service = new QueueService(queue, runtime, {
      collector: new QueueCollector(
        { counter: () => ({ inc: counted }) } as unknown as IMetricsService,
        vi.fn(),
      ),
      pollIntervalMs: 100,
    });
    await service.connect();
    service.process('build', vi.fn(), { onFailed: failed });
    await transport.send('source', '{payload-canary');
    await runtime.advanceMs(1000);
    expect(transport.depth('source')).toBe(0);
    expect(failed).not.toHaveBeenCalled();
    expect(counted).not.toHaveBeenCalled();
    expect(read).not.toHaveBeenCalled();
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(logger.warn.mock.calls)).toContain('discarded');
    expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('payload-canary');
    await service.disconnect();
  });
});
