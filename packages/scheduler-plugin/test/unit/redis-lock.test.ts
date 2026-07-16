/**
 * Tests for RedisLock with fake ioredis client.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RedisLock, validateClient } from '../../src/lock/redis-lock.ts';
import { FakeRedisClient } from '../fixtures/fake-ioredis-client.ts';

describe('RedisLock', () => {
  it('acquires lock via SET NX PX', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();
    const token = await lock.acquire('key1', 5000);
    expect(token).toBeTruthy();
    expect(fake.calls.some((c) => c.method === 'set')).toBe(true);
    await lock.disconnect();
  });

  it('returns null when key is held', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();
    const token = await lock.acquire('key1', 5000);
    expect(token).toBeTruthy();
    // Second acquire — fake returns null because key exists
    const token2 = await lock.acquire('key1', 5000);
    expect(token2).toBeNull();
    await lock.disconnect();
  });

  it('releases with token-checked delete', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();
    const token = await lock.acquire('key1', 5000);
    await lock.release('key1', token!);
    // Key should be gone, so next acquire succeeds
    const token2 = await lock.acquire('key1', 5000);
    expect(token2).toBeTruthy();
    await lock.disconnect();
  });

  it('does not release with wrong token', async () => {
    const fake = new FakeRedisClient();
    const lock = new RedisLock({ url: 'redis://localhost:6379', client: fake });
    await lock.connect();
    await lock.acquire('key1', 5000);
    await lock.release('key1', 'wrong-token');
    // Key still held
    const token = await lock.acquire('key1', 5000);
    expect(token).toBeNull();
    await lock.disconnect();
  });

  it('throws when not connected', async () => {
    const lock = new RedisLock({ url: 'redis://localhost:6379' });
    try {
      await lock.acquire('key1', 5000);
      throw new Error('expected throw');
    } catch (e) {
      expect((e as Error).message).toContain('not connected');
    }
  });
});

describe('validateClient', () => {
  it('returns true for valid client', () => {
    expect(validateClient(new FakeRedisClient())).toBe(true);
  });

  it('returns false for null', () => {
    // deno-lint-ignore no-explicit-any
    expect(validateClient(null as any)).toBe(false);
  });

  it('returns false for missing method', () => {
    expect(validateClient({ set: () => {}, quit: () => {} })).toBe(false);
  });
});
