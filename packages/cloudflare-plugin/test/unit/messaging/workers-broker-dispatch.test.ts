/**
 * The consume half. Every message must be acked or retried **exactly once** —
 * acking a message the consumer could not route discards it silently, and
 * retrying one nobody subscribed to burns the queue's retry budget until every
 * fire-and-forget message is dead-lettered.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  encodePublishEnvelope,
  encodeRequestEnvelope,
} from '../../../src/messaging/message-envelope.ts';
import { WorkersBroker } from '../../../src/messaging/workers-broker.ts';
import { FakeDurableObjectNamespace } from '../../do-fakes.ts';
import {
  AckFailsQueueMessage,
  FakeQueueBatch,
  FakeQueueMessage,
  FakeQueueProducer,
  RecordingLogger,
} from '../../fakes.ts';
import { FakeBrokerRuntime } from '../../messaging-fakes.ts';

/** A broker with a recording logger, and optionally a reply-inbox namespace. */
function makeBroker(withRpc = false): {
  broker: WorkersBroker;
  logger: RecordingLogger;
  namespace: FakeDurableObjectNamespace;
  runtime: FakeBrokerRuntime;
} {
  const logger = new RecordingLogger();
  const namespace = new FakeDurableObjectNamespace('reply-inbox');
  const runtime = new FakeBrokerRuntime();
  const broker = new WorkersBroker(new FakeQueueProducer(), runtime, {
    logger: () => logger,
    ...(withRpc ? { replyInbox: { namespace, binding: 'REPLY_INBOX' } } : {}),
  });
  return { broker, logger, namespace, runtime };
}

/** Dispatches one message and returns it, so its disposition is assertable. */
async function dispatchOne(
  broker: WorkersBroker,
  body: unknown,
  message: FakeQueueMessage = new FakeQueueMessage('m1', body),
): Promise<FakeQueueMessage> {
  await broker.dispatch(new FakeQueueBatch('messages', [message]));
  return message;
}

