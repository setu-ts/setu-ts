/**
 * `ServiceBusBroker` against Microsoft's OFFICIAL Azure Service Bus emulator.
 *
 * Guarded by `SERVICEBUS_CONNECTION_STRING`; skipped when absent. Needs no
 * Azure subscription — the emulator runs locally beside a SQL Edge sidecar.
 *
 * What only a real broker can settle: that `createReceiver(topic, subscription)`
 * with `autoCompleteMessages: false` really hands settlement to the receiver,
 * that `completeMessage`/`abandonMessage` reach the service, and that the AMQP
 * link teardown this milestone repaired works against a live connection.
 *
 * The legacy cases use Config.json entities and the data endpoint as the
 * default administration endpoint. Managed lifecycle cases below explicitly
 * use the emulator's HTTP administration endpoint on port 5300.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker, MessageMetadata } from '@setu-ts/common';
import { MessagingPlugin, ReplyInboxUnavailableError } from '../../src/index.ts';
import { ServiceBusBroker, JsonSerializer } from '../../src/index.ts';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { untilReal } from '../fixtures/real-fan-out.ts';

const connectionString = process.env['SERVICEBUS_CONNECTION_STRING'];

describe(
  'managed Service Bus consumer lifecycle',
  { skip: !connectionString || !process.env['SERVICEBUS_ADMIN_CONNECTION_STRING'] },
  () => {
    it(
      'holds retries, dead-letters the final attempt, and carries the measured zero-based count',
      { timeout: 60000 },
      async () => {
        const { ServiceBusAdministrationClient, ServiceBusClient } =
          await import('@azure/service-bus');
        const adminConnectionString = process.env['SERVICEBUS_ADMIN_CONNECTION_STRING']!;
        const admin = new ServiceBusAdministrationClient(adminConnectionString);
        const data = new ServiceBusClient(connectionString!);
        const topic = 'm143p-' + crypto.randomUUID();
        const queue = 'm143p-consumer';
        const starts: number[] = [];
        const broker = new ServiceBusBroker(createNodeRuntimeServices(), new JsonSerializer(), {
          connectionString: connectionString!,
          adminConnectionString,
          consumerRetry: { maxAttempts: 3, delaysMs: [100, 200] },
        });
        const dead = data.createReceiver(topic, queue, { subQueueType: 'deadLetter' });
        try {
          await admin.createTopic(topic);
          await admin.createSubscription(topic, queue);
          await broker.connect();
          await broker.subscribe(
            topic,
            () => {
              starts.push(performance.now());
              throw new Error('handler-secret-canary');
            },
            { queue },
          );
          await broker.publish(topic, { retained: true });
          await untilReal(() => starts.length === 3);
          const messages = await dead.receiveMessages(1, { maxWaitTimeInMs: 10000 });
          expect(messages).toHaveLength(1);
          expect(JSON.parse(messages[0]!.body as string)).toEqual({ retained: true });
          expect(messages[0]!.deadLetterReason).toBe('setu-attempts-exhausted');
          expect(starts[1]! - starts[0]!).toBeGreaterThanOrEqual(100);
          expect(starts[2]! - starts[1]!).toBeGreaterThanOrEqual(200);
          await dead.completeMessage(messages[0]!);
        } finally {
          await broker.disconnect();
          await dead.close();
          await data.close();
          await admin.deleteTopic(topic);
        }
      },
    );
  },
);

/**
 * Entities declared in the emulator config this suite expects.
 *
 * Each case takes its OWN topic. A Service Bus subscription accrues every
 * message published to its topic whether or not a receiver is attached, so
 * sharing one topic lets an earlier case's message arrive in a later one — a
 * real property of the broker that no in-process fake reproduces.
 */
const ROUNDTRIP_TOPIC = 'orders-roundtrip';
const ABANDON_TOPIC = 'orders-abandon';
const CLOSE_TOPIC = 'orders-close';
/** M106 §3.3: declared with `RequiresDuplicateDetection` and a one-minute window. */
const DEDUP_TOPIC = 'orders-dedup';
const SUBSCRIPTION = 'consumers';
const REPLY_TOPIC = 'messaging.replies';

