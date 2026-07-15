/**
 * Unit tests for RedisRateLimitStore.
 *
 * Every branch is driven through the injected fake client fixture; the REAL
 * `npm:ioredis@5.x` import is exercised by guarded tests that skip when the
 * package is absent (cache-plugin redis-store precedent).
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { RedisRateLimitStore, validateClient } from '../../src/stores/redis-rate-limit-store.ts';
import type { IRateLimitRedisClient } from '../../src/stores/redis-rate-limit-store.ts';
import { FakeIoredisClient } from '../fixtures/fake-ioredis-client.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

describe('RedisRateLimitStore', () => {
  describe('with an injected fake client', () => {
    it('first increment calls INCR then PEXPIRE then PTTL', async () => {
      const runtime = createFakeRuntime();
      const client = new FakeIoredisClient();
      const store = new RedisRateLimitStore({ runtime, client });

      const result = await store.increment('key-1', 60000);

      expect(result.count).toBe(1);
      expect(client.calls.map((c) => c.method)).toEqual(['incr', 'pexpire', 'pttl']);
    });

    it('subsequent within-window increments call INCR but NOT PEXPIRE', async () => {
      const runtime = createFakeRuntime();
      const client = new FakeIoredisClient();
      const store = new RedisRateLimitStore({ runtime, client });

      await store.increment('key-1', 60000);
      const r2 = await store.increment('key-1', 60000);

      expect(r2.count).toBe(2);
      expect(client.calls.map((c) => c.method)).toEqual([
        'incr',
        'pexpire',
        'pttl',
        'incr',
        'pttl',
      ]);
    });

    it('resetTime equals runtime.now() + PTTL (absolute epoch ms, not the raw TTL)', async () => {
      const runtime = createFakeRuntime();
      const client = new FakeIoredisClient();
      const store = new RedisRateLimitStore({ runtime, client });

      const now = runtime.now();
      const result = await store.increment('key-ttl', 45000);

      expect(result.count).toBe(1);
      expect(result.resetTime).toBe(now + 45000);
    });

    it('reset calls DEL and clears the counter', async () => {
      const runtime = createFakeRuntime();
      const client = new FakeIoredisClient();
      const store = new RedisRateLimitStore({ runtime, client });

      await store.increment('key-1', 60000);
      await store.reset('key-1');

      expect(client.calls.some((c) => c.method === 'del')).toBe(true);
      const r = await store.increment('key-1', 60000);
      expect(r.count).toBe(1);
    });

    it('different keys have independent counts', async () => {
      const runtime = createFakeRuntime();
      const client = new FakeIoredisClient();
      const store = new RedisRateLimitStore({ runtime, client });

      await store.increment('key-a', 60000);
      await store.increment('key-a', 60000);
      const rA = await store.increment('key-a', 60000);
      const rB = await store.increment('key-b', 60000);

      expect(rA.count).toBe(3);
      expect(rB.count).toBe(1);
    });

    it('disconnect calls QUIT', async () => {
      const runtime = createFakeRuntime();
      const client = new FakeIoredisClient();
      const store = new RedisRateLimitStore({ runtime, client });

      await store.increment('key-1', 60000);
      await store.disconnect();

      expect(client.calls.some((c) => c.method === 'quit')).toBe(true);
    });

    it('disconnect when the client never connected is safe', async () => {
      const runtime = createFakeRuntime();
      const store = new RedisRateLimitStore({ runtime });

      await store.disconnect(); // no throw, no client ever resolved
    });

    it('an injected client missing required methods is rejected on first use', async () => {
      const runtime = createFakeRuntime();
      const badClient = { notA: 'client' } as unknown as IRateLimitRedisClient;
      const store = new RedisRateLimitStore({ runtime, client: badClient });

      await expect(store.increment('key-1', 60000)).rejects.toThrow(
        'Injected Redis client does not match',
      );
    });
  });

  describe('validateClient', () => {
    it('returns true for a structurally valid client', () => {
      expect(validateClient(new FakeIoredisClient())).toBe(true);
    });

    it('returns false for null', () => {
      expect(validateClient(null)).toBe(false);
    });

    it('returns false for a non-object', () => {
      expect(validateClient('not-a-client')).toBe(false);
    });

    it('returns false for a plain object missing all methods', () => {
      expect(validateClient({})).toBe(false);
    });

    it('returns false when incr is missing', () => {
      expect(
        validateClient({
          pexpire: () => Promise.resolve(1),
          pttl: () => Promise.resolve(0),
          del: () => Promise.resolve(0),
          quit: () => Promise.resolve(),
        }),
      ).toBe(false);
    });

    it('returns false when quit is missing', () => {
      expect(
        validateClient({
          incr: () => Promise.resolve(1),
          pexpire: () => Promise.resolve(1),
          pttl: () => Promise.resolve(0),
          del: () => Promise.resolve(0),
        }),
      ).toBe(false);
    });

    it('returns false when a required method is not a function', () => {
      expect(
        validateClient({
          incr: 'not-a-function',
          pexpire: () => Promise.resolve(1),
          pttl: () => Promise.resolve(0),
          del: () => Promise.resolve(0),
          quit: () => Promise.resolve(),
        }),
      ).toBe(false);
    });
  });

  describe('REAL ioredis import (guarded)', () => {
    // These tests only run when ioredis is actually available; they skip
    // gracefully (return early) when the import fails.
    it('can lazy-import npm:ioredis@5.x and get a constructor', async () => {
      let RedisCtor: unknown;
      try {
        const mod = await import('npm:ioredis@5.x');
        RedisCtor = mod.Redis;
      } catch {
        // ioredis not available — skip this test
        return;
      }
      expect(RedisCtor).toBeDefined();
      expect(typeof RedisCtor).toBe('function');
    });

    it('resolves a real client through the lazy path when no client is injected', async () => {
      try {
        await import('npm:ioredis@5.x');
      } catch {
        // ioredis not available — skip this test
        return;
      }

      const runtime = createFakeRuntime();
      // Port 6390: no Redis expected there — the command fails, but the lazy
      // import + construction path (loadIoredis → new Redis(url)) executes.
      const store = new RedisRateLimitStore({ runtime, url: 'redis://127.0.0.1:6390' });
      try {
        await store.increment('guarded-key', 1000);
      } catch {
        // Connection refused is the expected outcome without a local Redis.
      } finally {
        // Always release the real client's socket/timers.
        await store.disconnect().catch(() => {});
      }
    });
  });
});