describe('WorkersBroker.dispatch — routing', () => {
  it('delivers a publish to its subscriber and acks', async () => {
    const { broker } = makeBroker();
    const seen: { message: unknown; topic: string }[] = [];
    await broker.subscribe('orders', (message, metadata) => {
      seen.push({ message, topic: metadata.topic });
    });

    const message = await dispatchOne(broker, encodePublishEnvelope('orders', 'i1', { id: 7 }));

    expect(seen).toEqual([{ message: { id: 7 }, topic: 'orders' }]);
    expect(message.disposition).toBe('acked');
  });

  it('carries the message id and a wall-clock timestamp as metadata', async () => {
    const { broker, runtime } = makeBroker();
    runtime.epoch = 1_700_000_123_000;
    let seen: { messageId?: string; timestamp?: Date } | undefined;
    await broker.subscribe('orders', (_message, metadata) => {
      seen = metadata;
    });

    await dispatchOne(broker, encodePublishEnvelope('orders', 'i1', null));

    expect(seen?.messageId).toBe('i1');
    expect(seen?.timestamp).toEqual(new Date(1_700_000_123_000));
  });

  it('fans one publish out to every queue-less subscriber', async () => {
    const { broker } = makeBroker();
    const seen: string[] = [];
    await broker.subscribe('orders', () => {
      seen.push('a');
    });
    await broker.subscribe('orders', () => {
      seen.push('b');
    });

    const message = await dispatchOne(broker, encodePublishEnvelope('orders', 'i1', 1));

    expect(seen).toEqual(['a', 'b']);
    expect(message.disposition).toBe('acked');
  });

  it('delivers to exactly one member of a consumer group', async () => {
    const { broker } = makeBroker();
    const seen: string[] = [];
    await broker.subscribe('orders', () => {
      seen.push('a');
    }, { queue: 'workers' });
    await broker.subscribe('orders', () => {
      seen.push('b');
    }, { queue: 'workers' });

    await dispatchOne(broker, encodePublishEnvelope('orders', 'i1', 1));

    expect(seen).toEqual(['a']);
  });

  it('ACKS a publish nobody subscribed to, rather than burning the retry budget', async () => {
    const { broker, logger } = makeBroker();
    await broker.subscribe('other', () => {});

    const message = await dispatchOne(broker, encodePublishEnvelope('orders', 'i1', 1));

    // The one place this deliberately departs from `WorkersQueue`: a job name
    // with no processor is a mistake, but publishing to a topic nobody listens
    // on is ordinary pub/sub.
    expect(message.disposition).toBe('acked');
    expect(logger.messages()).toEqual([
      'cloudflare-messaging: no subscriber for topic, acked',
    ]);
    expect(logger.records[0]?.level).toBe('debug');
    expect(logger.records[0]?.meta).toMatchObject({ topic: 'orders', subscribed: ['other'] });
  });

  it('RETRIES a body that is not one of our envelopes', async () => {
    const { broker, logger } = makeBroker();

    const message = await dispatchOne(broker, { some: 'other producer' });

    expect(message.disposition).toBe('retried');
    expect(logger.messages()).toEqual([
      'cloudflare-messaging: message not readable, retried',
    ]);
    expect(logger.records[0]?.level).toBe('error');
  });

  it('RETRIES a job envelope from the queue capability, which is not ours', async () => {
    const { broker } = makeBroker();

    const message = await dispatchOne(broker, { v: 1, name: 'send-email', id: 'j1', data: {} });

    expect(message.disposition).toBe('retried');
  });

  it('RETRIES when a subscriber throws, leaving max_retries to decide', async () => {
    const { broker, logger } = makeBroker();
    await broker.subscribe('orders', () => {
      throw new Error('handler exploded');
    });

    const message = await dispatchOne(
      broker,
      encodePublishEnvelope('orders', 'i1', 1),
      new FakeQueueMessage('m1', encodePublishEnvelope('orders', 'i1', 1), 3),
    );

    expect(message.disposition).toBe('retried');
    expect(logger.messages()).toEqual([
      'cloudflare-messaging: subscriber failed, message retried',
    ]);
    expect(logger.records[0]?.meta).toMatchObject({ attempts: 3, error: 'handler exploded' });
  });

  it('reports a subscriber that threw a non-Error', async () => {
    const { broker, logger } = makeBroker();
    await broker.subscribe('orders', () => {
      // Not every throw is an Error; a string here used to render as
      // "[object Object]" in the report.
      throw 'plain string failure';
    });

    const message = await dispatchOne(broker, encodePublishEnvelope('orders', 'i1', 1));

    expect(message.disposition).toBe('retried');
    expect(logger.records[0]?.meta).toMatchObject({ error: 'plain string failure' });
  });

  it('does not report a throwing ack as a subscriber failure', async () => {
    const { broker, logger } = makeBroker();
    await broker.subscribe('orders', () => {});

    const message = new AckFailsQueueMessage('m1', encodePublishEnvelope('orders', 'i1', 1));
    await expect(broker.dispatch(new FakeQueueBatch('messages', [message])))
      .rejects.toThrow('cannot ack');

    // `ack()` sits outside the handler's try, so a platform-side ack failure is
    // not reported as a subscriber failure AND then also retried — which would
    // give one message two dispositions.
    expect(message.disposition).toBe('acked');
    expect(logger.messages()).toEqual([]);
  });

  it('settles every message in a mixed batch exactly once', async () => {
    const { broker } = makeBroker();
    await broker.subscribe('orders', () => {});

    const routable = new FakeQueueMessage('m1', encodePublishEnvelope('orders', 'i1', 1));
    const unsubscribed = new FakeQueueMessage('m2', encodePublishEnvelope('nobody', 'i2', 1));
    const foreign = new FakeQueueMessage('m3', 'not an envelope');

    await broker.dispatch(new FakeQueueBatch('messages', [routable, unsubscribed, foreign]));

    expect(routable.disposition).toBe('acked');
    expect(unsubscribed.disposition).toBe('acked');
    expect(foreign.disposition).toBe('retried');
  });
});

describe('WorkersBroker.dispatch — RPC and pub/sub isolation', () => {
  it('does not deliver an RPC request to a plain subscriber of the same topic', async () => {
    const { broker } = makeBroker(true);
    const seen: unknown[] = [];
    await broker.subscribe('orders', (message) => {
      seen.push(message);
    });
    await broker.respond('orders', () => 'replied');

    await dispatchOne(
      broker,
      encodeRequestEnvelope('orders', 'i1', 'corr-1', 'rr.inbox.abc', 'req'),
    );

    // The `kind` discriminant is read before the subscription table, so a
    // request envelope structurally cannot reach a pub/sub consumer.
    expect(seen).toEqual([]);
  });

  it('does not deliver a plain publish to a responder of the same topic', async () => {
    const { broker } = makeBroker(true);
    const responded: unknown[] = [];
    await broker.respond('orders', (message) => {
      responded.push(message);
      return 'replied';
    });
    await broker.subscribe('orders', () => {});

    await dispatchOne(broker, encodePublishEnvelope('orders', 'i1', 'published'));

    expect(responded).toEqual([]);
  });
});

