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
import { describe, expect, it } from 'vitest';
import type { IMessageBroker, MessageMetadata } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import {
  MessagingPlugin,
  NatsConsumerNameCollisionError,
  PublishTimeoutError,
} from '../../src/index.ts';
import { run as runProcess } from '../../../../test/node-helpers.ts';

const natsUrl = process.env['NATS_URL'];

describe('M119a REAL NATS delivery bounds', { skip: natsUrl === undefined }, () => {
  async function fixture() {
    const nats = await import('nats');
    const url = natsUrl!;
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const scope = `m119a.${suffix}`;
    const streamName = `M119A_${suffix}`;
    const conn = await nats.connect({ servers: url });
    const jsm = await conn.jetstreamManager();
    const apps: ReturnType<typeof createApplication>[] = [];
    const boot = async (publishTimeoutMs = 15000) => {
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          MessagingPlugin({
            broker: 'nats',
            url,
            streamName,
            publishTimeoutMs,
            streamSubjects: [`${scope}.>`, `rr.req.${scope}.>`, 'rr.inbox.>'],
          }),
        ],
      });
      apps.push(app);
      await app.start();
      return { app, broker: app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING) };
    };
    return {
      url,
      scope,
      streamName,
      jsm,
      boot,
      async close() {
        for (const app of apps) await app.stop();
        await jsm.streams.delete(streamName).catch(() => {});
        await conn.close();
      },
    };
  }

  it('queue-less respond across three boots runs each request once and leaves one request consumer', async () => {
    const f = await fixture();
    let calls = 0;
    try {
      for (let boot = 0; boot < 3; boot++) {
        const { app, broker } = await f.boot();
        await broker.respond(`${f.scope}.echo`, (message) => {
          calls++;
          return message;
        });
        expect(await broker.request(`${f.scope}.echo`, { boot }, { timeoutMs: 10000 })).toEqual({
          boot,
        });
        await new Promise((resolve) => setTimeout(resolve, 150));
        await app.stop();
        const consumers = await f.jsm.consumers.list(f.streamName).next();
        expect(
          consumers.filter((c) => c.config.filter_subject === `rr.req.${f.scope}.echo`),
        ).toHaveLength(1);
        expect(consumers.filter((c) => c.name.startsWith('rr_2einbox_2e'))).toEqual([]);
        expect(calls).toBe(boot + 1);
      }
    } finally {
      await f.close();
    }
  }, 45000);

  it('two replicas split queue-less deliveries without duplicates', async () => {
    const f = await fixture();
    try {
      const a = await f.boot();
      const b = await f.boot();
      const deliveries: number[][] = [[], []];
      const topic = `${f.scope}.orders`;
      await a.broker.subscribe<number>(topic, (id) => {
        deliveries[0]!.push(id);
      });
      await b.broker.subscribe<number>(topic, (id) => {
        deliveries[1]!.push(id);
      });
      for (let id = 0; id < 20; id++) await a.broker.publish(topic, id);
      await waitFor(() => deliveries.flat().length >= 20, 'shared deliveries');
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(deliveries.flat().sort((a, b) => a - b)).toEqual(
        Array.from({ length: 20 }, (_, i) => i),
      );
      expect(deliveries.every((received) => received.length > 0)).toBe(true);
      expect(await f.jsm.consumers.list(f.streamName).next()).toHaveLength(1);
    } finally {
      await f.close();
    }
  });

  it('recreates a deleted running inbox and removes it on app.stop()', async () => {
    const f = await fixture();
    try {
      const { app, broker } = await f.boot();
      await broker.respond(`${f.scope}.echo`, (message) => message);
      expect(await broker.request(`${f.scope}.echo`, 1, { timeoutMs: 10000 })).toBe(1);
      const inbox = (await f.jsm.consumers.list(f.streamName).next()).find((c) =>
        c.name.startsWith('rr_2einbox_2e'),
      )!;
      expect(inbox.config.durable_name).toBeUndefined();
      expect(inbox.config.inactive_threshold).toBe(300_000_000_000);
      await f.jsm.consumers.delete(f.streamName, inbox.name);
      const deadline = performance.now() + 15000;
      let recovered = false;
      while (performance.now() < deadline) {
        recovered = await f.jsm.consumers.info(f.streamName, inbox.name).then(
          () => true,
          () => false,
        );
        if (recovered) break;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(recovered).toBe(true);
      expect(await broker.request(`${f.scope}.echo`, 2, { timeoutMs: 10000 })).toBe(2);
      await app.stop();
      expect(
        (await f.jsm.consumers.list(f.streamName).next()).filter((c) =>
          c.name.startsWith('rr_2einbox_2e'),
        ),
      ).toEqual([]);
    } finally {
      await f.close();
    }
  }, 40000);

  it('adds an inactive threshold to a pre-created leaked durable', async () => {
    const f = await fixture();
    const name = `messaging-${crypto.randomUUID()}`;
    try {
      await f.jsm.streams.add({ name: f.streamName, subjects: [`${f.scope}.>`] });
      const { AckPolicy } = await import('nats');
      await f.jsm.consumers.add(f.streamName, {
        name,
        durable_name: name,
        filter_subject: `${f.scope}.old`,
        ack_policy: AckPolicy.Explicit,
        metadata: { 'setu.queue': name },
      });
      await f.boot();
      let threshold = 0;
      const deadline = performance.now() + 5000;
      while (performance.now() < deadline) {
        threshold = (await f.jsm.consumers.info(f.streamName, name)).config.inactive_threshold ?? 0;
        if (threshold > 0) break;
        await new Promise((resolve) => setTimeout(resolve, 25));
      }
      expect(threshold).toBe(300_000_000_000);
    } finally {
      await f.close();
    }
  });

  it('a paused NATS server rejects publish with PublishTimeoutError', async () => {
    const f = await fixture();
    let container = '';
    let paused = false;
    try {
      const { broker } = await f.boot(200);
      // Under `ci:local` the backend publishes nothing on the host; its shard
      // labels identify it instead (the other outage suites' lookup).
      const port = new URL(f.url).port || '4222';
      const shard = process.env['SETU_CI_SHARD'];
      const filters = shard
        ? ['--filter', `label=setu.ci.shard=${shard}`, '--filter', `label=setu.ci.port.${port}=1`]
        : ['--filter', `publish=${port}`];
      const result = await runProcess('docker', { args: ['ps', '-q', ...filters] });
      expect(result.success).toBe(true);
      container = new TextDecoder().decode(result.stdout).trim().split('\n')[0]!;
      expect(container).not.toBe('');
      const pause = await runProcess('docker', { args: ['pause', container] });
      expect(pause.success).toBe(true);
      paused = true;
      const started = performance.now();
      const error = await broker.publish(`${f.scope}.paused`, {}).catch((error: unknown) => error);
      expect(error).toBeInstanceOf(PublishTimeoutError);
      expect(error).toMatchObject({ topic: `${f.scope}.paused`, timeoutMs: 200 });
      expect(performance.now() - started).toBeGreaterThanOrEqual(190);
      expect(performance.now() - started).toBeLessThan(1500);
    } finally {
      if (paused)
        expect((await runProcess('docker', { args: ['unpause', container] })).success).toBe(true);
      await f.close();
    }
  });
});

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

