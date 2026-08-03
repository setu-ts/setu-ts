/**
 * APQ (Automatic Persisted Queries) resolver.
 *
 * Handles the hash→document map over {@linkcode ICacheStore} with a bounded
 * in-memory LRU fallback when the cache capability is absent.
 *
 * @module
 * @since 0.3.0
 */

import type { ICacheStore } from '@hono-enterprise/common';
import { extractPersistedQuery, persistedQueryHash } from './persisted-query.ts';

/** Error code for a missing cached document. */
const NOT_FOUND = 'PERSISTED_QUERY_NOT_FOUND';
/** Error code for a hash that does not match the query. */
const HASH_MISMATCH = 'PERSISTED_QUERY_HASH_MISMATCH';

/**
 * The result of resolving APQ for a request.
 */
export type ApqResolveResult =
  | { ok: true; query: string }
  | { ok: false; message: string; code: string; status: number };

/**
 * Bounded in-memory LRU using insertion-order eviction.
 *
 * When `CAPABILITIES.CACHE` is absent, this keeps APQ working gracefully
 * rather than requiring a hard dependency.
 */
class InMemoryLru {
  #map = new Map<string, string>();
  #maxEntries: number;

  constructor(maxEntries: number) {
    this.#maxEntries = maxEntries;
  }

  async get(key: string): Promise<string | null> {
    const value = this.#map.get(key);
    if (value === undefined) {
      return null;
    }
    // Move to end (most recently used)
    this.#map.delete(key);
    this.#map.set(key, value);
    return value;
  }

  async set(key: string, value: string): Promise<void> {
    this.#map.delete(key); // remove old entry if present
    if (this.#map.size >= this.#maxEntries) {
      // Evict oldest (first key)
      const oldest = this.#map.keys().next().value;
      if (oldest !== undefined) {
        this.#map.delete(oldest);
      }
    }
    this.#map.set(key, value);
  }

  async has(key: string): Promise<boolean> {
    return this.#map.has(key);
  }
}

/** Unified store interface for both paths. */
interface ApqStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds?: number): Promise<void>;
}

/**
 * APQ resolver that verifies hashes before caching.
 */
export class ApqResolver {
  #store: ApqStore;
  #subtle: SubtleCrypto;
  #ttlSeconds: number;

  constructor(
    store: ICacheStore | null,
    subtle: SubtleCrypto,
    options: { ttlSeconds?: number; maxEntries?: number },
  ) {
    if (store !== null) {
      this.#store = store;
    } else {
      this.#store = new InMemoryLru(options.maxEntries ?? 1000);
    }
    this.#subtle = subtle;
    this.#ttlSeconds = options.ttlSeconds ?? 300;
  }

  /**
   * Resolve APQ for a request.
   *
   * @param params - The request parameters (may carry extensions)
   * @returns The resolved query or a refusal
   */
  async resolve(params: {
    query?: string;
    extensions?: Record<string, unknown>;
  }): Promise<ApqResolveResult> {
    const pqInfo = extractPersistedQuery(params.extensions);

    // No APQ info — pass through unchanged
    if (pqInfo === null) {
      if (params.query === undefined) {
        return {
          ok: false,
          message: 'Query is required when no persisted query info is present',
          code: NOT_FOUND,
          status: 400,
        };
      }
      return { ok: true, query: params.query };
    }

    const { sha256Hash } = pqInfo;

    // Request carries both a query and a hash — verify
    if (params.query !== undefined && params.query.length > 0) {
      const computedHash = await persistedQueryHash(params.query, this.#subtle);
      if (computedHash !== sha256Hash) {
        return {
          ok: false,
          message: 'Persisted query hash mismatch',
          code: HASH_MISMATCH,
          status: 400,
        };
      }
      // Hash matches — persist
      await this.#store.set(`apq:${sha256Hash}`, params.query, this.#ttlSeconds);
      return { ok: true, query: params.query };
    }

    // Hash-only request — lookup
    const cached = await this.#store.get(`apq:${sha256Hash}`);
    if (cached === null) {
      return {
        ok: false,
        message: 'PersistedQueryNotFound',
        code: NOT_FOUND,
        status: 400,
      };
    }
    return { ok: true, query: cached };
  }
}
