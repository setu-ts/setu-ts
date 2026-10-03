// deno-lint-ignore-file no-console -- guarded skip tests log SKIP messages.
/**
 * §3.7 real-outage bar: drives a **real** backend through a **real** stop and
 * restart for both queue adapters, asserting `up → (stop) down → (restart) up`.
 *
 * - `RedisQueue` against live Redis (guarded on `REDIS_URL`). F3 regression:
 *   without the bound `ping.call(client)` fix, `isHealthy()` reports `false`
 *   forever against a healthy Redis, so the baseline `up` would fail.
 * - `RabbitMqQueue` against live RabbitMQ (guarded on `RABBITMQ_URL`).
 * - M101a V8-5: a PAUSED Redis (socket open, no reply) through a real kernel
 *   app — `queue.add` rejects inside `commandTimeoutMs` instead of waiting
 *   forever, `/health` reports the queue `down`, and after unpause `add`
 *   succeeds. Guarded with `ignore:` on `REDIS_URL`, so an unset variable is
 *   reported as IGNORED rather than passing.
 *
 * `ALLOW_SKIP` does not apply here — that variable is read only by
 * `scripts/check-apps.ts` and governs `apps/`. `test/apps-gate.test.ts` pins the service, port
 * mapping, and env var.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RedisQueue } from '../../src/adapters/redis-queue.ts';
import { RabbitMqQueue } from '../../src/adapters/rabbitmq-queue.ts';
import { CAPABILITIES } from '@setu-ts/common';
import type { IQueue, IRuntimeServices } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { HealthPlugin } from '@setu-ts/health-plugin';
import { QueuePlugin } from '../../src/index.ts';

// ── Docker stop/start helpers ───────────────────────────────────────────────

async function docker(args: string[]): Promise<string> {
  const out = await new Deno.Command('docker', { args }).output();
  if (!out.success) {
    throw new Error(
      `docker ${args.join(' ')} failed: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
  return new TextDecoder().decode(out.stdout);
}

async function containerIdForPort(port: number): Promise<string> {
  const ids = (await docker(['ps', '-q', '--filter', `publish=${port}`])).trim();
  if (ids === '') {
    throw new Error(`no container publishing port ${port}`);
  }
  return ids.split('\n')[0];
}

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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

function toIpv4(url: string): string {
  return url.replace(/localhost/g, '127.0.0.1');
}

/**
 * Waits until the backend accepts TCP connections on the given port.
 * `docker start` returns when the container boots, not when the service
 * inside is listening (RabbitMQ needs a few seconds), so a reconnect issued
 * immediately after would hit a TCP reset. Poll a raw connect until it
 * succeeds.
 */
async function waitForPort(port: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const conn = await Deno.connect({ hostname: '127.0.0.1', port });
      conn.close();
      return;
    } catch {
      await wait(250);
    }
  }
  throw new Error(`timeout waiting for port ${port} to accept connections`);
}

/**
 * Reconnects a `RabbitMqQueue` after a real outage, retrying with backoff.
 * `docker start` returns at container boot and the port accepts TCP before
 * RabbitMQ's AMQP handshake is ready, so a single immediate `connect()` can
 * hit a reset. Retrying mirrors what an application/orchestrator would do for
 * an observation-only adapter (the §3.5 ReconnectSupervisor is scoped to
 * messaging-plugin brokers, not the queue).
 */
async function reconnectWithRetry(
  queue: RabbitMqQueue,
  attempts = 40,
): Promise<void> {
  let lastError: unknown = null;
  for (let i = 0; i < attempts; i++) {
    try {
      await queue.disconnect();
      await queue.connect();
      return;
    } catch (error) {
      lastError = error;
      await wait(500);
    }
  }
  throw new Error(
    `RabbitMqQueue reconnect failed after ${attempts} attempts: ${String(lastError)}`,
  );
}

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

// ── RedisQueue outage ───────────────────────────────────────────────────────

