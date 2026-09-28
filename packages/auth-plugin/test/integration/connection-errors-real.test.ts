/**
 * REAL Redis: a stopped server's connection errors reach the logger — never
 * the console, where `ioredis` writes an `'error'` event nothing listens to.
 *
 * `RedisRateLimitStore` is constructed by the application, not by a plugin,
 * so the reporter here is the one an application builds from
 * `@setu-ts/common` — the documented usage. Guarded on `REDIS_URL`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Redis } from 'npm:ioredis@5.x';
import { createConnectionErrorReporter } from '@setu-ts/common';
import { createRuntimeServices } from '@setu-ts/runtime';
import { RedisRateLimitStore } from '../../src/index.ts';
import type { IRateLimitRedisClient } from '../../src/stores/redis-rate-limit-store.ts';
import {
  expectOutageRoutedToLogger,
  RecordingLogger,
  REDIS_URL,
  redisUrl,
} from '../../../common/test/fixtures/redis-connection-errors.ts';

const SOURCE = 'app: rate limit store';

describe('REAL Redis rate-limit store: connection errors', () => {
  it('route to the supplied reporter, de-duplicated, and never to the console', {
    ignore: REDIS_URL === undefined,
  }, async () => {
    const logger = new RecordingLogger();
    let store: RedisRateLimitStore | undefined;
    await expectOutageRoutedToLogger({
      logger,
      source: SOURCE,
      start: async () => {
        store = new RedisRateLimitStore({
          url: redisUrl(),
          runtime: createRuntimeServices(),
          keyPrefix: `conn-errors-${crypto.randomUUID()}:`,
          connectionErrorReporter: createConnectionErrorReporter({
            source: SOURCE,
            logger: () => logger,
          }),
        });
        // The client is built on first use.
        await store.increment('probe', 60_000);
      },
      stop: async () => {
        // QUIT against a server that just restarted may still be reconnecting;
        // the store is discarded either way.
        await store?.disconnect().catch(() => undefined);
      },
    });
  });

  it('attaches no listener to an injected client', {
    ignore: REDIS_URL === undefined,
  }, async () => {
    const client = new Redis(redisUrl(), { lazyConnect: true });
    const before = client.listenerCount('error');
    const store = new RedisRateLimitStore({
      client: client as unknown as IRateLimitRedisClient,
      runtime: createRuntimeServices(),
      keyPrefix: `conn-errors-${crypto.randomUUID()}:`,
      connectionErrorReporter: createConnectionErrorReporter({
        source: SOURCE,
        logger: () => new RecordingLogger(),
      }),
    });
    try {
      await store.increment('probe', 60_000);
      expect(client.listenerCount('error')).toBe(before);
    } finally {
      await store.disconnect();
    }
  });
});
