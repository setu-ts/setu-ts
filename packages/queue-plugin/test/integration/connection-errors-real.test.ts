/**
 * REAL Redis: a stopped server's connection errors reach the logger — never
 * the console, where `ioredis` writes an `'error'` event nothing listens to.
 *
 * Driven through `QueuePlugin` in a real kernel app, so what is proven is the
 * plugin's own wiring, not a hand-built adapter. Guarded on `REDIS_URL`.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createConnectionErrorReporter } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { QueuePlugin } from '../../src/index.ts';
import type { QueuePluginOptions } from '../../src/index.ts';
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
} from '../../../common/test/fixtures/redis-clients.ts';

describe.each(REDIS_CLIENTS)('%s', (redisVariant) => {
  describe('REAL Redis queue adapter: connection errors', () => {
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
          source: 'queue-plugin: redis adapter',
          start: async () => {
            app = createApplication({
              plugins: [
                RuntimePlugin(),
                loggerPlugin(logger),
                QueuePlugin({
                  adapter: 'redis',
                  ...redisOptions(
                    redisVariant,
                    redisUrl(),
                    15000,
                    createConnectionErrorReporter({
                      source: 'queue-plugin: redis adapter',
                      logger: () => logger,
                    }),
                  ),
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
        const injected = client as unknown as NonNullable<QueuePluginOptions['client']>;
        const before = handle.listenerCount();
        const app = createApplication({
          plugins: [
            RuntimePlugin(),
            loggerPlugin(new RecordingLogger()),
            QueuePlugin({ adapter: 'redis', client: injected }),
          ],
        });
        try {
          await app.start();
          expect(handle.listenerCount()).toBe(before);
        } finally {
          await app.stop();
          handle.disconnect();
        }
      },
    );
  });
});
