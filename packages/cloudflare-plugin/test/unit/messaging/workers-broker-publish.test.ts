/**
 * The produce half: what reaches the platform, what the subscription table
 * records, and how the two RPC methods refuse when the `rpc` arm is absent.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { MessageMetadata } from '@setu-ts/common';
import { MAX_PUBLISH_HEADERS } from '@setu-ts/common';

import { CloudflareUnsupportedError } from '../../../src/errors.ts';
import { WorkersBroker } from '../../../src/messaging/workers-broker.ts';
import { FakeQueueBatch, FakeQueueMessage, FakeQueueProducer } from '../../fakes.ts';
import { FakeDurableObjectNamespace } from '../../do-fakes.ts';
import { ExplodingQueueProducer, FakeBrokerRuntime } from '../../messaging-fakes.ts';

/**
 * Runs `fn` with the `Object.prototype.__proto__` accessor Node, Bun and workerd
 * keep and Deno deletes, so a test running on Deno sees what those runtimes do
 * to a `__proto__` key built by assignment. Restores the prior state after.
 */
function withProtoAccessor<T>(fn: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, '__proto__');
  Object.defineProperty(Object.prototype, '__proto__', {
    configurable: true,
    get(this: object): object | null {
      return Object.getPrototypeOf(this);
    },
    set(this: object, value: unknown): void {
      if ((typeof value === 'object' && value !== null) || value === null) {
        Object.setPrototypeOf(this, value);
      }
    },
  });
  try {
    return fn();
  } finally {
    if (previous) Object.defineProperty(Object.prototype, '__proto__', previous);
    else delete (Object.prototype as { __proto__?: unknown }).__proto__;
  }
}

/**
 * Lets the inbox open and the request publish settle.
 *
 * A real macrotask rather than a counted number of microtask ticks: the open is
 * several awaits deep, and a test that counted them would break whenever an
 * `await` moved. The BROKER's timers are still the inert fake ones, so nothing
 * about the reply budget depends on real time here.
 */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

