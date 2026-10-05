/**
 * Pins the published `@setu-ts/cache-plugin` surface (the M56 class: a test
 * that imports the concrete module stays green when the barrel drops an
 * export). M101a adds an option field, never an export, so the runtime set
 * is asserted exactly and the internal Redis helpers are asserted absent.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import * as cache from '../../src/index.ts';
import type {
  CacheDiagnosticsOptions,
  CachedResponsePayload,
  CacheMiddlewareOptions,
  CachePluginOptions,
  CacheStoreOptions,
  CacheStoreType,
  ICacheStore,
  IRedisClient,
} from '../../src/index.ts';

describe('cache-plugin barrel exports', () => {
  it('exports exactly the published runtime surface', () => {
    expect(Object.keys(cache).sort()).toEqual([
      'CachePlugin',
      'CacheService',
      'MemoryStore',
      'NoopStore',
      'RedisStore',
      'cacheMiddleware',
    ]);
  });

  it('keeps the Redis client construction helpers internal', () => {
    for (
      const name of [
        'createLazyRedisClient',
        'resolveCommandTimeoutMs',
        'DEFAULT_REDIS_COMMAND_TIMEOUT_MS',
      ]
    ) {
      expect(Object.hasOwn(cache, name)).toBe(false);
    }
  });

  it('exports the published types at compile time', () => {
    const store: CacheStoreType = 'redis';
    const options: CacheStoreOptions = { commandTimeoutMs: 1000 };
    const plugin: CachePluginOptions = { store, options };
    const types: ReadonlyArray<unknown> = [
      plugin,
      null as unknown as CacheDiagnosticsOptions,
      null as unknown as CacheMiddlewareOptions,
      null as unknown as CachedResponsePayload,
      null as unknown as ICacheStore,
      null as unknown as IRedisClient,
    ];
    expect(types).toHaveLength(6);
  });
});
