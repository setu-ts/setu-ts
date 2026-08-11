/**
 * The whole RPC path wired end to end, with no step stubbed out.
 *
 * A caller's `request()` opens a real {@linkcode ReplyInboxObjectCore} through
 * the namespace fake, publishes to a producer fake, that body is handed back as
 * a real batch to a SECOND broker (the consuming Worker), whose responder's
 * value is posted to the same inbox object and pushed down the socket to the
 * caller. Every unit test here could pass with a reply that never arrived; this
 * one cannot.
 *
 * @module
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CloudflareRemoteHandlerError, CloudflareRequestTimeoutError } from '../../src/errors.ts';
import { WorkersBroker } from '../../src/messaging/workers-broker.ts';
import { FakeDurableObjectNamespace } from '../do-fakes.ts';
import { FakeQueueBatch, FakeQueueMessage, FakeQueueProducer } from '../fakes.ts';
import { FakeBrokerRuntime } from '../messaging-fakes.ts';

/**
 * A caller and a responder that are DIFFERENT broker instances, as they are in
 * production: the caller runs in a `fetch` invocation and the responder in the
 * consuming Worker's `queue` invocation. They share only the queue and the
 * Durable Object namespace — which is exactly what two deployed Workers share.
 */
function twoWorkers(): {
  caller: WorkersBroker;
  consumer: WorkersBroker;
  producer: FakeQueueProducer;
  callerRuntime: FakeBrokerRuntime;
  namespace: FakeDurableObjectNamespace;
} {
  const producer = new FakeQueueProducer();
  const namespace = new FakeDurableObjectNamespace('reply-inbox');
  const callerRuntime = new FakeBrokerRuntime();
  const replyInbox = { namespace, binding: 'REPLY_INBOX' };

  return {
    caller: new WorkersBroker(producer, callerRuntime, { replyInbox }),
    consumer: new WorkersBroker(producer, new FakeBrokerRuntime(), { replyInbox }),
    producer,
    callerRuntime,
    namespace,
  };
}

/** Lets the inbox upgrade and the request publish settle. */
function flush(): Promise<void> {
  return new Promise<void>((resolve) => setTimeout(resolve, 0));
}

/** Delivers everything the producer has accepted into the consumer. */
async function deliver(
  consumer: WorkersBroker,
  producer: FakeQueueProducer,
): Promise<readonly FakeQueueMessage[]> {
  const messages = producer.sends.map((send, index) =>
    new FakeQueueMessage(`m${index}`, send.body)
  );
  (producer.sends as unknown[]).length = 0;
  await consumer.dispatch(new FakeQueueBatch('messages', messages));
  return messages;
}