describe('WorkersBroker.dispatch — responders', () => {
  it('runs the responder and posts its value to the reply inbox', async () => {
    const { broker, namespace } = makeBroker(true);
    await broker.respond<number, number>('sum', (n) => n + 1);

    // A caller-side inbox object, so the reply has somewhere real to land.
    const inbox = namespace.get(namespace.idFromName('rr.inbox.abc'));
    await inbox.fetch('https://reply-inbox.internal/connect', {
      headers: { Upgrade: 'websocket' },
    });

    const message = await dispatchOne(
      broker,
      encodeRequestEnvelope('sum', 'i1', 'corr-1', 'rr.inbox.abc', 41),
    );

    expect(message.disposition).toBe('acked');

    // Read the frame the object actually pushed toward the caller, not just
    // that a socket exists: asserting on membership alone would pass for a
    // responder whose reply never left.
    const server = namespace.states.get('rr.inbox.abc')?.accepted[0] as
      | { readonly sent: string[] }
      | undefined;
    expect(server?.sent).toHaveLength(1);
    expect(JSON.parse(String(server?.sent[0]))).toEqual({
      v: 1,
      kind: 'rpc-reply',
      correlationId: 'corr-1',
      ok: true,
      payload: 42,
    });
  });

  it('relays a responder failure to the caller instead of retrying', async () => {
    const { broker, logger, namespace } = makeBroker(true);
    await broker.respond('sum', () => {
      throw new Error('bad input');
    });

    const inbox = namespace.get(namespace.idFromName('rr.inbox.abc'));
    await inbox.fetch('https://reply-inbox.internal/connect', {
      headers: { Upgrade: 'websocket' },
    });

    const message = await dispatchOne(
      broker,
      encodeRequestEnvelope('sum', 'i1', 'corr-1', 'rr.inbox.abc', 1),
    );

    // Acked, not retried: the caller has been told what happened, and a
    // redelivery would re-run a responder whose side effects already landed.
    expect(message.disposition).toBe('acked');
    const server = namespace.states.get('rr.inbox.abc')?.accepted[0] as
      | { readonly sent: string[] }
      | undefined;
    expect(JSON.parse(String(server?.sent[0]))).toMatchObject({ ok: false, error: 'bad input' });
    expect(logger.messages()).toEqual([
      'cloudflare-messaging: responder failed, caller informed',
    ]);
    expect(logger.records[0]?.meta).toMatchObject({ error: 'bad input' });
  });

  it('answers a request with no responder rather than making the caller wait', async () => {
    const { broker, logger } = makeBroker(true);
    await broker.respond('other', () => 1);

    const message = await dispatchOne(
      broker,
      encodeRequestEnvelope('sum', 'i1', 'corr-1', 'rr.inbox.abc', 1),
    );

    expect(message.disposition).toBe('acked');
    expect(logger.messages()).toEqual([
      'cloudflare-messaging: no responder for request topic',
    ]);
    expect(logger.records[0]?.meta).toMatchObject({ responding: ['other'] });
  });

  it('reports an undeliverable reply when the consumer has no rpc arm', async () => {
    const { broker, logger } = makeBroker(false);

    // Reachable even though `respond()` refuses without the arm: a request can
    // arrive at a consumer configured without RPC, and dropping it silently
    // would leave the caller to time out with nothing logged.
    const message = await dispatchOne(
      broker,
      encodeRequestEnvelope('sum', 'i1', 'corr-1', 'rr.inbox.abc', 1),
    );

    expect(message.disposition).toBe('acked');
    expect(logger.messages()).toEqual([
      'cloudflare-messaging: no responder for request topic',
      'cloudflare-messaging: reply undeliverable, no rpc arm configured',
    ]);
  });

  it('load-balances requests across a responder group', async () => {
    const { broker } = makeBroker(true);
    const seen: string[] = [];
    await broker.respond('sum', () => {
      seen.push('a');
      return 1;
    }, { queue: 'workers' });
    await broker.respond('sum', () => {
      seen.push('b');
      return 1;
    }, { queue: 'workers' });

    await dispatchOne(broker, encodeRequestEnvelope('sum', 'i1', 'c1', 'rr.inbox.abc', 1));
    await dispatchOne(broker, encodeRequestEnvelope('sum', 'i2', 'c2', 'rr.inbox.abc', 1));

    expect(seen).toEqual(['a', 'b']);
  });

  it('stays silent on every path when no logger is registered', async () => {
    const broker = new WorkersBroker(new FakeQueueProducer(), new FakeBrokerRuntime());

    const foreign = await dispatchOne(broker, 'not an envelope');
    const unsubscribed = await dispatchOne(broker, encodePublishEnvelope('orders', 'i1', 1));

    expect(foreign.disposition).toBe('retried');
    expect(unsubscribed.disposition).toBe('acked');
  });
});
