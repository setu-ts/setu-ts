# @setu-ts/cloudflare-plugin — use Workers bindings

**Add it:** `setu add cloudflare` adds it on Workers and prints the registration for
`setu.config.ts`; other runtimes are refused. `CloudflarePlugin` provides `CAPABILITIES.CLOUDFLARE`
(`ICloudflareBindings`), plus the capabilities selected by its arms.

## Register platform cache and storage

Call this from the Workers composition with its platform environment and background-work sink; put
the returned plugin in the config's plugins array:

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

- Missing `requireBindings` entries fail registration; a missing accessor binding throws
  `CloudflareBindingMissingError`.
- Omitted arms register nothing. Cache supplies `CAPABILITIES.CACHE` (`ICacheStore`); storage
  supplies `CAPABILITIES.STORAGE` (`IStorage`). Named arms derive separate capability tokens.
- KV default expiry and edge `ttlSeconds` use seconds; omitting KV expiry means no expiry.
- The edge cache is per datacenter. Without an available cache, middleware passes through.
- Edge hits skip the handler; put per-route caching after guards for responses needing
  authorization.
- Pass the platform `waitUntil` to extend background work beyond the response.

## Other options

- `queue` supplies `IQueue`; consuming needs the module export made by `createQueueHandler(app)`.
- `messaging` supplies `IMessageBroker`; `rpc` enables replies through a Durable Object binding.
- `durableObject` supplies `IRealtimeBackplane`; `WorkersCron` and `createScheduledHandler` handle
  cron.
- `D1Adapter`, `KvSessionStore` and `DurableObjectIdempotencyStore` adapt other platform services.
