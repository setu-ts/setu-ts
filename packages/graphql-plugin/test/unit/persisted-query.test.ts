/**
 * Tests for apq/persisted-query.ts
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { extractPersistedQuery, persistedQueryHash } from '../../src/apq/persisted-query.ts';

describe('extractPersistedQuery', () => {
  it('returns null when extensions is undefined', () => {
    expect(extractPersistedQuery(undefined)).toBeNull();
  });

  it('returns null when extensions is not an object', () => {
    // @ts-ignore -- intentional: test non-object input
    expect(extractPersistedQuery(null)).toBeNull();
  });

  it('returns null when persistedQuery is missing', () => {
    expect(extractPersistedQuery({})).toBeNull();
  });

  it('returns null when persistedQuery is null', () => {
    expect(extractPersistedQuery({ persistedQuery: null })).toBeNull();
  });

  it('returns null when persistedQuery is not an object', () => {
    expect(extractPersistedQuery({ persistedQuery: 'foo' })).toBeNull();
  });

  it('returns null when version is missing', () => {
    expect(extractPersistedQuery({
      persistedQuery: { sha256Hash: 'abc' },
    })).toBeNull();
  });

  it('returns null when version is not 1', () => {
    expect(extractPersistedQuery({
      persistedQuery: { version: 2, sha256Hash: 'abc' },
    })).toBeNull();
  });

  it('returns null when version is not a number', () => {
    expect(extractPersistedQuery({
      persistedQuery: { version: '1', sha256Hash: 'abc' },
    })).toBeNull();
  });

  it('returns null when sha256Hash is missing', () => {
    expect(extractPersistedQuery({
      persistedQuery: { version: 1 },
    })).toBeNull();
  });

  it('returns null when sha256Hash is empty', () => {
    expect(extractPersistedQuery({
      persistedQuery: { version: 1, sha256Hash: '' },
    })).toBeNull();
  });

  it('returns null when sha256Hash is not a string', () => {
    expect(extractPersistedQuery({
      persistedQuery: { version: 1, sha256Hash: 123 },
    })).toBeNull();
  });

  it('returns extracted info for valid v1 APQ', () => {
    const result = extractPersistedQuery({
      persistedQuery: { version: 1, sha256Hash: 'abc123' },
    });
    expect(result).not.toBeNull();
    expect(result!.version).toBe(1);
    expect(result!.sha256Hash).toBe('abc123');
  });
});

describe('persistedQueryHash', () => {
  it('produces deterministic SHA-256 hex hash', async () => {
    const subtle = globalThis.crypto.subtle;
    const hash = await persistedQueryHash('{ hello }', subtle);
    expect(typeof hash).toBe('string');
    expect(hash.length).toBe(64); // SHA-256 hex is 64 chars
    // Verify determinism
    const hash2 = await persistedQueryHash('{ hello }', subtle);
    expect(hash).toBe(hash2);
  });

  it('produces different hashes for different queries', async () => {
    const subtle = globalThis.crypto.subtle;
    const h1 = await persistedQueryHash('{ hello }', subtle);
    const h2 = await persistedQueryHash('{ world }', subtle);
    expect(h1).not.toBe(h2);
  });

  it('produces lowercase hex', async () => {
    const subtle = globalThis.crypto.subtle;
    const hash = await persistedQueryHash('{ hello }', subtle);
    expect(hash).toEqual(hash.toLowerCase());
    expect(/[0-9a-f]{64}/.test(hash)).toBe(true);
  });

  it('handles empty query', async () => {
    const subtle = globalThis.crypto.subtle;
    const hash = await persistedQueryHash('', subtle);
    expect(hash.length).toBe(64);
  });

  it('handles unicode query', async () => {
    const subtle = globalThis.crypto.subtle;
    const hash = await persistedQueryHash('{ ユニコード }', subtle);
    expect(hash.length).toBe(64);
  });
});
