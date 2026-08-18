import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRedisQueueClient } from '../../../src/interfaces/index.ts';
import { RedisQueue } from '../../../src/adapters/redis-queue.ts';

function makeClient(ping?: () => Promise<unknown>): IRedisQueueClient {
  const client: Record<string, unknown> = {
    zadd: () => Promise.resolve(1),
    zrangebyscore: () => Promise.resolve([]),
    zrem: () => Promise.resolve(0),
    hset: () => Promise.resolve(1),
    hget: () => Promise.resolve(null),
    hdel: () => Promise.resolve(0),
    del: () => Promise.resolve(0),
    quit: () => Promise.resolve(),
  };
  if (ping !== undefined) {
    client.ping = ping;
  }
  return client as unknown as IRedisQueueClient;
}

/**
 * An ioredis-shaped client whose `ping` is a method reading `this.options`,
 * exactly like the real ioredis. An unbound call throws
 * `TypeError: Cannot read properties of undefined (reading 'options')` — the
 * M70c defect that made `isHealthy()` report `false` forever against a
 * healthy server.
 */
function makeIoredisShapedClient(): IRedisQueueClient {
  const client = {
    zadd: () => Promise.resolve(1),
    zrangebyscore: () => Promise.resolve([]),
    zrem: () => Promise.resolve(0),
    hset: () => Promise.resolve(1),
    hget: () => Promise.resolve(null),
    hdel: () => Promise.resolve(0),
    del: () => Promise.resolve(0),
    quit: () => Promise.resolve(),
    options: { lazyConnect: false },
    ping() {
      // Unbound (`this === undefined` in strict mode) → TypeError, as ioredis does.
      void this.options;
      return Promise.resolve('PONG');
    },
  };
  return client as unknown as IRedisQueueClient;
}

describe('RedisQueue health (M70c)', () => {
  it('M70c regression: an ioredis-shaped `ping` that reads `this` still reports reachable', async () => {
    // ioredis `ping` reads `this.options`; an unbound call throws TypeError and
    // `isHealthy()` would report `false` forever against a healthy server.
    const queue = new RedisQueue({ client: makeIoredisShapedClient() });
    await queue.connect();
    const probe = queue.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(true);
    }
  });

  it('is reachable when client.ping() resolves', async () => {
    const queue = new RedisQueue({ client: makeClient(() => Promise.resolve('PONG')) });
    await queue.connect();
    const probe = queue.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(true);
    }
  });

  it('is unreachable when client.ping() rejects', async () => {
    const queue = new RedisQueue({
      client: makeClient(() => Promise.reject(new Error('ECONNREFUSED'))),
    });
    await queue.connect();
    const probe = queue.isHealthy;
    expect(typeof probe).toBe('function');
    if (typeof probe === 'function') {
      expect(await probe()).toBe(false);
    }
  });

  it('reports unknown (absent isHealthy) when the client has no ping()', async () => {
    // Asserted through the WIDENED IRedisQueueClient: a fake that does not
    // implement ping() must report unknown, not pass vacuously (M53 zrangebyscore
    // class).
    const queue = new RedisQueue({ client: makeClient() });
    await queue.connect();
    expect(queue.isHealthy).toBeUndefined();
  });

  it('reports unknown after disconnect', async () => {
    const queue = new RedisQueue({ client: makeClient(() => Promise.resolve('PONG')) });
    await queue.connect();
    expect(typeof queue.isHealthy).toBe('function');
    await queue.disconnect();
    expect(queue.isHealthy).toBeUndefined();
  });
});
