/**
 * Tests for document-cache.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DocumentCache } from '../../src/execution/document-cache.ts';

describe('DocumentCache', () => {
  it('caches and retrieves documents', () => {
    const cache = new DocumentCache(10);
    const entry = {
      document: { kind: 'Document', definitions: [] },
      validationErrors: null,
    };

    cache.set('query { hello }', entry);
    const retrieved = cache.get('query { hello }');

    expect(retrieved).toBe(entry);
  });

  it('returns undefined for cache miss', () => {
    const cache = new DocumentCache(10);
    const retrieved = cache.get('nonexistent');

    expect(retrieved).toBeUndefined();
  });

  it('evicts LRU entry at capacity', () => {
    const cache = new DocumentCache(2);

    cache.set('key1', { document: { kind: 'Document', definitions: [] }, validationErrors: null });
    cache.set('key2', { document: { kind: 'Document', definitions: [] }, validationErrors: null });
    cache.set('key3', { document: { kind: 'Document', definitions: [] }, validationErrors: null });

    expect(cache.get('key1')).toBeUndefined(); // Evicted
    expect(cache.get('key2')).toBeDefined();
    expect(cache.get('key3')).toBeDefined();
  });

  it('moves accessed entry to front', () => {
    const cache = new DocumentCache(2);

    cache.set('key1', { document: { kind: 'Document', definitions: [] }, validationErrors: null });
    cache.set('key2', { document: { kind: 'Document', definitions: [] }, validationErrors: null });
    cache.get('key1'); // Access key1
    cache.set('key3', { document: { kind: 'Document', definitions: [] }, validationErrors: null });

    expect(cache.get('key1')).toBeDefined(); // Not evicted
    expect(cache.get('key2')).toBeUndefined(); // Evicted
  });

  it('does not cache when size is 0', () => {
    const cache = new DocumentCache(0);

    cache.set('key1', { document: { kind: 'Document', definitions: [] }, validationErrors: null });
    expect(cache.get('key1')).toBeUndefined();
  });

  it('clears all entries', () => {
    const cache = new DocumentCache(10);

    cache.set('key1', { document: { kind: 'Document', definitions: [] }, validationErrors: null });
    cache.clear();

    expect(cache.get('key1')).toBeUndefined();
    expect(cache.size).toBe(0);
  });

  it('reports correct size', () => {
    const cache = new DocumentCache(10);

    expect(cache.size).toBe(0);
    cache.set('key1', { document: { kind: 'Document', definitions: [] }, validationErrors: null });
    expect(cache.size).toBe(1);
    cache.set('key2', { document: { kind: 'Document', definitions: [] }, validationErrors: null });
    expect(cache.size).toBe(2);
  });

  it('handles cache with no entries when evicting', () => {
    // Covers the branch where lruKey is undefined after keys().next()
    const cache = new DocumentCache(1);
    // Don't add any entries - just verify size is 0
    expect(cache.size).toBe(0);
    // set with maxSize=1 and no existing entries should not crash
    cache.set('key1', { document: { kind: 'Document', definitions: [] }, validationErrors: null });
    expect(cache.size).toBe(1);
  });
});