/** Waits until `predicate` holds or the budget elapses. */
async function until(predicate: () => boolean, budgetMs = 20000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('ServiceBusBroker — Service Bus emulator E2E', { skip: !connectionString }, () => {
  /**
   * Runs `body` against a freshly started app and stops it afterwards.
   *
   * Stopping matters: competing receivers on one Service Bus subscription share
   * the messages between them, so leaving an earlier test's receiver open
   * silently steals deliveries from the next.
   */
  async function withBroker(body: (broker: IMessageBroker) => Promise<void>): Promise<void> {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({
          broker: 'service-bus',
          connectionString: connectionString!,
          defaultQueue: SUBSCRIPTION,
          replyTopic: REPLY_TOPIC,
        }),
      ],
    });
    await app.start();
    try {
      await body(app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING));
    } finally {
      await app.stop();
    }
  }

  it('publish → subscribe round trip over real AMQP', async () => {
    await withBroker(async (broker) => {
      const received: { id: number }[] = [];
      await broker.subscribe<{ id: number }>(
        ROUNDTRIP_TOPIC,
        (message) => {
          received.push(message);
        },
        { queue: SUBSCRIPTION },
      );

      await broker.publish(ROUNDTRIP_TOPIC, { id: 42 });
      await until(() => received.length > 0);

      expect(received).toEqual([{ id: 42 }]);
    });
  });

  it('delivers the platform messageId and enqueue time on the metadata (X28-4)', async () => {
    // The emulator assigns both fields, so the metadata must carry the same
    // four-member set the working brokers report in X28 — the emulator-backed
    // proof of the adapter read the fakes cannot decide.
    await withBroker(async (broker) => {
      const seen: MessageMetadata[] = [];
      await broker.subscribe(
        ROUNDTRIP_TOPIC,
        (_message, metadata) => {
          seen.push(metadata);
        },
        { queue: SUBSCRIPTION },
      );

      await broker.publish(ROUNDTRIP_TOPIC, { id: 1 });
      await until(() => seen.length > 0);

      const metadata = seen[0]!;
      expect(Object.keys(metadata).sort()).toEqual(['headers', 'messageId', 'timestamp', 'topic']);
      expect((metadata.messageId ?? '').length).toBeGreaterThan(0);
      expect(metadata.timestamp).toBeInstanceOf(Date);
      expect(metadata.timestamp!.getTime()).not.toBeNaN();
    });
  });

  it('abandons a message whose handler throws, and the broker redelivers it', async () => {
    await withBroker(async (broker) => {
      let deliveries = 0;
      await broker.subscribe<{ id: number }>(
        ABANDON_TOPIC,
        () => {
          deliveries++;
          if (deliveries === 1) throw new Error('first delivery fails');
        },
        { queue: SUBSCRIPTION },
      );

      await broker.publish(ABANDON_TOPIC, { id: 7 });
      // An abandon releases the lock immediately, so a second delivery proves
      // the failure path reached the service instead of being swallowed.
      await until(() => deliveries >= 2);

      expect(deliveries).toBeGreaterThanOrEqual(2);
    });
  });

  it('closing a subscription releases its receiver against a live connection', async () => {
    await withBroker(async (broker) => {
      const received: { id: number }[] = [];
      const subscription = await broker.subscribe<{ id: number }>(
        CLOSE_TOPIC,
        (message) => {
          received.push(message);
        },
        { queue: SUBSCRIPTION },
      );

      await broker.publish(CLOSE_TOPIC, { id: 1 });
      await until(() => received.length > 0);
      expect(received).toEqual([{ id: 1 }]);

      // The repaired teardown closes the subscriber AND the receiver link. If
      // it threw or left the link wedged, a later subscribe would not deliver.
      await subscription.unsubscribe();

      // Re-subscribe on the SAME subscription: if the released link were left
      // wedged, this second receiver would never deliver.
      const second: { id: number }[] = [];
      await broker.subscribe<{ id: number }>(
        CLOSE_TOPIC,
        (message) => {
          second.push(message);
        },
        { queue: SUBSCRIPTION },
      );

      await broker.publish(CLOSE_TOPIC, { id: 2 });
      await until(() => second.length > 0);

      expect(second).toEqual([{ id: 2 }]);
    });
  });

  it('surfaces ReplyInboxUnavailableError when the broker refuses the admin operation', async () => {
    await withBroker(async (broker) => {
      // This app uses the AMQP data endpoint for administration too, so
      // `ServiceBusAdministrationClient.createSubscription` fails against it.
      // That makes it the one place the RPC reply inbox's failure path can be
      // exercised against a real broker rather than a fake: the design says a
      // refused create surfaces as a named error naming the topic and the
      // `Manage` right, and here it does.
      //
      // This legacy case intentionally omits the HTTP administration endpoint;
      // it verifies the named refusal rather than a successful RPC round trip.
      let caught: unknown;
      try {
        // The budget covers the inbox open now; the emulator's admin refusal takes
        // over 5 s after the SDK's retries, so leave room for it to arrive.
        await broker.request('math', { a: 1 }, { timeoutMs: 30000 });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ReplyInboxUnavailableError);
      expect((caught as Error).message).toContain(REPLY_TOPIC);
      expect((caught as Error).message).toContain('Manage');
    });
  });

  it('drops a re-sent messageId on a topic with duplicate detection (M106 §3.3)', async () => {
    // `orders-dedup` is declared with `RequiresDuplicateDetection: true` and a
    // one-minute window, so the broker's NATIVE mapping (`messageId`) is what
    // makes the second publish disappear — a property of the entity, not of this
    // process. A unique id per run keeps a rerun inside the window honest.
    await withBroker(async (broker) => {
      const received: { id: string }[] = [];
      await broker.subscribe<{ id: string }>(
        DEDUP_TOPIC,
        (message) => {
          received.push(message);
        },
        { queue: SUBSCRIPTION },
      );

      const suffix = crypto.randomUUID().slice(0, 8);
      const first = `dedup-${suffix}`;
      await broker.publish(DEDUP_TOPIC, { id: 'a' }, { deduplicationId: first });
      await broker.publish(DEDUP_TOPIC, { id: 'a' }, { deduplicationId: first });
      await broker.publish(DEDUP_TOPIC, { id: 'c' }, { deduplicationId: `dedup2-${suffix}` });
      await until(() => received.length >= 2);

      // The duplicate never arrives: two messages, not three.
      expect(received).toEqual([{ id: 'a' }, { id: 'c' }]);
    });
  });
});
