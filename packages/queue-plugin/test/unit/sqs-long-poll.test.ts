import { describe, expect, it, vi } from 'vitest';
import { sqsHarness } from '../fixtures/sqs-harness.ts';
import { SqsQueue } from '../../src/adapters/sqs-queue.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

describe('SQS long polling', () => {
  it('keeps receive unbounded when the request bound is explicitly disabled', async () => {
    const gate =
      Promise.withResolvers<
        readonly import('../../src/adapters/sqs-queue.ts').SqsReceivedMessage[]
      >();
    const h = await sqsHarness(
      { requestTimeoutMs: 0, deadLetterQueues: { build: false } },
      { receive: () => gate.promise },
    );
    let settled = false;
    const result = h.queue.reserve('build', 1, 0).finally(() => {
      settled = true;
    });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await h.runtime.advanceMs(40000);
    expect(settled).toBe(false);
    gate.resolve([]);
    expect(await result).toEqual([]);
    await h.queue.disconnect();
  });
  it('adds the long poll duration to the request bound', async () => {
    const h = await sqsHarness(
      { requestTimeoutMs: 25, waitTimeSeconds: 20, deadLetterQueues: { build: false } },
      { receive: () => new Promise(() => {}) },
    );
    let settled = false;
    const result = h.queue.reserve('build', 1, 0).catch((error: unknown) => {
      settled = true;
      return error;
    });
    for (let i = 0; i < 30; i++) await Promise.resolve();
    await h.runtime.advanceMs(20024);
    expect(settled).toBe(false);
    await h.runtime.advanceMs(1);
    expect(await result).toMatchObject({ name: 'BackendOutcomeUnknownError' });
    await h.queue.disconnect();
  });
  it.each([undefined, 0, 5])('forwards waitTimeSeconds %s', async (waitTimeSeconds) => {
    const receive = vi.fn(() => Promise.resolve([]));
    const h = await sqsHarness(
      {
        deadLetterQueues: { build: false },
        ...(waitTimeSeconds === undefined ? {} : { waitTimeSeconds }),
      },
      { receive },
    );
    await h.queue.reserve('build', 1, 0);
    expect(receive).toHaveBeenCalledWith('source', 1, 3, waitTimeSeconds ?? 20, {
      abortSignal: expect.any(AbortSignal),
    });
    await h.queue.disconnect();
  });
  it('aborts a waiting receive on disconnect', async () => {
    const receive = vi.fn<
      NonNullable<import('../../src/adapters/sqs-queue.ts').ISqsTransport['receive']>
    >(
      (_url, _max, _visibility, _wait, options) =>
        new Promise((_, reject) => {
          options!.abortSignal!.addEventListener(
            'abort',
            () => reject(options!.abortSignal!.reason),
            { once: true },
          );
        }),
    );
    const h = await sqsHarness({ deadLetterQueues: { build: false } }, { receive });
    const result = h.queue.reserve('build', 1, 0).catch((error: unknown) => error);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    await h.queue.disconnect();
    expect(receive.mock.calls[0]![4]!.abortSignal!.aborted).toBe(true);
    expect(await result).toBeInstanceOf(Error);
  });
  it.each([-1, 21, 1.5, NaN, Infinity])('refuses %s', (waitTimeSeconds) => {
    expect(() => new SqsQueue(new FakeRuntimeServices(0), { queues: {}, waitTimeSeconds })).toThrow(
      RangeError,
    );
  });
  it('warns about socket saturation once on connect', async () => {
    const h = await sqsHarness({
      queues: Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`job${i}`, `url${i}`])),
    });
    await h.queue.connect();
    expect(h.logger.warn).toHaveBeenCalledTimes(1);
    expect(h.logger.warn.mock.calls[0]![0]).toContain('50 HTTP sockets');
    await h.queue.disconnect();
  });
});
