import { run as runProcess } from '../../../../test/node-helpers.ts';
/**
 * §3.7 real-outage bar: drives a **real** broker through a **real** stop and
 * restart, asserting the sequence `up → (stop) down → (restart) up`, and for
 * RabbitMQ additionally that a subscription established before the outage
 * receives a message published after it (the X2-1 replay reproduction).
 *
 * Guarded on `RABBITMQ_URL` / `REDIS_URL` (M53 pattern): absent them, this suite
 * skips. `ALLOW_SKIP` does not apply here — that variable is read only by
 * `scripts/check-apps.ts` and governs `apps/`. What keeps this suite honest is
 * `test/apps-gate.test.ts`, which pins the service, port mapping and env var in
 * both workflows, so CI cannot silently stop running it.
 *
 * Container discovery: `docker ps --filter publish=<port>` locates the backend
 * container by its published port, so the same suite works against the CI
 * service containers (localhost-mapped) and local `smoke-*` containers alike.
 */
import { describe, expect, it } from 'vitest';
import { RabbitMqBroker } from '../../src/brokers/rabbitmq-broker.ts';
import { RedisStreamsBroker } from '../../src/brokers/redis-streams-broker.ts';
import { PipelinedBroker } from '../../src/pipeline/pipelined-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import type { IRuntimeServices } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { IMessageBroker } from '@setu-ts/common';
import type { MessagingPluginOptions } from '../../src/interfaces/index.ts';
import type { MessageBrokerAdapter } from '../../src/brokers/message-broker.ts';
import { kafkaHealthClientConfig } from '../../src/brokers/kafka-broker.ts';
import { PublishTimeoutError } from '../../src/errors.ts';
import { REDIS_CLIENTS, redisOptions } from '../../../common/test/fixtures/redis-clients.ts';

describe.each(REDIS_CLIENTS)('%s', (redisVariant) => {
  it(
    'M119a REAL paused Redis rejects at the configured publish bound',
    { skip: !process.env['REDIS_URL'] },
    async () => {
      const url = process.env['REDIS_URL']!;
      const container = await containerIdForPort(Number(new URL(url).port || 6379));
      const broker = new RedisStreamsBroker(makeRuntime(), new JsonSerializer(), {
        ...redisOptions(redisVariant, url),
        publishTimeoutMs: 2000,
      });
      let paused = false;
      try {
        await broker.connect();
        await broker.publish(`m119a.baseline.${crypto.randomUUID()}`, {});
        await docker(['pause', container]);
        paused = true;
        const started = performance.now();
        const error = await broker.publish('m119a.paused', {}).catch((error: unknown) => error);
        const elapsed = performance.now() - started;
        expect(error).toBeInstanceOf(PublishTimeoutError);
        expect(error).toMatchObject({ topic: 'm119a.paused', timeoutMs: 2000 });
        expect(elapsed).toBeGreaterThanOrEqual(2000);
        expect(elapsed).toBeLessThan(3000);
      } finally {
        if (paused) await docker(['unpause', container]);
        await broker.disconnect();
      }
    },
  );
});

// ── Docker stop/start helpers (inlined; no cross-package dep) ──────────────

async function docker(args: string[]): Promise<string> {
  const out = await runProcess('docker', { args });
  if (!out.success) {
    throw new Error(`docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`);
  }
  return new TextDecoder().decode(out.stdout);
}

/** Finds the container ID publishing the given port. */
async function containerIdForPort(port: number): Promise<string> {
  const shard = process.env['SETU_CI_SHARD'];
  const filters = shard
    ? ['--filter', `label=setu.ci.shard=${shard}`, '--filter', `label=setu.ci.port.${port}=1`]
    : ['--filter', `publish=${port}`];
  const ids = (await docker(['ps', '-q', ...filters])).trim();
  if (ids === '') {
    throw new Error(`no container publishing port ${port}`);
  }
  return ids.split('\n')[0];
}

