/**
 * M131a V11-10 real-Redis bar: the queue probe reads the client's `status`
 * first, so a client that is not `ready` reads `down` without I/O instead of
 * issuing a ping that ioredis parks in its offline queue and hangs.
 *
 * Guarded on `REDIS_URL`. No shared container is stopped: the closed-port case
 * points a real ioredis client at a port that is not the live one, and the
 * positive control uses the live server. The "zero I/O" half of the fix is
 * asserted at the unit level (redis-queue-health.test.ts); here we prove the
 * real driver exposes a non-`ready` `status` for a closed port — the
 * precondition the probe relies on — and that the live path still reads `true`.
 */
import { describe, expect, it } from 'vitest';
import { Redis } from 'ioredis';
import type { IRedisQueueClient } from '../../src/interfaces/index.ts';
import { RedisQueue } from '../../src/adapters/redis-queue.ts';

const redisUrl = process.env['REDIS_URL'];

/**
 * Adapts a real ioredis `Redis` to the structural `IRedisQueueClient` the
 * queue takes: the `status` field is the driver's own (the fix reads it), and
 * `zrangebyscore` is reshaped from ioredis's `LIMIT`-token form to the
 * interface's positional clause. `quit` is the ioredis `disconnect` (a clean
 * teardown that does not flush a closed port's offline queue).
 */
function toQueueClient(raw: Redis): IRedisQueueClient {
  return {
    zadd: (key, score, member) => raw.zadd(key, score, member),
    zrangebyscore: (key, min, max, ...limitClause) =>
      limitClause.length === 3
        ? raw.zrangebyscore(key, min, max, 'LIMIT', limitClause[1], limitClause[2])
        : raw.zrangebyscore(key, min, max),
    zrem: (key, ...members) => raw.zrem(key, ...members),
    hset: (key, field, value) => raw.hset(key, field, value),
    hget: (key, field) => raw.hget(key, field),
    hdel: (key, ...fields) => raw.hdel(key, ...fields),
    del: (...keys) => raw.del(...keys),
    quit(): Promise<void> {
      raw.disconnect();
      return Promise.resolve();
    },
    ping: () => raw.ping(),
    // A getter, not a snapshot: the probe reads the driver's CURRENT state, and
    // ioredis's `status` moves (wait → connect → ready / end) over the client's
    // lifetime.
    get status() {
      return raw.status;
    },
  };
}

describe('M131a V11-10 REAL RedisQueue probe reads client status', () => {
  it(
    'live server reads up; a closed port is not ready (the fix precondition)',
    { skip: redisUrl === undefined },
    async () => {
      const url = redisUrl!.replace(/localhost/g, '127.0.0.1');
      const livePort = new URL(url).port === '' ? 6379 : Number(new URL(url).port);
      const closedPort = livePort + 1;

      // Positive control: a real ioredis client against the live server.
      const live = new Redis(url, { lazyConnect: true, maxRetriesPerRequest: 1 });
      const liveQueue = new RedisQueue({ client: toQueueClient(live) });
      try {
        await liveQueue.connect();
        const probe = liveQueue.isHealthy;
        expect(typeof probe).toBe('function');
        if (typeof probe === 'function') {
          expect(await probe()).toBe(true);
        }
        // The probe's ping connected the lazy client (status was `wait`).
        expect(live.status).toBe('ready');
      } finally {
        await liveQueue.disconnect().catch(() => undefined);
      }

      // Closed port: a real ioredis client pointed at a port that is not the
      // live one. ioredis knows it has no connection, so its `status` is not
      // `ready` — the exact state the probe short-circuits on. We do not
      // await `connect()` (it would hang on the closed port, the V11-10 bug);
      // we assert the driver's own state instead.
      const closed = new Redis(`redis://127.0.0.1:${closedPort}`, {
        lazyConnect: true,
        retryStrategy: () => null,
      });
      try {
        // Kick the connection so ioredis moves off `wait` and reports its real
        // state; `retryStrategy: () => null` makes it settle to `end` rather
        // than retry forever.
        void closed.connect().catch(() => undefined);
        const deadline = Date.now() + 5000;
        while (Date.now() < deadline && closed.status === 'wait') {
          await new Promise((r) => setTimeout(r, 50));
        }
        expect(closed.status).not.toBe('ready');
        // The closed-port client has lost its only connection attempt, so the
        // probe answers `false` at once rather than hanging on the ping.
        const closedQueue = new RedisQueue({ client: toQueueClient(closed) });
        await closedQueue.connect().catch(() => undefined);
        const probe = closedQueue.isHealthy;
        if (typeof probe === 'function') {
          const started = performance.now();
          expect(await probe()).toBe(false);
          expect(performance.now() - started).toBeLessThan(500);
        }
      } finally {
        closed.disconnect();
      }
    },
  );
});
