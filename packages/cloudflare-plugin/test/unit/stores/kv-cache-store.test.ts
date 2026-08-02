/**
 * `KvCacheStore` against a fake KV that enforces the platform's real 60-second
 * `expirationTtl` floor, so the store's logical-expiry design is exercised
 * rather than assumed.
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import { CloudflareUnsupportedError, KvCacheStore } from '../../../src/index.ts';
import { FakeClock, FakeKv } from '../../fakes.ts';

function store(options?: { prefix?: string; defaultTtlSeconds?: number }): {
  kv: FakeKv;
  clock: FakeClock;
  cache: KvCacheStore;
} {
  const kv = new FakeKv();
  const clock = new FakeClock();
  return { kv, clock, cache: new KvCacheStore(kv, clock, options) };
}

describe('KvCacheStore', () => {
  it('writes and reads a value back', async () => {
    const { cache } = store();
    await cache.set('user:1', { name: 'ada' });
    expect(await cache.get<{ name: string }>('user:1')).toEqual({ name: 'ada' });
  });

  it('misses on a key that was never written', async () => {
    const { cache } = store();
    expect(await cache.get('absent')).toBeNull();
  });

  it('floors a sub-minimum TTL physically while honoring it logically', async () => {
    const { kv, clock, cache } = store();

    // 5 seconds: below KV's floor, so the platform would reject it outright.
    await cache.set('short', 'value', 5);

    const put = kv.puts.at(0);
    expect(put?.options?.expirationTtl).toBe(60);
    expect(JSON.parse(put?.value ?? '')).toEqual({ v: 'value', e: clock.now() + 5000 });

    // Still live a moment before the logical deadline...
    clock.advance(4999);
    expect(await cache.get<string>('short')).toBe('value');

    // ...and a miss on time, even though KV would still be serving the key.
    clock.advance(2);
    expect(await cache.get<string>('short')).toBeNull();
  });

  it('drops a logically expired key so the namespace does not accumulate it', async () => {
    const { kv, clock, cache } = store();
    await cache.set('short', 'value', 5);
    clock.advance(6000);

    await cache.get('short');

    expect(kv.deletes).toEqual(['short']);
    expect(kv.entries.has('short')).toBe(false);
  });

  it('passes a TTL above the floor through unchanged', async () => {
    const { kv, cache } = store();
    await cache.set('long', 'value', 3600);
    expect(kv.puts.at(0)?.options?.expirationTtl).toBe(3600);
  });

  it('writes no expiry at all when neither a TTL nor a default is configured', async () => {
    const { kv, clock, cache } = store();
    await cache.set('forever', 'value');

    expect(kv.puts.at(0)?.options).toBeUndefined();
    clock.advance(10 * 365 * 24 * 60 * 60 * 1000);
    expect(await cache.get<string>('forever')).toBe('value');
  });

  it('applies defaultTtlSeconds when set omits a TTL', async () => {
    const { kv, clock, cache } = store({ defaultTtlSeconds: 30 });
    await cache.set('defaulted', 'value');

    expect(kv.puts.at(0)?.options?.expirationTtl).toBe(60);
    clock.advance(30_001);
    expect(await cache.get('defaulted')).toBeNull();
  });

  it('lets an explicit TTL win over the configured default', async () => {
    const { kv, cache } = store({ defaultTtlSeconds: 30 });
    await cache.set('explicit', 'value', 900);
    expect(kv.puts.at(0)?.options?.expirationTtl).toBe(900);
  });

  it('reports has() from the same liveness rule as get()', async () => {
    const { clock, cache } = store();
    await cache.set('probe', 'value', 5);

    expect(await cache.has('probe')).toBe(true);
    clock.advance(6000);
    expect(await cache.has('probe')).toBe(false);
    expect(await cache.has('never-written')).toBe(false);
  });

  it('reports from delete() whether a live entry was removed', async () => {
    const { kv, cache } = store();
    await cache.set('doomed', 'value');

    expect(await cache.delete('doomed')).toBe(true);
    expect(await cache.delete('doomed')).toBe(false);
    expect(kv.entries.has('doomed')).toBe(false);
  });

  it('prefixes every physical key', async () => {
    const { kv, cache } = store({ prefix: 'cache:' });
    await cache.set('user:1', 'value');

    expect([...kv.entries.keys()]).toEqual(['cache:user:1']);
    expect(await cache.get<string>('user:1')).toBe('value');
  });

  it('sweeps every page when clearing a prefixed store', async () => {
    const { kv, cache } = store({ prefix: 'cache:' });
    kv.pageSize = 2; // force pagination

    for (const key of ['a', 'b', 'c', 'd', 'e']) {
      await cache.set(key, key);
    }
    // A key the store does not own, in the same namespace.
    await kv.put('session:x', 'not ours');

    await cache.clear();

    expect([...kv.entries.keys()]).toEqual(['session:x']);
    expect(kv.deletes.sort()).toEqual(
      ['cache:a', 'cache:b', 'cache:c', 'cache:d', 'cache:e'],
    );
  });

  it('does not delete a deliberately cached null on read', async () => {
    // Negative caching: `set(k, null)` records "the origin has nothing". A read
    // that deleted it would make the pattern silently useless — every request
    // would fall through to the origin, forever.
    const { kv, cache } = store();
    await cache.set('absent-upstream', null);

    expect(await cache.get('absent-upstream')).toBeNull();
    expect(kv.entries.has('absent-upstream')).toBe(true);
    expect(kv.deletes).toEqual([]);
  });

  it('reports a cached null as present, and deletes it once', async () => {
    const { kv, cache } = store();
    await cache.set('absent-upstream', null);

    expect(await cache.has('absent-upstream')).toBe(true);
    expect(await cache.delete('absent-upstream')).toBe(true);
    // Exactly one delete: reading presence must not issue its own.
    expect(kv.deletes).toEqual(['absent-upstream']);
  });

  it('never deletes a key it does not own', async () => {
    // `prefix` is optional and the namespace is shareable, so a plain `get` of
    // a key written by another store must leave that key alone.
    const { kv, cache } = store();
    await kv.put('session:abc', JSON.stringify({ userId: 1 }));

    expect(await cache.get('session:abc')).toBeNull();
    expect(await cache.has('session:abc')).toBe(false);
    expect(kv.entries.has('session:abc')).toBe(true);
    expect(kv.deletes).toEqual([]);
  });

  it('issues exactly one delete when removing an expired entry', async () => {
    const { kv, clock, cache } = store();
    await cache.set('short', 'value', 5);
    clock.advance(6000);

    expect(await cache.delete('short')).toBe(false);
    expect(kv.deletes).toEqual(['short']);
  });

  it('refuses to clear an unprefixed store rather than wiping the namespace', async () => {
    const { kv, cache } = store();
    await cache.set('mine', 'value');
    await kv.put('someone-elses', 'value');

    await expect(cache.clear()).rejects.toBeInstanceOf(CloudflareUnsupportedError);
    expect(kv.entries.has('someone-elses')).toBe(true);
  });
});
