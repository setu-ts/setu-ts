/**
 * Tests for resolveLock factory.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDistributedLock } from '../../src/interfaces/index.ts';
import { resolveLock, resolveLockTimeouts } from '../../src/lock/distributed-lock.ts';
import { FakeRuntime } from '../fixtures/fake-runtime.ts';
import { FakeRedisClient } from '../fixtures/fake-ioredis-client.ts';
import { RedisLock } from '../../src/lock/redis-lock.ts';

describe('resolveLock', () => {
  it('returns MemoryLock when distributedLock disabled', async () => {
    const runtime = new FakeRuntime();
    const lock = await resolveLock(undefined, runtime);
    expect(lock).toBeDefined();
    const token = await lock.acquire('test', 5000);
    expect(token).toBeTruthy();
  });

  it('returns injected custom lock when provided', async () => {
    const runtime = new FakeRuntime();
    const custom: IDistributedLock = {
      acquire() {
        return Promise.resolve('custom');
      },
      release() {
        return Promise.resolve();
      },
    };
    const lock = await resolveLock(
      { distributedLock: { lock: custom } },
      runtime,
    );
    expect(lock).toBe(custom);
  });

  it('returns MemoryLock when enabled is false', async () => {
    const runtime = new FakeRuntime();
    const lock = await resolveLock(
      { distributedLock: { enabled: false } },
      runtime,
    );
    expect(lock).toBeDefined();
    const token = await lock.acquire('test', 5000);
    expect(token).toBeTruthy();
  });

  it('returns MemoryLock when no options at all', async () => {
    const runtime = new FakeRuntime();
    const lock = await resolveLock({}, runtime);
    const token = await lock.acquire('test', 5000);
    expect(token).toBeTruthy();
  });

  it('returns MemoryLock when enabled true but storage not redis', async () => {
    const runtime = new FakeRuntime();
    const lock = await resolveLock(
      { distributedLock: { enabled: true } },
      runtime,
    );
    const token = await lock.acquire('test', 5000);
    expect(token).toBeTruthy();
  });

  it('custom lock takes priority over redis storage', async () => {
    const runtime = new FakeRuntime();
    const custom: IDistributedLock = {
      acquire() {
        return Promise.resolve('custom');
      },
      release() {
        return Promise.resolve();
      },
    };
    const lock = await resolveLock(
      {
        distributedLock: {
          lock: custom,
          storage: 'redis',
          enabled: true,
          url: 'redis://localhost:6379',
        },
      },
      runtime,
    );
    expect(lock).toBe(custom);
  });

  it('returns a RedisLock over the injected client when storage is redis', async () => {
    const client = new FakeRedisClient();
    const lock = await resolveLock(
      { distributedLock: { enabled: true, storage: 'redis', client } },
      new FakeRuntime(),
      { report: () => {}, recovered: () => {} },
    );
    expect(lock).toBeInstanceOf(RedisLock);
    // The injected client is the one the lock talks to.
    await (lock as RedisLock).connect();
    const token = await lock.acquire('job', 5000);
    expect(token).toBeTruthy();
    expect(await lock.acquire('job', 5000)).toBeNull();
    await (lock as RedisLock).disconnect();
  });

  it('builds a RedisLock with the default url and no reporter when none is given', async () => {
    const lock = await resolveLock(
      { distributedLock: { enabled: true, storage: 'redis' } },
      new FakeRuntime(),
    );
    expect(lock).toBeInstanceOf(RedisLock);
  });
});

describe('resolveLockTimeouts (M101a V8-24)', () => {
  it('defaults the acquire bound to 5000 and the command bound to it', () => {
    expect(resolveLockTimeouts(undefined)).toEqual({
      acquireTimeoutMs: 5000,
      commandTimeoutMs: 5000,
    });
  });

  it('derives the command bound from a configured acquire bound', () => {
    expect(resolveLockTimeouts({ acquireTimeoutMs: 500 })).toEqual({
      acquireTimeoutMs: 500,
      commandTimeoutMs: 500,
    });
  });

  it('falls back to the ioredis default when the acquire bound is disabled', () => {
    expect(resolveLockTimeouts({ acquireTimeoutMs: 0 })).toEqual({
      acquireTimeoutMs: 0,
      commandTimeoutMs: 15_000,
    });
    expect(resolveLockTimeouts({ acquireTimeoutMs: 0, commandTimeoutMs: 60_000 }))
      .toEqual({ acquireTimeoutMs: 0, commandTimeoutMs: 60_000 });
  });

  it('accepts a command bound at or below the acquire bound, 0 included', () => {
    expect(resolveLockTimeouts({ acquireTimeoutMs: 500, commandTimeoutMs: 200 }).commandTimeoutMs)
      .toBe(200);
    expect(resolveLockTimeouts({ acquireTimeoutMs: 500, commandTimeoutMs: 0 }).commandTimeoutMs)
      .toBe(0);
  });

  it('refuses a command bound that outlasts a non-zero acquire bound, naming both', () => {
    expect(() => resolveLockTimeouts({ acquireTimeoutMs: 500, commandTimeoutMs: 501 })).toThrow(
      'scheduler-plugin: distributedLock.commandTimeoutMs (501) must not exceed ' +
        'distributedLock.acquireTimeoutMs (500)',
    );
  });

  it('refuses out-of-range values for either option', () => {
    for (const value of [Number.NaN, -1, 2 ** 31, Number.POSITIVE_INFINITY]) {
      expect(() => resolveLockTimeouts({ acquireTimeoutMs: value })).toThrow(RangeError);
      expect(() => resolveLockTimeouts({ acquireTimeoutMs: 0, commandTimeoutMs: value })).toThrow(
        RangeError,
      );
    }
  });
});