/** A started Kafka container can take seconds to answer metadata; restore the service too. */
async function waitKafkaReady(brokers: string[]): Promise<void> {
  const { Kafka, logLevel } = await import('kafkajs');
  await waitTrue(
    async () => {
      const admin = new Kafka({
        ...kafkaHealthClientConfig(brokers, 'm113a-restore'),
        logLevel: logLevel.NOTHING,
      }).admin();
      try {
        await admin.connect();
        await admin.describeCluster();
        return true;
      } catch {
        return false;
      } finally {
        await admin.disconnect();
      }
    },
    'Kafka metadata service restored',
    60000,
  );
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

/** Polls a predicate until true or timeout. */
async function waitTrue(
  pred: () => boolean | Promise<boolean>,
  label: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await pred()) return;
    await wait(250);
  }
  throw new Error(`timeout waiting for ${label}`);
}

/**
 * Rewrites a `localhost` host to `127.0.0.1`. ioredis resolves `localhost`
 * against the OS host table, which on this runner yields the IPv6 loopback
 * `::1` for its background reconnect; the scoped test net permission
 * (`127.0.0.1`/`localhost`, no `::1`) then throws an uncaught `NotCapable`
 * after the suite finishes. Connecting via the explicit IPv4 loopback keeps
 * every ioredis dial inside the granted net set.
 */
function toIpv4(url: string): string {
  return url.replace(/localhost/, '127.0.0.1');
}

// ── IRuntimeServices for the RabbitMQ broker ────────────────────────────────

function makeRuntime(): IRuntimeServices {
  return {
    hrtime: () => performance.now(),
    now: () => Date.now(),
    uuid: () => crypto.randomUUID(),
    setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms),
    clearTimeout: (h: unknown) => clearTimeout(h as number),
    setInterval: (fn: () => void, ms: number) => setInterval(fn, ms),
    clearInterval: (h: unknown) => clearInterval(h as number),
  } as IRuntimeServices;
}

/** Real kernel path, including the registered health indicator. */
async function startM113App(options: MessagingPluginOptions) {
  const { createApplication } = await import('@setu-ts/kernel');
  const { RuntimePlugin } = await import('@setu-ts/runtime');
  const { HealthPlugin } = await import('@setu-ts/health-plugin');
  const { MessagingPlugin } = await import('../../src/index.ts');
  const app = createApplication({
    plugins: [RuntimePlugin(), MessagingPlugin(options), HealthPlugin({ details: true })],
  });
  await app.start();
  const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
  const health = async () => {
    const body = await (
      await app.inject({ method: 'GET', url: 'http://localhost/health' })
    ).json<{
      checks: Record<string, { status: string; data: { reachable: boolean | 'unknown' } }>;
    }>();
    return body.checks.messaging!;
  };
  const reachability = () => (broker as MessageBrokerAdapter).reachability();
  return { app, broker, health, reachability };
}

describe('M113a REAL Kafka metadata outage', { skip: !process.env['KAFKA_BROKERS'] }, () => {
  const brokers = (process.env['KAFKA_BROKERS'] ?? '').split(',');
  it('stopped Kafka reports false and indicator down inside the probe bound, then recovers', async () => {
    const port = Number(brokers[0]!.split(':').at(-1));
    const container = await containerIdForPort(port);
    await waitKafkaReady(brokers);
    const { app, broker, health, reachability } = await startM113App({
      broker: 'kafka',
      brokers,
    });
    try {
      expect(await broker.isHealthy!()).toBe(true);
      await docker(['stop', container]);
      await wait(5100); // age the broker's cached healthy result
      const started = performance.now();
      expect(await reachability()).toBe(false);
      expect(performance.now() - started).toBeLessThan(2500);
      expect(await health()).toMatchObject({ status: 'down', data: { reachable: false } });
      await docker(['start', container]);
      await waitTrue(async () => (await health()).data.reachable === true, 'Kafka recovery', 60000);
    } finally {
      await docker(['start', container]);
      try {
        await waitKafkaReady(brokers);
      } finally {
        await app.stop();
      }
    }
  }, 90000);

  it('paused Kafka reports unknown and publish rejects at its configured bound', async () => {
    const container = await containerIdForPort(Number(brokers[0]!.split(':').at(-1)));
    await waitKafkaReady(brokers);
    const { app, broker, health } = await startM113App({
      broker: 'kafka',
      brokers,
      publishTimeoutMs: 350,
    });
    let paused = false;
    try {
      expect(await broker.isHealthy!()).toBe(true);
      await docker(['pause', container]);
      paused = true;
      await wait(5100);
      const started = performance.now();
      expect(await health()).toMatchObject({ status: 'up', data: { reachable: 'unknown' } });
      expect(performance.now() - started).toBeLessThan(2500);
      const publishStarted = performance.now();
      await expect(broker.publish(`m113a.paused.${crypto.randomUUID()}`, {})).rejects.toThrow(
        '350 ms (publishTimeoutMs); it may still be delivered',
      );
      expect(performance.now() - publishStarted).toBeGreaterThanOrEqual(300);
      expect(performance.now() - publishStarted).toBeLessThan(1500);
      await docker(['unpause', container]);
      paused = false;
      await waitTrue(async () => (await health()).data.reachable === true, 'Kafka unpause', 30000);
    } finally {
      if (paused) await docker(['unpause', container]);
      await docker(['start', container]);
      try {
        await waitKafkaReady(brokers);
      } finally {
        await app.stop();
      }
    }
  }, 90000);
});

