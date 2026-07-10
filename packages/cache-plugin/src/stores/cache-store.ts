/**
 * Internal CacheStore backend interface — lifecycle-aware adapter that
 * CacheService delegates to.
 *
 * NOT exported from `src/index.ts`. Mirrors the `IDatabaseAdapter` pattern
 * from the database-plugin: lifecycle methods (`connect`/`disconnect`/
 * `isReady`) plus cache operations.
 *
 * @module
 */

/**
 * Internal backend interface for cache store implementations.
 *
 * Each backend is constructed with the configured `prefix` (possibly empty)
 * so that `clear()` can scope to it. The four keyed ops receive already-
 * prefixed keys from CacheService.
 *
 * @internal
 */
export interface CacheStore {
  /** Establish the backend connection (if applicable). */
  connect(): Promise<void>;
  /** Gracefully disconnect. */
  disconnect(): Promise<void>;
  /** Reports whether the backend is ready for operations. */
  isReady(): boolean;

  /**
   * Read a value. The key is already-prefixed by CacheService.
   * @typeParam T - Expected value type
   * @param key - Already-prefixed cache key
   * @returns The deserialized value, or `null` when absent/expired
   */
  get<T>(key: string): Promise<T | null>;

  /**
   * Write a value. The key is already-prefixed by CacheService.
   * @typeParam T - Value type
   * @param key - Already-prefixed cache key
   * @param value - Value to store
   * @param ttlSeconds - Optional TTL in seconds
   */
  set<T>(key: string, value: T, ttlSeconds?: number): Promise<void>;

  /**
   * Delete a value. The key is already-prefixed by CacheService.
   * @param key - Already-prefixed cache key
   * @returns `true` if removed
   */
  delete(key: string): Promise<boolean>;

  /**
   * Check existence. The key is already-prefixed by CacheService.
   * @param key - Already-prefixed cache key
   * @returns `true` if present and unexpired
   */
  has(key: string): Promise<boolean>;

  /**
   * Remove all entries scoped to this backend's prefix.
   *
   * The prefix is provided at construction time (not per-call), so each
   * backend can scope the clear appropriately:
   * - Redis: `SCAN MATCH ${prefix}*` + batch DEL
   * - Memory: empty the internal map (each plugin instance owns its own
   *   map, so it naturally holds only this prefix's keys)
   */
  clear(): Promise<void>;
}
