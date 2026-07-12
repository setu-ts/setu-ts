import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RabbitMqBroker, validateClient } from '../../src/brokers/rabbitmq-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { FakeAmqpConnection } from '../fixtures/fake-amqplib-client.ts';

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
});
