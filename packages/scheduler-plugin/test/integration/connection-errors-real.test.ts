/**
 * REAL Redis: a stopped server's connection errors reach the logger — never
 * the console, where `ioredis` writes an `'error'` event nothing listens to.
 *
 * Driven through `SchedulerPlugin` in a real kernel app, so what is proven is the
 * plugin's own wiring, not a hand-built lock. Guarded on `REDIS_URL`.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { createConnectionErrorReporter } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { SchedulerPlugin } from '../../src/index.ts';
import type { IRedisLockClient } from '../../src/index.ts';
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
  describe('REAL Redis scheduler lock: connection errors', () => {
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
          source: 'scheduler-plugin: redis lock',
          start: async () => {
            const options = redisOptions(
              redisVariant,
              redisUrl(),
              5000,
              createConnectionErrorReporter({
                source: 'scheduler-plugin: redis lock',
                logger: () => logger,
              }),
            );
            // With no jobs registered this scenario sends no commands; open
            // the caller-owned lazy client before stopping its server.
            if ('client' in options) await options.client.connect();
            app = createApplication({
              plugins: [
                RuntimePlugin(),
                loggerPlugin(logger),
                SchedulerPlugin({
                  distributedLock: {
                    enabled: true,
                    storage: 'redis',
                    ...options,
                  },
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
        const injected = client as unknown as IRedisLockClient;
        const before = handle.listenerCount();
        const app = createApplication({
          plugins: [
            RuntimePlugin(),
            loggerPlugin(new RecordingLogger()),
            SchedulerPlugin({
              distributedLock: { enabled: true, storage: 'redis', client: injected },
            }),
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
