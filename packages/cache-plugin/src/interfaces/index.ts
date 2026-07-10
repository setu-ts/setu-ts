/**
 * Public interfaces and types for the cache plugin.
 *
 * @module
 */

import type { IRequestContext } from '@hono-enterprise/common';

/** Supported cache store backends. */
export type CacheStoreType = 'memory' | 'redis' | 'noop';

/**
 * Options for creating a cache store backend.
 *
 * @since 0.1.0
 */
export interface CacheStoreOptions {
  /** Redis connection URL (used when store is `'redis'`). */
  url?: string;
  /** Injected ioredis-compatible client (bypasses lazy import). */
  client?: IRedisClient;
  /** Key prefix applied to all cache keys. */
  prefix?: string;
  /** Default TTL in seconds when {@linkcode set} omits ttlSeconds. */
  defaultTtl?: number;
  /** Maximum entry count for MemoryStore LRU eviction. */
  maxSize?: number;
}

/**
 * Options for the CachePlugin factory.
 *
 * @example
 * ```typescript
 * import { CachePlugin } from '@hono-enterprise/cache-plugin';
 *
 * // Memory store (default)
 * app.register(CachePlugin());
 *
 * // Redis store with URL
 * app.register(CachePlugin({ store: 'redis', options: { url: 'redis://localhost:6379' } }));
 * ```
 * @since 0.1.0
 */
export interface CachePluginOptions {
  /** Store backend type. Defaults to `'memory'`. */
  store?: CacheStoreType;
  /**
   * Plugin instance name for multi-cache setups. Derives the capability
   * token as `cache.<name>` when not `'default'`.
   */
  name?: string;
  /** Store-specific options. */
  options?: CacheStoreOptions;
}

/**
 * Structural shape of an ioredis-compatible client. Used for validation and
 * injection so that the plugin does not hard-depend on ioredis.
 *
 * @since 0.1.0
 */
export interface IRedisClient {
  /** Get a string value by key. Returns `null` when missing. */
  get(key: string): Promise<string | null>;
  /** Set a key with optional TTL. */
  set(key: string, value: string, ttlMode?: 'EX', ttlSeconds?: number): Promise<string | null>;
  /** Delete one or more keys. Returns the count of removed keys. */
  del(...keys: string[]): Promise<number>;
  /** Check if a key exists. Returns `1` or `0`. */
  exists(key: string): Promise<number>;
  /**
   * Cursor-based scan. Returns `[cursor, keys[]]`. Use `'0'` to start
   * and continue until cursor returns `'0'`.
   */
  scan(cursor: string, matcher: string, matchValue?: string): Promise<[string, string[]]>;
  /** Gracefully close the connection. */
  quit(): Promise<void>;
  /** Establish the connection. */
  connect?(): Promise<void>;
}

/**
 * Options for the transparent response-caching middleware.
 *
 * @example
 * ```typescript
 * import { cacheMiddleware } from '@hono-enterprise/cache-plugin';
 *
 * app.router.use('/api/data', cacheMiddleware({ ttlSeconds: 300 }));
 * ```
 * @since 0.1.0
 */
export interface CacheMiddlewareOptions {
  /** Per-route TTL override in seconds. */
  ttlSeconds?: number;
  /**
   * Custom cache key generator. Defaults to
   * `${request.method}:${request.url}`.
   */
  key?: (ctx: IRequestContext) => string;
  /**
   * Bypass function — when `true`, skip caching entirely for this
   * request and pass through to the handler.
   */
  bypass?: (ctx: IRequestContext) => boolean;
  /**
   * Capability token for the cache store to use. Defaults to
   * `CAPABILITIES.CACHE`.
   */
  store?: string;
  /**
   * HTTP status codes eligible for caching. Defaults to `[200]`.
   */
  cacheableStatuses?: number[];
}

/**
 * Serializable cached response payload stored in the cache backend.
 * Body is base64-encoded when binary so that JSON-safe stores (Redis) can
 * persist it without corruption.
 *
 * @since 0.1.0
 */
export interface CachedResponsePayload {
  /** HTTP status code. */
  status: number;
  /** Headers as `[name, value]` pairs. */
  headers: Array<[string, string]>;
  /** Body content (decoded string or base64-encoded bytes). */
  body: string | null;
  /**
   * Present when the body was base64-encoded during storage. The replay
   * helper decodes it back to `Uint8Array`.
   */
  bodyEncoding?: 'base64';
}
