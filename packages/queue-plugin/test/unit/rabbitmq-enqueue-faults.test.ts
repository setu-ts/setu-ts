import { describe, expect, it, vi } from 'vitest';
import { Buffer } from 'node:buffer';
import { BackendOutcomeUnknownError, BackendUnavailableError } from '@setu-ts/common';
import { errorHandler } from '@setu-ts/exceptions';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { RabbitMqQueue } from '../../src/adapters/rabbitmq-queue.ts';
import { FakeAmqpQueueConnection } from '../fixtures/fake-amqplib-client.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

describe('RabbitMQ enqueue faults', () => {
  it.each(['ready', 'delay', 'dead'])(
    'names a rejected %s declaration before enqueue without claiming a publish',
    async (suffix) => {
      const client = new FakeAmqpQueueConnection();
      const queue = new RabbitMqQueue(new FakeRuntimeServices(0), { client });
      await queue.connect();
      const channel = await client.createChannel();
      const driverError = new Error('declaration refused');
      const physicalQueue = `he.queue.build.${suffix}`;
      const assertQueue = channel.assertQueue.bind(channel);
      vi.spyOn(channel, 'assertQueue').mockImplementation((name, options) =>
        name === physicalQueue ? Promise.reject(driverError) : assertQueue(name, options),
      );
      const publish = vi.spyOn(channel, 'publish');
      try {
        const error: unknown = await queue
          .enqueue({
            id: 'j',
            name: 'build',
            data: {},
            attempts: 0,
            maxAttempts: 3,
            availableAtMs: 0,
          })
          .catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(BackendUnavailableError);
        expect(error).toMatchObject({
          source: 'queue-plugin: rabbitmq enqueue',
          cause: {
            message: `RabbitMQ could not declare queue ${JSON.stringify(physicalQueue)} before enqueue`,
          },
        });
        expect(((error as Error).cause as Error).cause).toBe(driverError);
        expect(publish).not.toHaveBeenCalled();
      } finally {
        await queue.disconnect();
      }
    },
  );
  it('preserves a reserve declaration rejection unchanged', async () => {
    const client = new FakeAmqpQueueConnection();
    const queue = new RabbitMqQueue(new FakeRuntimeServices(0), { client });
    await queue.connect();
    const channel = await client.createChannel();
    const driverError = new Error('reserve declaration refused');
    vi.spyOn(channel, 'assertQueue').mockRejectedValue(driverError);
    try {
      await expect(queue.reserve('build', 1, 0)).rejects.toBe(driverError);
      expect(channel.calls.filter((call) => call.method === 'publish')).toHaveLength(0);
    } finally {
      await queue.disconnect();
    }
  });
  it.each(['toString', 'message getter'] as const)(
    'preserves a synchronous confirm rejection with a throwing %s',
    async (rendering) => {
      const runtime = new FakeRuntimeServices(0);
      const client = new FakeAmqpQueueConnection();
      const queue = new RabbitMqQueue(runtime, { client, publishTimeoutMs: 25 });
      await queue.connect();
      const channel = await client.createChannel();
      const cause =
        rendering === 'toString'
          ? {
              toString() {
                throw new Error('diagnostic coercion failed');
              },
            }
          : Object.defineProperty(new Error(), 'message', {
              get() {
                throw new Error('diagnostic getter failed');
              },
            });
      vi.spyOn(channel, 'publish').mockImplementation(
        (_exchange, _key, _body, _options, confirm) => {
          confirm?.(cause);
          return true;
        },
      );
      try {
        const error: unknown = await queue
          .enqueue({
            id: 'j',
            name: 'build',
            data: {},
            attempts: 0,
            maxAttempts: 3,
            availableAtMs: 0,
          })
          .catch((failure: unknown) => failure);
        expect(error).toBeInstanceOf(BackendUnavailableError);
        expect(error).toMatchObject({
          source: 'queue-plugin: rabbitmq enqueue',
          cause: { message: expect.stringContaining('he.queue.build.ready') },
        });
        expect(((error as Error).cause as Error).cause).toBe(cause);
        expect(channel.listenerCount('close')).toBe(1);
      } finally {
        await queue.disconnect();
      }
    },
  );
  it.each(['enqueue', 'requeue', 'dead-letter', 'quarantine'] as const)(
    'labels %s faults at every shared publish path and keeps the original claim unacked',
    async (operation) => {
      for (const failure of ['nack', 'close', 'closed-callback', 'timeout', 'throw'] as const) {
        const runtime = new FakeRuntimeServices(0);
        const client = new FakeAmqpQueueConnection();
        const reportWarning = vi.fn();
        const queue = new RabbitMqQueue(runtime, { client, publishTimeoutMs: 25, reportWarning });
        await queue.connect();
        const channel = await client.createChannel();
        const job = {
          id: 'j',
          name: 'build',
          data: {},
          attempts: 1,
          maxAttempts: 3,
          availableAtMs: 0,
        };
        await queue.enqueue(job);
        const reserved = (await queue.reserve('build', 1, 0))[0]!;
        if (operation === 'quarantine')
          channel.publish('', 'he.queue.build.ready', Buffer.from('unreadable'));
        const original = new Error(
          failure === 'closed-callback' ? 'channel closed' : 'message nacked',
        );
        vi.spyOn(channel, 'publish').mockImplementation(
          (_exchange, _key, _body, _options, confirm) => {
            if (failure === 'throw') throw original;
            if (failure === 'nack' || failure === 'closed-callback')
              queueMicrotask(() => confirm?.(original));
            return true;
          },
        );
        const result = (
          operation === 'enqueue'
            ? queue.enqueue(job)
            : operation === 'requeue'
              ? queue.requeue('build', reserved.id, 1000, 2, reserved.claimToken!)
              : operation === 'dead-letter'
                ? queue.deadLetter('build', reserved.id, 0, reserved.claimToken!)
                : queue.reserve('build', 1, 0)
        ).catch((error: unknown) => error);
        for (let n = 0; n < 40; n++) await Promise.resolve();
        if (failure === 'close') channel.emitClose();
        if (failure === 'timeout') await runtime.advanceMs(25);
        const error = await result;
        const target =
          operation === 'enqueue' ? 'ready' : operation === 'requeue' ? 'delay' : 'dead';
        if (operation === 'quarantine') {
          expect(error).toEqual([]);
          expect(reportWarning).toHaveBeenCalledWith(
            expect.stringContaining('queue-plugin: rabbitmq quarantine:'),
          );
        } else {
          expect(error).toBeInstanceOf(
            ['close', 'closed-callback', 'timeout'].includes(failure)
              ? BackendOutcomeUnknownError
              : BackendUnavailableError,
          );
          expect(error).toMatchObject({
            source: `queue-plugin: rabbitmq ${operation}`,
            cause: { message: expect.stringContaining(`he.queue.build.${target}`) },
          });
          if (['nack', 'closed-callback', 'throw'].includes(failure))
            expect((error as Error).cause).toMatchObject({ cause: original });
        }
        expect(channel.calls.filter((call) => call.method === 'ack')).toHaveLength(0);
        await queue.disconnect();
      }
    },
  );
  it.each([
    'not-connected',
    'faulted',
    'assert',
    'throw',
    'nack',
    'close',
    'closed-callback',
    'timeout',
  ] as const)('classifies %s and serves its safe status', async (path) => {
    const runtime = new FakeRuntimeServices(0);
    const client = new FakeAmqpQueueConnection({
      ...(path === 'timeout' || path === 'close' ? { withholdConfirms: true } : {}),
      ...(path === 'nack' ? { confirmError: new Error('nack') } : {}),
      // amqplib/lib/channel.js drains callbacks with this error before later close listeners.
      ...(path === 'closed-callback' ? { confirmError: new Error('channel closed') } : {}),
      ...(path === 'throw' ? { rejectPublish: true } : {}),
    });
    const queue = new RabbitMqQueue(runtime, { client, publishTimeoutMs: 25 });
    if (path !== 'not-connected') await queue.connect();
    const channel = await client.createChannel();
    if (path === 'assert')
      vi.spyOn(channel, 'assertQueue').mockRejectedValue(new Error('assert failed'));
    if (path === 'faulted') {
      // ReconnectSupervisor listens on the connection before any channel I/O.
      channel.emitClose();
    }
    const result = queue
      .enqueue({
        id: 'j',
        name: 'build',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: 0,
      })
      .catch((error: unknown) => error);
    for (let i = 0; i < 30; i++) await Promise.resolve();
    if (path === 'close') channel.emitClose();
    if (path === 'timeout') await runtime.advanceMs(25);
    const error = await result;
    const unknown = path === 'close' || path === 'closed-callback' || path === 'timeout';
    expect(error).toBeInstanceOf(unknown ? BackendOutcomeUnknownError : BackendUnavailableError);
    expect(error).toMatchObject({
      source: 'queue-plugin: rabbitmq enqueue',
      cause: expect.any(Error),
    });
    const app = createApplication({ plugins: [RuntimePlugin()] });
    app.middleware.add(errorHandler({ format: 'rfc9457', logErrors: false }), { priority: 10 });
    app.router.get('/enqueue', () => {
      throw error;
    });
    await app.start();
    try {
      const response = await app.fetch(new Request('http://localhost/enqueue'));
      expect(response.status).toBe(unknown ? 504 : 503);
    } finally {
      await app.stop();
      await queue.disconnect();
    }
  });
});
