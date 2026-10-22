import { describe, expect, it, vi } from 'vitest';
import { httpStatusHintOf } from '@setu-ts/common';
import { RateLimitStoreUnavailableError, RedisRateLimitStore } from '../../src/index.ts';
import {
  createRateLimitRedisClient,
  resolveCommandTimeoutMs,
} from '../../src/stores/redis-rate-limit-store.ts';
import { FakeIoredisClient } from '../fixtures/fake-ioredis-client.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('RedisRateLimitStore outage classification', () => {
  for (const method of ['incr', 'pexpire', 'pttl', 'del'] as const) {
    for (const fault of [true, false]) {
      it(`${method} ${fault ? 'wraps connection faults' : 'preserves programming errors'}`, async () => {
        const original = Object.freeze(new Error(fault ? 'Command timed out' : 'WRONGTYPE'));
        const client = new FakeIoredisClient();
        vi.spyOn(client, method).mockRejectedValue(original);
        const store = new RedisRateLimitStore({ runtime: createFakeRuntime(), client });
        const error = await (
          method === 'del' ? store.reset('k') : store.increment('k', 1000)
        ).catch((caught: unknown) => caught);
        if (fault) {
          expect(error).toBeInstanceOf(RateLimitStoreUnavailableError);
          expect((error as Error).cause).toBe(original);
          expect(httpStatusHintOf(error)).toEqual({
            status: 503,
            title: 'Service Unavailable',
            detail: 'Rate limiting is temporarily unavailable.',
          });
        } else expect(error).toBe(original);
        await store.disconnect();
      });
    }
  }

  it('forwards commandTimeoutMs and omits zero', () => {
    const calls: unknown[][] = [];
    class Client {
      constructor(...args: unknown[]) {
        calls.push(args);
      }
    }
    createRateLimitRedisClient(Client, 'redis://example', resolveCommandTimeoutMs(undefined));
    createRateLimitRedisClient(Client, 'redis://example', 4321);
    createRateLimitRedisClient(Client, 'redis://example', 0);
    expect(calls).toEqual([
      ['redis://example', { commandTimeout: 15000 }],
      ['redis://example', { commandTimeout: 4321 }],
      ['redis://example'],
    ]);
  });

  it.each([NaN, Infinity, -1, 2147483648])(
    'refuses invalid commandTimeoutMs %s at construction',
    (commandTimeoutMs) => {
      expect(
        () => new RedisRateLimitStore({ runtime: createFakeRuntime(), commandTimeoutMs }),
      ).toThrow(RangeError);
    },
  );

  it('accepts both bounds and does not configure an injected client', async () => {
    expect(resolveCommandTimeoutMs(2147483647)).toBe(2147483647);
    const client = new FakeIoredisClient();
    const store = new RedisRateLimitStore({
      runtime: createFakeRuntime(),
      client,
      commandTimeoutMs: 0,
    });
    expect((await store.increment('k', 1000)).count).toBe(1);
    expect(Object.hasOwn(client, 'commandTimeout')).toBe(false);
    await store.disconnect();
  });
});
