/**
 * REAL Redis: a stopped server's connection errors reach the logger — never
 * the console, where `ioredis` writes an `'error'` event nothing listens to.
 *
 * Driven through `RealtimeBackplanePlugin` in a real kernel app, so what is proven is the
 * plugin's own wiring, not a hand-built transport. Guarded on `REDIS_URL`.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { Redis } from 'npm:ioredis@5.x';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { RealtimeBackplanePlugin } from '../../src/index.ts';
import type { IRedisBackplaneClient } from '../../src/index.ts';
import {
  expectOutageRoutedToLogger,
  loggerPlugin,
  RecordingLogger,
  REDIS_URL,
  redisUrl,
} from '../../../common/test/fixtures/redis-connection-errors.ts';

describe('REAL Redis backplane transport: connection errors', () => {
  it('route to the logger, de-duplicated, and never to the console', {
    ignore: REDIS_URL === undefined,
  }, async () => {
    const logger = new RecordingLogger();
    let app: IKernelApplication | undefined;
    await expectOutageRoutedToLogger({
      logger,
      source: 'realtime-backplane-plugin: redis transport',
      start: async () => {
        app = createApplication({
          plugins: [
            RuntimePlugin(),
            loggerPlugin(logger),
            RealtimeBackplanePlugin({ transport: 'redis', url: redisUrl() }),
          ],
        });
        await app.start();
      },
      stop: async () => {
        await app?.stop();
      },
    });
  });

  it('attaches no listener to an injected client', {
    ignore: REDIS_URL === undefined,
  }, async () => {
    const client = new Redis(redisUrl(), { lazyConnect: true });
    const injected = client as unknown as IRedisBackplaneClient;
    const subscriberClient = new Redis(redisUrl(), { lazyConnect: true });
    const subscriber = subscriberClient as unknown as IRedisBackplaneClient;
    const before = client.listenerCount('error');
    const subscriberBefore = subscriberClient.listenerCount('error');
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        loggerPlugin(new RecordingLogger()),
        RealtimeBackplanePlugin({ transport: 'redis', client: injected, subscriber }),
      ],
    });
    try {
      await app.start();
      expect(client.listenerCount('error')).toBe(before);
      expect(subscriberClient.listenerCount('error')).toBe(subscriberBefore);
    } finally {
      await app.stop();
      client.disconnect();
      subscriberClient.disconnect();
    }
  });
});
