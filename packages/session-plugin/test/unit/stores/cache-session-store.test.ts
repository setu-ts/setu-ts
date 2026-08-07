/**
 * Unit tests for the cache-backed session store.
 *
 * Driven against a recording `ICacheStore`, because the behaviour that matters is
 * the translation between the two contracts — `ISessionStore`'s TTL is in
 * milliseconds and `ICacheStore`'s is in seconds, so the conversion is asserted
 * from the recorded call rather than assumed.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { ICacheStore } from '@setu-ts/common';

import { CacheSessionStore } from '../../../src/stores/cache-session-store.ts';

/** Records every call the store makes into the cache. */
class RecordingCache implements ICacheStore {
  readonly values = new Map<string, unknown>();
  readonly calls: string[] = [];
  failOnHas = false;

  get<T>(key: string): Promise<T | null> {
    this.calls.push(`get:${key}`);
    return Promise.resolve((this.values.get(key) ?? null) as T | null);
  }

  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    this.calls.push(`set:${key}:${ttlSeconds}`);
    this.values.set(key, value);
    return Promise.resolve();
  }

  delete(key: string): Promise<boolean> {
    this.calls.push(`delete:${key}`);
    return Promise.resolve(this.values.delete(key));
  }

  has(key: string): Promise<boolean> {
    this.calls.push(`has:${key}`);
    if (this.failOnHas) {
      return Promise.reject(new Error('cache unreachable'));
    }
    return Promise.resolve(this.values.has(key));
  }

  clear(): Promise<void> {
    this.values.clear();
    return Promise.resolve();
  }
}

describe('CacheSessionStore', () => {
  it('reads back what it writes', async () => {
    const cache = new RecordingCache();
    const store = new CacheSessionStore(cache);

    await store.write('s-1', { userId: 'u-1' }, 60_000);
    expect(await store.read('s-1')).toEqual({ userId: 'u-1' });
  });

  it('converts a millisecond TTL to whole seconds', async () => {
    const cache = new RecordingCache();
    const store = new CacheSessionStore(cache);

    await store.write('s-1', {}, 60_000);
    expect(cache.calls).toContain('set:session:s-1:60');
  });

  it('rounds a fractional second up', async () => {
    const cache = new RecordingCache();
    const store = new CacheSessionStore(cache);

    await store.write('s-1', {}, 1_500);
    expect(cache.calls).toContain('set:session:s-1:2');
  });

  it('never writes a zero TTL, which some backends read as "no expiry"', async () => {
    const cache = new RecordingCache();
    const store = new CacheSessionStore(cache);

    await store.write('s-1', {}, 0);
    expect(cache.calls).toContain('set:session:s-1:1');

    await store.write('s-2', {}, 400);
    expect(cache.calls).toContain('set:session:s-2:1');
  });

  it('namespaces keys so sessions are identifiable in a shared cache', async () => {
    const cache = new RecordingCache();
    const store = new CacheSessionStore(cache);

    await store.read('s-1');
    expect(cache.calls).toContain('get:session:s-1');
  });

  it('honours a custom key prefix', async () => {
    const cache = new RecordingCache();
    const store = new CacheSessionStore(cache, { keyPrefix: 'app:sess:' });

    await store.write('s-1', {}, 1_000);
    await store.read('s-1');
    await store.destroy('s-1');

    expect(cache.calls).toEqual([
      'set:app:sess:s-1:1',
      'get:app:sess:s-1',
      'delete:app:sess:s-1',
    ]);
  });

  it('returns null for an absent session', async () => {
    const store = new CacheSessionStore(new RecordingCache());
    expect(await store.read('nope')).toBe(null);
  });

  it('reports whether an entry was deleted', async () => {
    const cache = new RecordingCache();
    const store = new CacheSessionStore(cache);

    await store.write('s-1', {}, 1_000);
    expect(await store.destroy('s-1')).toBe(true);
    expect(await store.destroy('s-1')).toBe(false);
  });

  it('reports healthy when the cache responds', async () => {
    const store = new CacheSessionStore(new RecordingCache());
    expect(await store.isHealthy()).toBe(true);
  });

  it('reports unhealthy when the cache throws', async () => {
    const cache = new RecordingCache();
    cache.failOnHas = true;
    const store = new CacheSessionStore(cache);

    // An unreachable cache must be reported, not propagated as a request error.
    expect(await store.isHealthy()).toBe(false);
  });
});
