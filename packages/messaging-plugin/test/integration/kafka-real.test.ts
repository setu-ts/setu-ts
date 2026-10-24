/**
 * §3.7 real-backend bar for the Kafka broker (X28-1).
 *
 * The claim this suite exists to prove is "an application configured with the
 * kafka broker STARTS against a real broker" — the thing no injected fake
 * could decide, because every fake accepted any string for `producer.on` and
 * the broker attached the uppercase `producer.events` KEYS, which real kafkajs
 * rejects. Per §3.6 the guard is `ignore:` on the missing endpoint variable,
 * so a skipped suite is VISIBLE in the count rather than reported as passed.
 *
 * It must NOT assert `MessagingNotSupportedError`: M14d deprecated that
 * refusal and `KafkaBroker.request` delegates to the shared `RequestReplyCore`
 * over the reply-topic inbox — the RPC case below is the first exercise that
 * path has ever had against a real broker.
 */
import { describe, expect, it } from 'vitest';
import type { Admin, ConsumerConfig } from 'kafkajs';
import type { IMessageBroker, MessageMetadata } from '@setu-ts/common';
import type { IKafkaFactory } from '../../src/interfaces/index.ts';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { KafkaTopicUnavailableError, MessagingPlugin } from '../../src/index.ts';

const kafkaBrokers = process.env['KAFKA_BROKERS'];

it(
  'M119a REAL ten fresh groups deliver each near-join publish exactly once',
  { skip: kafkaBrokers === undefined, timeout: 180000 },
  async () => {
    const { Kafka, logLevel } = await import('kafkajs');
    const { KafkaBroker, JsonSerializer } = await import('../../src/index.ts');
    const { createRuntimeServices } = await import('@setu-ts/runtime');
    const brokers = kafkaBrokers!.split(',');
    const kafka = new Kafka({ brokers, clientId: 'm119a-setup', logLevel: logLevel.NOTHING });
    const admin = kafka.admin();
    const producer = kafka.producer();
    const topics = Array.from({ length: 10 }, (_, i) => `m119a.join.${crypto.randomUUID()}.${i}`);
    try {
      await admin.connect();
      await producer.connect();
      await admin.createTopics({
        topics: topics.map((topic) => ({ topic, numPartitions: 1, replicationFactor: 1 })),
        waitForLeaders: true,
      });
      for (const topic of topics) {
        const broker = new KafkaBroker(createRuntimeServices(), new JsonSerializer(), {
          brokers,
          client: {
            producer: () => kafka.producer(),
            admin: () => kafka.admin(),
            consumer: (options) => kafka.consumer(options),
          },
        });
        const received: string[] = [];
        try {
          await fetchTopicOffsets(admin, topic);
          await broker.connect();
          await broker.subscribe(
            topic,
            (_message, metadata) => {
              received.push(metadata.messageId!);
            },
            { queue: `${topic}.group` },
          );
          // run() starts the join without awaiting it; publish during that join.
          await producer.send({ topic, messages: [{ value: '{}' }] });
          await waitFor(() => received.length > 0, `first delivery for ${topic}`);
          await new Promise((resolve) => setTimeout(resolve, 500));
          expect(received).toEqual(['0:0']);
        } finally {
          await broker.disconnect();
        }
      }
    } finally {
      await producer.disconnect();
      await admin.deleteTopics({ topics });
      await admin.disconnect();
    }
  },
);

