# @hono-enterprise/cloudflare-plugin

Cloudflare Workers platform bindings for Hono Enterprise.

The framework has served traffic on Workers since the Hono migration, but had no way to reach the
platform's own primitives. This plugin publishes a Worker's bindings under `CAPABILITIES.CLOUDFLARE`
and, optionally, serves the committed cache, storage, and queue capabilities from KV, R2, and
Cloudflare Queues. It also ships the `queue` and `scheduled` handler exports a Worker needs, and a
response cache over the platform's own edge cache.

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
| `queue.binding`           | `string`                 | —           | Queues producer binding serving `CAPABILITIES.QUEUE`.             |
| `queue.name`              | `string`                 | `'default'` | Derives `queue.<name>` when not `'default'`.                      |
| `queue.maxDelaySeconds`   | `number`                 | `86400`     | A larger `delayMs` throws rather than being truncated.            |

## Queues, Cron Triggers, and the edge cache

Cloudflare invokes `queue` and `scheduled` as **module-level exports** — `fetch` is not involved —
so your Worker assembles them beside it:

```typescript
import {
  cacheApiMiddleware,
  CloudflarePlugin,
  createQueueHandler,
  createScheduledHandler,
  WorkersCron,
} from '@hono-enterprise/cloudflare-plugin';
import { CAPABILITIES, type IQueue } from '@hono-enterprise/common';

const app = createApplication({
  plugins: [
    RuntimePlugin({ env }),
    CloudflarePlugin({ env, waitUntil, queue: { binding: 'JOBS' } }),
  ],
});

// A route cached in the datacenter it was served from.
app.router.get('/catalog', {
  handler: listCatalog,
  middleware: [cacheApiMiddleware({ ttlSeconds: 300 })],
});

await app.start();

const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
queue.process<{ to: string }>('send-welcome', async (job) => {
  await mailer.send(job.data);
}, { concurrency: 5 });

// The expression must match wrangler.toml `[triggers] crons` exactly.
const cron = new WorkersCron();
cron.on('0 3 * * *', () => queue.add('rebuild-reports', {}));

export default {
  fetch: app.fetch,
  queue: createQueueHandler(app),
  scheduled: createScheduledHandler(cron),
};
```

`wrangler.toml` needs the matching stanzas:

```toml
[[queues.producers]]
queue = "jobs"
binding = "JOBS"

[[queues.consumers]]
queue = "jobs"

[triggers]
crons = ["0 3 * * *"]
```

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
- **An unroutable queue message is retried, never acked.** A body that is not one of this package's
  job envelopes, or a job name with no registered processor, goes back for redelivery and is
  reported through the logger. Acking would discard it permanently and silently. Your queue's
  `max_retries` and dead-letter settings in `wrangler.toml` then decide what happens.
- **`queue.addRecurring` throws.** Cloudflare Queues has no recurring message. Declare the schedule
  in `[triggers] crons` and let a `WorkersCron` handler enqueue the work.
- **There is no `IScheduler` on Workers, deliberately.** `every` and `delay` arm timers, and the
  isolate is evicted between invocations, so they would silently never fire; `pause`/`resume`/
  `remove` need state that does not survive an invocation; and `getNextRun` is owned by
  `wrangler.toml`. `WorkersCron` is a small honest surface instead of an `IScheduler` where six of
  eight methods throw.
- **A cron expression registered here but absent from `wrangler.toml` never fires.** Nothing in the
  process can read that file. `cron.expressions()` lets you assert your own coverage, and a trigger
  that fires with nothing registered is logged every time. Matching is exact — whitespace is not
  normalized.
- **`caches.default` is per-datacenter.** `cacheApiMiddleware` is a latency optimisation, not a
  shared store: a hit in one colo says nothing about another, and a `delete` does not evict
  globally. It reports under `X-Cache-Api`, so it composes with `cache-plugin`'s `cacheMiddleware`
  (which reports under `X-Cache` and reads a store every colo shares) rather than colliding with it.
- **The edge cache refuses some responses, and the middleware skips them rather than failing.**
  Non-GET, 206, `Vary: *`, and an uncleared `Set-Cookie` all make `caches.default.put` throw; those
  are checked first. `Cache-Control: private=Set-Cookie` is the platform's opt-in. Streaming
  responses are never cached.
- **A cache HIT is replayed as a stream**, so `app.inject()` cannot read its body — drive cached
  routes in tests with `app.fetch` and a web `Request`, which is what a Worker invokes anyway.
- **Not verified against a live Worker.** Every binding is exercised against a fake built from the
  documented signatures, including KV's 60-second floor and R2's void `delete`. CI has no Cloudflare
  account.

## Not in this package

- **D1 as a database backend — M52c.** The seam a backend implements lives inside `database-plugin`,
  not `common`, so shipping it is a contract promotion. `bindings.d1('DB')` gives you the binding
  today.
- **Durable Objects — M52d.** A DO-backed realtime backplane and distributed lock both need your
  Worker to export a DO class plus a wrangler migration stanza. `bindings.durableObject('ROOMS')`
  gives you the namespace today.
- **Hyperdrive, Vectorize, Workers AI, Analytics Engine.** Reachable now through
  `bindings.get<T>('NAME')`; each becomes a first-class port only when an application needs one.

## Documentation

- [PUBLIC_API.md](https://github.com/dkpaul91/hono-enterprise/blob/main/PUBLIC_API.md)
- [ARCHITECTURE.md](https://github.com/dkpaul91/hono-enterprise/blob/main/ARCHITECTURE.md)

## License

MIT
