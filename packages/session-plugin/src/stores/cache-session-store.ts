/**
 * Cache-backed session store.
 *
 * Reaches the cache through `CAPABILITIES.CACHE` rather than importing
 * `cache-plugin` (AI_GUIDELINES §2.2/§3.3), so it works over whichever cache
 * store the application registered — memory, Redis, or a custom one — and adds
 * no dependency of its own.
 *
 * @module
 */
import type { ICacheStore, ISessionStore, SessionData } from '@setu-ts/common';

/** Default namespace for session keys inside the shared cache. */
const DEFAULT_PREFIX = 'session:';

/**
 * Options for {@linkcode CacheSessionStore}.
 *
 * @since 0.2.0
 */
export interface CacheSessionStoreOptions {
  /**
   * Key namespace inside the cache. Default `'session:'`.
   *
   * Sessions share the cache with application data, so they share its blast
   * radius: a `clear()` from elsewhere logs everybody out. The prefix keeps the
   * keys identifiable; a dedicated cache instance is the production answer.
   */
  readonly keyPrefix?: string;
}

/**
 * {@linkcode ISessionStore} over any `ICacheStore`.
 *
 * @example
 * ```typescript
 * // Registered for you by the plugin:
 * SessionPlugin({ secret, store: 'cache' });
 * ```
 * @since 0.2.0
 */
export class CacheSessionStore implements ISessionStore {
  readonly #cache: ICacheStore;
  readonly #prefix: string;

  /**
   * @param cache - The cache resolved from `CAPABILITIES.CACHE`
   * @param options - Namespacing options
   */
  constructor(cache: ICacheStore, options: CacheSessionStoreOptions = {}) {
    this.#cache = cache;
    this.#prefix = options.keyPrefix ?? DEFAULT_PREFIX;
  }

  async read(id: string): Promise<SessionData | null> {
    return await this.#cache.get<SessionData>(this.#key(id));
  }

  async write(id: string, data: SessionData, ttlMs: number): Promise<void> {
    // ICacheStore's TTL is in SECONDS while ISessionStore's is in milliseconds.
    // Rounded up so a sub-second remainder never truncates to a 0 TTL, which
    // several cache backends read as "no expiry" rather than "already expired".
    await this.#cache.set(this.#key(id), data, Math.max(1, Math.ceil(ttlMs / 1000)));
  }

  async destroy(id: string): Promise<boolean> {
    return await this.#cache.delete(this.#key(id));
  }

  async isHealthy(): Promise<boolean> {
    // A `has` against a key that will not exist still exercises the connection,
    // which is the part worth reporting on.
    try {
      await this.#cache.has(this.#key('__health'));
      return true;
    } catch {
      return false;
    }
  }

  /** Namespaces a session id into a cache key. */
  #key(id: string): string {
    return `${this.#prefix}${id}`;
  }
}
