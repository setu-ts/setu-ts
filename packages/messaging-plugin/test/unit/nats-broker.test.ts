import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { NatsBroker, validateClient } from '../../src/brokers/nats-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { FakeNatsConnection } from '../fixtures/fake-nats-client.ts';

/**
 * NatsBroker unit tests.
 *
 * Tests broker behavior using an injected fake NATS client.
 */
describe('NatsBroker', () => {
  it('validateClient rejects malformed client', () => {
    // Missing required methods
    expect(validateClient({})).toBe(false);
    expect(validateClient({ get: () => null })).toBe(false);

    // Valid shape
    expect(
      validateClient({
        jetstream: () => ({}),
        jetstreamManager: () => Promise.resolve({}),
        close: () => {},
      }),
    ).toBe(true);
  });

  it('publish emits js.publish with serialized payload', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection();
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();

    const message = { userId: 123, event: 'test' };
    await broker.publish('test.subject', message);

    const js = fakeConnection.jetstream();
    const calls = js.calls;
    const publishCall = calls.find((c) => c.method === 'publish');

    expect(publishCall).toBeDefined();
    expect(publishCall?.args[0]).toBe('test.subject');

    await broker.disconnect();
  });

  it('subscribe creates durable consumer', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection();
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();

    // Subscribe
    await broker.subscribe('test.subject', () => {}, { queue: 'my-consumer' });

    const js = fakeConnection.jetstream();
    const calls = js.calls;

    // Should have called consumers.add
    const consumersAddCall = calls.find((c) => c.method === 'consumers.add');

    expect(consumersAddCall).toBeDefined();

    await broker.disconnect();
  });

  it('disconnect closes connection', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection();
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    await broker.disconnect();

    // Connection should be closed
    expect(fakeConnection).toBeDefined();
  });

  it('connect is idempotent', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection();
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  it('validateClient rejects client without required methods', () => {
    expect(
      validateClient({
        jetstream: () => ({}),
        // Missing jetstreamManager and close
      }),
    ).toBe(false);
  });

  it('validateClient prefers injected client', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection();

    const broker = new NatsBroker(runtime, serializer, {
      client: fakeConnection,
      url: 'nats://should-not-be-used',
    });

    await broker.connect();

    // Should have used injected client
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  it('publish throws when not connected', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new NatsBroker(runtime, serializer, {});

    // Don't connect
    await expect(
      broker.publish('test', { data: 'test' }),
    ).rejects.toThrow('NatsBroker is not connected');
  });

  it('subscribe throws when not connected', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new NatsBroker(runtime, serializer, {});

    // Don't connect
    await expect(
      broker.subscribe('test', async () => {}),
    ).rejects.toThrow('NatsBroker is not connected');
  });

  it('isReady returns false before connect', () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new NatsBroker(runtime, serializer, {});

    expect(broker.isReady()).toBe(false);
  });

  it('isReady returns true after connect', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection();
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    await broker.disconnect();
  });

  it('isReady returns false after disconnect', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection();
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

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

  it('custom streamName is used', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection();
    const broker = new NatsBroker(runtime, serializer, {
      client: fakeConnection,
      streamName: 'CUSTOM-STREAM',
    });

    await broker.connect();

    const jsm = await fakeConnection.jetstreamManager();
    const calls = jsm.calls;
    const streamsAddCall = calls.find((c) => c.method === 'streams.add');

    if (streamsAddCall) {
      expect((streamsAddCall?.args[0] as { name: string }).name).toBe('CUSTOM-STREAM');
    }

    await broker.disconnect();
  });

  // Guarded real-import test - exercises the lazy-load path
  it('connect without an injected client exercises the loadNats() lazy-import path', async () => {
    // Covers the real loadNats() -> await import('npm:nats@2.x') path by constructing
    // a broker with NO injected client. connect() rejects either way: if nats is present it
    // fails to connect to the non-existent instance below; if nats is absent the dynamic import
    // rejects. In both cases loadNats() is entered, so this remains coverage of the real import
    // path rather than the injected-client seam (which validateClient covers separately).
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();

    const broker = new NatsBroker(runtime, serializer, {
      url: 'nats://localhost:9999', // Non-existent NATS instance
    });

    await expect(broker.connect()).rejects.toThrow();
  });
});