/** Waits for fresh-topic leaders to serve offsets, preserving permanent failures. */
async function fetchTopicOffsets(
  admin: Admin,
  topic: string,
): ReturnType<Admin['fetchTopicOffsets']> {
  const deadline = performance.now() + 5_000;
  for (;;) {
    try {
      return await admin.fetchTopicOffsets(topic);
    } catch (error) {
      if (
        typeof error !== 'object' ||
        error === null ||
        !('retriable' in error) ||
        error.retriable !== true ||
        performance.now() >= deadline
      ) {
        throw error;
      }
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
}

/** Polls a predicate until true or the deadline, without a fixed sleep. */
async function waitFor(
  predicate: () => boolean,
  label: string | (() => string),
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${typeof label === 'function' ? label() : label}`);
}

/** A probe plugin capturing the registered broker for direct exercise. */
function brokerProbe(capture: (broker: IMessageBroker) => void): IPlugin {
  return {
    name: 'm90d-kafka-probe',
    version: '0.0.0',
    dependencies: [CAPABILITIES.MESSAGING],
    register(ctx) {
      capture(ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING));
    },
  };
}

describe(
  'REAL Kafka broker (guarded on KAFKA_BROKERS)',
  { skip: kafkaBrokers === undefined },
  () => {
    const brokers = (kafkaBrokers ?? '')
      .split(',')
      .map((b) => b.trim())
      .filter(Boolean);

    it('delivers all messages between concurrent first starts of two members of a new group', async () => {
      const { Kafka, logLevel } = await import('kafkajs');
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
      const topic = `m113a.concurrent.${suffix}`;
      const group = `m113a.concurrent.${suffix}`;
      const kafka = new Kafka({
        brokers,
        clientId: 'm113a-concurrent-setup',
        logLevel: logLevel.NOTHING,
      });
      const admin = kafka.admin();
      const producer = kafka.producer();
      const joinGate = Promise.withResolvers<void>();
      const captured: IMessageBroker[] = [];
      const apps = [0, 1].map(() =>
        createApplication({
          plugins: [
            RuntimePlugin(),
            MessagingPlugin({
              broker: 'kafka',
              client: {
                producer: () => kafka.producer(),
                admin: () => kafka.admin(),
                consumer: (options: ConsumerConfig) => {
                  const consumer = kafka.consumer(options);
                  const run = consumer.run.bind(consumer);
                  // Hold only the start of the real run: both subscribe snapshots must precede
                  // the first join, even on the throwaway broker with zero rebalance delay.
                  consumer.run = async (runOptions) => {
                    await joinGate.promise;
                    await run(runOptions);
                  };
                  return consumer;
                },
              },
            }),
            brokerProbe((broker) => captured.push(broker)),
          ],
        }),
      );
      try {
        await admin.connect();
        await admin.createTopics({
          topics: [{ topic, numPartitions: 2, replicationFactor: 1 }],
          waitForLeaders: true,
        });
        await producer.connect();
        await producer.send({
          topic,
          messages: [0, 1].map((partition) => ({
            partition,
            value: JSON.stringify({ id: 'old' }),
          })),
        });
        for (const app of apps) await app.start();
        const received: string[] = [];
        const handler = (message: { id: string }): void => {
          received.push(message.id);
        };
        const aAt = performance.now();
        await captured[0]!.subscribe(topic, handler, { queue: group });
        const aMs = performance.now() - aAt;
        await new Promise((resolve) => setTimeout(resolve, 50));
        const expected = Array.from({ length: 6 }, (_, i) => `message-${i}`);
        await producer.send({
          topic,
          messages: expected.map((id, i) => ({ partition: i % 2, value: JSON.stringify({ id }) })),
        });
        const bAt = performance.now();
        await captured[1]!.subscribe(topic, handler, { queue: group });
        process.stdout.write(
          `M113a concurrent subscribe-to-ready: A=${aMs.toFixed(2)} ms B=${(performance.now() - bAt).toFixed(2)} ms\n`,
        );
        joinGate.resolve();
        await waitFor(
          () => expected.every((id) => received.includes(id)),
          () => `all six concurrent-start messages; received=${JSON.stringify(received)}`,
          12000,
        );
        await new Promise((resolve) => setTimeout(resolve, 300));
        expect(received.sort()).toEqual(expected);
      } finally {
        joinGate.resolve();
        for (const app of apps) await app.stop();
        await producer.disconnect();
        await admin.disconnect();
      }
    });

    it('boots an application, round-trips a publish/subscribe, and completes one request/reply', async () => {
      const kafkajs = await import('kafkajs');
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
      const topic = `m90d.orders.${suffix}`;
      const rpcTopic = `m90d.rpc.${suffix}`;
      const replyTopic = `m90d.replies.${suffix}`;
      // RPC rides the derived request channel (M14d) and the shared reply
      // topic, and Kafka auto-creation is not assumed: pre-create all three
      // wire topics out of band.
      const topicsToCreate = [topic, rpcTopic, `rr.req.${rpcTopic}`, replyTopic];

      const adminKafka = new kafkajs.Kafka({ clientId: 'm90d-setup', brokers });
      const admin = adminKafka.admin();
      await admin.connect();
      await admin.createTopics({
        topics: topicsToCreate.map((name) => ({
          topic: name,
          numPartitions: 1,
          replicationFactor: 1,
        })),
      });
      await admin.disconnect();

      let broker: IMessageBroker | undefined;
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          MessagingPlugin({ broker: 'kafka', brokers, replyTopic }),
          brokerProbe((b) => {
            broker = b;
          }),
        ],
      });

      try {
        // THE regression guard: start() resolves. Pre-fix, this boot died
        // inside register() with "Event name should be one of
        // producer.events.CONNECT, ..." because the KEYS reached `on()`.
        await app.start();
        expect(broker).toBeDefined();

        // Pin the high watermark at subscribe time: no pre-subscribe replay,
        // and a single immediate publish must arrive without waiting for a join.
        await broker!.publish(topic, { id: -1 });
        const received: Array<{ id: number }> = [];
        let deliveredMetadata: MessageMetadata | undefined;
        const subscribeAt = performance.now();
        await broker!.subscribe(topic, (message: { id: number }, metadata) => {
          received.push(message);
          deliveredMetadata = metadata;
        });
        process.stdout.write(
          `M113a subscribe-to-ready: ${(performance.now() - subscribeAt).toFixed(2)} ms\n`,
        );
        await broker!.publish(topic, { id: 1 });
        await waitFor(() => received.length > 0, 'Kafka immediate delivery');
        await new Promise((r) => setTimeout(r, 300));
        expect(received).toEqual([{ id: 1 }]);

        // The documented message identity is `partition:offset`, and the
        // partition comes from the OUTER eachMessage payload — real kafkajs
        // never puts it on the message record. Pre-fix the broker read
        // `message.partition` and delivered `"undefined:<offset>"` (90d
        // verification Finding 1), colliding across partitions and breaking
        // the de-duplication use the identity exists for. Pinned here against
        // the real broker, where no fake can echo the wrong shape.
        expect(
          deliveredMetadata?.messageId,
          `metadata ${JSON.stringify(deliveredMetadata)}`,
        ).toMatch(/^\d+:\d+$/);

        // First RPC after boot, without a join sleep or retries.
        await broker!.respond<{ n: number }, { doubled: number }>(rpcTopic, (req) => ({
          doubled: req.n * 2,
        }));
        const reply = await broker!.request<{ n: number }, { doubled: number }>(
          rpcTopic,
          { n: 21 },
          { timeoutMs: 15000 },
        );
        expect(reply).toEqual({ doubled: 42 });
      } finally {
        await app.stop();
      }
    });
    it('boots against topics that do not exist yet: two topics and RPC in ONE app (M101b, V8-26)', async () => {
      // The case above pre-creates every wire topic, which is exactly the
      // shape under which V8-26 was invisible. Measured on Kafka 4.0 (KRaft)
      // with auto-creation on: the metadata request that CREATES a topic
      // answers UNKNOWN_TOPIC_OR_PARTITION, and kafkajs does not retry that,
      // so a subscription to a fresh topic died at boot. Nothing is
      // pre-created here — the declared subscriptions, the derived
      // `rr.req.<topic>` channel and the reply topic are all new.
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
      const ordersTopic = `m101b.orders.${suffix}`;
      const paymentsTopic = `m101b.payments.${suffix}`;
      const rpcTopic = `m101b.rpc.${suffix}`;
      const replyTopic = `m101b.replies.${suffix}`;
      const orders: Array<{ id: number }> = [];
      const payments: Array<{ id: number }> = [];

      let broker: IMessageBroker | undefined;
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          MessagingPlugin({
            broker: 'kafka',
            brokers,
            replyTopic,
            subscriptions: [
              {
                topic: ordersTopic,
                handler: (message) => {
                  orders.push(message as { id: number });
                },
              },
              {
                topic: paymentsTopic,
                handler: (message) => {
                  payments.push(message as { id: number });
                },
              },
            ],
          }),
          brokerProbe((b) => {
            broker = b;
          }),
        ],
      });

      try {
        // THE regression guard: start() resolves with both declared
        // subscriptions on topics that did not exist a moment ago.
        await app.start();

        // One immediate publish per newly initialized group; no retry can hide a loss.
        await broker!.publish(ordersTopic, { id: 1 });
        await broker!.publish(paymentsTopic, { id: 101 });
        await waitFor(() => orders.length > 0 && payments.length > 0, 'two-topic delivery');
        expect(orders).toEqual([{ id: 1 }]);
        expect(payments).toEqual([{ id: 101 }]);

        await broker!.respond<{ n: number }, { doubled: number }>(rpcTopic, (req) => ({
          doubled: req.n * 2,
        }));
        const reply = await broker!.request<{ n: number }, { doubled: number }>(
          rpcTopic,
          { n: 21 },
          { timeoutMs: 15000 },
        );
        expect(reply).toEqual({ doubled: 42 });
      } finally {
        await app.stop();
      }
    });

    it('refuses a topic the broker will not create with a named error from start() (M101b, V8-26)', async () => {
      // CI's broker auto-creates, so the refusal is produced by the REAL
      // broker through a real kafkajs consumer that asks it NOT to create:
      // `allowAutoTopicCreation: false` makes the metadata answer an honest
      // UNKNOWN_TOPIC_OR_PARTITION every time — no fabricated error. The
      // subscribe retry applies to an injected client too.
      const kafkajs = await import('kafkajs');
      const kafka = new kafkajs.Kafka({
        clientId: 'm101b-no-autocreate',
        brokers,
        logLevel: kafkajs.logLevel.NOTHING,
      });
      const factory = {
        producer: () => kafka.producer(),
        consumer: ({ groupId }: { groupId: string }) =>
          kafka.consumer({ groupId, allowAutoTopicCreation: false }),
      } as unknown as IKafkaFactory;
      const topic = `m101b.never.${crypto.randomUUID().replaceAll('-', '').slice(0, 10)}`;

      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          MessagingPlugin({
            broker: 'kafka',
            client: factory,
            retry: { retries: 1, initialRetryTime: 50 },
            subscriptions: [{ topic, handler: () => {} }],
          }),
        ],
      });

      const err = await app.start().then(
        () => null,
        (e: unknown) => e,
      );
      try {
        expect(err).toBeInstanceOf(KafkaTopicUnavailableError);
        const named = err as KafkaTopicUnavailableError;
        expect(named.topic).toBe(topic);
        expect(named.groupId).toBe(`messaging-consumers:${topic}`);
        expect((named.cause as { type?: string }).type).toBe('UNKNOWN_TOPIC_OR_PARTITION');

        // And the broker really did not create it — the refusal was genuine.
        const admin = kafka.admin();
        await admin.connect();
        const topics = await admin.listTopics();
        await admin.disconnect();
        expect(topics).not.toContain(topic);
      } finally {
        await app.stop().catch(() => {});
      }
    });

    /** One partition's high watermark, from `fetchTopicOffsets`. */
    type TopicOffset = { partition: number; high: string };
    function highWatermarks(offsets: TopicOffset[]): Map<number, number> {
      return new Map(offsets.map((o) => [o.partition, Number(o.high)]));
    }

    it('places one orderingKey on exactly one partition (M106 §3.3, §10 obligation 9)', async () => {
      const kafkajs = await import('kafkajs');
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
      const topic = `m106.part.${suffix}`;

      const adminKafka = new kafkajs.Kafka({ clientId: 'm106-part-admin', brokers });
      const admin = adminKafka.admin();
      await admin.connect();
      await admin.createTopics({
        topics: [{ topic, numPartitions: 3, replicationFactor: 1 }],
      });

      let broker: IMessageBroker | undefined;
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          MessagingPlugin({ broker: 'kafka', brokers }),
          brokerProbe((b) => {
            broker = b;
          }),
        ],
      });

      try {
        await app.start();

        const before = highWatermarks(await fetchTopicOffsets(admin, topic));
        const N = 6;
        for (let i = 0; i < N; i++) {
          await broker!.publish(topic, { i }, { orderingKey: 'agg-1' });
        }
        const keyed = await fetchTopicOffsets(admin, topic);
        const grown = keyed
          .map((o) => ({
            partition: o.partition,
            delta: Number(o.high) - (before.get(o.partition) ?? 0),
          }))
          .filter((d) => d.delta > 0);
        // ONE partition took every keyed message: the key is the placement.
        expect(grown.length, `deltas ${JSON.stringify(keyed)}`).toBe(1);
        expect(grown[0]!.delta).toBe(N);

        // No key: behaviour unchanged — the messages are still accepted and
        // appended (a spread over partitions is allowed, not required).
        const keyedTotal = keyed.reduce((sum, o) => sum + Number(o.high), 0);
        for (let i = 0; i < N; i++) {
          await broker!.publish(topic, { i });
        }
        const unkeyed = await fetchTopicOffsets(admin, topic);
        const unkeyedTotal = unkeyed.reduce((sum, o) => sum + Number(o.high), 0);
        expect(unkeyedTotal - keyedTotal).toBe(N);
      } finally {
        await app.stop();
        await admin.deleteTopics({ topics: [topic] }).catch(() => {});
        await admin.disconnect();
      }
    });

    it('does not handle a later message for one key until the first succeeds (M106 §3.8)', async () => {
      const kafkajs = await import('kafkajs');
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
      const topic = `m106.block.${suffix}`;
      const groupId = `m106-block-${suffix}`;

      const adminKafka = new kafkajs.Kafka({ clientId: 'm106-block-admin', brokers });
      const admin = adminKafka.admin();
      await admin.connect();
      await admin.createTopics({
        topics: [{ topic, numPartitions: 3, replicationFactor: 1 }],
      });

      let broker: IMessageBroker | undefined;
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          MessagingPlugin({ broker: 'kafka', brokers }),
          brokerProbe((b) => {
            broker = b;
          }),
        ],
      });

      const handled: string[] = [];
      let attempts = 0;
      try {
        await app.start();
        await broker!.subscribe(
          topic,
          (message: { id: string }) => {
            if (message.id === 'first') {
              attempts++;
              handled.push(`first-attempt-${attempts}`);
              // Fail ONCE: the offset stays uncommitted, so kafkajs redelivers
              // from this record and the partition stalls behind it.
              if (attempts === 1) throw new Error('transient');
              return;
            }
            handled.push(`second(${message.id})`);
          },
          { queue: groupId },
        );

        // Let the consumer group join before publishing (`fromBeginning: false`
        // starts at the log end at join time).
        await new Promise((r) => setTimeout(r, 4_000));
        await broker!.publish(topic, { id: 'first' }, { orderingKey: 'agg-1' });
        await broker!.publish(topic, { id: 'second' }, { orderingKey: 'agg-1' });

        const deadline = Date.now() + 90_000;
        while (Date.now() < deadline) {
          if (attempts >= 2 && handled.some((h) => h.startsWith('second'))) break;
          await new Promise((r) => setTimeout(r, 200));
        }

        // Order KEPT BY BLOCKING: the retry of `first` precedes `second`.
        expect(handled, `handler order ${JSON.stringify(handled)}`).toEqual([
          'first-attempt-1',
          'first-attempt-2',
          'second(second)',
        ]);
      } finally {
        await app.stop();
        await admin.deleteTopics({ topics: [topic] }).catch(() => {});
        await admin.disconnect();
      }
    });
  },
);
