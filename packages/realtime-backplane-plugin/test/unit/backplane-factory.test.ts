/**
 * Tests for the transport factory's union dispatch.
 *
 * @module
 */

import { describe, expect, it, vi } from 'vitest';
import type { IMessageBroker, IRealtimeBackplane, IServiceRegistry } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import { createBackplane } from '../../src/transports/backplane-factory.ts';
import { MemoryBackplane } from '../../src/transports/memory-backplane.ts';
import { MessagingBackplane } from '../../src/transports/messaging-backplane.ts';
import { RedisBackplane } from '../../src/transports/redis-backplane.ts';
import type { IRedisBackplaneClient } from '../../src/interfaces/index.ts';

/** A registry fake holding a fixed token → service map. */
function registryWith(entries: Record<string, unknown>): IServiceRegistry {
  return {
    has: (token: string): boolean => token in entries,
    get: <T>(token: string): T => {
      if (!(token in entries)) {
        throw new Error(`no service for ${token}`);
      }
      return entries[token] as T;
    },
    getAll: <T>(token: string): readonly T[] => (token in entries ? [entries[token] as T] : []),
    register: (): void => {},
    registerFactory: (): void => {},
    unregister: (): boolean => false,
  } as unknown as IServiceRegistry;
}

const EMPTY = registryWith({});

/** A minimal client pair for the redis arm. */
function redisClient(): IRedisBackplaneClient {
  return {
    publish: (): Promise<number> => Promise.resolve(1),
    subscribe: (): Promise<unknown> => Promise.resolve(1),
    unsubscribe: (): Promise<unknown> => Promise.resolve(0),
    on: (): void => {},
    off: (): void => {},
    quit: (): Promise<unknown> => Promise.resolve('OK'),
  };
}

describe('createBackplane', () => {
  it('builds a MemoryBackplane for the memory arm', () => {
    const backplane = createBackplane({ transport: 'memory' }, EMPTY, 'generated');
    expect(backplane).toBeInstanceOf(MemoryBackplane);
    expect(backplane.origin).toBe('generated');
  });

  it('defaults to memory when no transport is named', () => {
    expect(createBackplane({}, EMPTY, 'generated')).toBeInstanceOf(MemoryBackplane);
  });

  it('prefers a configured origin over the generated one', () => {
    const backplane = createBackplane(
      { transport: 'memory', origin: 'fixed-origin' },
      EMPTY,
      'generated',
    );
    expect(backplane.origin).toBe('fixed-origin');
  });

  it('builds a MessagingBackplane over the registered broker', () => {
    const broker = { publish: () => Promise.resolve() } as unknown as IMessageBroker;
    const registry = registryWith({ [CAPABILITIES.MESSAGING]: broker });
    expect(createBackplane({ transport: 'messaging' }, registry, 'node-a')).toBeInstanceOf(
      MessagingBackplane,
    );
  });

  it('throws at registration when the messaging arm has no broker', () => {
    // Fails fast rather than per request, matching the notification plugin's
    // rule for a channel configured without its backing capability.
    expect(() => createBackplane({ transport: 'messaging' }, EMPTY, 'node-a')).toThrow(
      /requires a plugin providing 'messaging'/,
    );
  });

  it('builds a RedisBackplane for the redis arm', () => {
    const backplane = createBackplane(
      { transport: 'redis', client: redisClient(), subscriber: redisClient() },
      EMPTY,
      'node-a',
    );
    expect(backplane).toBeInstanceOf(RedisBackplane);
  });

  it('returns a custom instance untouched, ignoring topic and origin', () => {
    const instance = { origin: 'custom-origin' } as unknown as IRealtimeBackplane;
    const built = createBackplane({ transport: 'custom', instance }, EMPTY, 'generated');
    expect(built).toBe(instance);
    expect(built.origin).toBe('custom-origin');
  });

  it('throws for an unrecognized transport', () => {
    expect(() =>
      createBackplane(
        { transport: 'carrier-pigeon' } as unknown as Parameters<typeof createBackplane>[0],
        EMPTY,
        'node-a',
      ),
    ).toThrow(/unrecognized transport carrier-pigeon/);
  });
});

it.each(['redis', 'messaging'] as const)(
  'passes the clock and maxFrameAgeMs through the %s factory arm',
  async (transport) => {
    const publish = vi.fn(() => Promise.resolve());
    const broker = {
      publish,
      subscribe: () => Promise.resolve({ fanOut: true, unsubscribe: () => Promise.resolve() }),
    } as unknown as IMessageBroker;
    const registry = registryWith({ [CAPABILITIES.MESSAGING]: broker });
    const client = redisClient();
    const redisPublish = vi.spyOn(client, 'publish');
    const options =
      transport === 'redis'
        ? { transport, client, subscriber: redisClient(), maxFrameAgeMs: 100 }
        : { transport, maxFrameAgeMs: 100 };
    const backplane = createBackplane(options, registry, 'a', undefined, () => 50);
    await backplane.connect();
    await backplane.publish({ kind: 'ws-room', origin: 'a', name: 'n', data: 'd' });
    if (transport === 'messaging')
      expect(publish).toHaveBeenCalledWith(
        'setu-ts.realtime',
        expect.objectContaining({ sentAtMs: 50 }),
      );
    else expect(JSON.parse(redisPublish.mock.calls[0]![1])).toHaveProperty('sentAtMs', 50);
    await backplane.close();
    expect(() => createBackplane({ ...options, maxFrameAgeMs: NaN }, registry, 'a')).toThrow(
      RangeError,
    );
    const warn = vi.fn();
    createBackplane(options, registry, 'a', { failed: vi.fn(), succeeded: vi.fn(), warn });
    expect(warn).toHaveBeenCalledOnce();
  },
);