describe('brokered request-reply over Cloudflare Queues and a Durable Object', () => {
  it('resolves the caller with the responder value', async () => {
    const { caller, consumer, producer } = twoWorkers();
    await consumer.respond<number, number>('sum', (n) => n + 1);

    const reply = caller.request<number, number>('sum', 41);
    await flush();

    const delivered = await deliver(consumer, producer);

    expect(await reply).toBe(42);
    expect(delivered[0]?.disposition).toBe('acked');
  });

  it('carries a structured payload both ways', async () => {
    const { caller, consumer, producer } = twoWorkers();
    await consumer.respond<{ items: number[] }, { total: number }>('total', (request) => ({
      total: request.items.reduce((sum, n) => sum + n, 0),
    }));

    const reply = caller.request<{ items: number[] }, { total: number }>('total', {
      items: [1, 2, 3],
    });
    await flush();
    await deliver(consumer, producer);

    expect(await reply).toEqual({ total: 6 });
  });

  it('gives the responder the request metadata', async () => {
    const { caller, consumer, producer } = twoWorkers();
    let seenTopic: string | undefined;
    await consumer.respond('sum', (_request, metadata) => {
      seenTopic = metadata.topic;
      return 1;
    });

    const reply = caller.request('sum', 1);
    await flush();
    await deliver(consumer, producer);
    await reply;

    expect(seenTopic).toBe('sum');
  });

  it('rejects the caller with the responder failure, not a timeout', async () => {
    const { caller, consumer, producer } = twoWorkers();
    await consumer.respond('sum', () => {
      throw new Error('not a number');
    });

    const reply = caller.request('sum', 'x');
    await flush();
    await deliver(consumer, producer);

    await expect(reply).rejects.toThrow(CloudflareRemoteHandlerError);
    await expect(reply).rejects.toThrow('not a number');
  });

  it('rejects immediately when the consumer has no responder for the topic', async () => {
    const { caller, consumer, producer } = twoWorkers();
    await consumer.respond('other', () => 1);

    const reply = caller.request('sum', 1);
    await flush();
    await deliver(consumer, producer);

    // Answered rather than left to time out: the failure names the topic, and
    // the caller learns in one round trip instead of five seconds.
    await expect(reply).rejects.toThrow(CloudflareRemoteHandlerError);
    await expect(reply).rejects.toThrow("No responder is registered for 'sum'");
  });

  it('times out when no reply is ever delivered', async () => {
    const { caller, callerRuntime } = twoWorkers();

    const reply = caller.request('sum', 1, { timeoutMs: 250 });
    await flush();
    // The consumer never runs — the queue is configured but nothing consumes it.
    callerRuntime.fire(0);

    await expect(reply).rejects.toThrow(CloudflareRequestTimeoutError);
  });

  it('correlates two concurrent requests to their own replies', async () => {
    const { caller, consumer, producer } = twoWorkers();
    await consumer.respond<number, number>('double', (n) => n * 2);

    const first = caller.request<number, number>('double', 3);
    const second = caller.request<number, number>('double', 10);
    await flush();

    await deliver(consumer, producer);

    // Both ride one inbox socket, so a correlation-id mix-up would cross the
    // answers over silently.
    expect(await first).toBe(6);
    expect(await second).toBe(20);
  });

  it('leaves plain pub/sub on the same topic untouched', async () => {
    const { caller, consumer, producer } = twoWorkers();
    const published: unknown[] = [];
    await consumer.subscribe('sum', (message) => {
      published.push(message);
    });
    await consumer.respond<number, number>('sum', (n) => n + 1);

    const reply = caller.request<number, number>('sum', 1);
    await flush();
    await caller.publish('sum', 'a plain message');

    await deliver(consumer, producer);

    expect(await reply).toBe(2);
    expect(published).toEqual(['a plain message']);
  });

  it('drops a duplicate reply, which at-least-once delivery produces', async () => {
    const { caller, consumer, producer, namespace } = twoWorkers();
    let calls = 0;
    await consumer.respond<number, number>('sum', (n) => {
      calls += 1;
      return n + 1;
    });

    const reply = caller.request<number, number>('sum', 1);
    await flush();

    const messages = producer.sends.map((send, index) =>
      new FakeQueueMessage(`m${index}`, send.body)
    );
    // The same message delivered twice — the platform's at-least-once contract.
    await consumer.dispatch(new FakeQueueBatch('messages', messages));
    await consumer.dispatch(
      new FakeQueueBatch('messages', messages.map((m) => new FakeQueueMessage(m.id, m.body))),
    );

    expect(await reply).toBe(2);
    expect(calls).toBe(2);
    // Two replies reached the inbox object; only the first settled a caller.
    expect(namespace.states.size).toBe(1);
  });

  it('closes the inbox when the caller disconnects, releasing the object', async () => {
    const { caller, namespace } = twoWorkers();

    const pending = caller.request('sum', 1, { timeoutMs: 60_000 });
    await flush();
    expect(namespace.clients[0]?.closed).toBe(false);

    await caller.disconnect();

    await expect(pending).rejects.toThrow('disconnected');
    expect(namespace.clients[0]?.closed).toBe(true);
  });
});