describe('REAL RedisQueue outage (§3.7)', () => {
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

    const queue = new RedisQueue({ url: toIpv4(url) });

    try {
      await queue.connect();
      const probe = queue.isHealthy;
      expect(typeof probe).toBe('function');
      if (typeof probe !== 'function') return;

      // (up) baseline: F3 regression — the bound ping must report reachable.
      await waitTrue(async () => (await probe()) === true, 'up baseline', 15_000);
      expect(await probe()).toBe(true);

      // (stop) real Redis stop → probe reports down
      await docker(['stop', containerId]);
      await waitTrue(async () => (await probe()) === false, 'down after stop', 30_000);
      expect(await probe()).toBe(false);

      // (restart) real Redis start → probe reports up
      await docker(['start', containerId]);
      await waitTrue(async () => (await probe()) === true, 'up after restart', 30_000);
      expect(await probe()).toBe(true);
    } finally {
      await queue.disconnect();
      await new Deno.Command('docker', { args: ['start', containerId] }).output();
    }
  });
});

// ── RabbitMqQueue outage ────────────────────────────────────────────────────

describe('REAL RabbitMqQueue outage (§3.7)', () => {
  it('up → stop → down → restart → up', async () => {
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

    const queue = new RabbitMqQueue(makeRuntime(), { url: toIpv4(url) });

    try {
      await queue.connect();
      const probe = queue.isHealthy;
      expect(typeof probe).toBe('function');
      if (typeof probe !== 'function') return;

      // (up) baseline
      await waitTrue(async () => (await probe()) === true, 'up baseline', 15_000);
      expect(await probe()).toBe(true);

      // (stop) real RabbitMQ stop → fault listener sets #faulted → down
      await docker(['stop', containerId]);
      await waitTrue(async () => (await probe()) === false, 'down after stop', 30_000);
      expect(await probe()).toBe(false);

      // (restart) real RabbitMQ start. The queue adapter is observation-only
      // (§3.5 scopes the ReconnectSupervisor to messaging-plugin brokers), so
      // it does not self-heal: recovery is an explicit lifecycle reconnection,
      // which resets the fault flag and re-establishes the connection → up.
      // `docker start` returns at container boot, not when RabbitMQ is
      // listening, so wait for the port to accept connections first.
      await docker(['start', containerId]);
      await waitForPort(port, 30_000);
      await reconnectWithRetry(queue);
      const reprobe = queue.isHealthy;
      expect(typeof reprobe).toBe('function');
      if (typeof reprobe !== 'function') return;
      await waitTrue(async () => (await reprobe()) === true, 'up after restart', 30_000);
      expect(await reprobe()).toBe(true);
    } finally {
      await queue.disconnect();
      await new Deno.Command('docker', { args: ['start', containerId] }).output();
    }
  });
});

// ── RedisQueue paused-server bound (M101a V8-5) ─────────────────────────────

const redisUrl = Deno.env.get('REDIS_URL');
const BOUND_MS = 1000;

describe(
  'REAL paused Redis bounds queue.add (M101a V8-5)',
  { ignore: redisUrl === undefined },
  () => {
    it('paused → add rejects within the bound and /health down → unpaused → add succeeds', async () => {
      const url = toIpv4(redisUrl!);
      const port = new URL(url).port === '' ? 6379 : Number(new URL(url).port);
      const containerId = await containerIdForPort(port);

      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          QueuePlugin({ adapter: 'redis', url, commandTimeoutMs: BOUND_MS }),
          HealthPlugin(),
        ],
      });
      await app.start();
      const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
      const jobName = `m101a-${crypto.randomUUID()}`;

      let paused = false;
      try {
        await queue.add(jobName, { n: 1 });

        await docker(['pause', containerId]);
        paused = true;

        const started = performance.now();
        const outcome = await queue.add(jobName, { n: 2 }).then(
          () => 'resolved',
          (error: unknown) => error,
        );
        const elapsed = performance.now() - started;
        expect(outcome).toBeInstanceOf(Error);
        expect(elapsed).toBeLessThan(BOUND_MS * 3);

        let queueStatus: string | undefined;
        let healthStatus = 0;
        await waitTrue(
          async () => {
            const health = await app.inject({ method: 'GET', url: 'http://localhost/health' });
            healthStatus = health.statusCode;
            const checks = (health.json() as { checks?: Record<string, { status: string }> })
              .checks;
            queueStatus = checks?.['queue']?.status;
            return queueStatus === 'down';
          },
          'queue down while paused',
          20_000,
        );
        expect({ healthStatus, queueStatus }).toEqual({ healthStatus: 503, queueStatus: 'down' });

        await docker(['unpause', containerId]);
        paused = false;
        await expect(queue.add(jobName, { n: 3 })).resolves.toBeDefined();
      } finally {
        if (paused) await docker(['unpause', containerId]).catch(() => '');
        await app.stop();
      }
    });
  },
);
