import { CAPABILITIES } from '@setu-ts/common';
import type { IQueue } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { describe, expect, it, vi } from 'vitest';
import { QueuePlugin } from '../../src/index.ts';
import type { QueuePluginOptions } from '../../src/index.ts';
import { QueueService } from '../../src/services/queue-service.ts';
import { MemoryQueue } from '../../src/adapters/memory-queue.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';
import { sqsHarness, envelope } from '../fixtures/sqs-harness.ts';

describe('Queue retry delay option', () => {
  describe.each(['plugin', 'service'] as const)('%s construction', (entry) => {
    const construct = (input: unknown): unknown => {
      const options = input as QueuePluginOptions;
      return entry === 'plugin'
        ? QueuePlugin(options)
        : new QueueService(new MemoryQueue(), new FakeRuntimeServices(0), options);
    };

    it.each([
      { label: 'numeric string', value: '100' },
      { label: 'object', value: {} },
      { label: 'boolean', value: true },
      { label: 'null', value: null },
      { label: 'negative number', value: -1 },
      { label: 'NaN', value: NaN },
      { label: 'Infinity', value: Infinity },
    ])('refuses $label synchronously', ({ value }) => {
      expect(() => construct({ retryDelayMs: value })).toThrow(RangeError);
    });

    it.each([
      { label: 'zero', options: { retryDelayMs: 0 } },
      { label: 'finite number', options: { retryDelayMs: 100 } },
      { label: 'function', options: { retryDelayMs: (attempts: number) => attempts * 100 } },
      { label: 'undefined', options: { retryDelayMs: undefined } },
      { label: 'omitted', options: {} },
    ])('accepts $label synchronously', ({ options }) => {
      expect(() => construct(options)).not.toThrow();
    });

    it('refuses an object without rendering its value', () => {
      const toString = vi.fn(() => {
        throw new Error('private configuration');
      });
      let error: unknown;
      try {
        construct({ retryDelayMs: { toString } });
      } catch (failure) {
        error = failure;
      }
      expect(error).toBeInstanceOf(RangeError);
      expect(error).toMatchObject({
        message: 'retryDelayMs must be a function or a finite non-negative number',
      });
      expect(toString).not.toHaveBeenCalled();
    });
  });

  it.each([false, true])(
    'forwards retry delay through plugin behavior mode %s',
    async (withBehaviors) => {
      const runtime = new FakeRuntimeServices(0);
      const requeue = vi.spyOn(MemoryQueue.prototype, 'requeue');
      const app = createApplication({
        plugins: [
          RuntimePlugin({ platform: 'node', adapters: { node: () => runtime } }),
          QueuePlugin({
            pollIntervalMs: 100,
            retryDelayMs: 375,
            ...(withBehaviors ? { behaviors: [{ handle: (_ctx, next) => next() }] } : {}),
            processors: [
              {
                name: 'build',
                processor: () => {
                  throw new Error('failed');
                },
              },
            ],
          }),
        ],
      });
      await app.start();
      try {
        await app.services.get<IQueue>(CAPABILITIES.QUEUE).add('build', {});
        await runtime.advanceMs(100);
        for (let i = 0; i < 30; i++) await Promise.resolve();
        expect(requeue.mock.calls[0]?.[2]).toBe(475);
      } finally {
        await app.stop();
        requeue.mockRestore();
      }
    },
  );

  it.each([
    undefined,
    250,
    (attempts: number) => attempts * 300,
    () => -1,
    () => 3e9,
    () => Infinity,
    () => {
      throw new Error('private');
    },
  ])('uses delay %s on memory', async (retryDelayMs) => {
    const runtime = new FakeRuntimeServices(0);
    const adapter = new MemoryQueue();
    const requeue = vi.spyOn(adapter, 'requeue');
    const warn = vi.fn();
    const service = new QueueService(adapter, runtime, {
      pollIntervalMs: 100,
      ...(retryDelayMs === undefined ? {} : { retryDelayMs }),
      logger: { error: vi.fn(), warn },
    });
    service.process('build', () => {
      throw new Error('job');
    });
    await service.connect();
    await service.add('build', {});
    await runtime.advanceMs(100);
    for (let i = 0; i < 20; i++) await Promise.resolve();
    const expected =
      retryDelayMs === undefined
        ? 2000
        : retryDelayMs === 250
          ? 250
          : typeof retryDelayMs === 'function'
            ? (() => {
                try {
                  const n = retryDelayMs(1);
                  return Number.isFinite(n) ? Math.max(0, Math.min(n, 2147483647)) : 0;
                } catch {
                  return 0;
                }
              })()
            : 0;
    expect(requeue.mock.calls[0]?.[2]).toBe(100 + expected);
    await service.disconnect();
  });
  it('warns once across jobs when the retry callback fails', async () => {
    const runtime = new FakeRuntimeServices(0);
    const warn = vi.fn();
    const service = new QueueService(new MemoryQueue(), runtime, {
      pollIntervalMs: 100,
      retryDelayMs: () => NaN,
      logger: { error: vi.fn(), warn },
    });
    service.process(
      'build',
      () => {
        throw new Error('job');
      },
      { concurrency: 2 },
    );
    await service.connect();
    await service.add('build', {});
    await service.add('build', {});
    await runtime.advanceMs(200);
    expect(warn).toHaveBeenCalledTimes(1);
    await service.disconnect();
  });
  it('threads the failed attempt to the function and SQS visibility', async () => {
    const h = await sqsHarness({ deadLetterQueues: { build: false } });
    const delay = vi.fn((attempts: number) => attempts * 2000);
    const service = new QueueService(h.queue, h.runtime, {
      pollIntervalMs: 100,
      retryDelayMs: delay,
    });
    await service.connect();
    service.process('build', () => {
      throw new Error('job');
    });
    await h.transport.send('source', envelope());
    await h.runtime.advanceMs(100);
    for (let i = 0; i < 50; i++) await Promise.resolve();
    expect(delay).toHaveBeenCalledWith(1);
    expect(h.transport.visibilityChanges[0]?.seconds).toBe(2);
    await service.disconnect();
  });
  it.each([-1, NaN, Infinity])('refuses numeric delay %s at construction', (retryDelayMs) =>
    expect(() => QueuePlugin({ retryDelayMs })).toThrow(RangeError),
  );
});
