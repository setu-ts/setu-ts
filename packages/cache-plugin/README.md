# @hono-enterprise/cache-plugin

Caching with pluggable stores. Registers an `ICacheStore` under `CAPABILITIES.CACHE` (`'cache'`).

Three stores ship: `MemoryStore` (LRU with per-entry TTL, zero-dependency default), `RedisStore`
(over `npm:ioredis`, lazily imported or injected), and `NoopStore`.

## Installation

```typescript
import { CachePlugin } from '@hono-enterprise/cache-plugin';
```

## Usage

```typescript
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { cacheMiddleware, CachePlugin } from '@hono-enterprise/cache-plugin';
import { CAPABILITIES, type ICacheStore } from '@hono-enterprise/common';

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
```

## Options

| Option    | Type                            | Default     | Description                           |
| --------- | ------------------------------- | ----------- | ------------------------------------- |
| `store`   | `'memory' \| 'redis' \| 'noop'` | `'memory'`  | Backend implementation.               |
| `name`    | `string`                        | `'default'` | Instance name for multi-cache setups. |
| `options` | `CacheStoreOptions`             | —           | Store-specific configuration.         |

A `name` other than `'default'` derives the capability token as `cache.<name>`, so several caches
can coexist in one application.

## Response caching

`cacheMiddleware(options)` transparently caches responses. Streaming responses are skipped — a live
`ReadableStream` cannot be replayed from a cache, so those requests are marked `X-Cache: MISS` and
pass straight through.

## Full API

Every export and option is documented in
[PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md).
