/**
 * Cache store contract, implemented by the CachePlugin's stores (Memory,
 * Redis, Noop) under `CAPABILITIES.CACHE`.
 *
 * @module
 */

/**
 * Key/value cache with per-entry TTL.
 *
 * @example
 * ```typescript
 * const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
 * await cache.set('user:123', user, 3600);
 * const cached = await cache.get<User>('user:123');
 * ```
 * @since 0.1.0
 */
export interface ICacheStore {
  /**
   * Reads a cached value.
   *
   * @typeParam T - The expected value type
   * @param key - Cache key
   * @returns The value, or `null` when absent or expired
   */
  get<T>(key: string): Promise<T | null>;
  /**
   * Stores a value.
   *
   * @typeParam T - The value type
   * @param key - Cache key
   * @param value - Value to store
   * @param ttlSeconds - Time-to-live in seconds; omit for the store default
   */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;
  /**
   * Removes a cached value.
   *
   * @param key - Cache key
   * @returns `true` if an entry was removed
   */
  delete(key: string): Promise<boolean>;
  /**
   * Reports whether a live entry exists.
   *
   * @param key - Cache key
   * @returns `true` if present and unexpired
   */
  has(key: string): Promise<boolean>;
  /**
   * Removes every entry (respecting the store's key prefix, if configured).
   */
  clear(): Promise<void>;
}
