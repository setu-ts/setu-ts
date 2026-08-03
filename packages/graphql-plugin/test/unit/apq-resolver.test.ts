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
      get: async <T>(key: string): Promise<T | null> => {
        const v = store.get(key);
        return v as T ?? null;
      },
      set: async <T>(key: string, value: T, _ttlSeconds?: number): Promise<void> => {
        store.set(key, value as unknown);
      },
      delete: async (key: string): Promise<boolean> => {
        return store.delete(key);
      },
      has: async (key: string): Promise<boolean> => {
        return store.has(key);
      },
      clear: async (): Promise<void> => {
        store.clear();
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
      get: async () => null,
      set: async <T>(_key: string, _value: T, ttlSeconds?: number) => {
        receivedTtl = ttlSeconds;
      },
      delete: async () => true,
      has: async () => false,
      clear: async () => {},
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
});
