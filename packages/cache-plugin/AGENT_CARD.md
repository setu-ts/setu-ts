# @setu-ts/cache-plugin — caching with memory, Redis and no-op stores

`setu add cache` adds the dependency and installs — zero-configuration, so the bare `CachePlugin()`
call is inserted. It provides `CAPABILITIES.CACHE` and a health indicator.

```ts
import { CachePlugin } from '@setu-ts/cache-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { ICacheStore } from '@setu-ts/common';

export function createCachedApp() {
  const app = createApplication({
    plugins: [RuntimePlugin(), CachePlugin({ options: { defaultTtl: 60 } })],
  });
  app.router.get('/users/:id', async (ctx) => {
    const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
    const cached = await cache.get<{ id: string }>(`user:${ctx.params.id ?? ''}`);
    return ctx.response.json(cached ?? { id: ctx.params.id });
  });
  return app;
}
```

```ts
import { CacheService } from '@setu-ts/cache-plugin';
import { CAPABILITIES } from '@setu-ts/common';
import type { IServiceRegistry } from '@setu-ts/common';

export function profileLoader(services: IServiceRegistry, id: string) {
  const cache = services.get<CacheService>(CAPABILITIES.CACHE);
  return cache.getOrSet(`profile:${id}`, async () => ({ id }), 60);
}
```

- `store` is `'memory'` (default; LRU with per-entry TTL), `'redis'` (over `ioredis`) or `'noop'`.
  Under `options`: `url` and `client` configure Redis, `prefix` namespaces keys, `defaultTtl` is
  seconds and `maxSize` bounds the LRU.
- `get` resolves to `null` when absent or expired; `set(key, value, ttlSeconds?)` overrides the
  default TTL; `delete`, `has` and `clear` complete the contract.
- `name` other than `'default'` derives the capability token `cache.<name>`, so several caches
  coexist; point `cacheMiddleware`'s `store` at that token.
- Resolve the concrete `CacheService` for `getOrSet`, which coalesces concurrent cold reads of one
  key; a rejected leader leaves no entry, so callers retry their own factory.
- `cacheMiddleware({ ttlSeconds, key, vary, bypass, store, cacheableStatuses })` caches whole
  responses (`200` only by default); streaming ones are never replayed.
- Redis `options.commandTimeoutMs` defaults to `15000` (`0` disables it); an out-of-range value
  throws RangeError. Connection faults throw `CacheStoreUnavailableError` (503 under
  `errorHandler`).
- `diagnostics: { enabled: true, alias }` counts this instance's operations; `enabled` must be the
  literal `true`.
