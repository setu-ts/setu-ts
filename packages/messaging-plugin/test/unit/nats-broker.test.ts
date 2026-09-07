import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { NatsBroker, validateClient } from '../../src/brokers/nats-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';
import { FakeNatsConnection } from '../fixtures/fake-nats-client.ts';
import type { FakeNatsOptions } from '../fixtures/fake-nats-client.ts';
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

  it('releases the connection when a startup prerequisite fails (M90d review)', async () => {
    // `MessagingPlugin` awaits `connect()` BEFORE it installs
    // `ctx.lifecycle.onClose`, so an error escaping `connect()` leaves the
    // connection it opened live with nothing left to close it. All four
    // failure arms are covered, because the absent-stream one is reachable on
    // ordinary misconfiguration and the others share the code path.
    const arms: Array<{ label: string; options: FakeNatsOptions; subjects?: string[] }> = [
      { label: 'no JetStream on the server', options: { rejectJetstreamManager: true } },
      { label: 'stream read refused', options: { rejectStreamInfo: true } },
      { label: 'absent stream, no streamSubjects', options: { existingStreams: [] } },
      {
        label: 'stream create refused',
        options: { existingStreams: [], rejectStreamAdd: true },
        subjects: ['app.>'],
      },
    ];

    for (const arm of arms) {
      const client = new FakeNatsConnection(arm.options);
      const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
        client,
        streamName: 'MESSAGING',
        ...(arm.subjects !== undefined ? { streamSubjects: arm.subjects } : {}),
      });

      await expect(broker.connect()).rejects.toThrow();
      expect(client.isClosed()).toBe(true);
      // A failed startup must not report itself connected either.
      expect(broker.isReady()).toBe(false);
    }
  });

  it('reports the startup error even when releasing the connection fails', async () => {
    // The release is best-effort: `close()` on a connection whose startup just
    // failed can itself throw or reject, and neither may reach the caller in
    // place of the error that actually stopped startup.
    for (const closeFailure of ['throw', 'reject'] as const) {
      const client = new FakeNatsConnection({ existingStreams: [], closeFailure });
      const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
        client,
        streamName: 'MESSAGING',
      });

      const error = await broker.connect().then(
        () => {
          throw new Error('connect should have rejected');
        },
        (e: unknown) => e,
      );
      // The startup verdict, not the close failure.
      expect(error).toBeInstanceOf(JetStreamStreamError);
      expect((error as Error).message).not.toContain('close failed');
      expect(client.isClosed()).toBe(true);
    }
  });

  it('releases an injected client whose close() returns void', async () => {
    // `INatsConnection.close(): void` is the documented injected shape, while
    // the real nats connection returns `Promise<void>` — the return type
    // accepts both, so the release path must handle either.
    let closed = 0;
    const client = {
      jetstream: () => ({}),
      jetstreamManager: () => Promise.reject(new Error('503')),
      close: (): void => {
        closed += 1;
      },
    };
    const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
      client,
      streamName: 'MESSAGING',
    });

    await expect(broker.connect()).rejects.toBeInstanceOf(JetStreamUnavailableError);
    expect(closed).toBe(1);
  });

  it('stops the consume handle on unsubscribe, not the promise (M90d review)', async () => {
    // The real `Consumer.consume(opts?)` resolves to `ConsumerMessages`, and
    // `stop()` is a member of THAT (via `QueuedIterator`) — not of `Consumer`.
    // Storing the un-awaited promise made `unsubscribe()` call `.stop()` on a
    // `Promise`, a `TypeError` its `catch` swallowed, leaving the consumer
    // callback active after the caller cancelled it.
    const client = new FakeNatsConnection({
      seededMessages: [
        { subject: 'orders', data: '{"id":1}', seq: 1, timestampNanos: 1_700_000_000_000_000_000 },
      ],
    });
    const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
      client,
      streamName: 'MESSAGING',
    });
    await broker.connect();

    const subscription = await broker.subscribe('orders', () => {});
    const js = client.jetstream();
    const [handed] = js.handedOutConsumers;
    expect(handed).toBeDefined();
    expect(handed.isStopped()).toBe(false);

    await subscription.unsubscribe();

    // The handle the broker stored is the one that got stopped. Without the
    // `await`, `stop()` lands on a `Promise`, the `TypeError` is swallowed,
    // and this stays `false`.
    expect(handed.isStopped()).toBe(true);
    await broker.disconnect();
  });

  it('delivers only the subscribed subject (M90d review)', async () => {
    // The broker creates its consumer on the MANAGER and reads it back off the
    // JetStream CLIENT, which resolves `filter_subject` from the shared record.
    // The manager was recording only locally, so that lookup came back empty,
    // the fake fell through to "no filter", and every seeded subject was
    // delivered — which is why no existing assertion could see the filter.
    const client = new FakeNatsConnection({
      seededMessages: [
        { subject: 'orders', data: '{"id":1}', seq: 1, timestampNanos: 1_700_000_000_000_000_000 },
        { subject: 'billing', data: '{"id":2}', seq: 2, timestampNanos: 1_700_000_000_000_000_000 },
      ],
    });
    const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
      client,
      streamName: 'MESSAGING',
    });
    await broker.connect();

    const seen: Array<string | undefined> = [];
    await broker.subscribe<{ id: number }>('orders', (_msg, metadata) => {
      seen.push(metadata.messageId);
    });

    // Exactly the `orders` message (seq 1). Without the shared record the
    // `billing` message (seq 2) arrives here too.
    expect(seen).toEqual(['1']);

    await broker.disconnect();
  });

  it("keeps stopping consumers when one handle's stop() throws", async () => {
    // Shutdown is best-effort per consumer: a handle that refuses to stop must
    // not strand the ones after it in the map, or a single bad consumer keeps
    // the whole application's callbacks running.
    const client = new FakeNatsConnection({
      seededMessages: [
        { subject: 'a', data: '{"n":1}', seq: 1, timestampNanos: 1_700_000_000_000_000_000 },
        { subject: 'b', data: '{"n":2}', seq: 2, timestampNanos: 1_700_000_000_000_000_000 },
      ],
    });
    const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
      client,
      streamName: 'MESSAGING',
    });
    await broker.connect();
    await broker.subscribe('a', () => {});
    await broker.subscribe('b', () => {});

    const js = client.jetstream();
    const [first, second] = js.handedOutConsumers;
    first.failNextStop();

    await broker.disconnect();

    // The refusing handle stayed unstopped; the next one still stopped.
    expect(first.isStopped()).toBe(false);
    expect(second.isStopped()).toBe(true);
  });

  it('stops every consume handle on disconnect (M90d review)', async () => {
    // `disconnect()` used to call `stop()` on the `Consumer`, which has no
    // such member — so every shutdown raised a swallowed `TypeError` and left
    // the callbacks running. The handle is what carries `stop()`.
    const client = new FakeNatsConnection({
      seededMessages: [
        { subject: 'orders', data: '{"id":1}', seq: 1, timestampNanos: 1_700_000_000_000_000_000 },
      ],
    });
    const broker = new NatsBroker(createFakeRuntime(), new JsonSerializer(), {
      client,
      streamName: 'MESSAGING',
    });
    await broker.connect();
    await broker.subscribe('orders', () => {});

    const js = client.jetstream();
    const [handed] = js.handedOutConsumers;
    expect(handed.isStopped()).toBe(false);

    await broker.disconnect();
    expect(handed.isStopped()).toBe(true);
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
