/**
 * REAL Redis: a stopped server's connection errors reach the logger — never
 * the console, where `ioredis` writes an `'error'` event nothing listens to.
 *
 * Driven through `RealtimeBackplanePlugin` in a real kernel app, so what is proven is the
 * plugin's own wiring, not a hand-built transport. Guarded on `REDIS_URL`.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createConnectionErrorReporter } from '@setu-ts/common';
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
import {
  REDIS_CLIENTS,
  redisOptions,
  injectedRedis,
  nodeClient,
} from '../../../common/test/fixtures/redis-clients.ts';

describe.each(REDIS_CLIENTS)('%s', (redisVariant) => {
  describe('REAL Redis backplane transport: connection errors', () => {
    it(
      'route to the logger, de-duplicated, and never to the console',
      {
        skip: REDIS_URL === undefined,
      },
      async () => {
        const logger = new RecordingLogger();
        let app: IKernelApplication | undefined;
        await expectOutageRoutedToLogger({
          logger,
          source: 'realtime-backplane-plugin: redis transport',
          start: async () => {
            const reporter = createConnectionErrorReporter({
              source: 'realtime-backplane-plugin: redis transport',
              logger: () => logger,
            });
            app = createApplication({
              plugins: [
                RuntimePlugin(),
                loggerPlugin(logger),
                RealtimeBackplanePlugin({
                  transport: 'redis',
                  ...redisOptions(redisVariant, redisUrl(), 15000, reporter),
                  ...(redisVariant === 'ioredis'
                    ? {}
                    : { subscriber: nodeClient(redisVariant, redisUrl(), 15000, reporter) }),
                }),
              ],
            });
            await app.start();
          },
          stop: async () => {
            await app?.stop();
          },
        });
      },
    );

    it(
      'attaches no listener to an injected client',
      {
        skip: REDIS_URL === undefined,
      },
      async () => {
        const handle = injectedRedis(redisVariant, redisUrl());
        const client = handle.client;
        const injected = client as unknown as IRedisBackplaneClient;
        const subscriberHandle = injectedRedis(redisVariant, redisUrl());
        const subscriberClient = subscriberHandle.client;
        const subscriber = subscriberClient as unknown as IRedisBackplaneClient;
        const before = handle.listenerCount();
        const subscriberBefore = subscriberHandle.listenerCount();
        const app = createApplication({
          plugins: [
            RuntimePlugin(),
            loggerPlugin(new RecordingLogger()),
            RealtimeBackplanePlugin({ transport: 'redis', client: injected, subscriber }),
          ],
        });
        try {
          await app.start();
          expect(handle.listenerCount()).toBe(before);
          expect(subscriberHandle.listenerCount()).toBe(subscriberBefore);
        } finally {
          await app.stop();
          handle.disconnect();
          subscriberHandle.disconnect();
        }
      },
    );
  });
});
