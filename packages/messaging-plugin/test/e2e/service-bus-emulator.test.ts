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
 * Topics and subscriptions come from the emulator's `Config.json` — it is
 * config-driven and creates nothing at runtime, which is also why the RPC
 * reply-inbox case documents an emulator limitation rather than asserting a
 * successful round trip.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IMessageBroker } from '@hono-enterprise/common';
import { MessagingPlugin, ReplyInboxUnavailableError } from '../../src/index.ts';

const connectionString = Deno.env.get('SERVICEBUS_CONNECTION_STRING');

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
const SUBSCRIPTION = 'consumers';
const REPLY_TOPIC = 'messaging.replies';

/** Waits until `predicate` holds or the budget elapses. */
async function until(predicate: () => boolean, budgetMs = 20000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe('ServiceBusBroker — Service Bus emulator E2E', { ignore: !connectionString }, () => {
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
      await broker.subscribe<{ id: number }>(ROUNDTRIP_TOPIC, (message) => {
        received.push(message);
      }, { queue: SUBSCRIPTION });

      await broker.publish(ROUNDTRIP_TOPIC, { id: 42 });
      await until(() => received.length > 0);

      expect(received).toEqual([{ id: 42 }]);
    });
  });

  it('abandons a message whose handler throws, and the broker redelivers it', async () => {
    await withBroker(async (broker) => {
      let deliveries = 0;
      await broker.subscribe<{ id: number }>(ABANDON_TOPIC, () => {
        deliveries++;
        if (deliveries === 1) throw new Error('first delivery fails');
      }, { queue: SUBSCRIPTION });

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
      const subscription = await broker.subscribe<{ id: number }>(CLOSE_TOPIC, (message) => {
        received.push(message);
      }, { queue: SUBSCRIPTION });

      await broker.publish(CLOSE_TOPIC, { id: 1 });
      await until(() => received.length > 0);
      expect(received).toEqual([{ id: 1 }]);

      // The repaired teardown closes the subscriber AND the receiver link. If
      // it threw or left the link wedged, a later subscribe would not deliver.
      await subscription.unsubscribe();

      // Re-subscribe on the SAME subscription: if the released link were left
      // wedged, this second receiver would never deliver.
      const second: { id: number }[] = [];
      await broker.subscribe<{ id: number }>(CLOSE_TOPIC, (message) => {
        second.push(message);
      }, { queue: SUBSCRIPTION });

      await broker.publish(CLOSE_TOPIC, { id: 2 });
      await until(() => second.length > 0);

      expect(second).toEqual([{ id: 2 }]);
    });
  });

  it('surfaces ReplyInboxUnavailableError when the broker refuses the admin operation', async () => {
    await withBroker(async (broker) => {
      // The emulator is config-driven and supports NO management operations, so
      // `ServiceBusAdministrationClient.createSubscription` fails against it.
      // That makes it the one place the RPC reply inbox's failure path can be
      // exercised against a real broker rather than a fake: the design says a
      // refused create surfaces as a named error naming the topic and the
      // `Manage` right, and here it does.
      //
      // RPC itself therefore cannot be round-tripped on the emulator. Against
      // real Azure, where the management API exists, it is unverified.
      let caught: unknown;
      try {
        await broker.request('math', { a: 1 }, { timeoutMs: 5000 });
      } catch (err) {
        caught = err;
      }

      expect(caught).toBeInstanceOf(ReplyInboxUnavailableError);
      expect((caught as Error).message).toContain(REPLY_TOPIC);
      expect((caught as Error).message).toContain('Manage');
    });
  });
});
