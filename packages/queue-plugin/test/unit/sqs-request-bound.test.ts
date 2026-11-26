import { describe, expect, it, vi } from 'vitest';
import { BackendOutcomeUnknownError, BackendUnavailableError } from '@setu-ts/common';
import { sqsHarness, envelope } from '../fixtures/sqs-harness.ts';
import { toSqsFault } from '../../src/adapters/sqs-faults.ts';
import { adaptSqsModule, SqsQueue } from '../../src/adapters/sqs-queue.ts';
import type { ISqsTransport } from '../../src/adapters/sqs-queue.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

const flush = async () => {
  for (let i = 0; i < 30; i++) await Promise.resolve();
};
describe('SQS request bounds and faults', () => {
  it('forwards every SDK signal and uses a separate one-attempt client only for probes', async () => {
    const configs: Record<string, unknown>[] = [];
    const sends = [vi.fn(), vi.fn()];
    const destroys = [vi.fn(), vi.fn()];
    class Command {
      constructor(readonly input: Record<string, unknown>) {}
    }
    const transport = adaptSqsModule(
      {
        SQSClient: class {
          readonly index: number;
          constructor(config: Record<string, unknown>) {
            this.index = configs.length;
            configs.push(config);
          }
          send(command: unknown, options?: { abortSignal?: AbortSignal }): Promise<unknown> {
            sends[this.index]!(command, options);
            return Promise.resolve({
              Attributes: { QueueArn: 'arn' },
              QueueUrl: 'source',
              Messages: [],
            });
          }
          destroy(): Promise<void> {
            destroys[this.index]!();
            return Promise.resolve();
          }
        },
        SendMessageCommand: Command,
        ReceiveMessageCommand: Command,
        DeleteMessageCommand: Command,
        ChangeMessageVisibilityCommand: Command,
        GetQueueAttributesCommand: Command,
        GetQueueUrlCommand: Command,
      },
      { region: 'region', endpoint: 'endpoint' },
    );
    expect(configs).toEqual([
      { region: 'region', endpoint: 'endpoint' },
      { region: 'region', endpoint: 'endpoint', maxAttempts: 1 },
    ]);
    const options = { abortSignal: new AbortController().signal };
    await transport.send('source', '{}', undefined, undefined, options);
    await transport.receive('source', 1, 30, 7, options);
    await transport.delete('source', 'receipt', options);
    await transport.changeVisibility('source', 'receipt', 5, options);
    await transport.getQueueAttributes!('source', ['RedrivePolicy'], options);
    await transport.getQueueUrl!('name', 'owner', options);
    expect(sends[0]).toHaveBeenCalledTimes(6);
    for (const call of sends[0]!.mock.calls) expect(call[1]).toBe(options);
    expect(sends[0]!.mock.calls[1]![0]).toMatchObject({ input: { WaitTimeSeconds: 7 } });
    await transport.getQueueAttributes!('source', ['QueueArn']);
    expect(sends[1]).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ input: { QueueUrl: 'source', AttributeNames: ['QueueArn'] } }),
      undefined,
    );
    await transport.close();
    for (const destroy of destroys) expect(destroy).toHaveBeenCalledOnce();
  });
  it.each([undefined, 0])(
    'uses the default send bound or explicit disabled bound %s',
    async (requestTimeoutMs) => {
      const h = await sqsHarness(requestTimeoutMs === undefined ? {} : { requestTimeoutMs });
      const gate = Promise.withResolvers<void>();
      vi.spyOn(h.transport, 'send').mockReturnValue(gate.promise);
      let settled = false;
      const result = h.queue
        .enqueue({
          id: 'new',
          name: 'build',
          data: {},
          attempts: 0,
          maxAttempts: 3,
          availableAtMs: 0,
        })
        .catch((error: unknown) => error)
        .finally(() => {
          settled = true;
        });
      await flush();
      await h.runtime.advanceMs(requestTimeoutMs === 0 ? 16000 : 14999);
      expect(settled).toBe(false);
      if (requestTimeoutMs === 0) {
        gate.resolve();
        expect(await result).toBeUndefined();
      } else {
        await h.runtime.advanceMs(1);
        expect(await result).toBeInstanceOf(BackendOutcomeUnknownError);
      }
      await h.queue.disconnect();
    },
  );
  it.each(['send', 'receive', 'delete', 'changeVisibility', 'renewal'] as const)(
    'bounds and aborts %s',
    async (command) => {
      const h = await sqsHarness({
        requestTimeoutMs: 25,
        waitTimeSeconds: 0,
        deadLetterQueues: { build: false },
      });
      await h.transport.send('source', envelope());
      const job = (await h.queue.reserve('build', 1, 0))[0]!;
      let signal: AbortSignal | undefined;
      const stalled = (...args: unknown[]): Promise<never> => {
        signal = (args.at(-1) as { abortSignal: AbortSignal }).abortSignal;
        return new Promise(() => {});
      };
      const method = command === 'renewal' ? 'changeVisibility' : command;
      vi.spyOn(h.transport, method).mockImplementation(stalled);
      const call =
        command === 'send'
          ? h.queue.enqueue({
              id: 'new',
              name: 'build',
              data: {},
              attempts: 0,
              maxAttempts: 3,
              availableAtMs: 0,
            })
          : command === 'receive'
            ? h.queue.reserve('build', 1, 0)
            : command === 'delete'
              ? h.queue.ack('build', job.id, job.claimToken!)
              : command === 'renewal'
                ? h.queue.claimRenewal.extend('build', job.id, job.claimToken!)
                : h.queue.requeue('build', job.id, 1000, 2, job.claimToken!);
      const result = call.catch((error: unknown) => error);
      await flush();
      await h.runtime.advanceMs(25);
      expect(signal?.aborted).toBe(true);
      if (command === 'renewal') expect(await result).toBe(false);
      else expect(await result).toBeInstanceOf(BackendOutcomeUnknownError);
      await h.queue.disconnect();
    },
  );
  it.each([0, 25, 15000])('keeps redrive reads finite with option %s', async (requestTimeoutMs) => {
    let signal: AbortSignal | undefined;
    const getQueueAttributes: ISqsTransport['getQueueAttributes'] = (_url, _names, options) => {
      signal = options?.abortSignal;
      return new Promise(() => {});
    };
    const h = await sqsHarness({ requestTimeoutMs, deadLetterQueues: {} }, { getQueueAttributes });
    const result = h.queue.prepareConsumer('build').catch((error: unknown) => error);
    await flush();
    await h.runtime.advanceMs(requestTimeoutMs === 0 ? 10000 : Math.min(requestTimeoutMs, 10000));
    expect(await result).toMatchObject({ name: 'SqsDeadLetterTargetMissingError' });
    expect(signal?.aborted).toBe(true);
    await h.queue.disconnect();
  });
  it.each([
    [{ code: 'ECONNREFUSED' }, BackendUnavailableError],
    [{ code: 'ECONNREFUSED', $metadata: { attempts: 2 } }, BackendOutcomeUnknownError],
    [{ code: 'ECONNRESET' }, BackendOutcomeUnknownError],
    [{ $metadata: { httpStatusCode: 503, attempts: 1 } }, BackendUnavailableError],
    [{ $metadata: { httpStatusCode: 500, attempts: 2 } }, BackendOutcomeUnknownError],
    [{ name: 'ThrottlingException' }, BackendUnavailableError],
    [{ $retryable: { throttling: true }, $metadata: { attempts: 2 } }, BackendOutcomeUnknownError],
  ] as const)('classifies %j', (error, Expected) => {
    expect(toSqsFault(error, 'test')).toBeInstanceOf(Expected);
    expect(toSqsFault(error, 'test')).toMatchObject({ source: 'test', cause: error });
  });
  it.each([new Error('unrecognized'), null, 'failure', { $metadata: { httpStatusCode: 403 } }])(
    'preserves refusal %j',
    (error) => expect(toSqsFault(error, 'test')).toBe(error),
  );
  it.each([-1, NaN, Infinity, 2147483648])('refuses request bound %s', (requestTimeoutMs) =>
    expect(
      () => new SqsQueue(new FakeRuntimeServices(0), { queues: {}, requestTimeoutMs }),
    ).toThrow(RangeError),
  );
});