describe('WorkersBroker.publish', () => {
  it('sends exactly the envelope, with the topic the payload could not carry', async () => {
    const producer = new FakeQueueProducer();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime());

    await broker.publish('user.created', { userId: 7 });

    expect(producer.sends).toHaveLength(1);
    expect(producer.sends[0]?.body).toEqual({
      v: 1,
      kind: 'msg',
      topic: 'user.created',
      id: 'id-1',
      payload: { userId: 7 },
    });
  });

  it('sends no delaySeconds, which IMessageBroker.publish has no parameter for', async () => {
    const producer = new FakeQueueProducer();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime());

    await broker.publish('t', 1);

    expect(producer.sends[0]?.options).toBeUndefined();
  });

  it('propagates a refused send rather than reporting success', async () => {
    const broker = new WorkersBroker(new ExplodingQueueProducer(), new FakeBrokerRuntime());
    await expect(broker.publish('t', 1)).rejects.toThrow('queue send failed');
  });

  it('carries orderingKey and deduplicationId as envelope fields (M106 §3.3)', async () => {
    const producer = new FakeQueueProducer();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime());

    await broker.publish('orders', { id: 1 }, {
      orderingKey: 'agg-1',
      deduplicationId: 'dedup-1',
    });

    expect(producer.sends[0]?.body).toEqual({
      v: 1,
      kind: 'msg',
      topic: 'orders',
      id: 'id-1',
      payload: { id: 1 },
      orderingKey: 'agg-1',
      deduplicationId: 'dedup-1',
    });
  });

  it('carries a caller headers record on the envelope, since a queue has none (M106 §3.3)', async () => {
    const producer = new FakeQueueProducer();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime());

    await broker.publish('orders', { id: 1 }, { headers: { 'x-tenant': 'acme' } });

    expect(producer.sends[0]?.body).toEqual({
      v: 1,
      kind: 'msg',
      topic: 'orders',
      id: 'id-1',
      payload: { id: 1 },
      headers: { 'x-tenant': 'acme' },
    });
  });

  it('refuses a reserved name (as a rejected promise) and never reaches the platform (M106 §3.4)', async () => {
    const producer = new FakeQueueProducer();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime());

    await expect(broker.publish('orders', 1, { headers: { cc: 'x' } })).rejects.toThrow(RangeError);
    await expect(broker.publish('orders', 1, { headers: { 'x-setu-ordering-key': 'k' } })).rejects
      .toThrow(RangeError);
    expect(producer.sends).toEqual([]);
  });

  it('refuses a header with an invalid name or value (M106 §3.4)', async () => {
    const producer = new FakeQueueProducer();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime());

    await expect(broker.publish('orders', 1, { headers: { 'bad:name': 'v' } })).rejects.toThrow(
      RangeError,
    );
    await expect(broker.publish('orders', 1, { headers: { 'x-a': 'v'.repeat(1025) } })).rejects
      .toThrow(RangeError);
    expect(producer.sends).toEqual([]);
  });

  it('keeps a __proto__ header on the envelope where the __proto__ setter exists (M106 §10 D10)', async () => {
    const producer = new FakeQueueProducer();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime());
    const headers = JSON.parse('{"__proto__":"v","x-a":"1"}');

    await withProtoAccessor(() => {
      // Vacuity guard: under the accessor, assignment really drops the key.
      const assigned: Record<string, string> = {};
      assigned['__proto__'] = 'v';
      expect(Object.keys(assigned)).toEqual([]);
      return broker.publish('orders', 1, { headers });
    });

    const sent = producer.sends[0]?.body as { headers: Record<string, string> };
    expect(Object.keys(sent.headers)).toEqual(['__proto__', 'x-a']);
  });

  it('refuses a class instance as headers, as messaging-plugin does (M106 §3.4)', async () => {
    class NotPlain {
      'x-a' = '1';
    }
    const producer = new FakeQueueProducer();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime());

    await expect(broker.publish('orders', 1, { headers: new NotPlain() as never })).rejects.toThrow(
      'publish options headers must be a plain object',
    );
    expect(producer.sends).toHaveLength(0);
  });

  it('accepts an empty headers record, which carries nothing', async () => {
    const producer = new FakeQueueProducer();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime());

    await broker.publish('orders', 1, { headers: {} });

    expect(producer.sends).toHaveLength(1);
  });

  it('refuses an invalid ordering key as a rejected promise, never synchronously (M106 §3.4)', async () => {
    const producer = new FakeQueueProducer();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime());

    let promise: Promise<void> | undefined;
    expect(() => {
      promise = broker.publish('orders', 1, { orderingKey: 'a'.repeat(129) });
    }).not.toThrow();
    await expect(promise!).rejects.toThrow(RangeError);
    expect(producer.sends).toEqual([]);
  });
});