describe(
  'REAL Kafka shutdown with sends in flight (audit O1)',
  { skip: !process.env['KAFKA_BROKERS'] },
  () => {
    const brokers = (process.env['KAFKA_BROKERS'] ?? '').split(',');
    const port = Number(brokers[0]!.split(':').at(-1));
    /** Open sockets to the broker held by this process. */
    const brokerSockets = (): number =>
      (process as unknown as { _getActiveHandles(): unknown[] })
        ._getActiveHandles()
        .filter((handle) => (handle as { remotePort?: number }).remotePort === port).length;

    it('app.stop() returns at the release bound and leaves no broker connection open', async () => {
      const container = await containerIdForPort(port);
      await waitKafkaReady(brokers);
      const { app, broker } = await startM113App({
        broker: 'kafka',
        brokers,
        publishTimeoutMs: 350,
      });
      const topic = `o1.stop.${crypto.randomUUID()}`;
      await broker.publish(topic, {});
      let paused = false;
      let stopped = false;
      try {
        await docker(['pause', container]);
        paused = true;
        const sends = await Promise.allSettled([1, 2, 3].map((i) => broker.publish(topic, { i })));
        expect(sends.map((r) => r.status)).toEqual(['rejected', 'rejected', 'rejected']);
        const stopStarted = performance.now();
        await app.stop();
        stopped = true;
        const stopMs = performance.now() - stopStarted;
        // kafkajs waits for pending requests up to its 30 s request timeout; the
        // broker bounds that wait at 10 s (was ~26 s).
        expect(stopMs).toBeLessThan(12000);
        await docker(['unpause', container]);
        paused = false;
        // The abandoned sends retry after the first disconnect and reconnect; the
        // broker closes again once they settle, so nothing keeps the process alive.
        await waitTrue(() => brokerSockets() === 0, 'no open broker socket after stop', 45000);
      } finally {
        if (paused) await docker(['unpause', container]);
        try {
          await waitKafkaReady(brokers);
        } finally {
          if (!stopped) await app.stop();
        }
      }
    }, 120000);
  },
);

describe('M113a REAL NATS reconnect', { skip: !process.env['NATS_URL'] }, () => {
  it('recovers after a 26 second outage and an existing consumer delivers again', async () => {
    const url = process.env['NATS_URL']!;
    const container = await containerIdForPort(Number(new URL(url).port || 4222));
    const suffix = crypto.randomUUID().replaceAll('-', '');
    const subject = `m113a.${suffix}.orders`;
    const streamName = `M113A_${suffix}`;
    const { app, broker, health } = await startM113App({
      broker: 'nats',
      url,
      streamName,
      streamSubjects: [`m113a.${suffix}.>`],
    });
    const received: unknown[] = [];
    try {
      await broker.subscribe(subject, (message) => {
        received.push(message);
      });
      await broker.publish(subject, { before: true });
      await waitTrue(() => received.length === 1, 'baseline NATS delivery', 10000);
      expect((await health()).data.reachable).toBe(true);
      await docker(['stop', container]);
      await waitTrue(async () => (await health()).status === 'down', 'NATS down', 15000);
      await wait(26000);
      await docker(['start', container]);
      await waitTrue(
        async () => (await health()).data.reachable === true,
        'NATS recovery after 26s',
        25000,
      );
      await broker.publish(subject, { after: true });
      await waitTrue(() => received.length >= 2, 'pre-outage consumer delivery', 15000);
      expect(received).toEqual([{ before: true }, { after: true }]);
    } finally {
      await docker(['start', container]);
      await app.stop();
      const nats = await import('nats');
      const cleanup = await nats.connect({ servers: url });
      try {
        await (await cleanup.jetstreamManager()).streams.delete(streamName);
      } finally {
        await cleanup.close();
      }
    }
  }, 100000);
});

