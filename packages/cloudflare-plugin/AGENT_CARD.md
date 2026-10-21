# @setu-ts/cloudflare-plugin — Workers bindings, queues and cron

Cloudflare Workers only: `setu add cloudflare` is refused on every other runtime, because it needs
Workers bindings at registration. On Workers it pins the package and prints
`CloudflarePlugin({ env, ...(waitUntil ? { waitUntil } : {}) })` — name the generated factory's
second parameter `waitUntil`. It publishes `CAPABILITIES.CLOUDFLARE` during `app.start()` and, per
arm, serves cache, storage, queue and messaging from bindings.

```ts
import { env, waitUntil } from 'cloudflare:workers';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';

export const app = createApplication({
  plugins: [
    RuntimePlugin({ env }),
    CloudflarePlugin({
      env,
      waitUntil,
      requireBindings: ['CACHE_KV', 'UPLOADS'],
      cache: { binding: 'CACHE_KV', prefix: 'cache:', defaultTtlSeconds: 60 },
      storage: { binding: 'UPLOADS' },
    }),
  ],
});
```

```ts
import { env, waitUntil } from 'cloudflare:workers';
import { CloudflarePlugin, createQueueHandler } from '@setu-ts/cloudflare-plugin';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

export const app = createApplication({
  plugins: [
    RuntimePlugin({ env }),
    CloudflarePlugin({ env, waitUntil, queue: { binding: 'JOBS' } }),
  ],
});

export default { fetch: app.fetch, queue: createQueueHandler(app) };
```

- `compatibility_date` must be 2025-08-08 or later for `waitUntil`; without that sink on Workers,
  background work may be cut off when the response is sent.
- Arms, each registering nothing when omitted: `cache`, `storage`, `queue`, `messaging` (with
  `rpc`), and `durableObject`. Every arm takes `binding` and `name`; cache and storage also take
  `prefix`.
- In a handler, resolve `ICloudflareBindings` from `CAPABILITIES.CLOUDFLARE`: `has`, `names`,
  `vars`, `get`, `kv`, `r2`, `d1`, `queue`, `service`, `durableObject`, `waitUntil`. A missing
  binding throws `CloudflareBindingMissingError`.
- Queue consumption and cron are module exports, not options: `createQueueHandler(app)` and
  `createScheduledHandler(cron)`. A cron expression must match `wrangler.toml` exactly or the
  invocation fails.
- `cacheApiMiddleware({ ttlSeconds })` caches one route in the edge cache.
- Register this `messaging` arm or `MessagingPlugin` from `@setu-ts/messaging-plugin`, never both:
  one capability token takes one provider.
