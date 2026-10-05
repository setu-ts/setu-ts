/**
 * M101a: the RedisQueue Lua transitions run against a live Redis, and a
 * `reserve` whose script times out locally but is applied by the server leaves
 * the job whole in the processing set rather than in neither set.
 *
 * Guarded on `REDIS_URL` through `ignore`, so an absent backend reports the
 * suite ignored rather than passed.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RedisQueue } from '../../src/adapters/redis-queue.ts';
import type { IRedisQueueClient, StoredJob } from '../../src/interfaces/index.ts';

const url = Deno.env.get('REDIS_URL');

const job = (name: string, id: string): StoredJob<{ n: number }> => ({
  id,
  name,
  data: { n: 7 },
  attempts: 0,
  maxAttempts: 3,
  availableAtMs: 100,
});

describe('RedisQueue Lua transitions against live Redis', { ignore: url === undefined }, () => {
  it('requeues and dead-letters with retention through real scripts', async () => {
    const name = `m101a:${crypto.randomUUID()}`;
    const queue = new RedisQueue({ url: url!, deadLetterTtlMs: 60_000 });
    const { Redis } = await import('npm:ioredis@5.x');
    const inspect = new Redis(url!);
    try {
      await queue.connect();
      await queue.enqueue(job(name, 'a'));
      expect((await queue.reserve(name, 5, 100)).map((j) => j.id)).toEqual(['a']);

      await queue.requeue(name, 'a', 150, 1);
      expect(await inspect.zscore(`queue:${name}:ready`, 'a')).toBe('150');
      expect(await inspect.zcard(`queue:${name}:processing`)).toBe(0);
      const again = await queue.reserve<{ n: number }>(name, 5, 150);
      expect(again[0]).toMatchObject({ id: 'a', attempts: 1, data: { n: 7 } });

      await queue.deadLetter(name, 'a', 200);
      expect(await inspect.zrange(`queue:${name}:dead`, 0, -1)).toEqual(['a']);
      expect(await inspect.hget(`queue:${name}:jobs`, 'a')).toBeNull();
      expect(await inspect.hget(`queue:${name}:dead:jobs`, 'a')).not.toBeNull();
      expect(await inspect.ttl(`queue:${name}:dead`)).toBeGreaterThan(0);
    } finally {
      await inspect.del(
        `queue:${name}:ready`,
        `queue:${name}:processing`,
        `queue:${name}:dead`,
        `queue:${name}:jobs`,
        `queue:${name}:dead:jobs`,
      );
      inspect.disconnect();
      await queue.disconnect();
    }
  });

  it('a reserve script applied after a local timeout leaves the job in processing', async () => {
    const name = `m101a:${crypto.randomUUID()}`;
    const { Redis } = await import('npm:ioredis@5.x');
    const real = new Redis(url!, { lazyConnect: true });
    let armed = false;
    // The server runs the script; the client then reports a timeout, as
    // `commandTimeout` does when the server answers too late.
    const client = new Proxy(real, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver);
        if (prop === 'eval' && typeof value === 'function') {
          return async (...args: unknown[]) => {
            const result = await value.apply(target, args);
            if (armed) {
              armed = false;
              throw new Error('Command timed out');
            }
            return result;
          };
        }
        return typeof value === 'function' ? value.bind(target) : value;
      },
    }) as unknown as IRedisQueueClient;
    const queue = new RedisQueue({ client });
    try {
      await queue.connect();
      await queue.enqueue(job(name, 'b'));
      armed = true;
      await expect(queue.reserve(name, 5, 100)).rejects.toThrow('Command timed out');
      expect(await real.zcard(`queue:${name}:ready`)).toBe(0);
      expect(await real.zrange(`queue:${name}:processing`, 0, -1)).toEqual(['b']);
      expect(await real.hget(`queue:${name}:jobs`, 'b')).not.toBeNull();
    } finally {
      await real.del(`queue:${name}:ready`, `queue:${name}:processing`, `queue:${name}:jobs`);
      await queue.disconnect();
    }
  });
});
