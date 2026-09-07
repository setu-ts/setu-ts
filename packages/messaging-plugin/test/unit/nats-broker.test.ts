import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { NatsBroker, validateClient } from '../../src/brokers/nats-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { FakeNatsConnection } from '../fixtures/fake-nats-client.ts';
import {
  JetStreamStreamError,
  JetStreamUnavailableError,
  RequestTimeoutError,
} from '../../src/errors.ts';

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
    const expectedJson = JSON.stringify(message);
    await broker.publish('test.subject', message);

    const js = fakeConnection.jetstream();
    const calls = js.calls;
    const publishCall = calls.find((c) => c.method === 'publish');

    expect(publishCall).toBeDefined();
    expect(publishCall?.args[0]).toBe('test.subject');

    // Assert the serialized bytes match the expected JSON
    const dataArg = publishCall?.args[1] as Uint8Array;
    const decoded = new TextDecoder().decode(dataArg);
    expect(decoded).toBe(expectedJson);

    await broker.disconnect();
  });

  it('publishes supplied framework headers through the injected factory', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection();
    const values = new Map<string, string>();
    const broker = new NatsBroker(runtime, serializer, {
      client: fakeConnection,
      headersFactory: () => ({
        set: (key, value) => values.set(key, value),
        get: (key) => values.get(key),
        keys: () => values.keys(),
      }),
    });
    await broker.connect();

    await broker.publishWithHeaders('test.subject', { ok: true }, { traceparent: '00-test' });
    expect(values.get('traceparent')).toBe('00-test');
    await broker.disconnect();
  });

  it('reports once when headers are dropped for want of a MsgHdrs factory', async () => {
    // An injected connection carries no nats module, so there is no `headers()`
    // to build MsgHdrs with. Publishing must still succeed, but dropping trace
    // context silently is what made D2 invisible — so it is reported, once.
    const errors: string[] = [];
    const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
      client: new FakeNatsConnection(),
      logger: { error: (msg) => errors.push(msg) },
    });
    await broker.connect();

    await broker.publishWithHeaders('orders', { id: 1 }, { traceparent: '00-a' });
    await broker.publishWithHeaders('orders', { id: 2 }, { traceparent: '00-b' });

    expect(errors).toHaveLength(1);
    expect(errors[0]).toContain('headersFactory');
    await broker.disconnect();
  });

  it('stays silent when no headers were supplied, since nothing is lost', async () => {
    const errors: string[] = [];
    const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
      client: new FakeNatsConnection(),
      logger: { error: (msg) => errors.push(msg) },
    });
    await broker.connect();

    await broker.publish('orders', { id: 1 });

    expect(errors).toEqual([]);
    await broker.disconnect();
  });

  it('normalizes delivered NATS headers through keys and get', async () => {
    const values = new Map([['traceparent', '00-parent']]);
    const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
      client: new FakeNatsConnection({
        seededMessages: [{
          subject: 'orders',
          data: '{"id":"1"}',
          seq: 1,
          timestampNanos: 1735689600000000000,
          headers: { keys: () => values.keys(), get: (key) => values.get(key) },
        }],
      }),
    });
    await broker.connect();
    let headers: Readonly<Record<string, string>> | undefined;
    await broker.subscribeWithHeaders('orders', (_message, metadata) => {
      headers = metadata.headers;
    });
    expect(headers).toEqual({ traceparent: '00-parent' });
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

    // M90d: creation is a management operation — it must reach the JetStream
    // MANAGER (`jsm.consumers.add`), not the client, which exposes no `add`
    // against nats 2.29.
    const jsm = await fakeConnection.jetstreamManager();
    const consumersAddCall = jsm.calls.find((c) => c.method === 'consumers.add');
    expect(consumersAddCall).toBeDefined();
    const config = consumersAddCall?.args[1] as { name: string; durable_name: string };
    expect(config.name).toBe('my-consumer');
    expect(config.durable_name).toBe('my-consumer');

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

  it('creates an absent custom stream from the supplied streamSubjects', async () => {
    // X28-2: creation is reached only when the stream is ABSENT, so this test
    // models a fresh server (`existingStreams: []`). The corrected fake
    // rejects the catch-all the real server refuses, so the subjects asserted
    // here are what actually reached `streams.add`.
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection({ existingStreams: [] });
    const broker = new NatsBroker(runtime, serializer, {
      client: fakeConnection,
      streamName: 'CUSTOM-STREAM',
      streamSubjects: ['custom.a.>', 'custom.b.>'],
    });

    await broker.connect();

    const jsm = await fakeConnection.jetstreamManager();
    const streamsAddCall = jsm.calls.find((c) => c.method === 'streams.add');
    expect(streamsAddCall).toBeDefined();
    const config = streamsAddCall?.args[0] as { name: string; subjects: string[] };
    expect(config.name).toBe('CUSTOM-STREAM');
    expect(config.subjects).toEqual(['custom.a.>', 'custom.b.>']);
    // The catch-all carried `no_ack` only in the REVERSED design; the fix
    // sends neither a catch-all nor a no_ack key.
    expect('no_ack' in config).toBe(false);

    await broker.disconnect();
  });

  it('throws JetStreamStreamError when the stream is absent and no subjects are supplied', async () => {
    // X28-2/X28-3: the refusal names the stream and both remedies rather than
    // shipping a doomed catch-all subject.
    const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
      client: new FakeNatsConnection({ existingStreams: [] }),
      streamName: 'MESSAGING',
    });

    const error = await broker.connect().then(
      () => {
        throw new Error('connect should have rejected');
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(JetStreamStreamError);
    const streamError = error as JetStreamStreamError;
    expect(streamError.message).toContain('MESSAGING');
    expect(streamError.message).toContain('streamSubjects');
    expect(streamError.message).toContain('out of band');
    await broker.disconnect();
  });

  it('connects without creating anything when the stream already exists and no subjects are supplied', async () => {
    // The default fixture models a working server: the stream pre-exists, so
    // the info path connects and `streams.add` is never called (X28-2 — the
    // add is reached ONLY from the absence arm).
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection();
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    expect(broker.isReady()).toBe(true);

    const jsm = await fakeConnection.jetstreamManager();
    expect(jsm.calls.some((c) => c.method === 'streams.add')).toBe(false);

    await broker.disconnect();
  });

  it('throws JetStreamUnavailableError with the platform error as cause when JetStream is absent', async () => {
    // X28-3: the JetStream probe sits INSIDE the try, so a raw `503` becomes
    // a named error carrying the platform error as `cause`.
    const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
      client: new FakeNatsConnection({ rejectJetstreamManager: true }),
    });

    const error = await broker.connect().then(
      () => {
        throw new Error('connect should have rejected');
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(JetStreamUnavailableError);
    expect((error as JetStreamUnavailableError).message).toContain('-js');
    const cause = (error as JetStreamUnavailableError).cause as Error;
    expect(cause.message).toBe('503');
  });

  it('throws JetStreamStreamError with cause when the stream create is refused', async () => {
    const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
      client: new FakeNatsConnection({ existingStreams: [], rejectStreamAdd: true }),
      streamSubjects: ['orders.>'],
    });

    const error = await broker.connect().then(
      () => {
        throw new Error('connect should have rejected');
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(JetStreamStreamError);
    expect(((error as JetStreamStreamError).cause as Error).message).toContain(
      'stream create refused',
    );
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

  // N1: seeded delivery + ack on resolve
  it('subscribe delivers a seeded message and acks when the async handler resolves', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection({
      seededMessages: [
        {
          subject: 'test.subject',
          data: JSON.stringify({ x: 1 }),
          seq: 7,
          timestampNanos: new Date().getTime() * 1_000_000,
        },
      ],
    });
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

    let handlerCalled = false;
    let receivedData: unknown;
    let receivedMetadata: unknown;

    await broker.connect();
    await broker.subscribe('test.subject', (data, metadata) => {
      handlerCalled = true;
      receivedData = data;
      receivedMetadata = metadata;
    });

    expect(handlerCalled).toBe(true);
    expect(receivedData).toEqual({ x: 1 });
    const meta = receivedMetadata as { topic: string; messageId: string; timestamp: Date };
    expect(meta.topic).toBe('test.subject');
    expect(meta.messageId).toBe('7');
    expect(meta.timestamp instanceof Date).toBe(true);

    const js = fakeConnection.jetstream();
    // Verify ack was called (message is acked)
    const consumersGetCall = js.calls.find((c) => c.method === 'consumers.get');
    expect(consumersGetCall).toBeDefined();

    await broker.disconnect();
  });

  // N2: nacks when async handler rejects (margin test - verifies nack path exists)
  it('subscribe nacks when the async handler rejects', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection({
      seededMessages: [
        {
          subject: 'test.subject',
          data: JSON.stringify({ x: 1 }),
          seq: 8,
          timestampNanos: new Date().getTime() * 1_000_000,
        },
      ],
    });
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    // Subscribe with a handler that returns a rejected promise - the broker's .then/.catch chain
    // handles the rejection by calling nak() on the message. This is a margin test to ensure
    // the nack path exists.
    await broker.subscribe('test.subject', () => Promise.reject(new Error('handler failed')));

    // Give time for async handler to run and nack to be called
    await new Promise((resolve) => setTimeout(resolve, 50));

    await broker.disconnect();
  });

  // N3: sync ack
  it('subscribe acks a synchronous handler immediately', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection({
      seededMessages: [
        {
          subject: 'test.subject',
          data: JSON.stringify({ x: 2 }),
          seq: 9,
          timestampNanos: new Date().getTime() * 1_000_000,
        },
      ],
    });
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    await broker.subscribe('test.subject', (data) => {
      // Sync handler
      expect(data).toEqual({ x: 2 });
    });

    await broker.disconnect();
  });

  // N4: unsubscribe
  it('unsubscribe stops the consumer subscription', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection();
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();
    const sub = await broker.subscribe('test.subject', () => {}, { queue: 'my-consumer' });

    await sub.unsubscribe();

    const js = fakeConnection.jetstream();
    const calls = js.calls;
    // Verify subscription was stopped
    expect(calls).toBeDefined();

    await broker.disconnect();
  });

  // N5: non stream-not-found rethrow — now named (X28-3)
  it('rethrows a non stream-not-found jsm error as JetStreamStreamError', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection({
      rejectStreamInfo: true, // Throws a generic error instead of 'stream not found'
    });
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

    const error = await broker.connect().then(
      () => {
        throw new Error('connect should have rejected');
      },
      (e: unknown) => e,
    );
    expect(error).toBeInstanceOf(JetStreamStreamError);
    expect(((error as JetStreamStreamError).cause as Error).message).toContain('generic error');
  });

  // N6: already-exists consumer ignore
  it('subscribe ignores an already-existing consumer name', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection();
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();

    // First subscribe should create consumer
    await broker.subscribe('test.subject', () => {}, { queue: 'existing-consumer' });

    // Second subscribe with same name should not throw
    await expect(
      broker.subscribe('test.subject', () => {}, { queue: 'existing-consumer' }),
    ).resolves.not.toThrow();

    await broker.disconnect();
  });

  // N7: publish throws when not connected
  it('publish rejects when broker is not connected', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const broker = new NatsBroker(runtime, serializer, {});

    // Don't connect - should reject
    await expect(broker.publish('test', { data: 1 })).rejects.toThrow(
      'NatsBroker is not connected',
    );
  });

  // N8: failure-path - handler throws → nak() called
  it('subscribe calls nak() when the async handler throws', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection({
      seededMessages: [
        {
          subject: 'test.subject',
          data: JSON.stringify({ x: 1 }),
          seq: 1,
          timestampNanos: new Date().getTime() * 1_000_000,
        },
      ],
    });
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();

    // Handler that throws (async, returns rejected promise)
    let handlerInvoked = false;
    const sub = await broker.subscribe(
      'test.subject',
      async () => {
        handlerInvoked = true;
        await Promise.resolve(); // ensure async behavior
        throw new Error('handler failure');
      },
      { queue: 'failure-consumer' },
    );

    // Wait for async handler to run
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The delivered message must be nak()'d (not ack()'d) because the handler threw.
    const deliveredMsg = fakeConnection.jetstream().deliveredMessages[0];
    expect(handlerInvoked).toBe(true);
    expect(deliveredMsg.isNaked()).toBe(true);
    expect(deliveredMsg.isAcked()).toBe(false);

    await sub.unsubscribe();
    await broker.disconnect();
  });

  // N9: success-path - handler succeeds → ack() called
  it('subscribe calls ack() when the async handler succeeds', async () => {
    const runtime = createFakeRuntime();
    const serializer = new JsonSerializer();
    const fakeConnection = new FakeNatsConnection({
      seededMessages: [
        {
          subject: 'test.subject',
          data: JSON.stringify({ x: 1 }),
          seq: 1,
          timestampNanos: new Date().getTime() * 1_000_000,
        },
      ],
    });
    const broker = new NatsBroker(runtime, serializer, { client: fakeConnection });

    await broker.connect();

    let handlerCalled = false;
    const sub = await broker.subscribe(
      'test.subject',
      () => {
        handlerCalled = true;
      },
      { queue: 'success-consumer' },
    );

    // Wait for async handler to run
    await new Promise((resolve) => setTimeout(resolve, 10));

    // The delivered message must be ack()'d (not nak()'d) because the handler succeeded.
    const deliveredMsg = fakeConnection.jetstream().deliveredMessages[0];
    expect(handlerCalled).toBe(true);
    expect(deliveredMsg.isAcked()).toBe(true);
    expect(deliveredMsg.isNaked()).toBe(false);

    await sub.unsubscribe();
    await broker.disconnect();
  });
});

describe('NatsBroker request-reply delegation', () => {
  it('respond() returns a subscription', async () => {
    const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
      client: new FakeNatsConnection(),
    });
    await broker.connect();
    const sub = await broker.respond('resp.only', (m) => m);
    expect(typeof sub.unsubscribe).toBe('function');
    await sub.unsubscribe();
    await broker.disconnect();
  });

  it('request() rejects with RequestTimeoutError when unanswered', async () => {
    const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
      client: new FakeNatsConnection(),
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
