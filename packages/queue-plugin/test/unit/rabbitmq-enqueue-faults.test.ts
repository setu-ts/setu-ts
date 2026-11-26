import { describe, expect, it, vi } from 'vitest';
import { BackendOutcomeUnknownError, BackendUnavailableError } from '@setu-ts/common';
import { errorHandler } from '@setu-ts/exceptions';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { RabbitMqQueue } from '../../src/adapters/rabbitmq-queue.ts';
import { FakeAmqpQueueConnection } from '../fixtures/fake-amqplib-client.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

describe('RabbitMQ enqueue faults', () => {
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
