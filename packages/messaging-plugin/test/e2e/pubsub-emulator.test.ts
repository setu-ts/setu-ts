/**
 * `GcpPubSubBroker` against the OFFICIAL Google Pub/Sub emulator.
 *
 * Guarded by `PUBSUB_EMULATOR_HOST`; skipped when absent. The SDK honours that
 * variable natively and skips authentication entirely, so this needs no GCP
 * project and no credentials.
 *
 * What only a real server can settle: that `topic.createSubscription` and
 * `subscription.delete()` behave the way the RPC reply inbox assumes, that the
 * gRPC streaming pull actually delivers into the `on('message')` bridge, and
 * that `ack`/`nack` reach the platform. A recording fake answers all of those
 * by construction.
 *
 * Start the emulator with:
 * ```
 * docker run -d -p 8085:8085 gcr.io/google.com/cloudsdktool/google-cloud-cli:emulators \
 *   gcloud beta emulators pubsub start --project=he-test --host-port=0.0.0.0:8085
 * ```
 *
 * @module
 */
import { afterAll, beforeAll, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker } from '@setu-ts/common';
import { MessagingPlugin } from '../../src/index.ts';

const emulatorHost = Deno.env.get('PUBSUB_EMULATOR_HOST');
const projectId = Deno.env.get('PUBSUB_PROJECT_ID') ?? 'he-test';

/** Unique per run so repeated runs never share emulator state. */
const runId = crypto.randomUUID().slice(0, 8);
const TOPIC = `orders-${runId}`;
const REPLY_TOPIC = `messaging.replies-${runId}`;
const RPC_TOPIC = `math-${runId}`;
/** RPC rides a derived channel, and this broker creates no topics. */
const RPC_CHANNEL = `rr.req.${RPC_TOPIC}`;

/** Waits until `predicate` holds or the budget elapses. */
async function until(predicate: () => boolean, budgetMs = 15000): Promise<void> {
  const deadline = Date.now() + budgetMs;
  while (Date.now() < deadline && !predicate()) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe('GcpPubSubBroker — Pub/Sub emulator E2E', { ignore: !emulatorHost }, () => {
  // deno-lint-ignore no-explicit-any -- the SDK's PubSub type is not imported here.
  let admin: any;

  beforeAll(async () => {
    const mod = await import('npm:@google-cloud/pubsub@^6');
    admin = new mod.PubSub({ projectId });
    // Topics must pre-exist — the broker deliberately creates none.
    for (const name of [TOPIC, REPLY_TOPIC, RPC_CHANNEL]) {
      await admin.createTopic(name);
    }
  });

  afterAll(async () => {
    if (!admin) return;
    for (const name of [TOPIC, REPLY_TOPIC, RPC_CHANNEL]) {
      try {
        await admin.topic(name).delete();
      } catch {
        // Best-effort teardown.
      }
    }
    await admin.close();
  });

  it('publish → subscribe round trip over real gRPC', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({ broker: 'pubsub', projectId, replyTopic: REPLY_TOPIC }),
      ],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

    const received: { id: number }[] = [];
    await broker.subscribe<{ id: number }>(TOPIC, (message) => {
      received.push(message);
    }, { queue: `consumers-${runId}` });

    await broker.publish(TOPIC, { id: 42 });
    await until(() => received.length > 0);

    await app.stop();

    expect(received).toEqual([{ id: 42 }]);
  });

  it('nacks a message whose handler throws, and the platform redelivers it', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({ broker: 'pubsub', projectId, replyTopic: REPLY_TOPIC }),
      ],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

    let deliveries = 0;
    await broker.subscribe<{ id: number }>(TOPIC, () => {
      deliveries++;
      if (deliveries === 1) throw new Error('first delivery fails');
    }, { queue: `nack-consumers-${runId}` });

    await broker.publish(TOPIC, { id: 7 });
    // A nack returns the message immediately, so a second delivery proves the
    // failure path reached the platform rather than being swallowed.
    await until(() => deliveries >= 2);

    await app.stop();

    expect(deliveries).toBeGreaterThanOrEqual(2);
  });

  it('request → respond RPC creates and deletes a real reply subscription', async () => {
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({ broker: 'pubsub', projectId, replyTopic: REPLY_TOPIC }),
      ],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

    await broker.respond<{ a: number }, { sum: number }>(RPC_TOPIC, (req) => ({
      sum: req.a + 1,
    }));

    const reply = await broker.request<{ a: number }, { sum: number }>(
      RPC_TOPIC,
      { a: 41 },
      { timeoutMs: 15000 },
    );
    expect(reply).toEqual({ sum: 42 });

    // The inbox subscription exists on the reply topic while the broker is up.
    const [duringSubs] = await admin.topic(REPLY_TOPIC).getSubscriptions();
    const inboxDuring = (duringSubs as { name: string }[])
      .filter((s) => s.name.includes('rr-inbox-'));
    expect(inboxDuring.length).toBe(1);

    await app.stop();

    // …and disconnect deletes it, rather than leaving a durable resource behind.
    const [afterSubs] = await admin.topic(REPLY_TOPIC).getSubscriptions();
    const inboxAfter = (afterSubs as { name: string }[])
      .filter((s) => s.name.includes('rr-inbox-'));
    expect(inboxAfter.length).toBe(0);
  });
});
