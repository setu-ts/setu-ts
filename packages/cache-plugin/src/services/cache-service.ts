/**
 * CacheService — the registered `ICacheStore` that wraps a backend
 * `CacheStore` and applies key prefixing and default TTL.
 *
 * @module
 */
import type { ICacheStore } from '@setu-ts/common';
import type { CacheStore } from '../stores/cache-store.ts';
import { cacheCoalescer } from './coalescer.ts';
import {
  type CacheObservationCollector,
  observeCacheCall,
} from '../diagnostics/cache-observations.ts';

/** Writes a service's private collector slot; bound in the class's static block. */
let writeCollector: (
  service: CacheService,
  collector: CacheObservationCollector | undefined,
) => void;

/**
 * Service layer that delegates to a backend `CacheStore` while applying:
 * - **Key prefix**: Prepended to all keyed operations (`get`/`set`/`delete`/
 *   `has`). The prefix is also passed to the backend at construction so that
 *   `clear()` can scope to it.
 * - **Default TTL**: Used when `set()` is called without `ttlSeconds`.
 *
 * When its CachePlugin was opted into diagnostics (M98i), each backend call
 * is additionally counted — `getOrSet`'s internal `get` and `set` included.
 * A service constructed directly carries no collector and runs unobserved.
 *
 * @since 0.1.0
 */
export class CacheService implements ICacheStore {
  #backend: CacheStore;
  #prefix: string;
  #defaultTtl: number | undefined;
  /**
   * The M98i collector, set only by the owning CachePlugin through
   * {@linkcode attachCacheCollector}. `undefined` means unobserved: each
   * operation then calls its backend directly, exactly as before M98i, and
   * the only added work is this field read.
   */
  #collector: CacheObservationCollector | undefined = undefined;

  static {
    writeCollector = (service, collector) => {
      service.#collector = collector;
    };
  }

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
    const prefixed = `${this.#prefix}${key}`;
    const collector = this.#collector;
    return collector === undefined
      ? this.#backend.get<T>(prefixed)
      : observeCacheCall(collector, 'get', () => this.#backend.get<T>(prefixed));
  }

  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void> {
    const ttl = ttlSeconds ?? this.#defaultTtl;
    const prefixed = `${this.#prefix}${key}`;
    const collector = this.#collector;
    return collector === undefined
      ? this.#backend.set<T>(prefixed, value, ttl)
      : observeCacheCall(collector, 'set', () => this.#backend.set<T>(prefixed, value, ttl));
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
    const prefixed = `${this.#prefix}${key}`;
    const collector = this.#collector;
    return collector === undefined
      ? this.#backend.delete(prefixed)
      : observeCacheCall(collector, 'delete', () => this.#backend.delete(prefixed));
  }

  has(key: string): Promise<boolean> {
    const prefixed = `${this.#prefix}${key}`;
    const collector = this.#collector;
    return collector === undefined
      ? this.#backend.has(prefixed)
      : observeCacheCall(collector, 'has', () => this.#backend.has(prefixed));
  }

  /**
   * Delegates to the backend's `clear()`, which uses the construction-time
   * prefix to scope the deletion. CacheService does not prepend a key here
   * since `clear()` takes no key argument.
   */
  clear(): Promise<void> {
    const collector = this.#collector;
    return collector === undefined
      ? this.#backend.clear()
      : observeCacheCall(collector, 'clear', () => this.#backend.clear());
  }
}

/**
 * Attaches the owning plugin's collector to its service (M98i). INTERNAL:
 * not exported from the package barrel, so application code cannot observe
 * or replace a service's collector.
 *
 * @param service - The plugin-owned service
 * @param collector - Its collector
 * @internal
 */
export function attachCacheCollector(
  service: CacheService,
  collector: CacheObservationCollector,
): void {
  writeCollector(service, collector);
}

/**
 * Detaches a service's collector. The plugin's close hook detaches FIRST and
 * then clears the collector, so no late call is observed.
 *
 * @param service - The plugin-owned service
 * @internal
 */
export function detachCacheCollector(service: CacheService): void {
  writeCollector(service, undefined);
}
