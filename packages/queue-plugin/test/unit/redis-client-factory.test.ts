import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IRedisQueueClient } from '../../src/interfaces/index.ts';

import {
  createLazyRedisClient,
  DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
  type LazyRedisClientOptions,
  RedisQueue,
  resolveCommandTimeoutMs,
} from '../../src/adapters/redis-queue.ts';
import { QueuePlugin } from '../../src/plugin/queue-plugin.ts';

function capture(): {
  FakeRedis: new (url: string, options: LazyRedisClientOptions) => unknown;
  seen: { url: string; options: LazyRedisClientOptions | undefined };
} {
  const seen: { url: string; options: LazyRedisClientOptions | undefined } = {
    url: '',
    options: undefined,
  };
  class FakeRedis {
    constructor(url: string, options: LazyRedisClientOptions) {
      seen.url = url;
      seen.options = options;
    }
  }
  return { FakeRedis, seen };
}

describe('createLazyRedisClient', () => {
  it('passes lazyConnect and the default command bound to the ioredis constructor', () => {
    const { FakeRedis, seen } = capture();

    createLazyRedisClient(FakeRedis, 'redis://queue.example:6379');

    expect(seen.url).toBe('redis://queue.example:6379');
    expect(seen.options).toEqual({
      lazyConnect: true,
      commandTimeout: DEFAULT_REDIS_COMMAND_TIMEOUT_MS,
    });
    expect(DEFAULT_REDIS_COMMAND_TIMEOUT_MS).toBe(15_000);
  });

  it('passes a configured bound as commandTimeout (M101a V8-5)', () => {
    const { FakeRedis, seen } = capture();

    createLazyRedisClient(FakeRedis, 'redis://queue.example:6379', 1000);

    expect(seen.options).toEqual({ lazyConnect: true, commandTimeout: 1000 });
  });

  it('omits commandTimeout entirely when the bound is 0', () => {
    const { FakeRedis, seen } = capture();

    createLazyRedisClient(FakeRedis, 'redis://queue.example:6379', 0);

    expect(seen.options).toEqual({ lazyConnect: true });
    expect(Object.hasOwn(seen.options ?? {}, 'commandTimeout')).toBe(false);
  });
});

describe('resolveCommandTimeoutMs (M101a V8-5)', () => {
  it('defaults to 15000 and accepts the inclusive range ends', () => {
    expect(resolveCommandTimeoutMs(undefined)).toBe(15_000);
    expect(resolveCommandTimeoutMs(0)).toBe(0);
    expect(resolveCommandTimeoutMs(2_147_483_647)).toBe(2_147_483_647);
  });

  const refused: ReadonlyArray<readonly [string, unknown]> = [
    ['NaN', Number.NaN],
    ['a negative value', -1],
    ['a value past 2^31 - 1', 2_147_483_648],
    ['Infinity', Number.POSITIVE_INFINITY],
    ['a string', '1000'],
  ];
  for (const [label, value] of refused) {
    it(`refuses ${label} at construction, without echoing it`, () => {
      expect(() => new RedisQueue({ commandTimeoutMs: value as number })).toThrow(RangeError);
      expect(() => QueuePlugin({ adapter: 'redis', commandTimeoutMs: value as number })).toThrow(
        RangeError,
      );
      let message = '';
      try {
        resolveCommandTimeoutMs(value as number);
      } catch (error) {
        message = (error as Error).message;
      }
      expect(message).toContain('commandTimeoutMs');
      expect(message).not.toContain(String(value));
    });
  }

  it('ignores the option for a non-redis backend', () => {
    expect(() => QueuePlugin({ adapter: 'memory', commandTimeoutMs: Number.NaN })).not.toThrow();
  });

  it('never applies the bound to an injected client', async () => {
    const client: Record<string, unknown> = {};
    for (const method of 'zadd zrangebyscore zrem hset hget hdel del quit'.split(' ')) {
      client[method] = () => Promise.resolve(null);
    }
    // An injected client is the caller's: it is used as-is and no option is
    // written onto it, so its own configuration stays authoritative.
    const adapter = new RedisQueue({
      client: client as unknown as IRedisQueueClient,
      commandTimeoutMs: 1,
    });
    await adapter.connect();
    expect(Object.hasOwn(client, 'commandTimeout')).toBe(false);
    expect(Object.hasOwn(client, 'options')).toBe(false);
  });
});
