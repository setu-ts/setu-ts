/**
 * Tests for resolveLock factory.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IDistributedLock } from '../../src/interfaces/index.ts';
import { resolveLock } from '../../src/lock/distributed-lock.ts';
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
