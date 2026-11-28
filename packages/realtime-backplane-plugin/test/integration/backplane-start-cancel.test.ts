import { afterEach, describe, expect, it, vi } from 'vitest';
import { setImmediate } from 'node:timers/promises';
import { CAPABILITIES } from '@setu-ts/common';
import type { IPlugin } from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { RealtimeBackplanePlugin } from '../../src/index.ts';
import type { IRedisBackplaneClient } from '../../src/index.ts';

function make(): IRedisBackplaneClient {
  return {
    status: 'wait',
    connect: vi.fn(() => Promise.resolve()),
    publish: () => Promise.resolve(0),
    subscribe: vi.fn(() => Promise.resolve(1)),
    unsubscribe: vi.fn(() => Promise.resolve(0)),
    on: vi.fn(),
    off: vi.fn(),
    quit: vi.fn(() => Promise.resolve()),
    disconnect: vi.fn(),
  };
}

function expectBorrowed(publisher: IRedisBackplaneClient, subscriber: IRedisBackplaneClient): void {
  for (const client of [publisher, subscriber]) {
    expect(client.quit).not.toHaveBeenCalled();
    expect(client.disconnect).not.toHaveBeenCalled();
  }
}

function expectQuit(publisher: IRedisBackplaneClient, subscriber: IRedisBackplaneClient): void {
  expect(subscriber.unsubscribe).toHaveBeenCalledExactlyOnceWith('frames');
  expect(publisher.unsubscribe).not.toHaveBeenCalled();
  for (const client of [publisher, subscriber]) {
    expect(client.quit).toHaveBeenCalledTimes(1);
    expect(client.disconnect).not.toHaveBeenCalled();
  }
}

function expectUnregistered(app: ReturnType<typeof createApplication>): void {
  expect(app.services.has(CAPABILITIES.REALTIME_BACKPLANE)).toBe(false);
  expect(app.services.has(CAPABILITIES.REALTIME_DIAGNOSTICS)).toBe(false);
  expect(
    app.services.getAll(CAPABILITIES.HEALTH_INDICATOR).map((indicator) => indicator.name),
  ).not.toContain('realtime-backplane');
}

const openCases = (['connect', 'subscribe'] as const).flatMap((operation) =>
  [0, 25].map((commandTimeoutMs) => ({ operation, commandTimeoutMs })),
);

describe('Backplane startup cleanup', () => {
  afterEach(() => vi.useRealTimers());

  it.each(openCases)(
    'stop detaches an injected pair during hung $operation with bound $commandTimeoutMs without late registration',
    async ({ operation, commandTimeoutMs }) => {
      const entered = Promise.withResolvers<void>();
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
          RealtimeBackplanePlugin({
            transport: 'redis',
            client: publisher,
            subscriber,
            commandTimeoutMs,
          }),
        ],
      });
      const start = app.start().catch((error: unknown) => error);
      await entered.promise;
      await app.stop();
      expect(await start).toMatchObject({ name: 'StartCancelledError' });
      await setImmediate();
      expectBorrowed(publisher, subscriber);
      expectUnregistered(app);
    },
  );

  it.each(openCases)(
    'leaves injected clients alone when backplane $operation fails with bound $commandTimeoutMs',
    async ({ operation, commandTimeoutMs }) => {
      const publisher = make();
      const subscriber = make();
      const failure = new Error('backplane open refused');
      vi.mocked(
        operation === 'connect' ? publisher.connect! : subscriber.subscribe,
      ).mockRejectedValue(failure);
      const later: IPlugin = {
        name: 'later-consumer',
        version: '1.0.0',
        dependencies: [CAPABILITIES.REALTIME_BACKPLANE],
        register: vi.fn(),
      };
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          RealtimeBackplanePlugin({
            transport: 'redis',
            client: publisher,
            subscriber,
            commandTimeoutMs,
          }),
          later,
        ],
      });
      await expect(app.start()).rejects.toBe(failure);
      await app.stop();
      await setImmediate();
      expect(later.register).not.toHaveBeenCalled();
      expectBorrowed(publisher, subscriber);
      expectUnregistered(app);
    },
  );

  it.each(['connect', 'subscribe'] as const)(
    'leaves injected clients alone when backplane %s times out',
    async (operation) => {
      vi.useFakeTimers();
      const entered = Promise.withResolvers<void>();
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
          RealtimeBackplanePlugin({
            transport: 'redis',
            client: publisher,
            subscriber,
            commandTimeoutMs: 25,
          }),
        ],
      });
      const result = app.start().catch((error: unknown) => error);
      await entered.promise;
      await vi.advanceTimersByTimeAsync(25);
      expect(await result).toMatchObject({ source: 'realtime-backplane-plugin: redis transport' });
      await app.stop();
      expectBorrowed(publisher, subscriber);
      expectUnregistered(app);
      expect(vi.getTimerCount()).toBe(0);
    },
  );

  it.each([0, 25])(
    'quits an opened injected pair after later registration fails with bound %s',
    async (commandTimeoutMs) => {
      const publisher = make();
      const subscriber = make();
      const failure = new Error('later registration failed');
      const later: IPlugin = {
        name: 'later-failure',
        version: '1.0.0',
        dependencies: [CAPABILITIES.REALTIME_BACKPLANE],
        register: vi.fn<IPlugin['register']>((ctx) => {
          expect(ctx.services.has(CAPABILITIES.REALTIME_BACKPLANE)).toBe(true);
          expect(subscriber.subscribe).toHaveBeenCalledExactlyOnceWith('frames');
          throw failure;
        }),
      };
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          RealtimeBackplanePlugin({
            transport: 'redis',
            client: publisher,
            subscriber,
            commandTimeoutMs,
            topic: 'frames',
          }),
          later,
        ],
      });
      await expect(app.start()).rejects.toBe(failure);
      expect(later.register).toHaveBeenCalledTimes(1);
      expectQuit(publisher, subscriber);
      await app.stop();
      expectQuit(publisher, subscriber);
    },
  );

  it.each([0, 25])(
    'quits an opened injected pair when stop cancels later registration with bound %s',
    async (commandTimeoutMs) => {
      const publisher = make();
      const subscriber = make();
      const entered = Promise.withResolvers<void>();
      const gate = Promise.withResolvers<void>();
      const later: IPlugin = {
        name: 'later-wait',
        version: '1.0.0',
        dependencies: [CAPABILITIES.REALTIME_BACKPLANE],
        register(ctx) {
          expect(ctx.services.has(CAPABILITIES.REALTIME_BACKPLANE)).toBe(true);
          entered.resolve();
          return gate.promise;
        },
      };
      const app = createApplication({
        plugins: [
          RuntimePlugin(),
          RealtimeBackplanePlugin({
            transport: 'redis',
            client: publisher,
            subscriber,
            commandTimeoutMs,
            topic: 'frames',
          }),
          later,
        ],
      });
      const start = app.start().catch((error: unknown) => error);
      try {
        await entered.promise;
        expect(subscriber.subscribe).toHaveBeenCalledExactlyOnceWith('frames');
        expectBorrowed(publisher, subscriber);
        await app.stop();
        expect(await start).toMatchObject({ name: 'StartCancelledError' });
        gate.resolve();
        await setImmediate();
        expectQuit(publisher, subscriber);
      } finally {
        gate.resolve();
        await app.stop();
      }
      expectQuit(publisher, subscriber);
    },
  );
});
