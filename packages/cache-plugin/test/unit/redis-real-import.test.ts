// deno-lint-ignore-file no-console -- guarded skip tests log SKIP messages.
/**
 * Guarded real-import test: RedisStore set→get round trip against a live Redis.
 *
 * Guard: requires REDIS_URL env and npm:ioredis@5.x presence. When either is
 * absent, logs SKIP and returns (the standard guard pattern used across this
 * repo). When present, constructs RedisStore with NO injected client so the
 * production loadIoredis → createLazyRedisClient → connect() path runs for real.
 */
import { expect } from '@std/expect';
import { describe, it } from '@std/testing/bdd';
import { RedisStore } from '../../src/stores/redis-store.ts';

describe('REAL RedisStore round trip (guarded)', () => {
  it('set → get round trip against live Redis', async () => {
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
  });
});
