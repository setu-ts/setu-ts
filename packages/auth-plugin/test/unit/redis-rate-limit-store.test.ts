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

    it('reaches the real ioredis constructor through the lazy path', async () => {
      try {
        await import('npm:ioredis@5.x');
      } catch {
        // ioredis not available — skip this test
        return;
      }

      const runtime = createFakeRuntime();
      // An out-of-range port, so ioredis' own constructor refuses the URL.
      //
      // This used to point at `redis://127.0.0.1:6390` — a closed port — and
      // await the command, which reached the same two lines and then spent a
      // real 10 s doing it: ioredis treats a refused connection as retriable,
      // holds the command in its offline queue, and gives up only at its
      // default `connectTimeout` of 10 000 ms. That was the slowest step in this
      // package by an order of magnitude, and it asserted nothing at all.
      //
      // Bounding it through options is not available: ioredis DOES copy URL
      // query parameters onto its options, but as strings, so
      // `?connectTimeout=120` reaches `stream.setTimeout` and crashes the
      // process with `The "msecs" argument must be of type number` (measured).
      // `RedisRateLimitStore` exposes no options passthrough either.
      //
      // So the doomed operation is made to fail in ioredis' constructor rather
      // than on the wire. `resolveClient` still runs `await loadIoredis()` and
      // `new RedisCtor(url)` — the lazy path this test exists to cover — and the
      // rejection now carries ioredis' own message, which is what lets the two
      // assertions below distinguish "the real module was loaded and its
      // constructor was reached" from "the injected-client branch was taken".
      // No socket is opened, so no timer or handle outlives the test either.
      //
      // What this therefore no longer covers, stated rather than left implied:
      // `resolveClient` RETURNING a constructed client, and a command issued on
      // one. The constructor throws, so the return never completes. Recovering
      // that needs a reachable Redis, and `auth-plugin`'s own
      // `test.permissions` grants no `net` at all — so it would mean widening
      // this package's permissions for one test. The injected-fake tests above
      // cover the command sequence; what is uniquely covered here is the lazy
      // import and reaching the real constructor, which is what the name says.
      const store = new RedisRateLimitStore({ runtime, url: 'redis://127.0.0.1:99999' });
      const failure = await store.increment('guarded-key', 1000).then(
        () => null,
        (error: unknown) => error as Error,
      );

      // ioredis' own diagnostic: the real module was imported and `new
      // Redis(url)` ran. A fake or an unreached import cannot produce this.
      expect(failure?.message).toContain('Invalid URL');
      // And NOT the store's own structural rejection, which is what a wrongly
      // taken injected-client branch would have produced.
      expect(failure?.message).not.toContain('structural shape');

      await store.disconnect().catch(() => {});
    });
  });
});
