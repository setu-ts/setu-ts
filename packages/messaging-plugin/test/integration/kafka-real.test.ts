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
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker, MessageMetadata } from '@setu-ts/common';
import type { IKafkaFactory } from '../../src/interfaces/index.ts';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { KafkaTopicUnavailableError, MessagingPlugin } from '../../src/index.ts';

const kafkaBrokers = Deno.env.get('KAFKA_BROKERS');

/** Polls a predicate until true or the deadline, without a fixed sleep. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 20_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`timeout waiting for ${label}`);
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

describe({
  name: 'REAL Kafka broker (guarded on KAFKA_BROKERS)',
  ignore: kafkaBrokers === undefined,
  fn() {
    const brokers = (kafkaBrokers ?? '').split(',').map((b) => b.trim()).filter(Boolean);

    it('boots an application, round-trips a publish/subscribe, and completes one request/reply', async () => {
      const kafkajs = await import('npm:kafkajs@2.x');
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
      const topic = `m90d.orders.${suffix}`;
      const rpcTopic = `m90d.rpc.${suffix}`;
      const replyTopic = `m90d.replies.${suffix}`;
      // RPC rides the derived request channel (M14d) and the shared reply
      // topic, and Kafka auto-creation is not assumed: pre-create all three
      // wire topics out of band.
      const topicsToCreate = [
        topic,
        rpcTopic,
        `rr.req.${rpcTopic}`,
        replyTopic,
      ];

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

        // Publish/subscribe round trip. A fresh consumer group joins on the
        // broker's rebalance schedule (~3 s observed) and, with
        // `fromBeginning: false`, starts at the log end AT JOIN TIME — so a
        // single publish issued before the join can sit below the start
        // offset forever. That is standard Kafka consumer-group semantics, not
        // a broker defect; the round trip therefore RETRIES the publish until
        // delivery, bounded, rather than racing the rebalance.
        const received: Array<{ id: number }> = [];
        let deliveredMetadata: MessageMetadata | undefined;
        await broker!.subscribe(topic, (message: { id: number }, metadata) => {
          received.push(message);
          deliveredMetadata = metadata;
        });
        const published: Array<{ id: number }> = [];
        for (let attempt = 1; attempt <= 8 && received.length === 0; attempt++) {
          const payload = { id: attempt };
          await broker!.publish(topic, payload);
          published.push(payload);
          await new Promise((r) => setTimeout(r, 2_000));
        }
        await waitFor(() => received.length > 0, 'Kafka delivery');
        // Whatever the rebalance delivered must be a payload this test
        // published, serialized and returned intact.
        expect(
          published.some((p) => p.id === received[0]?.id),
          `delivered ${JSON.stringify(received[0])} vs published ${JSON.stringify(published)}`,
        ).toBe(true);

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

        // Request/reply round trip — implemented in M14d and never exercised
        // against a real broker, because the broker could not boot. The same
        // rebalance timing applies to the responder, so a request that races
        // the join is retried.
        await broker!.respond<{ n: number }, { doubled: number }>(
          rpcTopic,
          (req) => ({ doubled: req.n * 2 }),
        );
        await new Promise((r) => setTimeout(r, 3_000)); // let the responder join
        let reply: { doubled: number } | undefined;
        for (let attempt = 0; attempt < 3 && reply === undefined; attempt++) {
          try {
            reply = await broker!.request<{ n: number }, { doubled: number }>(
              rpcTopic,
              { n: 21 },
              { timeoutMs: 15_000 },
            );
          } catch (error) {
            if (attempt === 2) throw error;
          }
        }
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

        // Same rebalance timing as above: retry each publish until delivered.
        for (
          let attempt = 1;
          attempt <= 8 && (orders.length === 0 || payments.length === 0);
          attempt++
        ) {
          if (orders.length === 0) await broker!.publish(ordersTopic, { id: attempt });
          if (payments.length === 0) await broker!.publish(paymentsTopic, { id: 100 + attempt });
          await new Promise((r) => setTimeout(r, 2_000));
        }
        await waitFor(() => orders.length > 0 && payments.length > 0, 'two-topic delivery');
        // Each topic's handler sees only its own topic's messages.
        expect(orders.every((m) => m.id < 100)).toBe(true);
        expect(payments.every((m) => m.id > 100)).toBe(true);

        await broker!.respond<{ n: number }, { doubled: number }>(
          rpcTopic,
          (req) => ({ doubled: req.n * 2 }),
        );
        await new Promise((r) => setTimeout(r, 3_000)); // let the responder join
        let reply: { doubled: number } | undefined;
        for (let attempt = 0; attempt < 3 && reply === undefined; attempt++) {
          try {
            reply = await broker!.request<{ n: number }, { doubled: number }>(
              rpcTopic,
              { n: 21 },
              { timeoutMs: 15_000 },
            );
          } catch (error) {
            if (attempt === 2) throw error;
          }
        }
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
      const kafkajs = await import('npm:kafkajs@2.x');
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

      const err = await app.start().then(() => null, (e: unknown) => e);
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
      const kafkajs = await import('npm:kafkajs@2.x');
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

        const before = highWatermarks(await admin.fetchTopicOffsets(topic) as TopicOffset[]);
        const N = 6;
        for (let i = 0; i < N; i++) {
          await broker!.publish(topic, { i }, { orderingKey: 'agg-1' });
        }
        const keyed = await admin.fetchTopicOffsets(topic) as TopicOffset[];
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
        const unkeyed = await admin.fetchTopicOffsets(topic) as TopicOffset[];
        const unkeyedTotal = unkeyed.reduce((sum, o) => sum + Number(o.high), 0);
        expect(unkeyedTotal - keyedTotal).toBe(N);
      } finally {
        await app.stop();
        await admin.deleteTopics({ topics: [topic] }).catch(() => {});
        await admin.disconnect();
      }
    });

    it('does not handle a later message for one key until the first succeeds (M106 §3.8)', async () => {
      const kafkajs = await import('npm:kafkajs@2.x');
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
        await broker!.subscribe(topic, (message: { id: string }) => {
          if (message.id === 'first') {
            attempts++;
            handled.push(`first-attempt-${attempts}`);
            // Fail ONCE: the offset stays uncommitted, so kafkajs redelivers
            // from this record and the partition stalls behind it.
            if (attempts === 1) throw new Error('transient');
            return;
          }
          handled.push(`second(${message.id})`);
        }, { queue: groupId });

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
});
