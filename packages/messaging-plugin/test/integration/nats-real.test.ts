/**
 * §3.7 real-backend bar for the NATS broker (X28-2/X28-3).
 *
 * The claim this suite exists to prove is "an application configured with the
 * nats broker STARTS against a real server" — something no injected fake can
 * decide, because both defects (the catch-all subject the server refuses, and
 * the bare `503` when JetStream is off) lived behind a fake that accepted any
 * config. Per §3.6 the guard is `ignore:` on the missing endpoint variable, so
 * a skipped suite is VISIBLE in the count rather than reported as passed; the
 * suite itself must never early-return.
 *
 * The absent-stream precondition is load-bearing: `streams.add` is reached
 * ONLY from the absence arm, so a suite reusing a warm server exercises
 * nothing — which is precisely how the catch-all shipped. Every case here
 * provisions a FRESH stream name and asserts the resulting stream config.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IMessageBroker } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { MessagingPlugin } from '../../src/index.ts';

const natsUrl = Deno.env.get('NATS_URL');

/** Loopback form: the manifest's scoped net grant covers 127.0.0.1/localhost. */
function toIpv4(url: string): string {
  return url.replace('localhost', '127.0.0.1');
}

/** Polls a predicate until true or the deadline, without a fixed sleep. */
async function waitFor(predicate: () => boolean, label: string, timeoutMs = 10_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error(`timeout waiting for ${label}`);
}

/** A probe plugin capturing the registered broker for direct exercise. */
function brokerProbe(capture: (broker: IMessageBroker) => void): IPlugin {
  return {
    name: 'm90d-broker-probe',
    version: '0.0.0',
    dependencies: [CAPABILITIES.MESSAGING],
    register(ctx) {
      capture(ctx.services.get<IMessageBroker>(CAPABILITIES.MESSAGING));
    },
  };
}

describe({
  name: 'REAL NATS JetStream (guarded on NATS_URL)',
  // §3.6: `ignore:` reports the suite as ignored — visible in the run count —
  // where an early `return` inside `it` reports PASSED while asserting
  // nothing. test/apps-gate.test.ts pins CI to supply the variable.
  ignore: natsUrl === undefined,
  fn() {
    const url = toIpv4(natsUrl ?? '');

    it('boots an application, creates the stream from streamSubjects, and round-trips a publish', async () => {
      const nats = await import('npm:nats@2.x');
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
      const streamName = `M90D_${suffix}`;
      const subjectScope = `m90d.${suffix}`;
      const topic = `${subjectScope}.orders`;

      let broker: IMessageBroker | undefined;
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          MessagingPlugin({
            broker: 'nats',
            url,
            streamName,
            streamSubjects: [`${subjectScope}.>`],
          }),
          brokerProbe((b) => {
            broker = b;
          }),
        ],
      });

      const jsmConn = await nats.connect({ servers: url });
      const jsm = await jsmConn.jetstreamManager();
      try {
        // THE regression guard: start() resolves. Pre-fix, this exact boot
        // died inside register() with "capturing all subjects requires no-ack
        // to be true".
        await app.start();

        // The stream now exists with EXACTLY the configured subjects — and no
        // `no_ack` key, which the reversed design needed to even create one.
        const info = await jsm.streams.info(streamName);
        expect(info.config.subjects).toEqual([`${subjectScope}.>`]);
        expect(info.config.no_ack).toBeFalsy();

        // Publish/subscribe round trip. The publish PROMISE must RESOLVE —
        // under the reversed (`no_ack`) design the underlying JetStream
        // publish rejected unobserved ~2s later; a rejection here or as an
        // unhandled rejection fails the run.
        const received: unknown[] = [];
        await broker!.subscribe(topic, (message) => {
          received.push(message);
        });
        await broker!.publish(topic, { id: 1 });
        await waitFor(() => received.length > 0, 'NATS delivery');
        expect(received[0]).toEqual({ id: 1 });
        // Give a late JetStream ack rejection room to surface before the
        // run ends — it would fail the suite as an unhandled rejection.
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        await app.stop();
        await jsm.streams.delete(streamName).catch(() => {});
        await jsmConn.close();
      }
    });

    it('boots against a pre-existing stream without streamSubjects and leaves it untouched', async () => {
      const nats = await import('npm:nats@2.x');
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
      const streamName = `M90D_PRE_${suffix}`;
      const subjectScope = `m90dpre.${suffix}`;
      const topic = `${subjectScope}.orders`;

      const jsmConn = await nats.connect({ servers: url });
      const jsm = await jsmConn.jetstreamManager();
      // Provision out of band — the common working-server shape X28-2 records.
      await jsm.streams.add({ name: streamName, subjects: [`${subjectScope}.>`] });

      let broker: IMessageBroker | undefined;
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          // No streamSubjects: with the stream existing, the info path
          // connects and `streams.add` is never issued.
          MessagingPlugin({ broker: 'nats', url, streamName }),
          brokerProbe((b) => {
            broker = b;
          }),
        ],
      });

      try {
        await app.start();
        expect(broker).toBeDefined();

        // The existing configuration is untouched: still exactly the
        // provisioned subjects, no catch-all merged in.
        const info = await jsm.streams.info(streamName);
        expect(info.config.subjects).toEqual([`${subjectScope}.>`]);

        const received: unknown[] = [];
        await broker!.subscribe(topic, (message) => {
          received.push(message);
        });
        await broker!.publish(topic, { id: 2 });
        await waitFor(() => received.length > 0, 'NATS delivery (existing stream)');
        expect(received[0]).toEqual({ id: 2 });
        await new Promise((r) => setTimeout(r, 500));
      } finally {
        await app.stop();
        await jsm.streams.delete(streamName).catch(() => {});
        await jsmConn.close();
      }
    });

    it('re-subscribes the same queue on the same topic without an error (M90d review)', async () => {
      // Review asked whether the duplicate-durable filter in `subscribe()`
      // should also match JetStream's "consumer name already in use". Probed
      // against the real server (nats-server v2.14.6): re-adding a durable
      // consumer with an IDENTICAL configuration is idempotent and rejects
      // nothing, so the ordinary repeat-subscribe path never reaches that
      // filter at all. A genuine configuration CONFLICT under the same durable
      // name answers "consumer already exists" and must keep propagating —
      // widening the filter to swallow it would hide a real misconfiguration.
      // This pins the behaviour so the filter is not "fixed" on the assumption
      // that a repeat subscribe fails.
      const nats = await import('npm:nats@2.x');
      const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
      const streamName = `M90D_DUP_${suffix}`;
      const subjectScope = `m90ddup.${suffix}`;
      const topic = `${subjectScope}.orders`;
      const queue = `m90d_dup_${suffix}`;

      const jsmConn = await nats.connect({ servers: url });
      const jsm = await jsmConn.jetstreamManager();
      await jsm.streams.add({ name: streamName, subjects: [`${subjectScope}.>`] });

      let broker: IMessageBroker | undefined;
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          MessagingPlugin({ broker: 'nats', url, streamName }),
          brokerProbe((b) => {
            broker = b;
          }),
        ],
      });

      try {
        await app.start();
        const first = await broker!.subscribe(topic, () => {}, { queue });
        // The same queue on the same topic: an identical durable config, which
        // the server accepts again rather than refusing.
        const second = await broker!.subscribe(topic, () => {}, { queue });
        expect(second).toBeDefined();
        await first.unsubscribe();
        await second.unsubscribe();
      } finally {
        await app.stop();
        await jsm.streams.delete(streamName).catch(() => {});
        await jsmConn.close();
      }
    });
  },
});
