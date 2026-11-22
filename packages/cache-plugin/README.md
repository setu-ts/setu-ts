# @setu-ts/cache-plugin

Caching with pluggable stores. Registers an `ICacheStore` under `CAPABILITIES.CACHE` (`'cache'`).

Three stores ship: `MemoryStore` (LRU with per-entry TTL, zero-dependency default), `RedisStore`
(over `ioredis`, lazily imported or injected), and `NoopStore`.

## Installation

```typescript
import { CachePlugin } from '@setu-ts/cache-plugin';
```

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { cacheMiddleware, CachePlugin, CacheService } from '@setu-ts/cache-plugin';
import { CAPABILITIES } from '@setu-ts/common';

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    CachePlugin({ store: 'redis', options: { url: 'redis://localhost:6379' } }),
  ],
});
await app.start({ port: 3000 });

const cache = app.services.get(CAPABILITIES.CACHE);
await cache.set('user:1', { name: 'Ada' }, 60);
const user = await cache.get<{ name: string }>('user:1');

// The capability is typed as ICacheStore. The plugin registers a CacheService, so narrow with
// instanceof to reach its coalesced read-through for one cache key.
if (cache instanceof CacheService) {
  const profile = await cache.getOrSet('profile:1', async () => ({ name: 'Ada' }), 60);
}
```

## Options

| Option        | Type                            | Default     | Description                           |
| ------------- | ------------------------------- | ----------- | ------------------------------------- |
| `store`       | `'memory' \| 'redis' \| 'noop'` | `'memory'`  | Backend implementation.               |
| `name`        | `string`                        | `'default'` | Instance name for multi-cache setups. |
| `options`     | `CacheStoreOptions`             | —           | Store-specific configuration.         |
| `diagnostics` | `CacheDiagnosticsOptions`       | —           | Opt-in operation counters (M98i).     |

With `store: 'redis'`, connection errors of the `ioredis` client the store builds go to the
application logger — the first error of an outage at `warn`, identical repeats at `debug`, the
recovery at `info` — instead of `ioredis` printing every reconnect failure to `console.error`. An
injected client gets no listener: it belongs to the caller.

**node-redis.** To use node-redis instead of ioredis, pass
`options: { client: fromNodeRedis(createClient({ url })) }` (`fromNodeRedis` from `@setu-ts/common`,
`createClient` from `redis`, installed in your application). The adapter bounds its own commands
(`fromNodeRedis(client, { commandTimeoutMs })`); this store's `commandTimeoutMs` applies only to the
client it builds. See
[Using node-redis](https://github.com/setu-ts/setu-ts/blob/main/packages/common/README.md#using-node-redis-0110).

`options.commandTimeoutMs` (Redis only, default `15000`, `0` disables) bounds each command on the
client the store builds. A paused or partitioned server keeps its socket open, so without the bound
a cache call waits forever; with it the call rejects and the diagnostics count it `failed`. (The
`cache` health indicator reports such a server `down` on its own, independent of this option: its
`ping()` probe has a fixed 2-second bound.) It is not applied to an injected `client`, and a value
outside `0`–`2147483647` throws `RangeError` when `CachePlugin(...)` is called.

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
enabled calls add one clock read (two on the timed one-in-eight sample) and one derived promise each
(which re-rejects with the original reason, so an unhandled rejection stays unhandled), measured at
about 5% of throughput against a real Redis at 50 concurrent calls. Direct store calls and a
replacement service are outside coverage. Enable only on an approved development dataset: counts
aggregate every tenant using the instance.

## Response caching

`cacheMiddleware(options)` transparently caches responses. Streaming responses are skipped — a live
`ReadableStream` cannot be replayed from a cache, so those requests are marked `X-Cache: MISS` and
pass straight through.

Concurrent misses for the same key are coalesced within one process: one request reaches a
cacheable, buffered origin response and waiters replay it with `X-Cache: COALESCED`. A failed,
streaming, or otherwise uncacheable leader is not replayed; every waiter runs the origin itself.
Separate processes do not coordinate, so one overlapping successful batch can produce at most one
origin call per process. `CacheService.getOrSet()` applies the same per-store coalescing to
programmatic read-through calls; the capability is typed as `ICacheStore`, so narrow it with
`instanceof CacheService` first.

### Per-visitor responses are never shared

`cacheMiddleware` stores nothing that belongs to one visitor:

- A response is not stored when its `Cache-Control` holds `private` or `no-store`, or when it sets a
  cookie (as before), whatever the request.
- A request carrying `Authorization`, or a credential cookie, is **credentialed**. It is served a
  `HIT` only from an entry stored with `Cache-Control: public` whose `Vary` names neither `Cookie`
  nor `Authorization`, never shares an origin run with another request, and its own response is
  stored only when that response says `public`, varies on neither, and passes the checks above. A
  bearer API that marks its responses `public` without `Vary: Authorization` is still cached.
- A response whose `Vary` names `Cookie` or `Authorization` is stored from a request carrying no
  credential, so the entry is the cookie-less variant, and it is served only to requests carrying
  none. A localized application, whose responses vary on `Cookie` by default, is still cached for
  visitors without cookies.

The middleware cannot know which cookie identifies a visitor, so by default **any cookie** makes a
request credentialed, an analytics or consent cookie included: such a request is taken out of the
cache. An application whose every visitor carries an unrelated cookie gets nothing shared-cached
until it marks responses `public` or names its session cookie in `credentialCookies`:

```typescript
import { cacheMiddleware } from '@setu-ts/cache-plugin';

export const pageCache = cacheMiddleware({ ttlSeconds: 60, credentialCookies: ['setu_session'] });
```

`credentialCookies: []` leaves only `Authorization`. With `@setu-ts/session-plugin`, a page that
carries a CSRF token or belongs to a signed-in visitor is marked `private`, so it is never stored
whichever side of the session middleware the cache runs on; an anonymous page that only read the
session is marked `Vary: Cookie`, so it is stored for visitors without cookies only. Register
`cacheMiddleware` outside the session middleware (a priority below 260) where you can, so a cached
anonymous page is replayed before any session work.

## Exports

| Export                       | Kind      |
| ---------------------------- | --------- |
| `cacheMiddleware`            | function  |
| `CachePlugin`                | function  |
| `CacheService`               | class     |
| `CacheStoreUnavailableError` | class     |
| `MemoryStore`                | class     |
| `NoopStore`                  | class     |
| `RedisStore`                 | class     |
| `CacheDiagnosticsOptions`    | interface |
| `CachedResponsePayload`      | interface |
| `CacheMiddlewareOptions`     | interface |
| `CachePluginOptions`         | interface |
| `CacheStoreOptions`          | interface |
| `ICacheStore`                | interface |
| `IRedisClient`               | interface |
| `CacheStoreType`             | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#cacheplugin-setu-tscache-plugin).

## Readiness and dependency outages (M113b)

`RedisStore.get/set/delete/has/clear` wrap recognised connection faults in
`CacheStoreUnavailableError`, preserving the original as `cause`. With the exceptions
`errorHandler`, this returns 503 and the fixed detail `The cache is temporarily unavailable.` Other
errors propagate unchanged. Inspect `cause` for driver diagnostics.
