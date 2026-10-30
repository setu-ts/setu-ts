import { describe, expect, it } from 'vitest';
import { RedisQueue } from '../../src/index.ts';
import { REDIS_CLIENTS, redisOptions } from '../../../common/test/fixtures/redis-clients.ts';

describe.each(REDIS_CLIENTS)('%s', (redisVariant) => {
  describe('Redis namespace isolation', { skip: process.env['REDIS_URL'] === undefined }, () => {
    it('isolates two applications with one job name on real Redis', async () => {
      const url = process.env['REDIS_URL']!;
      const { Redis } = await import('ioredis');
      const client = new Redis(url);
      const id = crypto.randomUUID();
      const prefixes = [`m113c:${id}:one:`, `m113c:${id}:two:`];
      const queues = prefixes.map(
        (keyPrefix) => new RedisQueue({ ...redisOptions(redisVariant, url), keyPrefix }),
      );
      try {
        for (const queue of queues) await queue.connect();
        for (let i = 0; i < queues.length; i++)
          await queues[i].enqueue({
            id: `${i}`,
            name: 'email',
            data: { app: i },
            attempts: 0,
            maxAttempts: 3,
            availableAtMs: 0,
          });
        expect((await queues[0].reserve('email', 10, 0)).map((job) => job.id)).toEqual(['0']);
        expect((await queues[1].reserve('email', 10, 0)).map((job) => job.id)).toEqual(['1']);
      } finally {
        for (const queue of queues) await queue.disconnect();
        const keys = (
          await Promise.all(prefixes.map((prefix) => client.keys(`${prefix}*`)))
        ).flat();
        if (keys.length > 0) await client.del(...keys);
        await client.quit();
      }
    });
  });
});
