/**
 * Tests for apq/apq-resolver.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { ApqResolver } from '../../src/apq/apq-resolver.ts';
import { persistedQueryHash } from '../../src/apq/persisted-query.ts';
import type { ICacheStore } from '@hono-enterprise/common';

const subtle = globalThis.crypto.subtle;

describe('ApqResolver', () => {
  function createFakeCacheStore(): ICacheStore {
    const store = new Map<string, unknown>();
    return {
      get: <T>(key: string): Promise<T | null> => {
        const v = store.get(key);
        return Promise.resolve((v as T) ?? null);
      },
      set: <T>(key: string, value: T, _ttlSeconds?: number): Promise<void> => {
        store.set(key, value as unknown);
        return Promise.resolve();
      },
      delete: (key: string): Promise<boolean> => {
        return Promise.resolve(store.delete(key));
      },
      has: (key: string): Promise<boolean> => {
        return Promise.resolve(store.has(key));
      },
      clear: (): Promise<void> => {
        store.clear();
        return Promise.resolve();
      },
    };
  }

  it('passes through when no APQ extensions', async () => {
    const resolver = new ApqResolver(createFakeCacheStore(), subtle, {});
    const result = await resolver.resolve({ query: '{ hello }' });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.query).toBe('{ hello }');
  });

  it('passes through query when extensions has no persistedQuery', async () => {
    const resolver = new ApqResolver(createFakeCacheStore(), subtle, {});
    const result = await resolver.resolve({
      query: '{ hello }',
      extensions: { other: 'data' },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.query).toBe('{ hello }');
  });

  it('persists and returns on verified query+hash', async () => {
    const cacheStore = createFakeCacheStore();
    const resolver = new ApqResolver(cacheStore, subtle, {});
    const query = '{ hello }';
    const hash = await persistedQueryHash(query, subtle);
    const result = await resolver.resolve({
      query,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.query).toBe(query);

    // Verify cache entry was created
    const cached = await cacheStore.get<string>(`apq:${hash}`);
    expect(cached).toBe(query);
  });

  it('returns PERSISTED_QUERY_HASH_MISMATCH on bad hash', async () => {
    const resolver = new ApqResolver(createFakeCacheStore(), subtle, {});
    const result = await resolver.resolve({
      query: '{ hello }',
      extensions: { persistedQuery: { version: 1, sha256Hash: 'badhash' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PERSISTED_QUERY_HASH_MISMATCH');
      expect(result.status).toBe(400);
    }
  });

  it('returns cached document on hash-only hit', async () => {
    const cacheStore = createFakeCacheStore();
    const resolver = new ApqResolver(cacheStore, subtle, {});
    const query = '{ hello }';
    const hash = await persistedQueryHash(query, subtle);

    // Pre-populate cache
    await cacheStore.set(`apq:${hash}`, query);

    const result = await resolver.resolve({
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.query).toBe(query);
  });

  it('returns PERSISTED_QUERY_NOT_FOUND on hash-only miss', async () => {
    const resolver = new ApqResolver(createFakeCacheStore(), subtle, {});
    const result = await resolver.resolve({
      extensions: { persistedQuery: { version: 1, sha256Hash: 'unknown-hash' } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('PERSISTED_QUERY_NOT_FOUND');
      expect(result.status).toBe(400);
    }
  });

  it('refuses when query is undefined and no APQ info', async () => {
    const resolver = new ApqResolver(createFakeCacheStore(), subtle, {});
    const result = await resolver.resolve({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.status).toBe(400);
    }
  });

  it('uses in-memory LRU when no cache store', async () => {
    const resolver = new ApqResolver(null, subtle, { maxEntries: 2 });
    const query = '{ hello }';
    const hash = await persistedQueryHash(query, subtle);

    // Persist
    let result = await resolver.resolve({
      query,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    });
    expect(result.ok).toBe(true);

    // Hit
    result = await resolver.resolve({
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.query).toBe(query);
  });

  it('evicts oldest entry when maxEntries exceeded', async () => {
    const resolver = new ApqResolver(null, subtle, { maxEntries: 2 });

    // Insert two entries
    const q1 = '{ a }';
    const h1 = await persistedQueryHash(q1, subtle);
    await resolver.resolve({
      query: q1,
      extensions: { persistedQuery: { version: 1, sha256Hash: h1 } },
    });

    const q2 = '{ b }';
    const h2 = await persistedQueryHash(q2, subtle);
    await resolver.resolve({
      query: q2,
      extensions: { persistedQuery: { version: 1, sha256Hash: h2 } },
    });

    // Third entry should evict q1
    const q3 = '{ c }';
    const h3 = await persistedQueryHash(q3, subtle);
    await resolver.resolve({
      query: q3,
      extensions: { persistedQuery: { version: 1, sha256Hash: h3 } },
    });

    // q1 should be evicted
    let result = await resolver.resolve({
      extensions: { persistedQuery: { version: 1, sha256Hash: h1 } },
    });
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('PERSISTED_QUERY_NOT_FOUND');

    // q2 and q3 should still be present
    result = await resolver.resolve({
      extensions: { persistedQuery: { version: 1, sha256Hash: h2 } },
    });
    expect(result.ok).toBe(true);

    result = await resolver.resolve({
      extensions: { persistedQuery: { version: 1, sha256Hash: h3 } },
    });
    expect(result.ok).toBe(true);
  });

  it('passes ttlSeconds to cache store set', async () => {
    let receivedTtl: number | undefined;
    const cacheStore: ICacheStore = {
      get: () => Promise.resolve(null),
      set: <T>(_key: string, _value: T, ttlSeconds?: number) => {
        receivedTtl = ttlSeconds;
        return Promise.resolve();
      },
      delete: () => Promise.resolve(true),
      has: () => Promise.resolve(false),
      clear: () => Promise.resolve(),
    };
    const resolver = new ApqResolver(cacheStore, subtle, { ttlSeconds: 600 });
    const query = '{ hello }';
    const hash = await persistedQueryHash(query, subtle);
    await resolver.resolve({
      query,
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    });
    expect(receivedTtl).toBe(600);
  });

  it('treats an empty-string query with a hash as hash-only (lookup, not verify)', async () => {
    // The branch `params.query !== undefined && params.query.length > 0` is
    // false for `''`, so the resolver falls through to the hash-only lookup.
    const cacheStore = createFakeCacheStore();
    const resolver = new ApqResolver(cacheStore, subtle, {});
    const query = '{ hello }';
    const hash = await persistedQueryHash(query, subtle);
    await cacheStore.set(`apq:${hash}`, query);

    const result = await resolver.resolve({
      query: '',
      extensions: { persistedQuery: { version: 1, sha256Hash: hash } },
    });
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.query).toBe(query);
  });

  it('returns BAD_REQUEST when query is undefined and no APQ info (N3)', async () => {
    // N3: missing query without persisted-query extensions is a bad request,
    // not a persisted-query-not-found.
    const resolver = new ApqResolver(createFakeCacheStore(), subtle, {});
    const result = await resolver.resolve({});
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.code).toBe('BAD_REQUEST');
      expect(result.status).toBe(400);
    }
  });

  it('InMemoryLru.has() returns true for existing keys and false for missing keys', async () => {
    const resolver = new ApqResolver(null, subtle, { maxEntries: 2 });
    const q1 = '{ a }';
    const h1 = await persistedQueryHash(q1, subtle);

    // Pre-populate via resolve
    await resolver.resolve({
      query: q1,
      extensions: { persistedQuery: { version: 1, sha256Hash: h1 } },
    });

    // Access the internal LRU store via the resolver's resolve path to confirm has() works.
    // We verify by checking that the key is present via a hash-only lookup.
    const r = await resolver.resolve({
      extensions: { persistedQuery: { version: 1, sha256Hash: h1 } },
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.query).toBe(q1);

    // A non-existent hash should miss
    const r2 = await resolver.resolve({
      extensions: { persistedQuery: { version: 1, sha256Hash: 'nonexistent' } },
    });
    expect(r2.ok).toBe(false);
  });

  it('InMemoryLru re-orders on get so the most-recently-used survives eviction', async () => {
    const resolver = new ApqResolver(null, subtle, { maxEntries: 2 });
    const q1 = '{ a }';
    const h1 = await persistedQueryHash(q1, subtle);
    const q2 = '{ b }';
    const h2 = await persistedQueryHash(q2, subtle);

    await resolver.resolve({
      query: q1,
      extensions: { persistedQuery: { version: 1, sha256Hash: h1 } },
    });
    await resolver.resolve({
      query: q2,
      extensions: { persistedQuery: { version: 1, sha256Hash: h2 } },
    });

    // Touch q1 so q2 becomes the LRU candidate.
    let r = await resolver.resolve({
      extensions: { persistedQuery: { version: 1, sha256Hash: h1 } },
    });
    expect(r.ok).toBe(true);

    // Inserting a third entry evicts q2 (the least-recently-used), not q1.
    const q3 = '{ c }';
    const h3 = await persistedQueryHash(q3, subtle);
    await resolver.resolve({
      query: q3,
      extensions: { persistedQuery: { version: 1, sha256Hash: h3 } },
    });

    r = await resolver.resolve({
      extensions: { persistedQuery: { version: 1, sha256Hash: h1 } },
    });
    expect(r.ok).toBe(true); // q1 survived
    r = await resolver.resolve({
      extensions: { persistedQuery: { version: 1, sha256Hash: h2 } },
    });
    expect(r.ok).toBe(false); // q2 evicted
    if (!r.ok) expect(r.code).toBe('PERSISTED_QUERY_NOT_FOUND');
  });
});
