/**
 * `RedisRateLimitStore` key namespacing (M90a §3.5).
 *
 * X32-5: the store wrote keys exactly as `keyGenerator` produced them —
 * `anonymous`, `ip:203.0.113.7`, `user:42`. Both sibling Redis stores in this
 * framework namespace and both say why in their own source: `cache-plugin`'s
 * takes a prefix as a REQUIRED constructor argument, and `session-plugin`'s
 * `CacheSessionStore` defaults one so that a `clear()` from elsewhere cannot
 * sign everybody out. So two applications sharing one managed Redis counted
 * against each other's budget — and combined with X32-1, service A's traffic
 * would restart service B's pods.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  DEFAULT_RATE_LIMIT_KEY_PREFIX,
  RedisRateLimitStore,
} from '../../src/stores/redis-rate-limit-store.ts';
import { FakeIoredisClient } from '../fixtures/fake-ioredis-client.ts';
import { createFakeRuntime } from '../fixtures/fake-runtime.ts';

/** Every key the fake client was addressed with, in call order. */
function keysTouched(client: FakeIoredisClient): string[] {
  return client.calls.map((call) => call.args[0] as string);
}

describe('RedisRateLimitStore key prefix (X32-5)', () => {
  it('names its default prefix', () => {
    expect(DEFAULT_RATE_LIMIT_KEY_PREFIX).toBe('setu:ratelimit:');
  });

  it('applies the default prefix on every increment call', async () => {
    const client = new FakeIoredisClient();
    const store = new RedisRateLimitStore({ runtime: createFakeRuntime(), client });

    await store.increment('anonymous', 60_000);

    // INCR, PEXPIRE and PTTL must all address the SAME namespaced key —
    // prefixing one and not the others would expire a key nobody reads.
    expect(keysTouched(client)).toEqual([
      'setu:ratelimit:anonymous',
      'setu:ratelimit:anonymous',
      'setu:ratelimit:anonymous',
    ]);
  });

  it('applies the prefix on reset', async () => {
    const client = new FakeIoredisClient();
    const store = new RedisRateLimitStore({ runtime: createFakeRuntime(), client });

    await store.reset('ip:203.0.113.7');

    expect(keysTouched(client)).toEqual(['setu:ratelimit:ip:203.0.113.7']);
  });

  it('a supplied prefix REPLACES the default', async () => {
    const client = new FakeIoredisClient();
    const store = new RedisRateLimitStore({
      runtime: createFakeRuntime(),
      client,
      keyPrefix: 'orders-api:rl:',
    });

    await store.increment('anonymous', 60_000);

    expect(keysTouched(client)[0]).toBe('orders-api:rl:anonymous');
    expect(keysTouched(client)[0]).not.toContain('setu:ratelimit:');
  });

  it('an empty prefix opts out — the pre-0.5.0 wire keys, byte for byte', async () => {
    // An operator upgrading a single-application Redis who does not want the
    // in-flight counters orphaned has an escape hatch.
    const client = new FakeIoredisClient();
    const store = new RedisRateLimitStore({
      runtime: createFakeRuntime(),
      client,
      keyPrefix: '',
    });

    await store.increment('anonymous', 60_000);

    expect(keysTouched(client)[0]).toBe('anonymous');
  });

  it('two stores under different prefixes count independently', async () => {
    // The finding itself: one Redis, two applications, separate budgets.
    const client = new FakeIoredisClient();
    const runtime = createFakeRuntime();
    const serviceA = new RedisRateLimitStore({ runtime, client, keyPrefix: 'a:' });
    const serviceB = new RedisRateLimitStore({ runtime, client, keyPrefix: 'b:' });

    // Both count the SAME generated key — `anonymous`, the literal the default
    // generator produces on every first-party adapter.
    const a1 = await serviceA.increment('anonymous', 60_000);
    const a2 = await serviceA.increment('anonymous', 60_000);
    const b1 = await serviceB.increment('anonymous', 60_000);

    expect(a1.count).toBe(1);
    expect(a2.count).toBe(2);
    // Without the prefix this would be 3 — service A's traffic exhausting
    // service B's limit.
    expect(b1.count).toBe(1);
  });

  it('the PEXPIRE window is unchanged by prefixing', async () => {
    const client = new FakeIoredisClient();
    const store = new RedisRateLimitStore({ runtime: createFakeRuntime(), client });

    await store.increment('k', 45_000);

    const pexpire = client.calls.find((call) => call.method === 'pexpire');
    expect(pexpire?.args).toEqual(['setu:ratelimit:k', 45_000]);
  });
});
