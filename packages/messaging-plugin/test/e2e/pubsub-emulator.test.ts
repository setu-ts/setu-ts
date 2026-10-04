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
import type { IMessageBroker, MessageMetadata } from '@setu-ts/common';
import { MessagingPlugin, PubSubSubscriptionBoundElsewhereError } from '../../src/index.ts';

const emulatorHost = Deno.env.get('PUBSUB_EMULATOR_HOST');
const projectId = Deno.env.get('PUBSUB_PROJECT_ID') ?? 'he-test';

/** Unique per run so repeated runs never share emulator state. */
const runId = crypto.randomUUID().slice(0, 8);
const TOPIC = `orders-${runId}`;
const REPLY_TOPIC = `messaging.replies-${runId}`;
const RPC_TOPIC = `math-${runId}`;
/** RPC rides a derived channel, and this broker creates no topics. */
const RPC_CHANNEL = `rr.req.${RPC_TOPIC}`;
/** M101b: two topics subscribed with the DEFAULT subscription in one app. */
const TOPIC_A = `orders-a-${runId}`;
const TOPIC_B = `orders-b-${runId}`;
/** M101b: a topic whose default subscription name is pre-claimed by another topic. */
const TOPIC_TAKEN = `orders-taken-${runId}`;
const ALL_TOPICS = [TOPIC, REPLY_TOPIC, RPC_CHANNEL, TOPIC_A, TOPIC_B, TOPIC_TAKEN];
/**
 * The per-topic default subscriptions this suite causes (M101b). Pub/Sub keeps
 * a subscription after its topic is deleted, so they are removed explicitly —
 * otherwise a long-lived emulator accumulates them across runs.
 */
const DEFAULT_SUBSCRIPTIONS = [TOPIC_A, TOPIC_B, RPC_CHANNEL, TOPIC_TAKEN]
  .map((topic) => `messaging-consumers.${topic}`);

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
    for (const name of ALL_TOPICS) {
      await admin.createTopic(name);
    }
  });

  afterAll(async () => {
    if (!admin) return;
    for (const name of DEFAULT_SUBSCRIPTIONS) {
      try {
        await admin.subscription(name).delete();
      } catch {
        // Best-effort teardown; absent when a case did not create it.
      }
    }
    for (const name of ALL_TOPICS) {
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

  it('delivers the platform messageId and publishTime on the metadata (X28-4)', async () => {
    // The emulator assigns both fields, so the metadata must carry the same
    // four-member set the working brokers report in X28 — this is the
    // emulator-backed proof of the adapter read the fakes cannot decide.
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({ broker: 'pubsub', projectId, replyTopic: REPLY_TOPIC }),
      ],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

    const seen: MessageMetadata[] = [];
    await broker.subscribe(TOPIC, (_message, metadata) => {
      seen.push(metadata);
    }, { queue: `meta-${runId}` });

    await broker.publish(TOPIC, { id: 1 });
    await until(() => seen.length > 0);

    await app.stop();

    const metadata = seen[0]!;
    expect(Object.keys(metadata).sort()).toEqual([
      'headers',
      'messageId',
      'timestamp',
      'topic',
    ]);
    expect(typeof metadata.messageId).toBe('string');
    expect((metadata.messageId ?? '').length).toBeGreaterThan(0);
    expect(metadata.timestamp).toBeInstanceOf(Date);
    expect(metadata.timestamp!.getTime()).not.toBeNaN();
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
  it('two topics with default subscriptions and RPC in ONE application (M101b, V8-2)', async () => {
    // Every case above subscribes one topic per app with an explicit queue —
    // the shape under which V8-2 was invisible. Pub/Sub subscription names
    // are project-global, so the old shared default attached topic B to topic
    // A's subscription and the RPC channel to a previous run's: B's handler
    // consumed A's messages and every second run's request timed out.
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({ broker: 'pubsub', projectId, replyTopic: REPLY_TOPIC }),
      ],
    });
    await app.start();
    const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);

    const a: { topic: string }[] = [];
    const b: { topic: string }[] = [];
    await broker.subscribe<{ topic: string }>(TOPIC_A, (message) => {
      a.push(message);
    });
    await broker.subscribe<{ topic: string }>(TOPIC_B, (message) => {
      b.push(message);
    });
    await broker.respond<{ a: number }, { sum: number }>(RPC_TOPIC, (req) => ({
      sum: req.a + 1,
    }));

    for (let i = 0; i < 3; i++) {
      await broker.publish(TOPIC_A, { topic: 'a' });
      await broker.publish(TOPIC_B, { topic: 'b' });
    }
    const reply = await broker.request<{ a: number }, { sum: number }>(
      RPC_TOPIC,
      { a: 41 },
      { timeoutMs: 15000 },
    );
    await until(() => a.length >= 3 && b.length >= 3);

    // Each subscription is its own, bound to its own topic.
    const [subsA] = await admin.topic(TOPIC_A).getSubscriptions();
    const [subsB] = await admin.topic(TOPIC_B).getSubscriptions();
    await app.stop();

    expect(reply).toEqual({ sum: 42 });
    // Each handler saw only its own topic's messages — the control a shared
    // subscription fails.
    expect(a.length).toBe(3);
    expect(b.length).toBe(3);
    expect(a.every((m) => m.topic === 'a')).toBe(true);
    expect(b.every((m) => m.topic === 'b')).toBe(true);
    const short = (subs: { name: string }[]) => subs.map((s) => s.name.split('/').at(-1));
    expect(short(subsA)).toEqual([`messaging-consumers.${TOPIC_A}`]);
    expect(short(subsB)).toEqual([`messaging-consumers.${TOPIC_B}`]);
  });

  it('refuses a default subscription already bound to another topic, from start() (M101b)', async () => {
    // Pre-claim TOPIC_TAKEN's default subscription name on a DIFFERENT topic,
    // as the shared default did before M101b. Attaching would hand this
    // topic's handler the other topic's messages; the broker refuses by name.
    const claimed = `messaging-consumers.${TOPIC_TAKEN}`;
    await admin.topic(TOPIC_A).createSubscription(claimed);

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({
          broker: 'pubsub',
          projectId,
          replyTopic: REPLY_TOPIC,
          subscriptions: [{ topic: TOPIC_TAKEN, handler: () => {} }],
        }),
      ],
    });
    const err = await app.start().then(() => null, (e: unknown) => e);
    await app.stop().catch(() => {});

    expect(err).toBeInstanceOf(PubSubSubscriptionBoundElsewhereError);
    const named = err as PubSubSubscriptionBoundElsewhereError;
    expect(named.subscription).toBe(claimed);
    expect(named.boundTopic).toBe(`projects/${projectId}/topics/${TOPIC_A}`);
    expect(named.requestedTopic).toBe(TOPIC_TAKEN);
  });
});
