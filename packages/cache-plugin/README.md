# @setu-ts/cache-plugin

Caching with pluggable stores. Registers an `ICacheStore` under `CAPABILITIES.CACHE` (`'cache'`).

Three stores ship: `MemoryStore` (LRU with per-entry TTL, zero-dependency default), `RedisStore`
(over `npm:ioredis`, lazily imported or injected), and `NoopStore`.

## Installation

```typescript
import { CachePlugin } from '@setu-ts/cache-plugin';
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { cacheMiddleware, CachePlugin, CacheService } from '@setu-ts/cache-plugin';
import { CAPABILITIES, type ICacheStore } from '@setu-ts/common';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    CachePlugin({ store: 'redis', options: { url: 'redis://localhost:6379' } }),
  ],
});
await app.start({ port: 3000 });

const cache = app.services.get<ICacheStore>(CAPABILITIES.CACHE);
await cache.set('user:1', { name: 'Ada' }, 60);
const user = await cache.get<{ name: string }>('user:1');

// CacheService adds coalesced read-through for one cache key.
const readThroughCache = app.services.get<CacheService>(CAPABILITIES.CACHE);
const profile = await readThroughCache.getOrSet('profile:1', async () => {
  return await loadProfile('1');
}, 60);
```

## Options

| Option        | Type                            | Default     | Description                           |
| ------------- | ------------------------------- | ----------- | ------------------------------------- |
| `store`       | `'memory' \| 'redis' \| 'noop'` | `'memory'`  | Backend implementation.               |
| `name`        | `string`                        | `'default'` | Instance name for multi-cache setups. |
| `options`     | `CacheStoreOptions`             | —           | Store-specific configuration.         |
| `diagnostics` | `CacheDiagnosticsOptions`       | —           | Opt-in operation counters (M98i).     |

A `name` other than `'default'` derives the capability token as `cache.<name>`, so several caches
can coexist in one application.

## Diagnostics (M98i)

`CachePlugin({ diagnostics: { enabled: true, alias: 'primary' } })` counts every backend call this
instance's own `CacheService` makes (`get`, `set`, `delete`, `has`, `clear`; `getOrSet` counts as
its internal `get`/`set`) — succeeded, failed, hits, misses, present/absent and removed/notRemoved —
for the local diagnostics connector's `GET /v1/cache` (`@setu-ts/diagnostics-plugin`). Keys,
prefixes, values, Redis URLs, factory results and errors are never captured, and no eviction is
inferred. Without the option the instance registers an inert `disabled` source and its cache calls
are not touched. Results, errors, TTL, prefix and `getOrSet` coalescing are identical either way;
enabled calls add one clock read (two on the timed one-in-eight sample) and one side-branch promise
reaction each, measured at about 6% of throughput against a real Redis at 50 concurrent calls.
Direct store calls and a replacement service are outside coverage. Enable only on an approved
development dataset: counts aggregate every tenant using the instance.

## Response caching

`cacheMiddleware(options)` transparently caches responses. Streaming responses are skipped — a live
`ReadableStream` cannot be replayed from a cache, so those requests are marked `X-Cache: MISS` and
pass straight through.

Concurrent misses for the same key are coalesced within one process: one request reaches a
cacheable, buffered origin response and waiters replay it with `X-Cache: COALESCED`. A failed,
streaming, or otherwise uncacheable leader is not replayed; every waiter runs the origin itself.
Separate processes do not coordinate, so one overlapping successful batch can produce at most one
origin call per process. `CacheService.getOrSet()` applies the same per-store coalescing to
programmatic read-through calls.

## Exports

| Export                    | Kind      |
| ------------------------- | --------- |
| `cacheMiddleware`         | function  |
| `CachePlugin`             | function  |
| `CacheService`            | class     |
| `MemoryStore`             | class     |
| `NoopStore`               | class     |
| `RedisStore`              | class     |
| `CacheDiagnosticsOptions` | interface |
| `CachedResponsePayload`   | interface |
| `CacheMiddlewareOptions`  | interface |
| `CachePluginOptions`      | interface |
| `CacheStoreOptions`       | interface |
| `ICacheStore`             | interface |
| `IRedisClient`            | interface |
| `CacheStoreType`          | type      |

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#cacheplugin-setu-tscache-plugin).
