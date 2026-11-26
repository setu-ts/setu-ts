import { describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { CAPABILITIES } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { RealtimeBackplanePlugin } from '../../src/index.ts';
import type { IRedisBackplaneClient } from '../../src/index.ts';

describe('Backplane cancelled startup', () => {
  it.each(['connect', 'subscribe'] as const)(
    'stop detaches an injected pair during hung %s without late registration',
    async (operation) => {
      const entered = Promise.withResolvers<void>();
      const make = (): IRedisBackplaneClient => ({
        status: 'wait',
        connect: vi.fn(async () => {}),
        publish: () => Promise.resolve(0),
        subscribe: vi.fn(() => Promise.resolve(1)),
        unsubscribe: () => Promise.resolve(0),
        on: vi.fn(),
        off: vi.fn(),
        quit: vi.fn(async () => {}),
        disconnect: vi.fn(),
      });
      const publisher = make();
      const subscriber = make();
      vi.mocked(
        operation === 'connect' ? publisher.connect! : subscriber.subscribe,
      ).mockImplementation(() => {
        entered.resolve();
        return new Promise(() => {});
      });
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          RealtimeBackplanePlugin({ transport: 'redis', client: publisher, subscriber }),
        ],
      });
      const start = app.start().catch((error: unknown) => error);
      await entered.promise;
      await app.stop();
      expect(await start).toMatchObject({ name: 'StartCancelledError' });
      await setImmediate();
      expect(publisher.disconnect).not.toHaveBeenCalled();
      expect(subscriber.disconnect).not.toHaveBeenCalled();
      expect(publisher.quit).not.toHaveBeenCalled();
      expect(subscriber.quit).not.toHaveBeenCalled();
      expect(app.services.has(CAPABILITIES.REALTIME_BACKPLANE)).toBe(false);
      expect(app.services.has(CAPABILITIES.REALTIME_DIAGNOSTICS)).toBe(false);
      expect(
        app.services.getAll(CAPABILITIES.HEALTH_INDICATOR).map((indicator) => indicator.name),
      ).not.toContain('realtime-backplane');
    },
  );
});
