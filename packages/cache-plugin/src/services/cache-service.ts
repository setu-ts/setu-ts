/**
 * CacheService — the registered `ICacheStore` that wraps a backend
 * `CacheStore` and applies key prefixing and default TTL.
 *
 * @module
 */
import type { ICacheStore } from '@setu-ts/common';
import type { CacheStore } from '../stores/cache-store.ts';
import { cacheCoalescer } from './coalescer.ts';

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

  /**
   * Reads a cached value or produces and stores it once for all concurrent
   * callers of this service and key.
   *
   * The in-flight registry is cleared after either success or failure. A
   * rejected factory therefore leaves no poisoned entry and the next caller
   * gets a fresh attempt. The factory result is written with the same explicit
   * or default TTL resolution as {@linkcode set}.
   *
   * @typeParam T - Value type associated with `key`
   * @param key - Cache key without the service prefix
   * @param factory - Work that produces a value when the key is absent
   * @param ttlSeconds - Optional TTL override for the produced value
   * @returns The cached or newly-produced value
   * @since 0.5.0
   */
  async getOrSet<T>(
    key: string,
    factory: () => Promise<T>,
    ttlSeconds?: number,
  ): Promise<T> {
    const prefixedKey = `${this.#prefix}${key}`;
    const loaded = await cacheCoalescer.run(this.#backend, prefixedKey, async (): Promise<T> => {
      // The lookup belongs INSIDE the coalesced work. If it happened before
      // registration, two concurrent misses could both pass it before either
      // caller installed the in-flight entry.
      const cached = await this.get<T>(key);
      if (cached !== null) {
        return cached;
      }
      const value = await factory();
      await this.set(key, value, ttlSeconds);
      return value;
    });

    if (loaded.ok) {
      return loaded.value;
    }
    if (!loaded.joined) {
      throw loaded.error;
    }

    // A caller that joined a rejected leader cannot reuse its result. It runs
    // its own factory, matching the pre-coalescing failure behaviour.
    const value = await factory();
    await this.set(key, value, ttlSeconds);
    return value;
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
