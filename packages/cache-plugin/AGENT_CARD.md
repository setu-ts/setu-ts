# @setu-ts/cache-plugin — response and value caching

**Add it:** `setu add cache` adds it and inserts `CachePlugin()` (in-memory store) into
`setu.config.ts`. It provides `CAPABILITIES.CACHE` (`ICacheStore`) and a health indicator.

## Cache a route's response

Put `cacheMiddleware` on the route, in the module's routes file:

```ts
import type { IRouterApi } from '@setu-ts/common';
import { cacheMiddleware } from '@setu-ts/cache-plugin';

export function registerProductRoutes(router: IRouterApi): void {
  router.get('/products', {
    middleware: [cacheMiddleware({ ttlSeconds: 60 })],
    handler: (ctx) => ctx.response.json([{ id: 'p1', name: 'Pen' }]),
  });
}
```

## Cache a value

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { ICacheStore } from '@setu-ts/common';

const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
await cache.set('rates', { eur: 1.1 }, 300);
const rates = await cache.get<{ eur: number }>('rates');
```

## Behaviour the types do not show

- The middleware sets `X-Cache` itself: `MISS` when the handler ran, `HIT` when replayed,
  `COALESCED` when a concurrent miss shared one handler run. Do not set it in the handler.
- Only status `200` is stored by default (`cacheableStatuses` changes that); streamed responses and
  responses setting a cookie are never stored. The key is the method and URL, plus the tenant and
  locale when those are resolved.
- `get` returns `null` for an absent or expired key, never `undefined`.
- `ttlSeconds` is seconds; omitted, the store's `defaultTtl` applies.
- `CAPABILITIES.CACHE` resolves only after `app.start()`; inside a handler `ctx.services` is ready.

## Other options

- `CachePlugin({ store: 'redis', options: { url } })` uses Redis (install `ioredis`); `'noop'`
  disables caching. `options`: `prefix`, `defaultTtl`, `maxSize`, `commandTimeoutMs`.
- `cacheMiddleware` also takes `key(ctx)`, `vary(ctx)`, `bypass(ctx)` and `store` (a named instance:
  `CachePlugin({ name: 'pages' })` registers `cache.pages`).
- `CacheService.getOrSet(key, factory, ttl)` coalesces concurrent cold reads of one key.

<!-- card-allow: X MISS HIT COALESCED key vary bypass -->
