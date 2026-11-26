import { describe, expect, it, vi } from 'vitest';
import { BackendUnavailableError } from '@setu-ts/common';
import { RedisBackplane } from '../../src/transports/redis-backplane.ts';
import type { IRedisBackplaneClient } from '../../src/interfaces/index.ts';

function client(): IRedisBackplaneClient {
  return {
    status: 'wait',
    connect: vi.fn(async () => {}),
    publish: () => Promise.resolve(0),
    subscribe: vi.fn(() => Promise.resolve(1)),
    unsubscribe: vi.fn(() => Promise.resolve(0)),
    on: vi.fn(),
    off: vi.fn(),
    quit: vi.fn(async () => {}),
    disconnect: vi.fn(),
  };
}
describe('Injected Redis pair connect', () => {
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
      await vi.advanceTimersByTimeAsync(1);
      const error = await result;
      expect(error).toBeInstanceOf(BackendUnavailableError);
      expect(error).toMatchObject({
        source: 'realtime-backplane-plugin: redis transport',
        cause: { message: expect.stringContaining('injected client pair') },
      });
      await backplane.close();
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
        expect(publisher.disconnect).toHaveBeenCalledOnce();
        expect(subscriber.disconnect).toHaveBeenCalledOnce();
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
    vi.useRealTimers();
  });
});
