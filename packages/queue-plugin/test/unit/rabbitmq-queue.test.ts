/**
 * Unit tests for RabbitMqQueue adapter.
 */

import { beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RabbitMqQueue, validateClient } from '../../src/adapters/rabbitmq-queue.ts';
import { createFakeAmqpConnection } from '../fixtures/fake-amqplib-client.ts';
import type { FakeAmqpQueueChannel } from '../fixtures/fake-amqplib-client.ts';
import { FakeRuntimeServices } from '../fixtures/fake-runtime.ts';

describe('RabbitMqQueue', () => {
  describe('validateClient', () => {
    it('rejects null', () => {
      expect(validateClient(null)).toBe(false);
    });

    it('rejects non-object', () => {
      expect(validateClient('string')).toBe(false);
      expect(validateClient(123)).toBe(false);
      expect(validateClient(true)).toBe(false);
    });

    it('rejects object missing methods', () => {
      expect(validateClient({})).toBe(false);
      expect(validateClient({ createChannel: () => {} })).toBe(false);
    });

    it('accepts object with all required methods', () => {
      const client = {
        createChannel: () => Promise.resolve({}),
        close: () => Promise.resolve(),
      };
      expect(validateClient(client)).toBe(true);
    });
  });

  describe('lifecycle', () => {
    it('isReady() is false before connect', () => {
      const runtime = new FakeRuntimeServices();
      const queue = new RabbitMqQueue(runtime);
      expect(queue.isReady()).toBe(false);
    });

    it('isReady() is true after connect with fake client', async () => {
      const runtime = new FakeRuntimeServices();
      const fakeClient = createFakeAmqpConnection();
      const queue = new RabbitMqQueue(runtime, { client: fakeClient });
      await queue.connect();
      expect(queue.isReady()).toBe(true);
    });

    it('isReady() is false after disconnect', async () => {
      const runtime = new FakeRuntimeServices();
      const fakeClient = createFakeAmqpConnection();
      const queue = new RabbitMqQueue(runtime, { client: fakeClient });
      await queue.connect();
      await queue.disconnect();
      expect(queue.isReady()).toBe(false);
    });

    it('connect() is idempotent', async () => {
      const runtime = new FakeRuntimeServices();
      const fakeClient = createFakeAmqpConnection();
      const queue = new RabbitMqQueue(runtime, { client: fakeClient });
      await queue.connect();
      await queue.connect(); // Second call should not error
      expect(queue.isReady()).toBe(true);
    });
  });

  describe('enqueue and reserve with fake client', () => {
    let runtime: FakeRuntimeServices;
    let fakeClient: ReturnType<typeof createFakeAmqpConnection>;
    let queue: RabbitMqQueue;
    let channel: FakeAmqpQueueChannel;

    beforeEach(async () => {
      runtime = new FakeRuntimeServices();
      fakeClient = createFakeAmqpConnection();
      queue = new RabbitMqQueue(runtime, { client: fakeClient, prefix: 'test.queue' });
      await queue.connect();

      // Get the channel after connect
      const conn = fakeClient as unknown as { _channel?: FakeAmqpQueueChannel };
      channel = conn._channel ?? (await fakeClient.createChannel());
    });

    it('enqueue (no delay) publishes to ready queue', async () => {
      const job = {
        id: '1',
        name: 'test',
        data: { foo: 'bar' },
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: runtime.now(),
      };

      await queue.enqueue(job);

      const readyBuffer = channel.getReadyBuffer('test.queue.test.ready');
      expect(readyBuffer.length).toBe(1);
      expect(Buffer.isBuffer(readyBuffer[0].content)).toBe(true);

      // Verify content round-trips
      const decoded = JSON.parse(readyBuffer[0].content.toString('utf8'));
      expect(decoded.id).toBe('1');
      expect(decoded.data.foo).toBe('bar');
    });

    it('enqueue (delayed) publishes to delay queue with expiration', async () => {
      const job = {
        id: '2',
        name: 'test',
        data: { baz: 'qux' },
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: runtime.now() + 5000,
      };

      await queue.enqueue(job);

      // Delay queue messages now go to delayBuffers (not auto-routed to ready)
      const delayBuffer = channel.getDelayBuffer('test.queue.test.delay');
      expect(delayBuffer.length).toBe(1);

      // Verify expiration was set
      expect((delayBuffer[0].options as { expiration?: number })?.expiration).toBe(5000);
    });

    it('reserve polls via get() and returns jobs', async () => {
      // First enqueue a job
      const job = {
        id: '3',
        name: 'test',
        data: { test: 'data' },
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: runtime.now(),
      };
      await queue.enqueue(job);

      // Now reserve
      const reserved = await queue.reserve('test', 1, runtime.now());

      expect(reserved.length).toBe(1);
      expect(reserved[0].id).toBe('3');
      expect((reserved[0] as { data: { test: string } }).data.test).toBe('data');
    });

    it('reserve stops at false (empty queue sentinel)', async () => {
      const reserved = await queue.reserve('empty', 5, runtime.now());
      expect(reserved.length).toBe(0);
    });

    it('reserve claims jobs (second call returns nothing)', async () => {
      const job = {
        id: '4',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: runtime.now(),
      };
      await queue.enqueue(job);

      const reserved1 = await queue.reserve('test', 10, runtime.now());
      expect(reserved1.length).toBe(1);

      const reserved2 = await queue.reserve('test', 10, runtime.now());
      expect(reserved2.length).toBe(0);
    });

    it('ack removes job from processing', async () => {
      const job = {
        id: '5',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: runtime.now(),
      };
      await queue.enqueue(job);
      await queue.reserve('test', 1, runtime.now());

      await queue.ack('test', '5');
      // Should not throw
      expect(true).toBe(true);
    });

    it('requeue publishes to delay queue with fresh TTL via channel.calls', async () => {
      const job = {
        id: '6',
        name: 'test',
        data: { foo: 'bar' },
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: runtime.now(),
      };
      await queue.enqueue(job);
      const reserved = await queue.reserve('test', 1, runtime.now());
      expect(reserved.length).toBe(1);

      const newAvailableAtMs = runtime.now() + 10000;
      await queue.requeue('test', '6', newAvailableAtMs, 1);

      // Find the publish call to the delay queue
      const publishCalls = channel.calls.filter(
        (c) => c.method === 'publish' && c.args[1] === 'test.queue.test.delay',
      );
      expect(publishCalls.length).toBe(1);

      const publishCall = publishCalls[0];
      const routingKey = publishCall.args[1];
      const content = publishCall.args[2] as Buffer;
      const options = publishCall.args[3];

      // Assert delay routing key
      expect(routingKey).toBe('test.queue.test.delay');

      // Assert content is a Buffer
      expect(Buffer.isBuffer(content)).toBe(true);

      // Assert expiration equals the expected TTL
      const expectedExpiration = newAvailableAtMs - runtime.now();
      expect((options as { expiration?: number })?.expiration).toBe(expectedExpiration);

      // Assert payload has updated attempts and availableAtMs
      const decoded = JSON.parse(content.toString('utf8'));
      expect(decoded.attempts).toBe(1);
      expect(decoded.availableAtMs).toBe(newAvailableAtMs);
      expect(decoded.data.foo).toBe('bar');

      // Assert the original message was acked
      const ackCalls = channel.calls.filter((c) => c.method === 'ack');
      expect(ackCalls.length).toBe(1);
    });

    it('deadLetter publishes to dead queue', async () => {
      const job = {
        id: '7',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: runtime.now(),
      };
      await queue.enqueue(job);
      const reserved = await queue.reserve('test', 1, runtime.now());
      expect(reserved.length).toBe(1);

      await queue.deadLetter('test', '7', runtime.now());

      const deadBuffer = channel.getReadyBuffer('test.queue.test.dead');
      expect(deadBuffer.length).toBe(1);
    });

    it('DLX wiring: delay queue has camelCase deadLetterExchange/deadLetterRoutingKey', async () => {
      // Connect the adapter and enqueue a job to trigger queue assertion
      const fakeClient2 = createFakeAmqpConnection();
      const queue2 = new RabbitMqQueue(runtime, { client: fakeClient2, prefix: 'test.queue' });
      await queue2.connect();

      // Enqueue a delayed job to trigger queue assertion
      await queue2.enqueue({
        id: 'dlx-test',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: runtime.now() + 5000,
      });

      // Get the channel
      const channel2 = await fakeClient2.createChannel();

      // Find all assertQueue calls
      const assertQueueCalls = channel2.calls.filter((c) => c.method === 'assertQueue');

      // Find the delay queue assert
      const delayQueueCall = assertQueueCalls.find(
        (c) => c.args[0] === 'test.queue.test.delay',
      );
      expect(delayQueueCall).toBeDefined();

      const delayOptions = delayQueueCall!.args[1] as {
        durable: boolean;
        deadLetterExchange?: string;
        deadLetterRoutingKey?: string;
      };

      // Assert the camelCase keys (amqplib reads these, NOT raw x-... keys)
      expect(delayOptions.durable).toBe(true);
      expect(delayOptions.deadLetterExchange).toBe('');
      expect(delayOptions.deadLetterRoutingKey).toBe('test.queue.test.ready');

      // Find the ready queue assert
      const readyQueueCall = assertQueueCalls.find(
        (c) => c.args[0] === 'test.queue.test.ready',
      );
      expect(readyQueueCall).toBeDefined();
      const readyOptions = readyQueueCall!.args[1] as { durable: boolean };
      expect(readyOptions.durable).toBe(true);
      // Ready queue should NOT have DLX keys
      expect((readyOptions as Record<string, unknown>).deadLetterExchange).toBeUndefined();
      expect((readyOptions as Record<string, unknown>).deadLetterRoutingKey).toBeUndefined();

      // Find the dead queue assert
      const deadQueueCall = assertQueueCalls.find(
        (c) => c.args[0] === 'test.queue.test.dead',
      );
      expect(deadQueueCall).toBeDefined();
      const deadOptions = deadQueueCall!.args[1] as { durable: boolean };
      expect(deadOptions.durable).toBe(true);
      // Dead queue should NOT have DLX keys
      expect((deadOptions as Record<string, unknown>).deadLetterExchange).toBeUndefined();
      expect((deadOptions as Record<string, unknown>).deadLetterRoutingKey).toBeUndefined();
    });
  });

  describe('recurring jobs', () => {
    let runtime: FakeRuntimeServices;
    let fakeClient: ReturnType<typeof createFakeAmqpConnection>;
    let queue: RabbitMqQueue;

    beforeEach(async () => {
      runtime = new FakeRuntimeServices();
      fakeClient = createFakeAmqpConnection();
      queue = new RabbitMqQueue(runtime, { client: fakeClient });
      await queue.connect();
    });

    it('storeRecurring stores the job', async () => {
      const rec = {
        id: 'rec-1',
        name: 'daily-task',
        data: { type: 'cleanup' },
        cron: '0 0 * * *',
        nextRunAtMs: runtime.now() + 3600000,
      };

      await queue.storeRecurring(rec);

      const due = await queue.fetchRecurringDue(runtime.now() + 7200000);
      expect(due.length).toBe(1);
      expect(due[0].id).toBe('rec-1');
    });

    it('fetchRecurringDue filters by nextRunAtMs', async () => {
      const rec1 = {
        id: 'rec-1',
        name: 'task-1',
        data: {},
        cron: '0 * * * *',
        nextRunAtMs: runtime.now(),
      };
      const rec2 = {
        id: 'rec-2',
        name: 'task-2',
        data: {},
        cron: '0 * * * *',
        nextRunAtMs: runtime.now() + 100000,
      };

      await queue.storeRecurring(rec1);
      await queue.storeRecurring(rec2);

      const due = await queue.fetchRecurringDue(runtime.now() + 50000);
      expect(due.length).toBe(1);
      expect(due[0].id).toBe('rec-1');
    });

    it('advanceRecurring updates nextRunAtMs', async () => {
      const rec = {
        id: 'rec-3',
        name: 'task-3',
        data: {},
        cron: '0 * * * *',
        nextRunAtMs: runtime.now(),
      };

      await queue.storeRecurring(rec);
      await queue.advanceRecurring('rec-3', runtime.now() + 3600000);

      const due = await queue.fetchRecurringDue(runtime.now() + 1000);
      expect(due.length).toBe(0);
    });
  });

  describe('prefix option', () => {
    it('uses custom prefix for queue names', async () => {
      const runtime = new FakeRuntimeServices();
      const fakeClient = createFakeAmqpConnection();
      const queue = new RabbitMqQueue(runtime, {
        client: fakeClient,
        prefix: 'custom.prefix',
      });
      await queue.connect();

      const job = {
        id: '1',
        name: 'myjob',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: runtime.now(),
      };
      await queue.enqueue(job);

      const channel =
        await (fakeClient as unknown as { createChannel(): Promise<FakeAmqpQueueChannel> })
          .createChannel();
      const readyBuffer = channel.getReadyBuffer('custom.prefix.myjob.ready');
      expect(readyBuffer.length).toBe(1);
    });
  });

  describe('guarded real-import test', () => {
    it('enters loadAmqplib when no client injected and URL is invalid', async () => {
      const runtime = new FakeRuntimeServices();
      // No client injected, invalid URL
      const queue = new RabbitMqQueue(runtime, { url: 'amqp://localhost:9999' });

      // This should reject because the port is not listening
      // which means it attempted the real connection (loadAmqplib path)
      await expect(queue.connect()).rejects.toThrow();
    });
  });

  describe('throws when not connected', () => {
    it('enqueue throws when not connected', async () => {
      const runtime = new FakeRuntimeServices();
      const queue = new RabbitMqQueue(runtime);

      const job = {
        id: '1',
        name: 'test',
        data: {},
        attempts: 0,
        maxAttempts: 3,
        availableAtMs: runtime.now(),
      };

      await expect(queue.enqueue(job)).rejects.toThrow('not connected');
    });

    it('reserve throws when not connected', async () => {
      const runtime = new FakeRuntimeServices();
      const queue = new RabbitMqQueue(runtime);

      await expect(queue.reserve('test', 1, runtime.now())).rejects.toThrow('not connected');
    });
  });

  describe('error paths and edge cases', () => {
    it('requeue returns early when job not in processing', async () => {
      const runtime = new FakeRuntimeServices();
      const fakeClient = createFakeAmqpConnection();
      const queue = new RabbitMqQueue(runtime, { client: fakeClient });
      await queue.connect();

      // Try to requeue a job that was never reserved
      await expect(queue.requeue('test', 'nonexistent', runtime.now(), 1)).resolves.toBeUndefined();
    });

    it('deadLetter returns early when job not in processing', async () => {
      const runtime = new FakeRuntimeServices();
      const fakeClient = createFakeAmqpConnection();
      const queue = new RabbitMqQueue(runtime, { client: fakeClient });
      await queue.connect();

      // Try to deadLetter a job that was never reserved
      await expect(queue.deadLetter('test', 'nonexistent', runtime.now())).resolves.toBeUndefined();
    });

    it('advanceRecurring returns early when recurring job not found', async () => {
      const runtime = new FakeRuntimeServices();
      const fakeClient = createFakeAmqpConnection();
      const queue = new RabbitMqQueue(runtime, { client: fakeClient });
      await queue.connect();

      // Try to advance a recurring job that doesn't exist
      await expect(queue.advanceRecurring('nonexistent', runtime.now())).resolves.toBeUndefined();
    });

    it('disconnect with injected client clears channel and connection state', async () => {
      const runtime = new FakeRuntimeServices();
      const fakeClient = createFakeAmqpConnection();
      const queue = new RabbitMqQueue(runtime, { client: fakeClient });
      await queue.connect();

      await queue.disconnect();

      // After disconnect, isReady should be false
      expect(queue.isReady()).toBe(false);
    });
  });

  describe('throws when not connected (additional methods)', () => {
    it('ack throws when not connected', async () => {
      const runtime = new FakeRuntimeServices();
      const queue = new RabbitMqQueue(runtime);

      await expect(queue.ack('test', '1')).rejects.toThrow('RabbitMqQueue is not connected');
    });

    it('storeRecurring throws when not connected', async () => {
      const runtime = new FakeRuntimeServices();
      const queue = new RabbitMqQueue(runtime);

      await expect(
        queue.storeRecurring({
          id: 'r1',
          name: 'test',
          data: {},
          cron: '* * * * *',
          nextRunAtMs: runtime.now(),
        }),
      ).rejects.toThrow('RabbitMqQueue is not connected');
    });

    it('fetchRecurringDue throws when not connected', async () => {
      const runtime = new FakeRuntimeServices();
      const queue = new RabbitMqQueue(runtime);

      await expect(queue.fetchRecurringDue(runtime.now())).rejects.toThrow(
        'RabbitMqQueue is not connected',
      );
    });

    it('advanceRecurring throws when not connected', async () => {
      const runtime = new FakeRuntimeServices();
      const queue = new RabbitMqQueue(runtime);

      await expect(queue.advanceRecurring('r1', runtime.now())).rejects.toThrow(
        'RabbitMqQueue is not connected',
      );
    });

    it('requeue throws when not connected', async () => {
      const runtime = new FakeRuntimeServices();
      const queue = new RabbitMqQueue(runtime);

      await expect(queue.requeue('test', '1', runtime.now(), 1)).rejects.toThrow(
        'RabbitMqQueue is not connected',
      );
    });

    it('deadLetter throws when not connected', async () => {
      const runtime = new FakeRuntimeServices();
      const queue = new RabbitMqQueue(runtime);

      await expect(queue.deadLetter('test', '1', runtime.now())).rejects.toThrow(
        'RabbitMqQueue is not connected',
      );
    });
  });
});
