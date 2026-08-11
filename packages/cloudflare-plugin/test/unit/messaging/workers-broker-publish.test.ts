/**
 * The produce half: what reaches the platform, what the subscription table
 * records, and how the two RPC methods refuse when the `rpc` arm is absent.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CloudflareUnsupportedError } from '../../../src/errors.ts';
import { WorkersBroker } from '../../../src/messaging/workers-broker.ts';
import { FakeQueueBatch, FakeQueueMessage, FakeQueueProducer } from '../../fakes.ts';
import { FakeDurableObjectNamespace } from '../../do-fakes.ts';
import { ExplodingQueueProducer, FakeBrokerRuntime } from '../../messaging-fakes.ts';

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
