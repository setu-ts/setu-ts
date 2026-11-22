import { describe, expect, it, vi } from 'vitest';
import { SqsDeadLetterTargetMissingError } from '../../src/index.ts';
import type { SqsDeadLetterTargetMissingReason } from '../../src/index.ts';
import type { ISqsTransport } from '../../src/adapters/sqs-queue.ts';
import { sqsHarness } from '../fixtures/sqs-harness.ts';

const arn = 'arn:aws:sqs:us-east-1:123456789012:dead';
const readFault = new Error('AccessDenied');
const urlFault = new Error('QueueDoesNotExist');

/** Each way a consumed name ends with no provable target, as test data. */
const refusals: ReadonlyArray<{
  readonly title: string;
  readonly transport: Partial<ISqsTransport>;
  readonly reason: SqsDeadLetterTargetMissingReason;
  readonly cause?: unknown;
  readonly text: string;
}> = [
  {
    title: 'no policy on the queue',
    transport: { getQueueAttributes: () => Promise.resolve({}) },
    reason: 'no-target',
    text: 'no deadLetterQueues entry and the queue has no RedrivePolicy',
  },
  {
    title: 'a policy that is not JSON',
    transport: { getQueueAttributes: () => Promise.resolve({ RedrivePolicy: '{not json' }) },
    reason: 'policy-unreadable',
    text: "the queue's RedrivePolicy cannot be read",
  },
  {
    title: 'a policy with a malformed maxReceiveCount',
    transport: {
      getQueueAttributes: () =>
        Promise.resolve({
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 'three' }),
        }),
    },
    reason: 'policy-unreadable',
    text: "the queue's RedrivePolicy cannot be read",
  },
  {
    title: 'a transport without getQueueAttributes',
    transport: {},
    reason: 'attributes-unavailable',
    text: "the queue's attributes (RedrivePolicy) could not be read",
  },
  {
    title: 'a refused attribute read',
    transport: { getQueueAttributes: () => Promise.reject(readFault) },
    reason: 'attributes-unavailable',
    cause: readFault,
    text: "the queue's attributes (RedrivePolicy) could not be read",
  },
  {
    title: 'a policy target with no getQueueUrl',
    transport: {
      getQueueAttributes: () =>
        Promise.resolve({
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 4 }),
        }),
    },
    reason: 'target-unresolvable',
    text: "the RedrivePolicy target's queue URL could not be resolved",
  },
  {
    title: 'a policy target whose URL lookup fails',
    transport: {
      getQueueAttributes: () =>
        Promise.resolve({
          RedrivePolicy: JSON.stringify({ deadLetterTargetArn: arn, maxReceiveCount: 4 }),
        }),
      getQueueUrl: () => Promise.reject(urlFault),
    },
    reason: 'target-unresolvable',
    cause: urlFault,
    text: "the RedrivePolicy target's queue URL could not be resolved",
  },
];

describe('SQS dead-letter refusal reasons', () => {
  for (const row of refusals) {
    it(`names ${row.title} as ${row.reason}`, async () => {
      const { queue } = await sqsHarness({ deadLetterQueues: {} }, row.transport);
      const error = await queue.prepareConsumer('build').then(
        () => undefined,
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(SqsDeadLetterTargetMissingError);
      const refusal = error as SqsDeadLetterTargetMissingError;
      expect(refusal.reason).toBe(row.reason);
      expect(refusal.message).toContain(row.text);
      expect(refusal.cause).toBe(row.cause);
      await queue.disconnect();
    });
  }

  it('keeps an explicit target and warns with the read failure when attributes are refused', async () => {
    const { queue, logger } = await sqsHarness(
      { deadLetterQueues: { build: 'dead' } },
      { getQueueAttributes: () => Promise.reject(readFault) },
    );
    await queue.prepareConsumer('build');
    expect(logger.warn).toHaveBeenCalledExactlyOnceWith(
      expect.stringContaining("the queue's attributes (RedrivePolicy) could not be read"),
    );
    await queue.disconnect();
  });

  it('times out an attribute read with the timeout as the cause', async () => {
    const pending = vi.fn(() => new Promise<Readonly<Record<string, string>>>(() => {}));
    const { queue, runtime } = await sqsHarness(
      { deadLetterQueues: {} },
      { getQueueAttributes: pending },
    );
    const outcome = queue.prepareConsumer('build').then(
      () => undefined,
      (caught: unknown) => caught,
    );
    await runtime.advanceMs(10_000);
    const error = (await outcome) as SqsDeadLetterTargetMissingError;
    expect(error.reason).toBe('attributes-unavailable');
    expect(String((error.cause as Error).message)).toContain('timed out after 10000 ms');
    await queue.disconnect();
  });

  it('defaults the reason to no-target and omits a cause', () => {
    const error = new SqsDeadLetterTargetMissingError('build', 'source');
    expect(error.reason).toBe('no-target');
    expect('cause' in error).toBe(false);
  });
});
