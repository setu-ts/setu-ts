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
 * A3: Uses Map.delete + Map.set for O(1) access and reordering.
 */
export class DocumentCache {
  #cache: Map<string, CacheEntry>;
  #maxSize: number;

  constructor(maxSize: number) {
    this.#maxSize = maxSize;
    this.#cache = new Map();
  }

  /**
   * Get a cached entry, moving it to the front (most recently used).
   * A3: O(1) using Map.delete + Map.set.
   */
  get(key: string): CacheEntry | undefined {
    const entry = this.#cache.get(key);
    if (entry) {
      // A3: Move to front by deleting and re-inserting (O(1))
      this.#cache.delete(key);
      this.#cache.set(key, entry);
    }
    return entry;
  }

  /**
   * Set a cached entry, evicting LRU if at capacity.
   * A3: O(1) using Map operations.
   */
  set(key: string, entry: CacheEntry): void {
    if (this.#maxSize === 0) {
      return; // Cache disabled
    }

    // If already exists, delete and re-insert to move to front
    if (this.#cache.has(key)) {
      this.#cache.delete(key);
    } else if (this.#cache.size >= this.#maxSize) {
      // Evict LRU (first entry in Map iteration order)
      const lruKey = this.#cache.keys().next().value;
      if (lruKey !== undefined) {
        this.#cache.delete(lruKey);
      }
    }

    this.#cache.set(key, entry);
  }

  /**
   * Clear all cached entries.
   */
  clear(): void {
    this.#cache.clear();
  }

  /**
   * Current number of cached entries.
   */
  get size(): number {
    return this.#cache.size;
  }
}
