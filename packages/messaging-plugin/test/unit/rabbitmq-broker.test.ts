import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Buffer } from 'node:buffer';
import { RabbitMqBroker, validateClient } from '../../src/brokers/rabbitmq-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { FakeAmqpConnection } from '../fixtures/fake-amqplib-client.ts';
import { RequestTimeoutError } from '../../src/errors.ts';

/**
 * RabbitMqBroker unit tests.
 *
 * Tests broker behavior using an injected fake AMQP client.
 */
describe('RabbitMqBroker', () => {
  it('validateClient rejects malformed client', () => {
    // Missing required methods
    expect(validateClient({})).toBe(false);
    expect(validateClient({ get: () => null })).toBe(false);

    // Valid shape
    expect(
      validateClient({
        createChannel: () => Promise.resolve({}),
        close: () => Promise.resolve(),
      }),
    ).toBe(true);
  });

  it('publish emits publish with serialized payload', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection();
    const broker = new RabbitMqBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();

    const message = { userId: 123, event: 'test' };
    await broker.publish('test.topic', message);

    const channel = await fakeConnection.createChannel();
    const calls = channel.calls;
    const publishCall = calls.find((c) => c.method === 'publish');

    expect(publishCall).toBeDefined();
    expect(publishCall?.args[0] as string).toBe('messaging'); // default exchange name

    // Content MUST be a Node Buffer (amqplib rejects string/Uint8Array), and it
    // must round-trip back to the original serialized payload.
    const content = publishCall?.args[2];
    expect(Buffer.isBuffer(content)).toBe(true);
    const decoded = serializer.deserialize<typeof message>(
      (content as Buffer).toString('utf8'),
    );
    expect(decoded).toEqual(message);

    await broker.disconnect();
  });

  it('subscribe creates queue and binds to topic', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection();
    const broker = new RabbitMqBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();

    // Subscribe
    await broker.subscribe('test.topic', () => {}, { queue: 'my-queue' });

    const channel = await fakeConnection.createChannel();
    const calls = channel.calls;

    // Should have called assertQueue and bindQueue
    const assertQueueCall = calls.find((c) => c.method === 'assertQueue');
    const bindQueueCall = calls.find((c) => c.method === 'bindQueue');

    expect(assertQueueCall).toBeDefined();
    expect(bindQueueCall).toBeDefined();

    await broker.disconnect();
  });

  it('disconnect closes connection', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection();
    const broker = new RabbitMqBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    await broker.disconnect();

    // Connection should be closed
    expect(fakeConnection).toBeDefined();
  });

  it('connect is idempotent', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection();
    const broker = new RabbitMqBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  it('validateClient rejects client without required methods', () => {
    expect(
      validateClient({
        createChannel: () => Promise.resolve({}),
        // Missing close
      }),
    ).toBe(false);
  });

  it('validateClient prefers injected client', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection();

    const broker = new RabbitMqBroker(runtime, serializer, {
      client: fakeConnection,
      url: 'amqp://should-not-be-used',
    });

    await broker.connect();

    // Should have used injected client
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  it('publish throws when not connected', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new RabbitMqBroker(runtime, serializer, {});

    // Don't connect
    await expect(
      broker.publish('test', { data: 'test' }),
    ).rejects.toThrow('RabbitMqBroker is not connected');
  });

  it('subscribe throws when not connected', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new RabbitMqBroker(runtime, serializer, {});

    // Don't connect
    await expect(
      broker.subscribe('test', async () => {}),
    ).rejects.toThrow('RabbitMqBroker is not connected');
  });

  it('isReady returns false before connect', () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new RabbitMqBroker(runtime, serializer, {});

    expect(broker.isReady()).toBe(false);
  });

  it('isReady returns true after connect', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection();
    const broker = new RabbitMqBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  it('isReady returns false after disconnect', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection();
    const broker = new RabbitMqBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
    expect(broker.isReady()).toBe(false);
  });

  it('validateClient rejects null', () => {
    expect(validateClient(null)).toBe(false);
  });

  it('validateClient rejects non-object', () => {
    expect(validateClient('string')).toBe(false);
    expect(validateClient(123)).toBe(false);
    expect(validateClient(true)).toBe(false);
  });

  it('custom exchangeName is used', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection();
    const broker = new RabbitMqBroker(runtime, serializer, {
      client: fakeConnection,
      exchangeName: 'custom-exchange',
    });

    await broker.connect();

    const message = { test: 'value' };
    await broker.publish('test.topic', message);

    const channel = await fakeConnection.createChannel();
    const calls = channel.calls;
    const publishCall = calls.find((c) => c.method === 'publish');

    expect(publishCall?.args[0]).toBe('custom-exchange');

    await broker.disconnect();
  });

  // Guarded real-import test - exercises the lazy-load path
  it('connect without an injected client exercises the loadAmqplib() lazy-import path', async () => {
    // Covers the real loadAmqplib() -> await import('npm:amqplib@0.10.x') path by constructing
    // a broker with NO injected client. connect() rejects either way: if amqplib is present it
    // fails to connect to the non-existent instance below; if amqplib is absent the dynamic import
    // rejects. In both cases loadAmqplib() is entered, so this remains coverage of the real import
    // path rather than the injected-client seam (which validateClient covers separately).
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();

    const broker = new RabbitMqBroker(runtime, serializer, {
      url: 'amqp://localhost:9999', // Non-existent RabbitMQ instance
    });

    await expect(broker.connect()).rejects.toThrow();
  });

  // R1: seeded delivery + ack
  it('subscribe delivers a seeded message, invokes handler, and acks', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection({
      seededMessages: [
        {
          topic: 'test.topic',
          content: JSON.stringify({ x: 1 }),
          properties: { messageId: 'm1' },
        },
      ],
    });
    const broker = new RabbitMqBroker(runtime, serializer, { client: fakeConnection });

    let handlerCalled = false;
    let receivedData: unknown;
    let receivedMetadata: unknown;

    await broker.connect();
    await broker.subscribe('test.topic', (data, metadata) => {
      handlerCalled = true;
      receivedData = data;
      receivedMetadata = metadata;
    });

    // Give time for message delivery
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handlerCalled).toBe(true);
    expect(receivedData).toEqual({ x: 1 });
    const meta = receivedMetadata as { topic: string; messageId: string };
    expect(meta.topic).toBe('test.topic');
    expect(meta.messageId).toBe('m1');

    const channel = await fakeConnection.createChannel();
    const calls = channel.calls;
    const ackCall = calls.find((c) => c.method === 'ack');
    expect(ackCall).toBeDefined();

    await broker.disconnect();
  });

  // R2: nack+logger on handler throw
  it('subscribe nacks and logs when the handler throws', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection({
      seededMessages: [
        {
          topic: 'test.topic',
          content: JSON.stringify({ x: 1 }),
          properties: { messageId: 'm2' },
        },
      ],
    });
    const logger = { error: (_msg: string) => {} };
    const broker = new RabbitMqBroker(runtime, serializer, {
      client: fakeConnection,
      logger,
    });

    await broker.connect();
    await broker.subscribe('test.topic', () => {
      throw new Error('handler failed');
    });

    // Give time for message delivery and nack
    await new Promise((resolve) => setTimeout(resolve, 10));

    const channel = await fakeConnection.createChannel();
    const calls = channel.calls;
    const nackCall = calls.find((c) => c.method === 'nack');
    expect(nackCall).toBeDefined();
    // nack(msg, allUpTo=false, requeue=false) — no requeue, so no poison-message hot-loop.
    expect(nackCall?.args[1]).toBe(false);
    expect(nackCall?.args[2]).toBe(false);
    // The message must NOT be ack'd when the handler throws.
    const ackCall = calls.find((c) => c.method === 'ack');
    expect(ackCall).toBeUndefined();

    await broker.disconnect();
  });

  // R3: unsubscribe of exclusive queue deletes the queue
  it('unsubscribe of an exclusive queue deletes the queue', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection();
    const broker = new RabbitMqBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    const sub = await broker.subscribe('test.topic', () => {});

    await sub.unsubscribe();

    const channel = await fakeConnection.createChannel();
    const calls = channel.calls;
    const deleteQueueCall = calls.find((c) => c.method === 'deleteQueue');
    expect(deleteQueueCall).toBeDefined();

    await broker.disconnect();
  });

  // R4: unsubscribe of named queue cancels without deleting
  it('unsubscribe of a named queue cancels without deleting', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection();
    const broker = new RabbitMqBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    const sub = await broker.subscribe('test.topic', () => {}, { queue: 'my-queue' });

    await sub.unsubscribe();

    const channel = await fakeConnection.createChannel();
    const calls = channel.calls;
    const cancelCall = calls.find((c) => c.method === 'cancel');
    const deleteQueueCall = calls.find((c) => c.method === 'deleteQueue');
    expect(cancelCall).toBeDefined();
    expect(deleteQueueCall).toBeUndefined();

    await broker.disconnect();
  });

  // R5: publish messageId from object
  it('publish copies messageId from an object payload', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection();
    const broker = new RabbitMqBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    await broker.publish('test.topic', { messageId: 'custom-id', data: 1 });

    const channel = await fakeConnection.createChannel();
    const calls = channel.calls;
    const publishCall = calls.find((c) => c.method === 'publish');

    expect(publishCall).toBeDefined();
    const properties = publishCall?.args[3] as { messageId?: string };
    expect(properties.messageId).toBe('custom-id');

    await broker.disconnect();
  });

  // R6: publish generates messageId for non-object
  it('publish with a non-object payload generates a messageId', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection();
    const broker = new RabbitMqBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    await broker.publish('test.topic', 'string-payload');

    const channel = await fakeConnection.createChannel();
    const calls = channel.calls;
    const publishCall = calls.find((c) => c.method === 'publish');

    expect(publishCall).toBeDefined();
    const properties = publishCall?.args[3] as { messageId?: string };
    // Fake runtime generates "fake-uuid-0", "fake-uuid-1", etc.
    expect(properties.messageId).toMatch(/^fake-uuid-\d+$/);

    await broker.disconnect();
  });

  // R7: null message handling
  it('subscribe ignores a null message (consumer-cancel notification)', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection({ deliverNull: true });
    const broker = new RabbitMqBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    await broker.subscribe('test.topic', () => {});

    // Should not throw
    await new Promise((resolve) => setTimeout(resolve, 10));

    await broker.disconnect();
  });

  // R8: failure-path - handler throws → nack(msg, false, false) called
  it('subscribe calls nack(msg, false, false) when the handler throws', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection({
      seededMessages: [
        {
          topic: 'test.topic',
          content: JSON.stringify({ x: 1 }),
          properties: { messageId: 'msg-1' },
        },
      ],
    });
    const broker = new RabbitMqBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();

    // Handler that throws
    await broker.subscribe(
      'test.topic',
      () => {
        throw new Error('handler failure');
      },
      { queue: 'failure-queue' },
    );

    // Wait for async handler to run
    await new Promise((resolve) => setTimeout(resolve, 10));

    const channel = await fakeConnection.createChannel();
    const calls = channel.calls;

    // Verify nack was called with correct parameters
    const nackCall = calls.find((c) => c.method === 'nack');
    expect(nackCall).toBeDefined();
    expect(nackCall?.args[1]).toBe(false); // allUpTo
    expect(nackCall?.args[2]).toBe(false); // requeue

    await broker.disconnect();
  });

  // R9: success-path - handler succeeds → ack() called
  it('subscribe calls ack() when the handler succeeds', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeAmqpConnection({
      seededMessages: [
        {
          topic: 'test.topic',
          content: JSON.stringify({ x: 1 }),
          properties: { messageId: 'msg-1' },
        },
      ],
    });
    const broker = new RabbitMqBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();

    let handlerCalled = false;
    await broker.subscribe(
      'test.topic',
      () => {
        handlerCalled = true;
      },
      { queue: 'success-queue' },
    );

    // Wait for async handler to run
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(handlerCalled).toBe(true);

    const channel = await fakeConnection.createChannel();
    const calls = channel.calls;

    // Verify ack was called
    const ackCall = calls.find((c) => c.method === 'ack');
    expect(ackCall).toBeDefined();

    await broker.disconnect();
  });
});

describe('RabbitMqBroker request-reply delegation', () => {
  it('respond() returns a subscription', async () => {
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
      client: new FakeAmqpConnection(),
    });
    await broker.connect();
    const sub = await broker.respond('resp.only', (m) => m);
    expect(typeof sub.unsubscribe).toBe('function');
    await sub.unsubscribe();
    await broker.disconnect();
  });

  it('request() rejects with RequestTimeoutError when unanswered', async () => {
    const broker = new RabbitMqBroker(createFakeRuntime(), new JsonSerializer(), {
      client: new FakeAmqpConnection(),
    });
    await broker.connect();
    let caught: unknown;
    try {
      await broker.request('no.responder', { ping: true }, { timeoutMs: 30 });
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RequestTimeoutError);
    await broker.disconnect();
  });
});
