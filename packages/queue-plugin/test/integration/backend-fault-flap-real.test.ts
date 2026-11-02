/**
 * A `503` ("not applied") is answered only when the job cannot have been stored
 * (M131a X88-5, security audit F-1). REAL Redis behind a test-owned TCP proxy,
 * for both clients, guarded on `REDIS_URL`.
 *
 * The proxy lets the test cut a connection AFTER the enqueue reached Redis and
 * before its reply came back, which no fake can reproduce: node-redis writes the
 * commands it queued while disconnected together with its reconnect handshake,
 * BEFORE `'ready'`, so an earlier rule that counted `'ready'` answered `503`
 * with the job stored. The rule now counts socket `'connect'` events.
 *
 * - `flap`: dispatch while reconnecting, let the next socket carry the job,
 *   cut before the reply. The job IS stored, so the answer must be `504`.
 * - `ready`: dispatch while connected, cut after the job reached Redis → `504`.
 * - `down`: the proxy stops listening, as a stopped Redis does, so every redial
 *   is refused → `503`, nothing stored. (A server that accepts the TCP
 *   connection and then drops it counts as a socket connect and answers `504`:
 *   the rule errs toward "may have been sent".)
 *
 * The invariant every run checks: a `503` never coexists with a stored job.
 *
 * @module
 */
import * as net from 'node:net';
import { describe, expect, it } from 'vitest';
import {
  BackendOutcomeUnknownError,
  BackendUnavailableError,
  CAPABILITIES,
  fromNodeRedis,
} from '@setu-ts/common';
import type { IQueue } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { QueuePlugin } from '../../src/index.ts';

const redisUrl = process.env['REDIS_URL'];

type Mode = 'pass' | 'refuse' | 'drop-after-job';
type Scenario = 'flap' | 'ready' | 'down';
type Client = 'node-redis' | 'ioredis';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** One enqueue through the proxy; returns what was thrown and what Redis stored. */
async function run(clientKind: Client, scenario: Scenario) {
  const upstreamUrl = new URL(redisUrl!.replace(/localhost/g, '127.0.0.1'));
  const upstream = {
    host: upstreamUrl.hostname,
    port: upstreamUrl.port === '' ? 6379 : Number(upstreamUrl.port),
  };
  const password = decodeURIComponent(upstreamUrl.password);
  const job = `m131a-flap-${scenario}-${Math.random().toString(36).slice(2, 8)}`;
  let mode: Mode = 'pass';
  let forwarded = 0;
  const sockets = new Set<net.Socket>();
  const proxy = net.createServer((client) => {
    if (mode === 'refuse') {
      client.destroy();
      return;
    }
    const server = net.connect(upstream);
    sockets.add(client);
    sockets.add(server);
    const kill = (): void => {
      client.destroy();
      server.destroy();
      sockets.delete(client);
      sockets.delete(server);
    };
    for (const socket of [client, server]) {
      socket.on('error', kill);
      socket.on('close', kill);
    }
    client.on('data', (chunk: Buffer) => {
      server.write(chunk);
      if (mode === 'drop-after-job' && chunk.includes(job)) {
        forwarded++;
        // Redis receives and runs it; the client never sees the reply.
        server.prependOnceListener('data', () => {
          mode = 'refuse';
          kill();
        });
      }
    });
    server.on('data', (chunk: Buffer) => {
      if (sockets.has(client)) client.write(chunk);
    });
  });
  await new Promise<void>((resolve) => proxy.listen(0, '127.0.0.1', resolve));
  const port = (proxy.address() as net.AddressInfo).port;
  const auth = password === '' ? '' : `:${encodeURIComponent(password)}@`;
  const url = `redis://${auth}127.0.0.1:${port}`;
  const dropAll = (): void => {
    for (const socket of sockets) socket.destroy();
    sockets.clear();
  };

  const queueOptions =
    clientKind === 'node-redis'
      ? {
          adapter: 'redis' as const,
          client: fromNodeRedis(
            async () => {
              const { createClient } = await import('redis');
              return createClient({ url, socket: { reconnectStrategy: () => 300 } });
            },
            { commandTimeoutMs: 4000 },
          ),
        }
      : { adapter: 'redis' as const, url, commandTimeoutMs: 4000 };
  const app = createApplication({
    plugins: [RuntimePlugin(), QueuePlugin(queueOptions as never)],
  });
  await app.start();
  const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
  let thrown: unknown;
  try {
    let pending: Promise<unknown>;
    if (scenario === 'flap') {
      mode = 'refuse';
      dropAll();
      await sleep(400);
      pending = queue.add(job, { n: 1 });
      await sleep(50);
      mode = 'drop-after-job';
    } else if (scenario === 'ready') {
      mode = 'drop-after-job';
      pending = queue.add(job, { n: 1 });
    } else {
      // Stop listening, as a stopped Redis does: every redial is REFUSED at the
      // TCP level, so no socket ever opens and the job cannot be written.
      mode = 'refuse';
      await new Promise<void>((resolve) => {
        proxy.close(() => resolve());
        dropAll();
      });
      await sleep(400);
      pending = queue.add(job, { n: 1 });
    }
    await pending.catch((error: unknown) => {
      thrown = error;
    });
  } finally {
    mode = 'refuse';
    await Promise.race([app.stop().catch(() => undefined), sleep(3000)]);
    if (proxy.listening) proxy.close();
  }

  // Read Redis directly, not through the proxy: was the job stored?
  const { Redis } = await import('ioredis');
  const direct = new Redis({ ...upstream, password, lazyConnect: true });
  await direct.connect();
  let stored = 0;
  try {
    for (const key of await direct.keys(`*${job}*`)) {
      if ((await direct.type(key)) === 'hash') stored += await direct.hlen(key);
      await direct.del(key);
    }
  } finally {
    await direct.quit();
  }
  return { thrown, stored, forwarded };
}

describe('REAL: a 503 is answered only when the job cannot have been stored (F-1)', () => {
  for (const clientKind of ['node-redis', 'ioredis'] as const) {
    it(
      `${clientKind}: flap → 504 with the job stored`,
      { skip: redisUrl === undefined, timeout: 30_000 },
      async () => {
        const { thrown, stored, forwarded } = await run(clientKind, 'flap');
        expect(forwarded).toBeGreaterThan(0);
        expect(stored).toBe(1);
        expect(thrown).toBeInstanceOf(BackendOutcomeUnknownError);
      },
    );
    it(
      `${clientKind}: ready → 504 with the job stored`,
      { skip: redisUrl === undefined, timeout: 30_000 },
      async () => {
        const { thrown, stored } = await run(clientKind, 'ready');
        expect(stored).toBe(1);
        expect(thrown).toBeInstanceOf(BackendOutcomeUnknownError);
      },
    );
    it(
      `${clientKind}: down → 503 with nothing stored`,
      { skip: redisUrl === undefined, timeout: 30_000 },
      async () => {
        const { thrown, stored } = await run(clientKind, 'down');
        expect(stored).toBe(0);
        expect(thrown).toBeInstanceOf(BackendUnavailableError);
      },
    );
  }
});
