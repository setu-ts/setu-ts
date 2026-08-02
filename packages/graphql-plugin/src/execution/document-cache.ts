/**
 * Bounded LRU document cache for parse+validate results.
 *
 * @module
 */

import type {
  GraphqlDocumentNodeLike,
  GraphqlGraphQLErrorLike,
} from '../interfaces/graphql-runtime.ts';

/**
 * Cached document entry.
 */
interface CacheEntry {
  document: GraphqlDocumentNodeLike;
  validationErrors: GraphqlGraphQLErrorLike[] | null;
}

/**
 * A bounded LRU cache for parsed and validated documents.
 */
export class DocumentCache {
  #cache: Map<string, CacheEntry>;
  #order: string[];
  #maxSize: number;

  constructor(maxSize: number) {
    this.#maxSize = maxSize;
    this.#cache = new Map();
    this.#order = [];
  }

  /**
   * Get a cached entry, moving it to the front (most recently used).
   */
  get(key: string): CacheEntry | undefined {
    const entry = this.#cache.get(key);
    if (entry) {
      // Move to front
      this.#order = this.#order.filter((k) => k !== key);
      this.#order.unshift(key);
    }
    return entry;
  }

  /**
   * Set a cached entry, evicting LRU if at capacity.
   */
  set(key: string, entry: CacheEntry): void {
    if (this.#maxSize === 0) {
      return; // Cache disabled
    }

    // If already exists, remove old entry
    if (this.#cache.has(key)) {
      this.#order = this.#order.filter((k) => k !== key);
    } else if (this.#cache.size >= this.#maxSize) {
      // Evict LRU (last in order array)
      const lruKey = this.#order[this.#order.length - 1];
      this.#cache.delete(lruKey);
      this.#order.pop();
    }

    this.#cache.set(key, entry);
    this.#order.unshift(key);
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.#cache.clear();
    this.#order = [];
  }

  /**
   * Current number of cached entries.
   */
  get size(): number {
    return this.#cache.size;
  }
}
