# @hono-enterprise/cloudflare-plugin

Cloudflare Workers platform bindings for Hono Enterprise.

The framework has served traffic on Workers since the Hono migration, but had no way to reach the
platform's own primitives. This plugin publishes a Worker's bindings under `CAPABILITIES.CLOUDFLARE`
and, optionally, serves the committed cache and storage capabilities from KV and R2.

**Zero npm dependencies.** Nothing in this package imports `cloudflare:workers` — the application
passes `env` in, which keeps the package type-checkable on Deno, Node, and Bun, and trivially
testable with a plain object.

## Installation

```bash
deno add jsr:@hono-enterprise/cloudflare-plugin
```

## Usage

```typescript
import { env, waitUntil } from 'cloudflare:workers';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { CloudflarePlugin } from '@hono-enterprise/cloudflare-plugin';
import { CAPABILITIES, type ICacheStore } from '@hono-enterprise/common';
import type { ICloudflareBindings } from '@hono-enterprise/cloudflare-plugin';

const app = createApplication({
  plugins: [
    // Populates runtime.env with the Worker's string variables and secrets.
    RuntimePlugin({ env }),
    CloudflarePlugin({
      env,
      waitUntil,
      cache: { binding: 'CACHE_KV', prefix: 'cache:' },
      storage: { binding: 'UPLOADS' },
      requireBindings: ['CACHE_KV', 'UPLOADS'],
    }),
  ],
});

app.router.get('/settings', async (ctx) => {
  const cache = ctx.services.get<ICacheStore>(CAPABILITIES.CACHE);
  const cf = ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);

  const cached = await cache.get<Settings>('settings');
  if (cached !== null) return ctx.response.json(cached);

  const settings = await loadSettings(cf.d1('DB'));
  await cache.set('settings', settings, 30);
  cf.waitUntil(recordCacheMiss()); // finishes after the response
  return ctx.response.json(settings);
});

export default { fetch: app.fetch };
```

`honoe new --runtime cloudflare-workers` scaffolds the `env` wiring and a `wrangler.toml` with
commented binding stanzas.

## Requirements

`compatibility_date` must be **2025-08-08 or later** — that is when Cloudflare shipped
`import { waitUntil } from 'cloudflare:workers'`. `env` has been importable at module scope for
longer; only `waitUntil` needs the newer date.

## Options

| Option                    | Type                     | Default     | Description                                                       |
| ------------------------- | ------------------------ | ----------- | ----------------------------------------------------------------- |
| `env`                     | `Record<string,unknown>` | —           | Required. The Worker's `env`.                                     |
| `waitUntil`               | `WaitUntilHost`          | —           | The platform sink. Omit off Workers.                              |
| `requireBindings`         | `string[]`               | `[]`        | Bindings that must exist; `register()` throws naming absent ones. |
| `cache.binding`           | `string`                 | —           | KV namespace serving `CAPABILITIES.CACHE`.                        |
| `cache.name`              | `string`                 | `'default'` | Derives `cache.<name>` when not `'default'`.                      |
| `cache.prefix`            | `string`                 | —           | Key prefix. **Required to call `clear()`.**                       |
| `cache.defaultTtlSeconds` | `number`                 | —           | TTL applied when `set` omits one.                                 |
| `storage.binding`         | `string`                 | —           | R2 bucket serving `CAPABILITIES.STORAGE`.                         |
| `storage.name`            | `string`                 | `'default'` | Derives `storage.<name>` when not `'default'`.                    |
| `storage.prefix`          | `string`                 | —           | Object-key prefix.                                                |

## Sessions

`SessionPluginOptions.store` is read when the plugin is **constructed**, before any application
exists, so a store published in the registry could never reach it. Build one yourself:

```typescript
import { createRuntimeServices } from '@hono-enterprise/runtime';
import { SessionPlugin } from '@hono-enterprise/session-plugin';
import { type IKvNamespace, KvSessionStore } from '@hono-enterprise/cloudflare-plugin';

const runtime = createRuntimeServices({ env });

SessionPlugin({
  secret: String(env.SESSION_SECRET),
  mode: 'sign', // the payload lives in KV, so the cookie holds only an opaque id
  store: new KvSessionStore(env.SESSIONS as IKvNamespace, runtime),
});
```

## Behaviour worth knowing before you deploy

- **KV rejects a TTL under 60 seconds.** `ICacheStore.set` accepts any TTL, so the value carries its
  own deadline: a 5-second entry reads as a miss on time even though the key survives up to a minute
  longer. Short TTLs are correct; they are just not free of storage.
- **KV writes are eventually consistent.** This suits read-heavy caching, not coordination. Reach
  for a Durable Object when you need a consistent read after write.
- **A read never deletes a key the store does not own**, and a deliberately cached `null` survives a
  read — negative caching works. `get` still answers `null` for it, because `ICacheStore` has no way
  to distinguish a cached absence from a miss, but `has` and `delete` report it as present.
- **`clear()` needs a prefix and costs one delete per key.** The binding has no bulk delete, so the
  sweep pages `list` (1000 keys at a time) and deletes each one. Without a prefix it would delete
  keys the store does not own, so it throws instead.
- **R2 cannot presign.** `getSignedUrl` throws. Serve the object through a route (`getStream` gives
  you a zero-copy download) or put a custom domain in front of the bucket.
- **Binding methods only work inside a request.** Cloudflare prohibits I/O in global scope. The
  plugin holds bindings at `register()` and never reads through them there, and the health indicator
  performs no binding I/O.
- **Not verified against a live Worker.** Every binding is exercised against a fake built from the
  documented signatures, including KV's 60-second floor and R2's void `delete`. CI has no Cloudflare
  account.

## Not in this package

D1 as a database backend, Queues, Cron Triggers, Durable Objects, and the Cache API response cache
are **M52b**. Each needs either a new module-level handler export from your Worker or a contract
promotion in `common`. Their bindings are reachable today through `bindings.d1(...)`,
`bindings.queue(...)`, and `bindings.durableObject(...)`.

## Documentation

- [PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md)
- [ARCHITECTURE.md](https://github.com/dkpaul91/hono-enterprise/blob/main/ARCHITECTURE.md)

## License

MIT
