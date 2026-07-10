/**
 * @module
 *
 * Caching plugin with Memory and Redis stores and cache middleware.
 *
 * Exports the plugin factory, service, store implementations, middleware,
 * and all public option types.
 */

// ── Plugin factory ──────────────────────────────────────────────────────────

/**
 * CachePlugin factory — registers an {@linkcode ICacheStore} under
 * `CAPABILITIES.CACHE`.
 */
export { CachePlugin } from './plugin/cache-plugin.ts';

// ── Service ─────────────────────────────────────────────────────────────────

/**
 * CacheService — wraps a backend CacheStore and applies key prefixing
 * and default TTL.
 */
export { CacheService } from './services/cache-service.ts';

// ── Store implementations ──────────────────────────────────────────────────

/**
 * In-memory cache with LRU eviction and per-entry TTL.
 */
export { MemoryStore } from './stores/memory-store.ts';

/**
 * Redis-backed cache using ioredis (lazy-loaded or injected).
 */
export { RedisStore } from './stores/redis-store.ts';

/**
 * No-op cache — all operations resolve immediately without effect.
 */
export { NoopStore } from './stores/noop-store.ts';

// ── Middleware ──────────────────────────────────────────────────────────────

/**
 * Transparent response-caching middleware.
 */
export { cacheMiddleware } from './middleware/cache-middleware.ts';

// ── Public types ────────────────────────────────────────────────────────────

/**
 * Supported cache store backend types (`'memory' | 'redis' | 'noop'`).
 */
export type { CacheStoreType } from './interfaces/index.ts';

/** Options for creating a cache store backend. */
export type { CacheStoreOptions } from './interfaces/index.ts';

/** Options for the CachePlugin factory. */
export type { CachePluginOptions } from './interfaces/index.ts';

/** Structural shape of an ioredis-compatible client. */
export type { IRedisClient } from './interfaces/index.ts';

/** Options for the transparent response-caching middleware. */
export type { CacheMiddlewareOptions } from './interfaces/index.ts';

/** Serializable cached response payload stored in the cache backend. */
export type { CachedResponsePayload } from './interfaces/index.ts';

// ── Re-exported from @hono-enterprise/common ────────────────────────────────

/**
 * The committed cache store interface (5 methods: get, set, delete, has, clear).
 */
export type { ICacheStore } from '@hono-enterprise/common';