// ── RabbitMQ outage ─────────────────────────────────────────────────────────

describe('REAL RabbitMQ outage (§3.7)', () => {
  it(
    'up → stop → down → restart → up, and pre-outage subscription receives post-outage publish',
    {
      skip: process.env['RABBITMQ_URL'] === undefined,
    },
    async () => {
      const url = process.env['RABBITMQ_URL'];
      if (url === undefined) throw new Error('Backend guard failed');

      await import('amqplib');

      const port = new URL(url).port === '' ? 5672 : Number(new URL(url).port);
      const containerId = await containerIdForPort(port);

      const broker = new RabbitMqBroker(makeRuntime(), new JsonSerializer(), {
        url: toIpv4(url),
      });
      const received: string[] = [];

      try {
        await broker.connect();

        // (up) baseline
        expect(await broker.isHealthy()).toBe(true);

        // Pre-outage subscription (X2-1: must survive the outage via replay)
        const topic = `m70c.outage.${crypto.randomUUID()}`;
        await broker.subscribe(topic, (msg: unknown) => {
          received.push(JSON.stringify(msg));
        });

        // (stop) real broker stop → drive-mode supervisor faults → down
        await docker(['stop', containerId]);
        await waitTrue(async () => (await broker.isHealthy()) === false, 'down after stop', 30_000);
        expect(await broker.isHealthy()).toBe(false);
        // Lifecycle intact: isReady stays true during the fault window
        expect(broker.isReady()).toBe(true);

        // (restart) real broker start → drive-mode reconnect → up
        await docker(['start', containerId]);
        await waitTrue(async () => (await broker.isHealthy()) === true, 'up after restart', 60_000);
        expect(await broker.isHealthy()).toBe(true);

        // X2-1: the pre-outage subscription receives a post-outage publish
        await broker.publish(topic, { after: 'outage' });
        await waitTrue(() => received.length >= 1, 'post-outage delivery', 20_000);
        expect(received.length).toBeGreaterThanOrEqual(1);
      } finally {
        await broker.disconnect();
        // Leave the container running for the environment.
        await runProcess('docker', { args: ['start', containerId] });
      }
    },
  );
});

// ── Redis Streams outage ────────────────────────────────────────────────────

describe.each(REDIS_CLIENTS)('%s REAL Redis Streams outage (§3.7)', (redisVariant) => {
  it(
    'up → stop → down → restart → up',
    { skip: process.env['REDIS_URL'] === undefined },
    async () => {
      const url = process.env['REDIS_URL'];
      if (url === undefined) throw new Error('Backend guard failed');

      await import('ioredis');

      const port = new URL(url).port === '' ? 6379 : Number(new URL(url).port);
      const containerId = await containerIdForPort(port);

      const broker = new RedisStreamsBroker(makeRuntime(), new JsonSerializer(), {
        ...redisOptions(redisVariant, toIpv4(url)),
      });

      try {
        await broker.connect();

        // (up) baseline: poll until the ioredis connection settles to ready
        await waitTrue(async () => (await broker.isHealthy()) === true, 'up baseline', 15_000);
        expect(await broker.isHealthy()).toBe(true);

        // (stop) real Redis stop → probe reports down
        await docker(['stop', containerId]);
        await waitTrue(async () => (await broker.isHealthy()) === false, 'down after stop', 30_000);
        expect(await broker.isHealthy()).toBe(false);

        // (restart) real Redis start → probe reports up
        await docker(['start', containerId]);
        await waitTrue(async () => (await broker.isHealthy()) === true, 'up after restart', 30_000);
        expect(await broker.isHealthy()).toBe(true);
      } finally {
        await broker.disconnect();
        await runProcess('docker', { args: ['start', containerId] });
      }
    },
  );
});

