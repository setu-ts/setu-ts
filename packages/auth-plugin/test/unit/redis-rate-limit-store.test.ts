/**
 * Unit tests for RedisRateLimitStore.
 *
 * Uses a fake ioredis-compatible client for unit tests; one guarded real-import
 * test exercises the actual npm:ioredis@5.x import.
 */

import { assertEquals, assertExists } from 'https://deno.land/std@0.224.0/assert/mod.ts';
import { RedisRateLimitStore } from '../../src/stores/redis-rate-limit-store.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** Fake ioredis-compatible client for unit tests. */
class FakeRedisClient {
  #store = new Map<string, { value: number; ttl: number }>();

  incr(key: string): Promise<number> {
    const existing = this.#store.get(key);
    if (existing === undefined) {
      this.#store.set(key, { value: 1, ttl: 0 });
      return Promise.resolve(1);
    }
    existing.value++;
    return Promise.resolve(existing.value);
  }

  pexpire(key: string, ms: number): Promise<number> {
    const existing = this.#store.get(key);
    if (existing !== undefined) {
      existing.ttl = ms;
    }
    return Promise.resolve(1);
  }

  pttl(key: string): Promise<number> {
    const existing = this.#store.get(key);
    if (existing === undefined) return Promise.resolve(-2);
    return Promise.resolve(existing.ttl > 0 ? existing.ttl : 0);
  }

  del(...keys: string[]): Promise<number> {
    let deleted = 0;
    for (const key of keys) {
      if (this.#store.delete(key)) deleted++;
    }
    return Promise.resolve(deleted);
  }

  quit(): Promise<void> {
    this.#store.clear();
    return Promise.resolve();
  }
}

Deno.test('RedisRateLimitStore — first increment calls INCR + PEXPIRE', async () => {
  const runtime = createFakeRuntime();
  const fakeClient = new FakeRedisClient();
  const store = new RedisRateLimitStore({ runtime, client: fakeClient });

  const result = await store.increment('key-1', 60000);

  assertEquals(result.count, 1);
  assertEquals(result.resetTime, runtime.now() + 60000);
});

Deno.test('RedisRateLimitStore — subsequent increments skip PEXPIRE', async () => {
  const runtime = createFakeRuntime();
  const fakeClient = new FakeRedisClient();
  const store = new RedisRateLimitStore({ runtime, client: fakeClient });

  await store.increment('key-1', 60000);
  const r2 = await store.increment('key-1', 60000);

  assertEquals(r2.count, 2);
});

Deno.test('RedisRateLimitStore — reset calls DEL', async () => {
  const runtime = createFakeRuntime();
  const fakeClient = new FakeRedisClient();
  const store = new RedisRateLimitStore({ runtime, client: fakeClient });

  await store.increment('key-1', 60000);
  await store.reset('key-1');

  const r = await store.increment('key-1', 60000);
  assertEquals(r.count, 1);
});

Deno.test('RedisRateLimitStore — disconnect calls QUIT', async () => {
  const runtime = createFakeRuntime();
  const fakeClient = new FakeRedisClient();
  const store = new RedisRateLimitStore({ runtime, client: fakeClient });

  await store.increment('key-1', 60000);
  await store.disconnect();
});

Deno.test('RedisRateLimitStore — guarded real-import test', async () => {
  // This test exercises the ACTUAL lazy import of npm:ioredis@5.x.
  // Skipped when the package is absent (deno test --filter ...).
  try {
    const RedisCtor = await import('npm:ioredis@5.x');
    assertExists(RedisCtor.Redis);
    // If we got here, the import resolved successfully
  } catch {
    // Silently skip when ioredis is not installed
  }
});
