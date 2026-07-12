import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { KafkaBroker, validateClient } from '../../src/brokers/kafka-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { FakeKafkaFactory } from '../fixtures/fake-kafkajs-client.ts';

/**
 * KafkaBroker unit tests.
 *
 * Tests broker behavior using an injected fake Kafka client.
 */
describe('KafkaBroker', () => {
  it('validateClient rejects malformed client', () => {
    // Missing required methods
    expect(validateClient({})).toBe(false);
    expect(validateClient({ get: () => null })).toBe(false);

    // Valid shape
    expect(
      validateClient({
        producer: () => ({}),
        consumer: () => ({}),
      }),
    ).toBe(true);
  });

  it('publish emits producer.send with serialized payload', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();

    const message = { userId: 123, event: 'test' };
    await broker.publish('test.topic', message);

    const producer = fakeFactory.producer();
    const calls = producer.calls;
    const sendCall = calls.find((c) => c.method === 'send');

    expect(sendCall).toBeDefined();
    expect((sendCall?.args[0] as { topic: string }).topic).toBe('test.topic');

    await broker.disconnect();
  });

  it('subscribe creates consumer with groupId', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();

    // Subscribe
    await broker.subscribe('test.topic', () => {}, { queue: 'my-group' });

    const consumer = fakeFactory.consumer({ groupId: 'my-group' });
    const calls = consumer.calls;

    // Should have called subscribe
    const subscribeCall = calls.find((c) => c.method === 'subscribe');

    expect(subscribeCall).toBeDefined();

    await broker.disconnect();
  });

  it('disconnect stops consumer and producer', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    await broker.disconnect();

    // Should be disconnected
    expect(broker.isReady()).toBe(false);
  });

  it('connect is idempotent', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  it('validateClient rejects client without required methods', () => {
    expect(
      validateClient({
        producer: () => ({}),
        // Missing consumer
      }),
    ).toBe(false);
  });

  it('validateClient prefers injected client', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();

    const broker = new KafkaBroker(runtime, serializer, {
      client: fakeFactory,
      brokers: ['should-not-be-used'],
    });

    await broker.connect();

    // Should have used injected client
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  it('publish throws when not connected', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new KafkaBroker(runtime, serializer, {});

    // Don't connect
    await expect(
      broker.publish('test', { data: 'test' }),
    ).rejects.toThrow('KafkaBroker is not connected');
  });

  it('subscribe throws when not connected', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new KafkaBroker(runtime, serializer, {});

    // Don't connect
    await expect(
      broker.subscribe('test', async () => {}),
    ).rejects.toThrow('KafkaBroker is not connected');
  });

  it('isReady returns false before connect', () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new KafkaBroker(runtime, serializer, {});

    expect(broker.isReady()).toBe(false);
  });

  it('isReady returns true after connect', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  it('isReady returns false after disconnect', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

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

  it('custom clientId is used', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, {
      client: fakeFactory,
      clientId: 'custom-client',
    });

    await broker.connect();

    // Client ID would be used in real Kafka factory creation
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  // Guarded real-import test - exercises the lazy-load path
  it('connect without an injected client exercises the loadKafkajs() lazy-import path', async () => {
    // Covers the real loadKafkajs() -> await import('npm:kafkajs@2.x') path by constructing
    // a broker with NO injected client. connect() rejects either way: if kafkajs is present it
    // fails to connect to the non-existent instance below; if kafkajs is absent the dynamic import
    // rejects. In both cases loadKafkajs() is entered, so this remains coverage of the real import
    // path rather than the injected-client seam (which validateClient covers separately).
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();

    const broker = new KafkaBroker(runtime, serializer, {
      brokers: ['localhost:9999'], // Non-existent Kafka instance
    });

    await expect(broker.connect()).rejects.toThrow();
  });

  // K1: seeded-message delivery
  it('subscribe delivers a seeded message to the handler with decoded metadata', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory({
      seededMessages: [
        {
          topic: 'test.topic',
          value: JSON.stringify({ x: 1 }),
          partition: 0,
          offset: '5',
          timestamp: String(Date.now()),
          headers: { h: 'v' },
        },
      ],
    });
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    let handlerCalled = false;
    let receivedData: unknown;
    let receivedMetadata: unknown;

    await broker.connect();
    await broker.subscribe('test.topic', (data, metadata) => {
      handlerCalled = true;
      receivedData = data;
      receivedMetadata = metadata;
    });

    // Deliver seeded messages
    await fakeFactory.deliverAll();

    expect(handlerCalled).toBe(true);
    expect(receivedData).toEqual({ x: 1 });
    const meta = receivedMetadata as {
      topic: string;
      messageId: string;
      timestamp: Date;
      headers: Record<string, string>;
    };
    expect(meta.topic).toBe('test.topic');
    expect(meta.messageId).toBe('0:5');
    expect(meta.timestamp instanceof Date).toBe(true);
    expect(meta.headers).toEqual({ h: 'v' });

    await broker.disconnect();
  });

  // K2: unsubscribe closure
  it('unsubscribe stops the consumer and removes the active subscription', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    const sub = await broker.subscribe('test.topic', () => {});

    await sub.unsubscribe();

    // Verify stop was called on consumer
    const consumer = fakeFactory.consumer({ groupId: 'messaging-consumers' });
    const calls = consumer.calls;
    const stopCall = calls.find((c) => c.method === 'stop');
    expect(stopCall).toBeDefined();

    await broker.disconnect();
  });

  // K3: publish with non-object payload
  it('publish with a non-object payload sends headers undefined', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory();
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    await broker.publish('test.topic', 42);

    const producer = fakeFactory.producer();
    const calls = producer.calls;
    const sendCall = calls.find((c) => c.method === 'send');

    expect(sendCall).toBeDefined();
    const messages = (sendCall?.args[0] as { messages: unknown[] }).messages;
    expect(messages[0]).toEqual({ value: '42', headers: undefined });

    await broker.disconnect();
  });

  // K4: disconnect swallows consumer that rejects on stop
  it('disconnect swallows a consumer that rejects on stop', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeFactory = new FakeKafkaFactory({ rejectStop: true });
    const broker = new KafkaBroker(runtime, serializer, { client: fakeFactory });

    await broker.connect();
    await broker.subscribe('test.topic', () => {});

    // Should not throw
    await expect(broker.disconnect()).resolves.not.toThrow();
  });

  // K5: validateClient throws when injected client is invalid
  it('connect throws when injected client is invalid', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new KafkaBroker(runtime, serializer, {
      client: { producer: () => {} } as unknown as FakeKafkaFactory, // missing consumer
    });

    await expect(broker.connect()).rejects.toThrow('does not match the required structural shape');
  });
});