describe('WorkersBroker message metadata (M106 §3.3)', () => {
  async function deliver(envelope: Record<string, unknown>): Promise<MessageMetadata> {
    const broker = new WorkersBroker(new FakeQueueProducer(), new FakeBrokerRuntime());
    const delivered: MessageMetadata[] = [];
    await broker.subscribe('orders', (_message, metadata) => {
      delivered.push(metadata);
    });
    await broker.dispatch(new FakeQueueBatch('q', [new FakeQueueMessage('m1', envelope)]));
    return delivered[0]!;
  }

  it('surfaces valid envelope fields as the transport headers', async () => {
    const metadata = await deliver({
      v: 1,
      kind: 'msg',
      topic: 'orders',
      id: 'i',
      payload: 1,
      orderingKey: 'agg-1',
      deduplicationId: 'dedup-1',
    });
    expect(metadata.headers).toEqual({
      'x-setu-ordering-key': 'agg-1',
      'x-setu-deduplication-id': 'dedup-1',
    });
  });

  it('surfaces a caller header carried on the envelope, dropping an invalid one (M106 §3.4)', async () => {
    const metadata = await deliver({
      v: 1,
      kind: 'msg',
      topic: 'orders',
      id: 'i',
      payload: 1,
      headers: {
        'x-tenant': 'acme',
        cc: 'sneaky',
        'x-bad': 'v'.repeat(1025),
        'bad:name': 'v',
      },
    });
    // Only the valid entry survives; the reserved name, the over-long value and
    // the un-encodable name are all dropped, never surfaced.
    expect(metadata.headers).toEqual({ 'x-tenant': 'acme' });
  });

  it('ignores a non-object headers field a foreign producer wrote (M106 §3.4)', async () => {
    const metadata = await deliver({
      v: 1,
      kind: 'msg',
      topic: 'orders',
      id: 'i',
      payload: 1,
      headers: 'not-an-object',
    });
    expect(metadata.headers).toEqual({});
  });

  it('surfaces a __proto__ header as an own key where the __proto__ setter exists (M106 §10 D10)', async () => {
    const envelope = JSON.parse(
      '{"v":1,"kind":"msg","topic":"orders","id":"i","payload":1,"headers":{"__proto__":"v"}}',
    );
    const delivered: MessageMetadata[] = [];
    const broker = new WorkersBroker(new FakeQueueProducer(), new FakeBrokerRuntime());
    await broker.subscribe('orders', (_message, metadata) => {
      delivered.push(metadata);
    });
    // The dispatch runs synchronously up to its first await, which is where
    // `envelopeHeaders` builds the record — so the accessor must be live for it.
    await withProtoAccessor(() =>
      broker.dispatch(new FakeQueueBatch('q', [new FakeQueueMessage('m1', envelope)]))
    );
    expect(Object.keys(delivered[0]!.headers ?? {})).toEqual(['__proto__']);
  });

  it('drops every carried header when the record is over the publish count bound, keeping the id headers', async () => {
    const atBound = Object.fromEntries(
      Array.from({ length: MAX_PUBLISH_HEADERS }, (_, i) => [`x-h${i}`, 'v']),
    );
    const overBound = { ...atBound, 'x-extra': 'v' };
    const base = { v: 1, kind: 'msg', topic: 'orders', id: 'i', payload: 1 } as const;

    const kept = await deliver({ ...base, headers: atBound });
    expect(Object.keys(kept.headers ?? {})).toHaveLength(MAX_PUBLISH_HEADERS);

    const dropped = await deliver({ ...base, headers: overBound, orderingKey: 'agg-1' });
    expect(dropped.headers).toEqual({ 'x-setu-ordering-key': 'agg-1' });
  });

  it('reports empty headers when the envelope carries neither field', async () => {
    const metadata = await deliver({ v: 1, kind: 'msg', topic: 'orders', id: 'i', payload: 1 });
    expect(metadata.headers).toEqual({});
  });

  it('drops a field that fails the id rule, surfacing no header for it (M106 §3.4)', async () => {
    const metadata = await deliver({
      v: 1,
      kind: 'msg',
      topic: 'orders',
      id: 'i',
      payload: 1,
      orderingKey: 'a'.repeat(129),
      deduplicationId: 42,
    });
    expect(metadata.headers).toEqual({});
  });
});

describe('WorkersBroker.connect / disconnect', () => {
  it('connects without touching the binding, since a producer is always ready', async () => {
    const producer = new FakeQueueProducer();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime());

    await broker.connect();

    // A probe read here would throw on a real deployment: Cloudflare prohibits
    // binding I/O outside a request context.
    expect(producer.sends).toEqual([]);
  });

  it('drops every subscription, so a disconnected broker delivers nothing', async () => {
    const producer = new FakeQueueProducer();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime());
    const seen: unknown[] = [];
    await broker.subscribe('orders', (message) => {
      seen.push(message);
    });

    await broker.disconnect();
    await broker.dispatch(
      new FakeQueueBatch('q', [
        new FakeQueueMessage('m1', { v: 1, kind: 'msg', topic: 'orders', id: 'i', payload: 1 }),
      ]),
    );

    expect(seen).toEqual([]);
  });

  it('is safe to disconnect a broker that never opened an inbox', async () => {
    const broker = new WorkersBroker(new FakeQueueProducer(), new FakeBrokerRuntime());
    await expect(broker.disconnect()).resolves.toBeUndefined();
  });
});

describe('WorkersBroker.subscribe', () => {
  it('registers rather than delivering, because a consumer is a module export', async () => {
    const producer = new FakeQueueProducer();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime());
    const seen: unknown[] = [];

    await broker.subscribe('orders', (message) => {
      seen.push(message);
    });
    await broker.publish('orders', { id: 1 });

    // The publish went to the queue; nothing is delivered until the Worker's
    // `queue` export dispatches a batch back in.
    expect(producer.sends).toHaveLength(1);
    expect(seen).toEqual([]);
  });

  it('unsubscribe stops delivery to that handler alone', async () => {
    const broker = new WorkersBroker(new FakeQueueProducer(), new FakeBrokerRuntime());
    const first: unknown[] = [];
    const second: unknown[] = [];

    const subscription = await broker.subscribe('orders', (m) => {
      first.push(m);
    });
    await broker.subscribe('orders', (m) => {
      second.push(m);
    });
    await subscription.unsubscribe();

    await broker.dispatch(
      new FakeQueueBatch('q', [
        new FakeQueueMessage('m1', { v: 1, kind: 'msg', topic: 'orders', id: 'i', payload: 'x' }),
      ]),
    );

    expect(first).toEqual([]);
    expect(second).toEqual(['x']);
  });
});