// ── M89c: register-time publish on a REAL broker ────────────────────────────

describe('REAL RabbitMQ register-time publish (M89c §6)', () => {
  it(
    'a register-time publish still boots and still delivers through the COMPLETE chain',
    {
      skip: process.env['RABBITMQ_URL'] === undefined,
    },
    async () => {
      const url = process.env['RABBITMQ_URL'];
      if (url === undefined) throw new Error('Backend guard failed');

      let amqplibPresent = false;
      try {
        await import('amqplib');
        amqplibPresent = true;
      } catch {
        // npm:amqplib not available
      }
      if (!amqplibPresent) {
        return;
      }

      // The production shape: the broker wrapped by the behaviour chain with the
      // gate armed (the factory arm). The measurement (2026-09-03) showed
      // rabbitmq boots AND delivers complete through this path; §3.1 changed the
      // IN-MEMORY promise only, so this pins that the real path cannot regress.
      const { promise: chainReady, resolve: openChainGate } = Promise.withResolvers<void>();
      const log: string[] = [];
      const rabbit = new RabbitMqBroker(makeRuntime(), new JsonSerializer(), {
        url: toIpv4(url),
      });
      const piped = new PipelinedBroker(
        rabbit,
        [
          {
            handle: (ctx, next) => {
              expect(ctx.kind).toBe('messaging');
              log.push('instance');
              return next();
            },
          },
          {
            handle: (ctx, next) => {
              expect(ctx.kind).toBe('messaging');
              log.push('factory');
              return next();
            },
          },
        ],
        chainReady,
        { runtime: makeRuntime(), timeoutMs: 30_000 },
      );

      const topic = `m89c.register-publish.${crypto.randomUUID()}`;
      const received: string[] = [];

      try {
        await rabbit.connect();
        // "register()" of a later plugin: subscribe, then AWAIT a publish —
        // before the gate opens. On a real broker publish already returned
        // before delivery; it must still resolve, not deadlock.
        await piped.subscribe(topic, (msg: unknown) => {
          log.push('handler');
          received.push(JSON.stringify(msg));
        });
        await piped.publish(topic, { at: 'register-time' });

        // "onInit" ends: the gate opens and the held message flows through the
        // complete chain.
        openChainGate();
        await waitTrue(() => received.length >= 1, 'register-time delivery', 20_000);

        expect(received.length).toBe(1);
        expect(log).toEqual(['instance', 'factory', 'handler']);
      } finally {
        await piped.disconnect();
      }
    },
  );
});

// ── M95b §3.6: the hung backend the stopped arm never produces ──────────────

/**
 * A real kernel application whose `/health` carries the real messaging
 * indicator. The hung arm must drive the INDICATOR level — the bound lives
 * there (§3.6) — and a direct `broker.isHealthy()` call has no bound by
 * design, so it could not discriminate.
 */
async function startHealthApp(rabbitUrl: string) {
  const { createApplication } = await import('@setu-ts/kernel');
  const { RuntimePlugin } = await import('@setu-ts/runtime');
  const { HealthPlugin } = await import('@setu-ts/health-plugin');
  const { MessagingPlugin } = await import('../../src/index.ts');
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      MessagingPlugin({ broker: 'rabbitmq', url: toIpv4(rabbitUrl) }),
      HealthPlugin({ details: true }),
    ],
  });
  await app.start();
  return app;
}

