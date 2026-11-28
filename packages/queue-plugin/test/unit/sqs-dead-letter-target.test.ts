import { describe, expect, it, vi } from 'vitest';
import { SqsQueue, SqsDeadLetterTargetMissingError } from '../../src/index.ts';
import { sqsHarness, envelope } from '../fixtures/sqs-harness.ts';

const arn = 'arn:aws:sqs:us-east-1:123456789012:dead.fifo';
const policy = (maxReceiveCount: unknown = '3', deadLetterTargetArn: unknown = arn) => ({
  RedrivePolicy: JSON.stringify({ maxReceiveCount, deadLetterTargetArn }),
});

describe('SQS consumer dead-letter targets', () => {
  it.each(['toString', 'constructor'])(
    'refuses inherited dead-letter targets for %s',
    async (name) => {
      const { queue } = await sqsHarness({ queues: { [name]: 'source' }, deadLetterQueues: {} });
      try {
        await expect(queue.prepareConsumer(name)).rejects.toBeInstanceOf(
          SqsDeadLetterTargetMissingError,
        );
      } finally {
        await queue.disconnect();
      }
    },
  );
  it.each(['toString', 'constructor'])(
    'refuses inherited source queue URLs for %s',
    async (name) => {
      const { queue } = await sqsHarness({ queues: {}, deadLetterQueues: { [name]: false } });
      try {
        await expect(queue.prepareConsumer(name)).rejects.toThrow('is not configured');
      } finally {
        await queue.disconnect();
      }
    },
  );
  it('falls back to an error-only logger for clamp warnings', async () => {
    const {
      queue: existing,
      transport,
      runtime,
    } = await sqsHarness({}, { getQueueAttributes: () => Promise.resolve(policy(3)) });
    await existing.disconnect();
    const error = vi.fn<(message: string) => void>();
    const queue = new SqsQueue(
      runtime,
      { queues: { build: 'source' }, deadLetterQueues: { build: 'dead' }, client: transport },
      { error },
    );
    await queue.connect();
    try {
      await transport.send('source', envelope(8));
      const [job] = await queue.reserve('build', 1, 0);
      expect(job!.maxAttempts).toBe(2);
      expect(error).toHaveBeenCalledWith(expect.stringContaining('effective budget=2'));
    } finally {
      await queue.disconnect();
    }
  });
  it('does not prepare producer-only names and refuses consumption without a target', async () => {
    const { queue, transport } = await sqsHarness({ deadLetterQueues: {} });
    await queue.enqueue({
      id: 'j1',
      name: 'build',
      data: {},
      attempts: 0,
      maxAttempts: 3,
      availableAtMs: 0,
    });
    expect(transport.depth('source')).toBe(1);
    await expect(queue.prepareConsumer('build')).rejects.toBeInstanceOf(
      SqsDeadLetterTargetMissingError,
    );
    await expect(queue.reserve('build', 1, 0)).rejects.toThrow(/build.*source/);
    expect(transport.deleted).toEqual([]);
    try {
      await queue.prepareConsumer('build');
    } catch (error) {
      for (const text of [
        'deadLetterQueues entry',
        'redrive policy',
        "deadLetterQueues: { 'build': false }",
        'sqs:GetQueueAttributes',
        'sqs:GetQueueUrl',
        'sqs:SendMessage',
        'kms:GenerateDataKey',
        'kms:Decrypt',
      ]) {
        expect((error as Error).message).toContain(text);
      }
    }
    await queue.disconnect();
  });
  it('resolves a policy URL once, shares preparation and clamps each job budget with one warning', async () => {
    const read = vi.fn(() => Promise.resolve(policy()));
    const getUrl = vi.fn(() => Promise.resolve('policy-dead'));
    const { queue, transport, logger } = await sqsHarness(
      { deadLetterQueues: {} },
      { getQueueAttributes: read, getQueueUrl: getUrl },
    );
    await Promise.all([queue.prepareConsumer('build'), queue.prepareConsumer('build')]);
    expect(read).toHaveBeenCalledTimes(1);
    expect(getUrl).toHaveBeenCalledExactlyOnceWith('dead.fifo', '123456789012', {
      abortSignal: expect.any(AbortSignal),
    });
    for (const maxAttempts of [8, 9]) {
      await transport.send('source', envelope(maxAttempts));
      const [job] = await queue.reserve('build', 1, 0);
      expect(job!.maxAttempts).toBe(2);
      await queue.deadLetter('build', job!.id, 0, job!.claimToken!);
    }
    expect(logger.warn).toHaveBeenCalledTimes(1);
    expect(logger.warn.mock.calls[0]![0]).toMatch(
      /maxAttempts=8.*maxReceiveCount=3.*budget=2.*maxReceiveCount = maxAttempts \+ 1/,
    );
    expect(transport.sent.filter((s) => s.queueUrl === 'policy-dead')).toHaveLength(2);
    await queue.disconnect();
  });
  it.each([1, '1', 1000, '1000', 3])(
    'accepts a policy count %s and lets explicit URL win',
    async (count) => {
      const getUrl = vi.fn(() => Promise.resolve('unused'));
      const { queue, transport, logger } = await sqsHarness(
        {},
        { getQueueAttributes: () => Promise.resolve(policy(count)), getQueueUrl: getUrl },
      );
      await transport.send('source', envelope(8));
      const [job] = await queue.reserve('build', 1, 0);
      expect(job!.maxAttempts).toBe(Math.max(1, Math.min(8, Number(count) - 1)));
      await queue.deadLetter('build', 'j1', 0, job!.claimToken!);
      expect(getUrl).not.toHaveBeenCalled();
      expect(transport.sent.at(-1)!.queueUrl).toBe('dead');
      if (Number(count) === 1) expect(logger.warn.mock.calls[0]![0]).toContain('without onFailed');
      await queue.disconnect();
    },
  );
  it.each([0, -1, 1001, 1.1, '1.1', ' 3', '+3', 'NaN', null, {}, '', 'Infinity'])(
    'refuses malformed policy count %j without a target',
    async (count) => {
      const { queue } = await sqsHarness(
        { deadLetterQueues: {} },
        { getQueueAttributes: () => Promise.resolve(policy(count)) },
      );
      await expect(queue.prepareConsumer('build')).rejects.toBeInstanceOf(
        SqsDeadLetterTargetMissingError,
      );
      await queue.disconnect();
    },
  );
  it.each(['bad', '', 'arn:aws:sns:r:123:dead', null, 1])(
    'refuses malformed target ARN %j',
    async (target) => {
      const { queue } = await sqsHarness(
        { deadLetterQueues: {} },
        { getQueueAttributes: () => Promise.resolve(policy(3, target)) },
      );
      await expect(queue.prepareConsumer('build')).rejects.toBeInstanceOf(
        SqsDeadLetterTargetMissingError,
      );
      await queue.disconnect();
    },
  );
  it.each([
    'absent',
    'denied',
    'no-policy',
    'bad-json',
    'null-policy',
    'unresolvable',
    'empty-url',
    'url-denied',
  ] as const)('handles %s with and without explicit URL', async (kind) => {
    for (const explicit of [false, true]) {
      const { queue, logger } = await sqsHarness(
        { deadLetterQueues: explicit ? { build: 'dead' } : {} },
        {
          ...(kind === 'absent'
            ? {}
            : {
                getQueueAttributes: () => {
                  if (kind === 'denied') throw new Error('AccessDenied payload-canary');
                  if (kind === 'no-policy') return Promise.resolve({});
                  if (kind === 'bad-json') return Promise.resolve({ RedrivePolicy: '{' });
                  if (kind === 'null-policy') return Promise.resolve({ RedrivePolicy: 'null' });
                  return Promise.resolve(policy());
                },
              }),
          ...(kind === 'empty-url' ? { getQueueUrl: () => Promise.resolve('') } : {}),
          ...(kind === 'url-denied'
            ? {
                getQueueUrl: () => {
                  return Promise.reject(new Error('denied'));
                },
              }
            : {}),
        },
      );
      if (explicit) {
        await queue.prepareConsumer('build');
        await queue.prepareConsumer('build');
        // A successful absent-policy read or a usable policy needs no fallback warning.
        expect(logger.warn.mock.calls.length).toBe(
          ['no-policy', 'unresolvable', 'empty-url', 'url-denied'].includes(kind) ? 0 : 1,
        );
        expect(JSON.stringify(logger.warn.mock.calls)).not.toContain('payload-canary');
      } else
        await expect(queue.prepareConsumer('build')).rejects.toBeInstanceOf(
          SqsDeadLetterTargetMissingError,
        );
      await queue.disconnect();
    }
  });
  it('runs independent reads in parallel, bounds them and clears timers on shutdown', async () => {
    const read = vi.fn(() => new Promise<Readonly<Record<string, string>>>(() => {}));
    const { queue, runtime } = await sqsHarness(
      { deadLetterQueues: {} },
      { getQueueAttributes: read },
    );
    const results = Promise.allSettled([
      queue.prepareConsumer('build'),
      queue.prepareConsumer('other'),
    ]);
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(read).toHaveBeenCalledTimes(2);
    expect(runtime.timerCount).toBe(2);
    await runtime.advanceMs(9999);
    expect(runtime.timerCount).toBe(2);
    await runtime.advanceMs(1);
    expect((await results).map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(runtime.timerCount).toBe(0);
    await queue.disconnect();
  });
  it('cancels pending attributes and URL lookups without repopulating state', async () => {
    for (const phase of ['attributes', 'url']) {
      const gate = Promise.withResolvers<Record<string, string>>();
      const urlGate = Promise.withResolvers<string>();
      const { queue, runtime, transport } = await sqsHarness(
        { deadLetterQueues: {} },
        {
          getQueueAttributes: () =>
            phase === 'attributes' ? gate.promise : Promise.resolve(policy()),
          getQueueUrl: () => urlGate.promise,
        },
      );
      const pending = queue.prepareConsumer('build');
      const result = expect(pending).rejects.toBeInstanceOf(SqsDeadLetterTargetMissingError);
      for (let i = 0; i < 20; i++) await Promise.resolve();
      await queue.disconnect();
      await result;
      expect(runtime.timerCount).toBe(0);
      gate.resolve(policy());
      urlGate.resolve('late');
      expect(transport.closed).toBe(true);
      await expect(queue.prepareConsumer('build')).rejects.toThrow('not connected');
    }
  });
  it.each(['attempts-exhausted', 'abandoned'] as const)(
    'forwards original bytes and attributes for %s before deleting',
    async (reason) => {
      const { queue, transport } = await sqsHarness();
      await transport.send('source', envelope());
      const [job] = await queue.reserve('build', 1, 0);
      await queue.deadLetter('build', 'j1', 0, job!.claimToken!, reason);
      expect(transport.sent.at(-1)).toMatchObject({
        queueUrl: 'dead',
        body: envelope(),
        attributes: {
          'setu-dead-letter-reason': { DataType: 'String', StringValue: reason },
          'setu-attempts': { DataType: 'Number', StringValue: '1' },
          'setu-source-message-id': { DataType: 'String', StringValue: 'msg-1' },
        },
      });
      expect(transport.depth('source')).toBe(0);
      expect(transport.depth('dead')).toBe(1);
      await queue.disconnect();
    },
  );
  it('keeps the source and claim on send failure and throws on delete failure after forward', async () => {
    const { queue, transport, logger } = await sqsHarness();
    await transport.send('source', envelope());
    const [job] = await queue.reserve('build', 1, 0);
    vi.spyOn(transport, 'send').mockRejectedValueOnce(new Error('send failed'));
    await expect(queue.deadLetter('build', 'j1', 0, job!.claimToken!)).rejects.toThrow(
      'send failed',
    );
    expect(transport.deleted).toEqual([]);
    vi.spyOn(transport, 'delete').mockRejectedValueOnce(new Error('delete failed'));
    await expect(queue.deadLetter('build', 'j1', 0, job!.claimToken!)).rejects.toThrow(
      'delete failed',
    );
    expect(logger.error).toHaveBeenCalledWith(expect.stringContaining('possible duplicate'));
    expect(transport.depth('source')).toBe(1);
    await queue.deadLetter('build', 'j1', 0, job!.claimToken!);
    expect(transport.depth('source')).toBe(0);
    await queue.disconnect();
  });
  it('uses the consumer default for an envelope without maxAttempts', async () => {
    const { queue, transport } = await sqsHarness();
    await transport.send('source', JSON.stringify({ v: 1, id: 'j1', name: 'build', data: null }));
    expect((await queue.reserve('build', 1, 0))[0]!.maxAttempts).toBe(7);
    await queue.disconnect();
  });
});