describe('WorkersBroker RPC without the rpc arm', () => {
  it('refuses request(), naming the arm and the reason a queue cannot reply', async () => {
    const broker = new WorkersBroker(new FakeQueueProducer(), new FakeBrokerRuntime());

    await expect(broker.request('sum', 2)).rejects.toThrow(CloudflareUnsupportedError);
    await expect(broker.request('sum', 2)).rejects.toThrow('rpc');
    await expect(broker.request('sum', 2)).rejects.toThrow('ReplyInboxObjectCore');
  });

  it('refuses respond() the same way, at registration rather than at delivery', async () => {
    const broker = new WorkersBroker(new FakeQueueProducer(), new FakeBrokerRuntime());

    await expect(broker.respond('sum', () => 1)).rejects.toThrow(CloudflareUnsupportedError);
  });

  it('never reaches the queue when it refuses', async () => {
    const producer = new FakeQueueProducer();
    const broker = new WorkersBroker(producer, new FakeBrokerRuntime());

    await expect(broker.request('sum', 2)).rejects.toThrow(CloudflareUnsupportedError);

    expect(producer.sends).toEqual([]);
  });
});

describe('WorkersBroker.request', () => {
  /** A broker whose reply inbox is a namespace backed by the real DO core. */
  function brokerWithRpc(defaultTimeoutMs?: number): {
    broker: WorkersBroker;
    producer: FakeQueueProducer;
    runtime: FakeBrokerRuntime;
    namespace: FakeDurableObjectNamespace;
  } {
    const producer = new FakeQueueProducer();
    const runtime = new FakeBrokerRuntime();
    const namespace = new FakeDurableObjectNamespace('reply-inbox');
    const broker = new WorkersBroker(producer, runtime, {
      replyInbox: {
        namespace,
        binding: 'REPLY_INBOX',
        ...(defaultTimeoutMs === undefined ? {} : { defaultTimeoutMs }),
      },
    });
    return { broker, producer, runtime, namespace };
  }

  it('publishes a request envelope carrying its own inbox address', async () => {
    const { broker, producer, runtime } = brokerWithRpc();

    const pending = broker.request('sum', [1, 2]).catch(() => undefined);
    await flush();

    expect(producer.sends).toHaveLength(1);
    const body = producer.sends[0]?.body as Record<string, unknown>;
    expect(body.kind).toBe('rpc-req');
    expect(body.topic).toBe('sum');
    expect(body.payload).toEqual([1, 2]);
    expect(String(body.replyTo)).toMatch(/^rr\.inbox\./);

    runtime.fire(0);
    await pending;
  });

  it('opens exactly one inbox however many requests are in flight', async () => {
    const { broker, runtime, namespace } = brokerWithRpc();

    const first = broker.request('sum', 1).catch(() => undefined);
    const second = broker.request('sum', 2).catch(() => undefined);
    await flush();

    expect(namespace.requestedNames.filter((n) => n.startsWith('rr.inbox.'))).toHaveLength(1);

    runtime.fire(0);
    runtime.fire(1);
    await Promise.all([first, second]);
  });

  it('applies the arm default budget when the call omits one', async () => {
    const { broker, runtime } = brokerWithRpc(1234);

    const pending = broker.request('sum', 1).catch(() => undefined);
    await flush();

    expect(runtime.scheduled[0]?.ms).toBe(1234);
    runtime.fire(0);
    await pending;
  });

  it('lets the call override the arm default', async () => {
    const { broker, runtime } = brokerWithRpc(1234);

    const pending = broker.request('sum', 1, { timeoutMs: 50 }).catch(() => undefined);
    await flush();

    expect(runtime.scheduled[0]?.ms).toBe(50);
    runtime.fire(0);
    await pending;
  });

  it('falls back to 5000ms with no arm default and no option', async () => {
    const { broker, runtime } = brokerWithRpc();

    const pending = broker.request('sum', 1).catch(() => undefined);
    await flush();

    expect(runtime.scheduled[0]?.ms).toBe(5000);
    runtime.fire(0);
    await pending;
  });

  it('abandons the pending entry when the publish fails', async () => {
    const runtime = new FakeBrokerRuntime();
    const namespace = new FakeDurableObjectNamespace('reply-inbox');
    const broker = new WorkersBroker(new ExplodingQueueProducer(), runtime, {
      replyInbox: { namespace, binding: 'REPLY_INBOX' },
    });

    await expect(broker.request('sum', 1)).rejects.toThrow('queue send failed');

    // The caller already has the failure, so a timer left running would fire
    // into a promise nobody is holding.
    expect(runtime.outstandingTimers).toBe(0);
  });

  it('rejects an in-flight request when the broker disconnects', async () => {
    const { broker, runtime } = brokerWithRpc();

    const pending = broker.request('sum', 1);
    await flush();
    await broker.disconnect();

    await expect(pending).rejects.toThrow('disconnected');
    expect(runtime.outstandingTimers).toBe(0);
  });

  it('rejects an in-flight request when the inbox socket drops', async () => {
    const { broker, namespace } = brokerWithRpc();

    const pending = broker.request('sum', 1);
    await flush();
    namespace.clients[0]?.fire('close', { data: '' });

    await expect(pending).rejects.toThrow('reply inbox closed');
  });

  it('reopens the inbox after a drop rather than failing every later request', async () => {
    const { broker, namespace, runtime } = brokerWithRpc();

    const first = broker.request('sum', 1);
    await flush();
    namespace.clients[0]?.fire('close', { data: '' });
    await expect(first).rejects.toThrow('reply inbox closed');

    const second = broker.request('sum', 2).catch(() => undefined);
    await flush();

    expect(namespace.clients).toHaveLength(2);
    runtime.fire(1);
    await second;
  });

  it('does not cache a failed inbox open, so a later request retries', async () => {
    const { broker, producer, namespace, runtime } = brokerWithRpc();
    namespace.omitSocket = true;

    await expect(broker.request('sum', 1)).rejects.toThrow('REPLY_INBOX');
    expect(producer.sends).toEqual([]);

    namespace.omitSocket = false;
    const second = broker.request('sum', 2).catch(() => undefined);
    await flush();

    // The retry got a live inbox and its request left the isolate. Memoizing
    // the rejected open would have failed this one with the same stale error
    // forever, even after the namespace recovered.
    expect(producer.sends).toHaveLength(1);
    expect((producer.sends[0]?.body as { payload?: unknown }).payload).toBe(2);

    runtime.fire(0);
    await second;
  });

  it('ignores an unparseable frame on the inbox, leaving the timeout to report', async () => {
    const { broker, runtime, namespace } = brokerWithRpc();

    const pending = broker.request('sum', 1, { timeoutMs: 250 });
    await flush();
    // A reply inbox is addressed by a UUID no other producer knows, so garbage
    // here is version skew rather than cross-talk — dropped, so the caller's
    // timeout reports something diagnosable instead of a parse error escaping
    // inside a socket listener where nothing would catch it.
    namespace.clients[0]?.receive('not json at all');
    namespace.clients[0]?.receive('{"kind":"something-else"}');

    runtime.fire(0);
    await expect(pending).rejects.toThrow('within 250ms');
  });

  it('disconnects cleanly when the inbox open itself failed', async () => {
    const { broker, namespace } = brokerWithRpc();
    namespace.omitSocket = true;

    await expect(broker.request('sum', 1)).rejects.toThrow('REPLY_INBOX');

    // There is no socket to release; disconnect must not surface the open's
    // failure as a shutdown failure.
    await expect(broker.disconnect()).resolves.toBeUndefined();
  });

  it('refuses a request whose inbox opened after a disconnect', async () => {
    const { broker } = brokerWithRpc();

    const pending = broker.request('sum', 1);
    // Lands while the upgrade is still in flight: the open must not publish a
    // socket onto a broker that has already torn down.
    await broker.disconnect();

    await expect(pending).rejects.toThrow('disconnected');
  });
});
