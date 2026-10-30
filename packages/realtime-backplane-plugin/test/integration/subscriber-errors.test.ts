import { setImmediate } from 'node:timers/promises';
import { describe, expect, it, vi } from 'vitest';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { IRealtimeBackplane, RealtimeFrame } from '@setu-ts/common';
import { MemoryBackplane, RealtimeBackplanePlugin } from '../../src/index.ts';
import {
  loggerPlugin,
  RecordingLogger,
} from '../../../common/test/fixtures/redis-connection-errors.ts';

describe('plugin subscriber failure reporting', () => {
  for (const useHook of [false, true]) {
    it(`captures real memory transport async rejections through the plugin (${useHook ? 'hook' : 'logger'})`, async () => {
      const logger = new RecordingLogger();
      const hook = vi.fn();
      const bus = `subscriber-${useHook}`;
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          loggerPlugin(logger),
          RealtimeBackplanePlugin({
            transport: 'memory',
            bus,
            localNotice: false,
            ...(useHook ? { onHandlerError: hook } : {}),
          }),
        ],
      });
      const sender = new MemoryBackplane('sender', bus);
      const unhandled: unknown[] = [];
      const listener = (error: unknown): void => {
        unhandled.push(error);
      };
      process.on('unhandledRejection', listener);
      try {
        await app.start();
        await sender.connect();
        const receiver = app.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE);
        const error = new Error('async\r\nsubscriber');
        await receiver.subscribe(async () => {
          await Promise.resolve();
          throw error;
        });
        const healthy = vi.fn();
        await receiver.subscribe(healthy);
        const frame: RealtimeFrame = {
          kind: 'sse-channel',
          origin: 'sender',
          name: 'updates',
          data: 'secret',
        };
        await sender.publish(frame);
        await sender.publish(frame);
        await setImmediate();
        expect(unhandled).toEqual([]);
        expect(healthy).toHaveBeenCalledTimes(2);
        expect((receiver as MemoryBackplane).handlerErrors).toEqual([error, error]);
        if (useHook) {
          expect(hook.mock.calls).toEqual([
            [error, frame],
            [error, frame],
          ]);
          expect(logger.entries.filter((entry) => entry.message.includes('subscriber'))).toEqual(
            [],
          );
        } else {
          expect(logger.entries.map((entry) => entry.level)).toContain('warn');
          expect(
            logger.entries.some(
              (entry) => entry.level === 'debug' && entry.metadata?.['repeats'] === 1,
            ),
          ).toBe(true);
          expect(logger.entries.find((entry) => entry.level === 'warn')?.message).toContain(
            'Error: async subscriber',
          );
        }
      } finally {
        await sender.close();
        await app.stop();
        process.off('unhandledRejection', listener);
      }
    });
  }
});
