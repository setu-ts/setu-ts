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
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MessagingPlugin } from '../../src/index.ts';

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
  },
});