describe('REAL RabbitMQ hung backend (M95b §3.6 / X51-2)', () => {
  it(
    'a paused broker: /health SETTLES inside the bound, never claims reachable true, and recovers',
    { skip: process.env['RABBITMQ_URL'] === undefined },
    async () => {
      const url = process.env['RABBITMQ_URL'];
      if (url === undefined) throw new Error('Backend guard failed');
      await import('amqplib');

      const port = new URL(url).port === '' ? 5672 : Number(new URL(url).port);
      const containerId = await containerIdForPort(port);
      const app = await startHealthApp(url);
      let paused = false;

      try {
        const healthBody = async (): Promise<{
          status: string;
          checks?: Record<string, { status: string; data?: unknown }>;
        }> => (await app.inject({ method: 'GET', url: 'http://localhost/health' })).json();

        // (up) baseline: the probe's real round trip answers true.
        await waitTrue(
          async () => {
            const body = await healthBody();
            const data = body.checks?.messaging?.data as { reachable?: unknown } | undefined;
            return body.status === 'up' && data?.reachable === true;
          },
          'baseline up with reachable true',
          30_000,
        );

        // (pause) the condition a stopped container never produces: the
        // socket stays open and nothing answers. X51-2 measured this as
        // `reachable: true` in 0.576 ms — a flag read. Now the /health
        // request must SETTLE (finding 2: the 0.6.0 hang never returned —
        // 'it settled' is asserted by MEASURING the elapsed time), and the
        // unanswerable probe must report 'unknown' (the R4 mapping §3.6
        // preserves), never a claimed true.
        await docker(['pause', containerId]);
        paused = true;

        let elapsed = -1;
        let sawUnknown = false;
        let unknownIndicatorStatus = '';
        const deadline = Date.now() + 30_000;
        while (Date.now() < deadline) {
          const started = performance.now();
          const body = await healthBody();
          elapsed = performance.now() - started;
          const data = body.checks?.messaging?.data as { reachable?: unknown } | undefined;
          if (data?.reachable === 'unknown') {
            sawUnknown = true;
            unknownIndicatorStatus = body.checks?.messaging?.status ?? '';
            break;
          }
          // A cached outcome inside the 5 s TTL answers instantly; keep
          // polling until a FRESH probe has run against the paused broker.
          await wait(500);
        }
        expect(sawUnknown).toBe(true);
        // The bound is 2 s; the request that answered 'unknown' must have
        // settled well inside the suite's own timeout — a request that never
        // returns fails here by measurement, not by luck.
        expect(elapsed).toBeGreaterThan(0);
        expect(elapsed).toBeLessThan(10_000);
        // The indicator reports unknown as `up` (the documented R4 rule §3.6
        // leaves unchanged) — the honest "we asked, nothing answered", not a
        // claimed reachable.
        expect(unknownIndicatorStatus).toBe('up');

        // (unpause) the broker answers again and the probe recovers to a
        // real `reachable: true`.
        await docker(['unpause', containerId]);
        paused = false;
        await waitTrue(
          async () => {
            const body = await healthBody();
            const data = body.checks?.messaging?.data as { reachable?: unknown } | undefined;
            return data?.reachable === true;
          },
          'recovered reachable true',
          30_000,
        );
      } finally {
        if (paused) {
          await runProcess('docker', { args: ['unpause', containerId] });
        }
        await app.stop().catch(() => {});
      }
    },
  );

  it(
    '§3.6 shared-channel guard: after N health polls a publish and a subscription still round-trip',
    { skip: process.env['RABBITMQ_URL'] === undefined },
    async () => {
      const url = process.env['RABBITMQ_URL'];
      if (url === undefined) throw new Error('Backend guard failed');
      await import('amqplib');

      const app = await startHealthApp(url);
      try {
        // N health polls against the RUNNING broker. If any poll ever touched
        // the shared channel (or leaked a fault into it), the traffic below
        // fails — the e2e form of the guard the unit suite pins.
        for (let i = 0; i < 5; i++) {
          await app.inject({ method: 'GET', url: 'http://localhost/health' });
        }

        const { CAPABILITIES } = await import('@setu-ts/common');
        const broker = app.services.get<{
          subscribe(
            topic: string,
            handler: (msg: unknown) => void | Promise<void>,
          ): Promise<{ unsubscribe(): Promise<void> }>;
          publish(topic: string, message: unknown): Promise<void>;
        }>(CAPABILITIES.MESSAGING);

        const topic = `m95b.channel-guard.${crypto.randomUUID()}`;
        const received: unknown[] = [];
        const sub = await broker.subscribe(topic, (msg: unknown) => {
          received.push(msg);
        });
        await broker.publish(topic, { after: 'polls' });
        await waitTrue(() => received.length >= 1, 'post-poll delivery', 20_000);
        await sub.unsubscribe();
        expect(received.length).toBe(1);
      } finally {
        await app.stop().catch(() => {});
      }
    },
  );
});
