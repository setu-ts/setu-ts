/**
 * Guarded real-import test: RedisStore set→get round trip against a live Redis.
 *
 * Guard: requires REDIS_URL env and npm:ioredis@5.x presence. When either is
 * absent, logs SKIP and returns (the standard guard pattern used across this
 * repo). When present, constructs RedisStore with NO injected client so the
 * production loadIoredis → createLazyRedisClient → connect() path runs for real.
 */
import { describe, expect, it } from 'vitest';
import { RedisStore } from '../../src/stores/redis-store.ts';

describe('REAL RedisStore round trip (guarded)', () => {
  it(
    'set → get round trip against live Redis',
    { skip: process.env['REDIS_URL'] === undefined },
    async () => {
      const url = process.env['REDIS_URL'];
      if (url === undefined) throw new Error('Backend guard failed');

      await import('ioredis');

      const prefix = `m53:${crypto.randomUUID()}:`;
      const store = new RedisStore(prefix, { url });

      try {
        await store.connect();
        expect(store.isReady()).toBe(true);

        await store.set('key', 'value');
        const result = await store.get<string>('key');
        expect(result).toBe('value');
      } finally {
        await store.disconnect();
      }
    },
  );
});
