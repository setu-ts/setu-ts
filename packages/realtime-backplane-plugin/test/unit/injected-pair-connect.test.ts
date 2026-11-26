import { afterEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import { BackendUnavailableError } from '@setu-ts/common';
import { RedisBackplane } from '../../src/transports/redis-backplane.ts';
import type { IRedisBackplaneClient } from '../../src/interfaces/index.ts';

function client(): IRedisBackplaneClient & { listenerCount(event: string): number } {
  return Object.assign(new EventEmitter(), {
    status: 'wait',
    connect: vi.fn(async () => {}),
    publish: () => Promise.resolve(0),
    subscribe: vi.fn(() => Promise.resolve(1)),
    unsubscribe: vi.fn(() => Promise.resolve(0)),
    quit: vi.fn(async () => {}),
    disconnect: vi.fn(),
  });
}
describe('Injected Redis pair connect', () => {
  afterEach(() => vi.useRealTimers());
  function assertDetached(...clients: ReturnType<typeof client>[]): void {
    for (const connection of clients) {
      for (const event of ['message', 'error', 'ready', 'end'])
        expect(connection.listenerCount(event)).toBe(0);
    }
  }
  function assertBorrowed(...clients: ReturnType<typeof client>[]): void {
    assertDetached(...clients);
    for (const connection of clients) {
      expect(connection.quit).not.toHaveBeenCalled();
      expect(connection.disconnect).not.toHaveBeenCalled();
    }
  }
  it('preserves the successor subscription while a cancelled injected open retires', async () => {
    const publisher = Object.assign(client(), { status: 'ready' });
    const subscriber = Object.assign(client(), { status: 'ready' });
    const gate = Promise.withResolvers<number>();
    let subscribed = false;
    vi.mocked(subscriber.subscribe).mockImplementation(() => {
      subscribed = true;
      return gate.promise;
    });
    vi.mocked(subscriber.unsubscribe).mockImplementation(() => {
      subscribed = false;
      return Promise.resolve(0);
    });
    const backplane = new RedisBackplane(
      { transport: 'redis', client: publisher, subscriber, commandTimeoutMs: 250 },
      'origin',
      'frames',
    );
    const old = backplane.connect();
    expect(subscriber.subscribe).toHaveBeenCalledTimes(1);
    expect(subscribed).toBe(true);
    gate.resolve(1);
    // SUBSCRIBE wins its cancellation race before the old open resumes.
    await Promise.resolve();
    const closing = backplane.close();
    const next = backplane.connect();
    await Promise.all([old, closing, next]);
    expect(subscriber.subscribe).toHaveBeenCalledTimes(2);
    expect(subscribed).toBe(true);
    expect(subscriber.unsubscribe).not.toHaveBeenCalled();
    expect(subscriber.listenerCount('message')).toBe(1);
    for (const connection of [publisher, subscriber]) {
      expect(connection.listenerCount('error')).toBe(1);
      expect(connection.listenerCount('ready')).toBe(1);
      expect(connection.quit).not.toHaveBeenCalled();
      expect(connection.disconnect).not.toHaveBeenCalled();
    }
    await backplane.close();
    expect(subscribed).toBe(false);
    expect(subscriber.unsubscribe).toHaveBeenCalledTimes(1);
    assertDetached(publisher, subscriber);
    for (const connection of [publisher, subscriber]) {
      expect(connection.quit).toHaveBeenCalledTimes(1);
      expect(connection.disconnect).not.toHaveBeenCalled();
    }
  });
  it.each(['unsubscribe', 'quit'] as const)(
    'attempts every injected close step after %s fails, keeping watches until cleanup ends',
    async (firstFailure) => {
      const publisher = Object.assign(client(), { status: 'ready' });
      const subscriber = Object.assign(client(), { status: 'ready' });
      const backplane = new RedisBackplane(
        { transport: 'redis', client: publisher, subscriber },
        'origin',
        'frames',
      );
      await backplane.connect();
      const steps: string[] = [];
      const unsubscribeError = new Error('unsubscribe refused');
      const quitError = new Error('subscriber quit refused');
      const record = (step: string): void => {
        steps.push(step);
        expect(subscriber.listenerCount('message')).toBe(0);
        for (const connection of [publisher, subscriber]) {
          expect(connection.listenerCount('error')).toBe(1);
          expect(connection.listenerCount('ready')).toBe(1);
        }
      };
      vi.mocked(subscriber.unsubscribe).mockImplementation(() => {
        record('unsubscribe');
        return firstFailure === 'unsubscribe'
          ? Promise.reject(unsubscribeError)
          : Promise.resolve(0);
      });
      for (const [name, connection] of [
        ['subscriber', subscriber],
        ['publisher', publisher],
      ] as const) {
        vi.mocked(connection.quit).mockImplementation(() => {
          record(`${name} quit`);
          return Promise.reject(
            name === 'subscriber' ? quitError : new Error('publisher quit refused'),
          );
        });
        vi.mocked(connection.disconnect!).mockImplementation(() => {
          record(`${name} disconnect`);
          throw new Error(`${name} disconnect refused`);
        });
      }
      await expect(backplane.close()).rejects.toBe(
        firstFailure === 'unsubscribe' ? unsubscribeError : quitError,
      );
      expect(steps).toEqual([
        'unsubscribe',
        'subscriber quit',
        'subscriber disconnect',
        'publisher quit',
        'publisher disconnect',
      ]);
      assertDetached(publisher, subscriber);
      for (const connection of [publisher, subscriber]) {
        expect(connection.quit).toHaveBeenCalledTimes(1);
        expect(connection.disconnect).toHaveBeenCalledTimes(1);
      }
    },
  );
  it.each(['connect', 'subscribe'] as const)(
    'detaches watches after a failed %s',
    async (operation) => {
      const publisher = client();
      const subscriber = client();
      vi.mocked(
        operation === 'connect' ? publisher.connect! : subscriber.subscribe,
      ).mockRejectedValue(new Error('refused'));
      const backplane = new RedisBackplane(
        { transport: 'redis', client: publisher, subscriber },
        'origin',
        'frames',
      );
      await expect(backplane.connect()).rejects.toThrow('refused');
      assertBorrowed(publisher, subscriber);
      await backplane.close();
      assertBorrowed(publisher, subscriber);
    },
  );
  it.each([
    { operation: 'connect', timeout: 25 },
    { operation: 'subscribe', timeout: 25 },
    { operation: 'connect', timeout: undefined },
    { operation: 'subscribe', timeout: undefined },
  ] as const)(
    'bounds a hung $operation at $timeout and removes its listeners',
    async ({ operation, timeout }) => {
      vi.useFakeTimers();
      const publisher = client();
      const subscriber = client();
      vi.mocked(
        operation === 'connect' ? publisher.connect! : subscriber.subscribe,
      ).mockReturnValue(new Promise(() => {}));
      const backplane = new RedisBackplane(
        {
          transport: 'redis',
          client: publisher,
          subscriber,
          ...(timeout === undefined ? {} : { commandTimeoutMs: timeout }),
        },
        'origin',
        'frames',
      );
      const result = backplane.connect().catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync((timeout ?? 15000) - 1);
      let settled = false;
      void result.then(() => {
        settled = true;
      });
      expect(settled).toBe(false);
      for (const connection of [publisher, subscriber]) {
        expect(connection.listenerCount('error')).toBe(1);
        expect(connection.listenerCount('ready')).toBe(1);
      }
      expect(subscriber.listenerCount('message')).toBe(operation === 'subscribe' ? 1 : 0);
      await vi.advanceTimersByTimeAsync(1);
      const error = await result;
      expect(error).toBeInstanceOf(BackendUnavailableError);
      expect(error).toMatchObject({
        source: 'realtime-backplane-plugin: redis transport',
        cause: { message: expect.stringContaining('injected client pair') },
      });
      assertBorrowed(publisher, subscriber);
      await backplane.close();
      assertBorrowed(publisher, subscriber);
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    },
  );
  it.each(['connect', 'subscribe'] as const)(
    'close cancels a hung %s with zero or finite bounds',
    async (operation) => {
      vi.useFakeTimers();
      for (const commandTimeoutMs of [0, 250]) {
        const publisher = client();
        const subscriber = client();
        vi.mocked(
          operation === 'connect' ? publisher.connect! : subscriber.subscribe,
        ).mockReturnValue(new Promise(() => {}));
        const backplane = new RedisBackplane(
          { transport: 'redis', client: publisher, subscriber, commandTimeoutMs },
          'origin',
          'frames',
        );
        let settled = false;
        const opening = backplane.connect().then(() => {
          settled = true;
        });
        await vi.advanceTimersByTimeAsync(commandTimeoutMs === 0 ? 20000 : 1);
        expect(settled).toBe(false);
        await backplane.close();
        await opening;
        assertBorrowed(publisher, subscriber);
      }
      expect(vi.getTimerCount()).toBe(0);
      vi.useRealTimers();
    },
  );
  it('uses one deadline for both connects and first subscribe', async () => {
    vi.useFakeTimers();
    const publisher = client();
    const subscriber = client();
    const gate = Promise.withResolvers<void>();
    vi.mocked(publisher.connect!).mockReturnValue(gate.promise);
    vi.mocked(subscriber.subscribe).mockReturnValue(new Promise(() => {}));
    const backplane = new RedisBackplane(
      { transport: 'redis', client: publisher, subscriber, commandTimeoutMs: 25 },
      'origin',
      'frames',
    );
    const result = backplane.connect().catch((error: unknown) => error);
    await vi.advanceTimersByTimeAsync(20);
    gate.resolve();
    await vi.advanceTimersByTimeAsync(5);
    expect(await result).toBeInstanceOf(BackendUnavailableError);
    await backplane.close();
    assertBorrowed(publisher, subscriber);
    vi.useRealTimers();
  });
});
