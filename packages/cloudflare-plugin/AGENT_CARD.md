# @setu-ts/cloudflare-plugin — use Workers bindings

**Add it:** on Workers, `setu add cloudflare` registers it and renames `_waitUntil` to `waitUntil`,
or prints both steps. `CloudflarePlugin` provides `CAPABILITIES.CLOUDFLARE` (`ICloudflareBindings`),
plus the capabilities selected by its arms.

## Register platform cache and storage

Call it from the Workers composition; put the result in the config's plugins array:

```ts
import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';
import type { CloudflareWorkerEnv, WaitUntilHost } from '@setu-ts/cloudflare-plugin';

export function bindings(env: CloudflareWorkerEnv, waitUntil: WaitUntilHost) {
  return CloudflarePlugin({
    env,
    waitUntil,
    requireBindings: ['CACHE_KV', 'UPLOADS'],
    cache: { binding: 'CACHE_KV', prefix: 'cache:', defaultTtlSeconds: 60 },
    storage: { binding: 'UPLOADS' },
  });
}
```

## Cache a public route at the edge

```ts
import type { IRouterApi } from '@setu-ts/common';
import { cacheApiMiddleware } from '@setu-ts/cloudflare-plugin';

export function registerCatalogRoutes(router: IRouterApi): void {
  router.get('/catalog', {
    middleware: [cacheApiMiddleware({ ttlSeconds: 60 })],
    handler: (ctx) => ctx.response.json([{ id: 'p1' }]),
  });
}
```

## Behaviour the types do not show

- Missing `requireBindings` entries fail registration; a missing binding throws
  `CloudflareBindingMissingError`.
- Omitted arms register nothing. Cache supplies `CAPABILITIES.CACHE` (`ICacheStore`); storage
  supplies `CAPABILITIES.STORAGE` (`IStorage`). Named arms derive separate capability tokens.
- KV default expiry and edge `ttlSeconds` use seconds; omitting KV expiry means no expiry.
- The edge cache is per datacenter; without one, middleware passes through.
- Edge hits skip the handler; put per-route caching after guards. Per-visitor responses are never
  stored; `purgeCacheApi` evicts.
- Pass the platform `waitUntil` so background work outlives the response.

## Other options

- `queue` supplies `IQueue`; consuming needs `createQueueHandler(app)` and `deadLetterQueue`
  (producer or `false`).
- `messaging` supplies `IMessageBroker`; `rpc` adds replies via a Durable Object.
- `durableObject` supplies `IRealtimeBackplane` (rooms need it); `WorkersCron` handles cron.
- `bindings.service('NAME').fetch()` calls a Worker; deploy it first.
- `VectorizeVectorStore` serves vectors (namespace = scope; no `replaceSource`/`deleteScope`).
- `D1Adapter`, `KvSessionStore` and `DurableObjectIdempotencyStore` adapt other platform services.
