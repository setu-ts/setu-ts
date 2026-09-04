// deno-lint-ignore-file no-console -- guarded skip tests log SKIP messages.
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
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RabbitMqBroker } from '../../src/brokers/rabbitmq-broker.ts';
import { RedisStreamsBroker } from '../../src/brokers/redis-streams-broker.ts';
import { PipelinedBroker } from '../../src/pipeline/pipelined-broker.ts';
import { JsonSerializer } from '../../src/serializers/json-serializer.ts';
import type { IRuntimeServices } from '@setu-ts/common';

// ── Docker stop/start helpers (inlined; no cross-package dep) ──────────────

async function docker(args: string[]): Promise<string> {
  const out = await new Deno.Command('docker', { args }).output();
  if (!out.success) {
    throw new Error(
      `docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

/** Finds the container ID publishing the given port. */
async function containerIdForPort(port: number): Promise<string> {
  const ids = (await docker(['ps', '-q', '--filter', `publish=${port}`])).trim();
  if (ids === '') {
    throw new Error(`no container publishing port ${port}`);
  }
  return ids.split('\n')[0];
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

// ── RabbitMQ outage ─────────────────────────────────────────────────────────

describe('REAL RabbitMQ outage (§3.7)', () => {
  it('up → stop → down → restart → up, and pre-outage subscription receives post-outage publish', async () => {
    const url = Deno.env.get('RABBITMQ_URL');
    if (url === undefined) {
      console.log('SKIP: RABBITMQ_URL not set');
      return;
    }

    let amqplibPresent = false;
    try {
      await import('npm:amqplib@0.10.x');
      amqplibPresent = true;
    } catch {
      // npm:amqplib not available
    }
    if (!amqplibPresent) {
      console.log('SKIP: npm:amqplib not available');
      return;
    }

    const port = new URL(url).port === '' ? 5672 : Number(new URL(url).port);
    const containerId = await containerIdForPort(port);

    const broker = new RabbitMqBroker(makeRuntime(), new JsonSerializer(), { url: toIpv4(url) });
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
      await new Deno.Command('docker', { args: ['start', containerId] }).output();
    }
  });
});

// ── Redis Streams outage ────────────────────────────────────────────────────

describe('REAL Redis Streams outage (§3.7)', () => {
  it('up → stop → down → restart → up', async () => {
    const url = Deno.env.get('REDIS_URL');
    if (url === undefined) {
      console.log('SKIP: REDIS_URL not set');
      return;
    }

    let ioredisPresent = false;
    try {
      await import('npm:ioredis@5.x');
      ioredisPresent = true;
    } catch {
      // npm:ioredis not available
    }
    if (!ioredisPresent) {
      console.log('SKIP: npm:ioredis@5.x not available');
      return;
    }

    const port = new URL(url).port === '' ? 6379 : Number(new URL(url).port);
    const containerId = await containerIdForPort(port);

    const broker = new RedisStreamsBroker(makeRuntime(), new JsonSerializer(), {
      url: toIpv4(url),
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
      await new Deno.Command('docker', { args: ['start', containerId] }).output();
    }
  });
});

// ── M89c: register-time publish on a REAL broker ────────────────────────────

describe('REAL RabbitMQ register-time publish (M89c §6)', () => {
  it('a register-time publish still boots and still delivers through the COMPLETE chain', async () => {
    const url = Deno.env.get('RABBITMQ_URL');
    if (url === undefined) {
      console.log('SKIP: RABBITMQ_URL not set');
      return;
    }

    let amqplibPresent = false;
    try {
      await import('npm:amqplib@0.10.x');
      amqplibPresent = true;
    } catch {
      // npm:amqplib not available
    }
    if (!amqplibPresent) {
      console.log('SKIP: npm:amqplib not available');
      return;
    }

    // The production shape: the broker wrapped by the behaviour chain with the
    // gate armed (the factory arm). The measurement (2026-09-03) showed
    // rabbitmq boots AND delivers complete through this path; §3.1 changed the
    // IN-MEMORY promise only, so this pins that the real path cannot regress.
    const { promise: chainReady, resolve: openChainGate } = Promise.withResolvers<void>();
    const log: string[] = [];
    const rabbit = new RabbitMqBroker(makeRuntime(), new JsonSerializer(), { url: toIpv4(url) });
    const piped = new PipelinedBroker(
      rabbit,
      [
        {
          handle: (_ctx, next) => {
            log.push('instance');
            return next();
          },
        },
        {
          handle: (_ctx, next) => {
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
  });
});
