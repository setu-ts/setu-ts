/**
 * The bounded tenant cache (M127 §3.7): TTL on a monotonic clock, entry and
 * byte eviction, oversize and unserializable tenants uncached, frozen hits,
 * misses and throws never cached, and single-flight.
 */
import { describe, expect, it } from 'vitest';
import type { ITenant, ITenantRegistry, Option } from '@setu-ts/common';
import { none, some } from '@setu-ts/common';
import { CachingTenantRegistry } from '../../src/registry/caching-tenant-registry.ts';

const LIMITS = { ttlMs: 1_000, maxEntries: 100, maxBytes: 1_048_576 };

/** A registry counting lookups and answering from a function. */
function counting(answer: (id: string) => Promise<Option<ITenant>>): {
  registry: ITenantRegistry;
  calls: string[];
} {
  const calls: string[] = [];
  return {
    calls,
    registry: {
      lookup: (id) => {
        calls.push(id);
        return answer(id);
      },
    },
  };
}

/** A controllable monotonic clock. */
function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

const admitAll = (id: string): Promise<Option<ITenant>> => Promise.resolve(some({ id }));

describe('CachingTenantRegistry', () => {
  it('serves a hit from cache until ttlMs elapses on the monotonic clock, then looks up again', async () => {
    const { registry, calls } = counting(admitAll);
    const c = clock();
    const cache = new CachingTenantRegistry(registry, LIMITS, c.now);
    await cache.lookup('acme');
    await cache.lookup('acme');
    expect(calls).toEqual(['acme']);
    c.advance(999);
    await cache.lookup('acme');
    expect(calls).toHaveLength(1);
    c.advance(1);
    await cache.lookup('acme');
    expect(calls).toHaveLength(2);
    expect(cache.size).toBe(1);
  });

  it('a cached hit is a frozen copy with frozen top-level metadata', async () => {
    const source = { id: 'acme', name: 'Acme', metadata: { plan: 'gold' } };
    const cache = new CachingTenantRegistry(
      { lookup: () => Promise.resolve(some(source)) },
      LIMITS,
      clock().now,
    );
    const first = await cache.lookup('acme');
    const second = await cache.lookup('acme');
    const tenant = first.present ? first.value : undefined;
    expect(tenant).toEqual(source);
    expect(tenant).not.toBe(source);
    expect(Object.isFrozen(tenant)).toBe(true);
    expect(Object.isFrozen(tenant?.metadata)).toBe(true);
    expect(second.present && second.value).toBe(tenant);
  });

  it('misses and throws are never cached', async () => {
    let mode: 'miss' | 'throw' | 'hit' = 'miss';
    const { registry, calls } = counting((id) =>
      mode === 'miss'
        ? Promise.resolve(none())
        : mode === 'throw'
          ? Promise.reject(new Error('down'))
          : Promise.resolve(some({ id })),
    );
    const cache = new CachingTenantRegistry(registry, LIMITS, clock().now);
    expect((await cache.lookup('new')).present).toBe(false);
    expect((await cache.lookup('new')).present).toBe(false);
    mode = 'throw';
    await expect(cache.lookup('new')).rejects.toThrow('down');
    await expect(cache.lookup('new')).rejects.toThrow('down');
    expect(cache.size).toBe(0);
    mode = 'hit';
    expect((await cache.lookup('new')).present).toBe(true);
    expect(calls).toHaveLength(5);
    expect(cache.size).toBe(1);
  });

  it('a malformed answer is passed through uncached', async () => {
    const bad = some({}) as unknown as Option<ITenant>;
    const cache = new CachingTenantRegistry(
      { lookup: () => Promise.resolve(bad) },
      LIMITS,
      clock().now,
    );
    expect(await cache.lookup('x')).toBe(bad);
    const nullish = new CachingTenantRegistry(
      { lookup: () => Promise.resolve(undefined as unknown as Option<ITenant>) },
      LIMITS,
      clock().now,
    );
    expect(await nullish.lookup('x')).toBeUndefined();
    expect(cache.size + nullish.size).toBe(0);
  });

  it('evicts oldest-first to stay within maxEntries', async () => {
    const cache = new CachingTenantRegistry(
      { lookup: admitAll },
      { ...LIMITS, maxEntries: 2 },
      clock().now,
    );
    await cache.lookup('a');
    await cache.lookup('b');
    await cache.lookup('c');
    expect(cache.size).toBe(2);
    // 'a' was evicted: looking it up again re-queries (and evicts 'b').
    const { registry, calls } = counting(admitAll);
    const tracked = new CachingTenantRegistry(registry, { ...LIMITS, maxEntries: 2 }, clock().now);
    await tracked.lookup('a');
    await tracked.lookup('b');
    await tracked.lookup('c');
    await tracked.lookup('c');
    await tracked.lookup('a');
    expect(calls).toEqual(['a', 'b', 'c', 'a']);
  });

  it('evicts to stay within maxBytes, counting key and JSON bytes in UTF-8', async () => {
    // key 'é' = 2 bytes; JSON {"id":"é"} = 11 bytes → 13 bytes per entry.
    const cache = new CachingTenantRegistry(
      { lookup: admitAll },
      { ...LIMITS, maxBytes: 26 },
      clock().now,
    );
    await cache.lookup('é');
    expect(cache.bytes).toBe(13);
    await cache.lookup('ü');
    expect(cache.bytes).toBe(26);
    expect(cache.size).toBe(2);
    await cache.lookup('ö');
    expect(cache.size).toBe(2);
    expect(cache.bytes).toBe(26);
  });

  it('an entry larger than maxBytes alone is returned uncached', async () => {
    const big = { id: 'acme', name: 'x'.repeat(500) };
    const { registry, calls } = counting(() => Promise.resolve(some(big)));
    const cache = new CachingTenantRegistry(registry, { ...LIMITS, maxBytes: 100 }, clock().now);
    const result = await cache.lookup('acme');
    expect(result.present && result.value).toEqual(big);
    await cache.lookup('acme');
    expect(calls).toHaveLength(2);
    expect(cache.size).toBe(0);
    expect(cache.bytes).toBe(0);
  });

  it('a tenant whose JSON.stringify throws is returned uncached', async () => {
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    const cases: ITenant[] = [
      { id: 'cycle', metadata: cyclic },
      { id: 'bigint', metadata: { n: 1n } },
    ];
    for (const tenant of cases) {
      const cache = new CachingTenantRegistry(
        { lookup: () => Promise.resolve(some(tenant)) },
        LIMITS,
        clock().now,
      );
      const result = await cache.lookup(tenant.id);
      expect(result.present && result.value.id).toBe(tenant.id);
      expect(cache.size).toBe(0);
    }
  });

  it('ttlMs: 0 caches nothing', async () => {
    const { registry, calls } = counting(admitAll);
    const cache = new CachingTenantRegistry(registry, { ...LIMITS, ttlMs: 0 }, clock().now);
    await cache.lookup('a');
    await cache.lookup('a');
    expect(calls).toHaveLength(2);
    expect(cache.size).toBe(0);
  });

  it('replacing an expired entry keeps the byte count exact', async () => {
    const c = clock();
    const cache = new CachingTenantRegistry({ lookup: admitAll }, LIMITS, c.now);
    await cache.lookup('a');
    const bytes = cache.bytes;
    c.advance(5_000);
    await cache.lookup('a');
    expect(cache.bytes).toBe(bytes);
    expect(cache.size).toBe(1);
  });

  it('a store racing an existing entry replaces it without double-counting bytes', async () => {
    // Two lookups of one id that are NOT single-flighted (the first settles
    // after the entry expired and was re-fetched) both store.
    const c = clock();
    const releases: (() => void)[] = [];
    const registry: ITenantRegistry = {
      lookup: (id) =>
        new Promise((resolve) => {
          releases.push(() => resolve(some({ id })));
        }),
    };
    const cache = new CachingTenantRegistry(registry, LIMITS, c.now);
    const first = cache.lookup('a');
    releases.shift()!();
    await first;
    const bytes = cache.bytes;
    c.advance(5_000);
    const second = cache.lookup('a');
    releases.shift()!();
    await second;
    expect(cache.bytes).toBe(bytes);
  });

  it('single-flight: N concurrent lookups of one id make one call; the in-flight map empties', async () => {
    let release: (() => void) | undefined;
    const { registry, calls } = counting(
      (id) =>
        new Promise((resolve) => {
          release = () => resolve(some({ id }));
        }),
    );
    const cache = new CachingTenantRegistry(registry, LIMITS, clock().now);
    const pending = Array.from({ length: 50 }, () => cache.lookup('acme'));
    expect(calls).toEqual(['acme']);
    expect(cache.inFlight).toBe(1);
    release!();
    const results = await Promise.all(pending);
    expect(results.every((r) => r.present && r.value.id === 'acme')).toBe(true);
    expect(cache.inFlight).toBe(0);
  });

  it('the in-flight entry is removed when a lookup rejects', async () => {
    const cache = new CachingTenantRegistry(
      { lookup: () => Promise.reject(new Error('down')) },
      LIMITS,
      clock().now,
    );
    const pending = [cache.lookup('x'), cache.lookup('x')];
    expect(cache.inFlight).toBe(1);
    await Promise.allSettled(pending);
    expect(cache.inFlight).toBe(0);
  });

  it('O5: 100 000 distinct unknown ids leave the cache and in-flight map empty', async () => {
    const cache = new CachingTenantRegistry(
      { lookup: () => Promise.resolve(none()) },
      LIMITS,
      clock().now,
    );
    for (let i = 0; i < 100_000; i++) {
      await cache.lookup(`unknown-${i}`);
    }
    expect(cache.size).toBe(0);
    expect(cache.inFlight).toBe(0);
  });

  it('O5: 10 000 distinct hits stay within maxEntries and maxBytes; a small set stays cached', async () => {
    const limits = { ttlMs: 60_000, maxEntries: 500, maxBytes: 8_192 };
    const cache = new CachingTenantRegistry({ lookup: admitAll }, limits, clock().now);
    for (let i = 0; i < 10_000; i++) {
      await cache.lookup(`tenant-${i}`);
      expect(cache.size).toBeLessThanOrEqual(limits.maxEntries);
      expect(cache.bytes).toBeLessThanOrEqual(limits.maxBytes);
    }
    // Positive control: a small set fits and is served from cache.
    const { registry, calls } = counting(admitAll);
    const small = new CachingTenantRegistry(registry, limits, clock().now);
    for (let round = 0; round < 3; round++) {
      for (const id of ['a', 'b', 'c']) await small.lookup(id);
    }
    expect(calls).toEqual(['a', 'b', 'c']);
  });
});
