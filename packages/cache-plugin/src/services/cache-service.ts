/**
 * CacheService — the registered `ICacheStore` that wraps a backend
 * `CacheStore` and applies key prefixing and default TTL.
 *
 * @module
 */
import type { ICacheStore } from '@hono-enterprise/common';
import type { CacheStore } from '../stores/cache-store.ts';

/**
 * Service layer that delegates to a backend `CacheStore` while applying:
 * - **Key prefix**: Prepended to all keyed operations (`get`/`set`/`delete`/
 *   `has`). The prefix is also passed to the backend at construction so that
 *   `clear()` can scope to it.
 * - **Default TTL**: Used when `set()` is called without `ttlSeconds`.
 *
 * @since 0.1.0
 */
export class CacheService implements ICacheStore {
  #backend: CacheStore;
  #prefix: string;
  #defaultTtl: number | undefined;

  /**
   * @param backend - The CacheStore backend implementation
   * @param prefix - Key prefix prepended to all keyed operations. Also passed
   *   to the backend constructor for `clear()` scoping.
   * @param defaultTtl - Default TTL in seconds applied when `set()` omits ttlSeconds
   */
  constructor(backend: CacheStore, prefix: string, defaultTtl?: number) {
    this.#backend = backend;
    this.#prefix = prefix;
    this.#defaultTtl = defaultTtl;
  }

  get<T>(key: string): Promise<T | null> {
    return this.#backend.get<T>(`${this.#prefix}${key}`);
  }

  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.#defaultTtl;
    return this.#backend.set<T>(`${this.#prefix}${key}`, value, ttl);
  }

  delete(key: string): Promise<boolean> {
    return this.#backend.delete(`${this.#prefix}${key}`);
  }

  has(key: string): Promise<boolean> {
    return this.#backend.has(`${this.#prefix}${key}`);
  }

  /**
   * Delegates to the backend's `clear()`, which uses the construction-time
   * prefix to scope the deletion. CacheService does not prepend a key here
   * since `clear()` takes no key argument.
   */
  clear(): Promise<void> {
    return this.#backend.clear();
  }
}