describe('REAL NATS JetStream (guarded on NATS_URL)', { skip: natsUrl === undefined }, () => {
  const url = toIpv4(natsUrl ?? '');

  it('boots an application, creates the stream from streamSubjects, and round-trips a publish', async () => {
    const nats = await import('nats');
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

  it('a resolved publish is stored, and a subject outside the stream REJECTS', async () => {
    // Pre-fix, js.publish was never awaited: the out-of-stream publish
    // RESOLVED and the server's 503 escaped as an unhandled rejection,
    // which fails this run (and terminates a Deno or Node process).
    const nats = await import('nats');
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const streamName = `M90D_ACK_${suffix}`;
    const subjectScope = `m90dack.${suffix}`;

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
      await app.start();
      await broker!.publish(`${subjectScope}.orders`, { id: 1 });
      expect((await jsm.streams.info(streamName)).state.messages).toBe(1);

      const outside = `outside.${suffix}`;
      await expect(broker!.publish(outside, { id: 2 })).rejects.toThrow(
        `no stream captures this subject`,
      );
      await expect(broker!.publish(outside, { id: 2 })).rejects.toThrow(JSON.stringify(outside));
      expect((await jsm.streams.info(streamName)).state.messages).toBe(1);
    } finally {
      await app.stop();
      await jsm.streams.delete(streamName).catch(() => {});
      await jsmConn.close();
    }
  });

  it('boots against a pre-existing stream without streamSubjects and leaves it untouched', async () => {
    const nats = await import('nats');
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
    // Probed against the real server (nats-server v2.14.6): re-adding a
    // durable consumer with an IDENTICAL configuration is idempotent and
    // rejects nothing, so the ordinary repeat-subscribe path never reaches
    // the "already exists" arm at all. A genuine configuration CONFLICT
    // under the same name answers "consumer already exists" (err_code
    // 10148); since M101b that arm reads the consumer's recorded queue and
    // topic and refuses a mismatch by name (the collision case below)
    // rather than attaching to it. This pins the idempotent half.
    const nats = await import('nats');
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
  it('serves RPC and two topics with a dotted queue in ONE application (M101b, V8-6)', async () => {
    // Every case above subscribes one topic with a legal queue, which is
    // precisely the shape under which V8-6 was invisible: the reply inbox
    // subscribes with the dotted queue `rr.inbox.<uuid>`, which the nats
    // client refused as a consumer name before the wire, so `request()` had
    // never worked against a real server. The stream must cover the RPC
    // subjects too: `rr.req.<topic>` and `rr.inbox.>`.
    const nats = await import('nats');
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const streamName = `M101B_RPC_${suffix}`;
    const scope = `m101b.${suffix}`;
    const ordersTopic = `${scope}.orders`;
    const paymentsTopic = `${scope}.payments`;
    const rpcTopic = `${scope}.quote`;

    let broker: IMessageBroker | undefined;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({
          broker: 'nats',
          url,
          streamName,
          streamSubjects: [`${scope}.>`, `rr.req.${scope}.>`, 'rr.inbox.>'],
        }),
        brokerProbe((b) => {
          broker = b;
        }),
      ],
    });

    const jsmConn = await nats.connect({ servers: url });
    const jsm = await jsmConn.jetstreamManager();
    try {
      await app.start();

      const orders: unknown[] = [];
      const payments: unknown[] = [];
      await broker!.subscribe(
        ordersTopic,
        (m) => {
          orders.push(m);
        },
        { queue: 'orders.eu' },
      );
      await broker!.subscribe(paymentsTopic, (m) => {
        payments.push(m);
      });
      await broker!.respond<{ n: number }, { quote: number }>(rpcTopic, (req) => ({
        quote: req.n * 2,
      }));

      await broker!.publish(ordersTopic, { order: 1 });
      await broker!.publish(paymentsTopic, { payment: 1 });
      const reply = await broker!.request<{ n: number }, { quote: number }>(
        rpcTopic,
        { n: 21 },
        { timeoutMs: 10_000 },
      );
      expect(reply).toEqual({ quote: 42 });

      await waitFor(() => orders.length > 0 && payments.length > 0, 'two-topic delivery');
      // Each topic delivers only its own messages.
      expect(orders).toEqual([{ order: 1 }]);
      expect(payments).toEqual([{ payment: 1 }]);

      // The dotted user queue became a legal, readable consumer name that
      // records the raw queue it was created for.
      const info = await jsm.consumers.info(streamName, 'orders_2eeu');
      expect(info.config.filter_subject).toBe(ordersTopic);
      expect(info.config.metadata?.['setu.queue']).toBe('orders.eu');
    } finally {
      await app.stop();
      await jsm.streams.delete(streamName).catch(() => {});
      await jsmConn.close();
    }
  });

  it("refuses a queue that encodes onto another instance's consumer (M101b, V8-6)", async () => {
    // `orders_2eeu` is a legal queue that encodes exactly like `orders.eu`.
    // Two independent instances must not split one consumer's deliveries.
    const nats = await import('nats');
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const streamName = `M101B_COL_${suffix}`;
    const scope = `m101bcol.${suffix}`;
    const topic = `${scope}.orders`;

    const jsmConn = await nats.connect({ servers: url });
    const jsm = await jsmConn.jetstreamManager();
    await jsm.streams.add({ name: streamName, subjects: [`${scope}.>`] });

    let first: IMessageBroker | undefined;
    let second: IMessageBroker | undefined;
    const appA = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({ broker: 'nats', url, streamName }),
        brokerProbe((b) => {
          first = b;
        }),
      ],
    });
    const appB = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({ broker: 'nats', url, streamName }),
        brokerProbe((b) => {
          second = b;
        }),
      ],
    });

    try {
      await appA.start();
      await appB.start();
      const received: unknown[] = [];
      await first!.subscribe(
        topic,
        (m) => {
          received.push(m);
        },
        { queue: 'orders.eu' },
      );

      const err = await second!
        .subscribe(topic, () => {}, { queue: 'orders_2eeu' })
        .then(
          () => null,
          (e: unknown) => e,
        );
      expect(err).toBeInstanceOf(NatsConsumerNameCollisionError);
      expect((err as NatsConsumerNameCollisionError).existingQueue).toBe('orders.eu');

      // The first instance is unaffected and keeps every message.
      await first!.publish(topic, { id: 1 });
      await first!.publish(topic, { id: 2 });
      await waitFor(() => received.length >= 2, 'first instance delivery');
      expect(received).toEqual([{ id: 1 }, { id: 2 }]);
    } finally {
      await appB.stop();
      await appA.stop();
      await jsm.streams.delete(streamName).catch(() => {});
      await jsmConn.close();
    }
  });

  it('stores ONE copy for a repeated deduplicationId (M106 §3.3, §10 obligation 9)', async () => {
    const nats = await import('nats');
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const streamName = `M106_DEDUP_${suffix}`;
    const scope = `m106dedup.${suffix}`;
    const topic = `${scope}.orders`;

    let broker: IMessageBroker | undefined;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({ broker: 'nats', url, streamName, streamSubjects: [`${scope}.>`] }),
        brokerProbe((b) => {
          broker = b;
        }),
      ],
    });

    const jsmConn = await nats.connect({ servers: url });
    const jsm = await jsmConn.jetstreamManager();
    try {
      await app.start();
      await broker!.publish(topic, { id: 1 }, { deduplicationId: 'dedup-1' });
      // The server answers `duplicate: true` on the PubAck and keeps one copy.
      await broker!.publish(topic, { id: 1 }, { deduplicationId: 'dedup-1' });
      expect((await jsm.streams.info(streamName)).state.messages).toBe(1);

      // A different id is NOT a duplicate.
      await broker!.publish(topic, { id: 2 }, { deduplicationId: 'dedup-2' });
      expect((await jsm.streams.info(streamName)).state.messages).toBe(2);
    } finally {
      await app.stop();
      await jsm.streams.delete(streamName).catch(() => {});
      await jsmConn.close();
    }
  });

  it('refuses a caller Nats-Rollup header before the server ever sees it (M106 §3.4, §10 obligation 9)', async () => {
    const nats = await import('nats');
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const streamName = `M106_ROLLUP_${suffix}`;
    const scope = `m106rollup.${suffix}`;
    const topic = `${scope}.orders`;

    let broker: IMessageBroker | undefined;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({ broker: 'nats', url, streamName, streamSubjects: [`${scope}.>`] }),
        brokerProbe((b) => {
          broker = b;
        }),
      ],
    });

    const jsmConn = await nats.connect({ servers: url });
    const jsm = await jsmConn.jetstreamManager();
    try {
      await app.start();
      await expect(
        broker!.publish(topic, { id: 1 }, { headers: { 'Nats-Rollup': 'sub' } }),
      ).rejects.toThrow(RangeError);
      await expect(
        broker!.publish(topic, { id: 1 }, { headers: { 'nats-rollup': 'sub' } }),
      ).rejects.toThrow(RangeError);
      // Nothing was appended: the server never saw the refused publish.
      expect((await jsm.streams.info(streamName)).state.messages).toBe(0);
    } finally {
      await app.stop();
      await jsm.streams.delete(streamName).catch(() => {});
      await jsmConn.close();
    }
  });

  it('round-trips a permitted caller header byte for byte (M106 §10 obligation 9)', async () => {
    const nats = await import('nats');
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const streamName = `M106_HDR_${suffix}`;
    const scope = `m106hdr.${suffix}`;
    const topic = `${scope}.orders`;

    let broker: IMessageBroker | undefined;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({ broker: 'nats', url, streamName, streamSubjects: [`${scope}.>`] }),
        brokerProbe((b) => {
          broker = b;
        }),
      ],
    });

    const jsmConn = await nats.connect({ servers: url });
    const jsm = await jsmConn.jetstreamManager();
    const seen: MessageMetadata[] = [];
    try {
      await app.start();
      await broker!.subscribe(topic, (_message, metadata) => {
        seen.push(metadata);
      });
      await broker!.publish(topic, { id: 1 }, { headers: { 'x-tenant': 'acme' } });
      await waitFor(() => seen.length > 0, 'NATS header delivery');
      const headers = seen[0]?.headers ?? {};
      expect(headers['x-tenant']).toBe('acme');
      // The framework's own header rides beside the caller's.
      expect(headers['x-setu-ordering-key']).toBeUndefined();
    } finally {
      await app.stop();
      await jsm.streams.delete(streamName).catch(() => {});
      await jsmConn.close();
    }
  });

  it('boots the scaffold subject set under the fixed `app` scope (M113h V9-17)', async () => {
    // The literal set the CLI now renders into every NATS scaffold. It is the
    // messaging plugin's documented RPC-capable shape; `>` alone is refused by
    // NATS, and this is what a scaffolded workspace's shared MESSAGING stream
    // owns.
    const subjects = ['app.>', 'rr.req.app.>', 'rr.inbox.>'] as const;
    const nats = await import('nats');
    const suffix = crypto.randomUUID().replaceAll('-', '').slice(0, 10);
    const streamName = `M113H_NATS_${suffix}`;

    let broker: IMessageBroker | undefined;
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        MessagingPlugin({ broker: 'nats', url, streamName, streamSubjects: [...subjects] }),
        brokerProbe((b) => {
          broker = b;
        }),
      ],
    });

    const jsmConn = await nats.connect({ servers: url });
    const jsm = await jsmConn.jetstreamManager();
    try {
      // Only one stream per account may own `rr.inbox.>`, so a leftover MESSAGING
      // stream from a booted scaffold (including this milestone's own
      // verification) makes the fresh stream's creation fail as an opaque
      // overlap. Name the owner instead, and say how to clear it.
      const owner = await jsm.streams.find('app.x').catch(() => undefined);
      if (owner !== undefined) {
        throw new Error(
          `Stream '${owner}' already owns 'app.x'. Delete it before running this case: ` +
            `nats stream rm ${owner}`,
        );
      }

      await app.start();
      const info = await jsm.streams.info(streamName);
      expect(info.config.subjects).toEqual([...subjects]);

      // Publish/subscribe under `app.>` …
      const received: unknown[] = [];
      await broker!.subscribe('app.x', (message) => {
        received.push(message);
      });
      await broker!.publish('app.x', { id: 1 });
      await waitFor(() => received.length > 0, 'app.x delivery');
      expect(received[0]).toEqual({ id: 1 });

      // … and request/reply, whose subjects the set covers via `rr.req.app.>`
      // and `rr.inbox.>`.
      await broker!.respond<{ n: number }, { doubled: number }>('app.y', (request) => ({
        doubled: request.n * 2,
      }));
      const reply = await broker!.request<{ n: number }, { doubled: number }>(
        'app.y',
        { n: 21 },
        { timeoutMs: 10_000 },
      );
      expect(reply).toEqual({ doubled: 42 });
    } finally {
      await app.stop();
      await jsm.streams.delete(streamName).catch(() => {});
      await jsmConn.close();
    }
  });
});
