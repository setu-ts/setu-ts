# @setu-ts/cloudflare-plugin

Cloudflare Workers platform bindings for Setu-TS.

The framework has served traffic on Workers since the Hono migration, but had no way to reach the
platform's own primitives. This plugin publishes a Worker's bindings under `CAPABILITIES.CLOUDFLARE`
and, optionally, serves the committed cache, storage, queue, and messaging capabilities from KV, R2,
and Cloudflare Queues. It also ships the `queue` and `scheduled` handler exports a Worker needs, and
a response cache over the platform's own edge cache.

**Zero npm dependencies.** Nothing in this package imports `cloudflare:workers` — the application
passes `env` in, which keeps the package type-checkable on Deno, Node, and Bun, and trivially
testable with a plain object.

## Installation

```bash
npm install @setu-ts/cloudflare-plugin
# Deno: deno add npm:@setu-ts/cloudflare-plugin
```

## Usage

```typescript
import { env, waitUntil } from 'cloudflare:workers';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CloudflarePlugin } from '@setu-ts/cloudflare-plugin';
import { CAPABILITIES, type ICacheStore } from '@setu-ts/common';
import type { ICloudflareBindings } from '@setu-ts/cloudflare-plugin';

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

`setu new --runtime cloudflare-workers` scaffolds the `env` wiring and a `wrangler.toml` with
commented binding stanzas.

## Requirements

`compatibility_date` must be **2025-08-08 or later** — that is when Cloudflare shipped
`import { waitUntil } from 'cloudflare:workers'`. `env` has been importable at module scope for
longer; only `waitUntil` needs the newer date.

## Options

| Option                           | Type                     | Default      | Description                                                                                                                                                                                                                                                                 |
| -------------------------------- | ------------------------ | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `env`                            | `Record<string,unknown>` | —            | Required. The Worker's `env`.                                                                                                                                                                                                                                               |
| `waitUntil`                      | `WaitUntilHost`          | —            | The platform sink. Omit off Workers. Without it on Workers, work passed to `bindings.waitUntil()` may be cut off when the response is sent, and one warning says so at startup — pass `import { waitUntil } from 'cloudflare:workers'` from your entry through the factory. |
| `requireBindings`                | `string[]`               | `[]`         | Bindings that must exist; `register()` throws naming absent ones.                                                                                                                                                                                                           |
| `cache.binding`                  | `string`                 | —            | KV namespace serving `CAPABILITIES.CACHE`.                                                                                                                                                                                                                                  |
| `cache.name`                     | `string`                 | `'default'`  | Derives `cache.<name>` when not `'default'`.                                                                                                                                                                                                                                |
| `cache.prefix`                   | `string`                 | —            | Key prefix. **Required to call `clear()`.**                                                                                                                                                                                                                                 |
| `cache.defaultTtlSeconds`        | `number`                 | —            | TTL applied when `set` omits one.                                                                                                                                                                                                                                           |
| `storage.binding`                | `string`                 | —            | R2 bucket serving `CAPABILITIES.STORAGE`.                                                                                                                                                                                                                                   |
| `storage.name`                   | `string`                 | `'default'`  | Derives `storage.<name>` when not `'default'`.                                                                                                                                                                                                                              |
| `storage.prefix`                 | `string`                 | —            | Object-key prefix.                                                                                                                                                                                                                                                          |
| `queue.binding`                  | `string`                 | —            | Queues producer binding serving `CAPABILITIES.QUEUE`.                                                                                                                                                                                                                       |
| `queue.name`                     | `string`                 | `'default'`  | Derives `queue.<name>` when not `'default'`.                                                                                                                                                                                                                                |
| `queue.maxDelaySeconds`          | `number`                 | `86400`      | A larger `delayMs` throws rather than being truncated.                                                                                                                                                                                                                      |
| `messaging.binding`              | `string`                 | —            | Queues producer binding serving `CAPABILITIES.MESSAGING`.                                                                                                                                                                                                                   |
| `messaging.name`                 | `string`                 | `'default'`  | Derives `messaging.<name>` when not `'default'`.                                                                                                                                                                                                                            |
| `messaging.rpc.binding`          | `string`                 | —            | DO namespace serving RPC reply inboxes. Absent, RPC throws.                                                                                                                                                                                                                 |
| `messaging.rpc.defaultTimeoutMs` | `number`                 | `5000`       | Reply budget when `RequestOptions.timeoutMs` is omitted.                                                                                                                                                                                                                    |
| `durableObject.binding`          | `string`                 | —            | DO namespace serving `CAPABILITIES.REALTIME_BACKPLANE`.                                                                                                                                                                                                                     |
| `durableObject.name`             | `string`                 | `'default'`  | Derives `realtime-backplane.<name>` when not `'default'`.                                                                                                                                                                                                                   |
| `durableObject.topic`            | `string`                 | `'realtime'` | The object every replica shares. Differ it per application.                                                                                                                                                                                                                 |

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
} from '@setu-ts/cloudflare-plugin';
import { CAPABILITIES, type IQueue } from '@setu-ts/common';

const app = createApplication({
  plugins: [
    // One waitUntil for the kernel's cleanups and this plugin's background work.
    RuntimePlugin({ env, waitUntil }),
    CloudflarePlugin({
      env,
      queue: { binding: 'JOBS', maxRetries: 3, deadLetterQueue: 'JOBS_DLQ' },
    }),
  ],
});

// A route cached in the datacenter it was served from.
app.router.get('/catalog', {
  handler: listCatalog,
  middleware: [cacheApiMiddleware({ ttlSeconds: 300 })],
});

await app.start();

const queue = app.services.get<IQueue>(CAPABILITIES.QUEUE);
queue.process<{ to: string }>(
  'send-welcome',
  async (job) => {
    await mailer.send({ to: job.data.to, subject: 'Welcome', text: 'Welcome!' });
  },
  {
    concurrency: 5,
    // Once, on the final attempt, before the job goes to JOBS_DLQ.
    onFailed: (job, error) => logger.error('welcome mail abandoned', { id: job.id, error }),
  },
);

// The expression must match wrangler.toml `[triggers] crons` exactly.
// An unmatched trigger FAILS the invocation. A logger adds a structured
// warning naming the registered expressions; it never changes the outcome.
const cron = new WorkersCron({ logger });
cron.on('0 3 * * *', async () => {
  await queue.add('rebuild-reports', {});
});

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

# The dead-letter queue the adapter forwards exhausted jobs to.
[[queues.producers]]
queue = "jobs-dlq"
binding = "JOBS_DLQ"

[[queues.consumers]]
queue = "jobs"
max_retries = 3                  # must equal the queue arm's maxRetries
dead_letter_queue = "jobs-dlq"   # a second net if the adapter's own forward fails twice

[triggers]
crons = ["0 3 * * *"]
```

### When a job runs out of attempts

A Worker that consumes a queue must say where an exhausted job goes, or `queue.process()` throws:
`deadLetterQueue` names a producer binding for a dead-letter queue, or `deadLetterQueue: false`
discards exhausted jobs with one warning each (never the payload). The adapter cannot read the
consumer's `max_retries` or `dead_letter_queue` from the binding, and without a `dead_letter_queue`
Cloudflare deletes a message that runs out of retries, so the adapter keeps the job itself.

- **`maxRetries` must equal `max_retries` in `wrangler.toml`** (default 3, both sides). It must be a
  whole number from 1 to 100; anything else throws a `RangeError` when the queue is built. A job's
  attempt budget is `min(maxAttempts, maxRetries)`. A larger `maxAttempts` is capped, with one
  warning per job name; raise both settings together to allow more attempts.
- **`onFailed` runs once, on the final attempt**, with the error the processor threw. Then the job
  is sent to the dead-letter queue unchanged, plus `failedAt`, `attempts` and a bounded `error`
  text, and acked.
- **One delivery stays in reserve.** The platform delivers a message up to `max_retries + 1` times
  and the budget stops one short, so a dead-letter send that fails is retried on a later delivery
  (on the default budget that is the last one, and the copy then carries no error text, to stay
  under the message size limit; on an earlier one its `error` is the fixed reason
  `attempt budget exhausted`). On the platform's last delivery, if that send fails too, the message
  body is sent once more exactly as it arrived (the job envelope, or an unroutable body as is),
  without the dead-letter fields, in case they pushed it over the size limit; only if that fails as
  well does the job leave the adapter's hands: the platform writes it to `dead_letter_queue` when
  one is configured, or deletes it. That is why the stanza above sets both. A dead-letter consumer
  therefore sees two shapes: the copy with `failedAt`, `attempts` and `error` (an unroutable body
  under `body`), and, rarely, the message body alone. Both are sent as JSON, which pull consumers
  and the dashboard can read, unless the body, a job envelope or not, is one JSON would change (an
  envelope whose `data` another producer filled with such a value included): an `ArrayBuffer` or
  typed array, a `Date`, `Map` or other non-plain object, a `bigint`, `undefined`, `-0` or a
  non-finite number, an array with a hole or an extra key, an object reached twice (a cycle, or one
  shared by two references), or nesting past 64 levels. Then the copy is sent with
  `contentType: 'v8'`, and the body alone as `bytes` when it is an `ArrayBuffer`, else `v8`.
- **A message the consumer cannot route** (not a job envelope, or a name with no processor) is
  retried, and on its last attempt forwarded or discarded the same way. Its copy's `error` names its
  own reason, `body is not a job envelope` or `no processor registered`, and a retried copy past
  `maxRetries` carries none. A queue with no dead-letter target (one that only produces) keeps
  retrying it for the platform's own `dead_letter_queue`.
- **`deadLetterQueue` must be another queue.** Naming the queue's own binding fails `app.start()`:
  each exhausted job would be re-enqueued and run again without end.
- **`retryDelaySeconds`** spaces redeliveries: a number of seconds, or a function of the attempt
  that failed, bounded by `maxDelaySeconds`. `0` redelivers at once, overriding the queue's
  `retry_delay`; omitted, the queue's own `retry_delay` applies.

## Messaging

`CAPABILITIES.MESSAGING` over Cloudflare Queues, with request/reply through a Durable Object.

```typescript
app.register(
  CloudflarePlugin({
    env,
    messaging: { binding: 'MESSAGES', rpc: { binding: 'REPLY_INBOX' } },
  }),
);

const broker = app.services.get<IMessageBroker>(CAPABILITIES.MESSAGING);
await broker.subscribe<{ id: string }>('user.created', async (user) => {
  /* … */
});
await broker.respond<number, number>('double', (n) => n * 2);

// Consuming is a MODULE export. Combine with a job queue by routing on the
// queue name, which your `wrangler.toml` owns and this package cannot see.
export default { fetch: app.fetch, queue: createMessagingHandler(app) };
```

```toml
[[queues.producers]]
binding = "MESSAGES"
queue = "messages"

# REQUIRED for request/reply: the platform default of 5s alone exhausts the
# default reply budget, so every request() would time out.
[[queues.consumers]]
queue = "messages"
max_batch_size = 10
max_batch_timeout = 0

[[durable_objects.bindings]]
name = "REPLY_INBOX"
class_name = "ReplyInboxObject"

[[migrations]]
tag = "v1"
new_classes = ["ReplyInboxObject"]
```

The `rpc` arm needs a Durable Object class your application exports, delegating to
`ReplyInboxObjectCore` exactly as the realtime backplane's class does — see
[the class you export](#the-class-you-export).

The broker runs up to ten handlers of one batch at once, so `max_batch_size = 10` lets ten requests
be answered together; a batch of one makes every request wait for the one before it. Measured on
local workerd with a 250 ms responder: 50 concurrent requests were all answered in 1.6 s at 10 and
took 13 s at 1, well past the default 5 s reply budget.

Five things to know before you rely on it:

- **`publish` reaches one consumer Worker, not every subscriber in the cluster.** Cloudflare allows
  exactly one active consumer per queue. Fan-out happens across the handlers registered inside that
  consumer; cross-service fan-out means one queue per consuming service.
- **`subscribe` registers, it does not start receiving.** Delivery begins when the Worker exports
  the handler above and the queue is declared under `[[queues.consumers]]`.
- **A publish nobody subscribed to is acked, not retried.** Retrying ordinary pub/sub would burn the
  queue's retry budget and dead-letter every fire-and-forget message. An unreadable body is still
  retried, and a subscriber that throws is retried.
- **A trace crosses the queue when a telemetry service is registered.** `publish` and `request` run
  in a `producer` span whose `traceparent` rides the envelope's framework `trace` field, and each
  subscriber and responder runs in a `consumer` span parented from it. Your own headers are carried
  as before and never mixed with it.
- **No fan-out subscription.** A queue reaches one consumer Worker, so a subscription here is never
  delivered to every instance, and `RealtimeBackplanePlugin({ transport: 'messaging' })` cannot fan
  frames out over this broker: a frame would reach one consumer Worker only. The Durable Object
  backplane below is the Workers answer for realtime fan-out.

Without the `rpc` arm, `request` and `respond` throw `CloudflareUnsupportedError` naming the binding
to add — `publish` and `subscribe` are unaffected.

## Sessions

`SessionPluginOptions.store` is read when the plugin is **constructed**, before any application
exists, so a store published in the registry could never reach it. Build one yourself:

```typescript
import { createRuntimeServices } from '@setu-ts/runtime';
import { SessionPlugin } from '@setu-ts/session-plugin';
import { type IKvNamespace, KvSessionStore } from '@setu-ts/cloudflare-plugin';

const runtime = createRuntimeServices({ env });

SessionPlugin({
  secret: String(env.SESSION_SECRET),
  mode: 'sign', // the payload lives in KV, so the cookie holds only an opaque id
  store: new KvSessionStore(env.SESSIONS as IKvNamespace, runtime),
});
```

**KV is outside the session plugin's revocation guarantee.** Workers KV is eventually consistent:
Cloudflare says a change "may take up to 60 seconds or more to be visible in other global network
locations". The session plugin's revocation markers (`revoked:<id>`, `superseded:<id>`) are KV
writes too, so a logout or `regenerate()` may not yet be visible to a request served elsewhere, and
a revoked session can be used there for that long. Use a Durable Object-backed store where a logout
must hold everywhere at once. `KvCacheStore` under `cacheMiddleware` has the same delay for replayed
entries.

## D1

`D1Adapter` implements the committed `IDatabaseAdapter`, so a Worker serves `CAPABILITIES.DATABASE`
through the ordinary repository and Unit-of-Work surface. Like the session store, you build it and
hand it over — `DatabasePlugin`'s options are read before any application exists.

```typescript
import { DatabasePlugin } from '@setu-ts/database-plugin';
import { D1Adapter, type ID1Database } from '@setu-ts/cloudflare-plugin';

DatabasePlugin({
  type: 'custom',
  adapter: new D1Adapter(env.DB as ID1Database, {
    // Optional: entity name → table / primary key. Unmapped entities use their
    // own name as the table and `id` as the key.
    tables: { User: { table: 'users' } },
  }),
});
```

**D1 has no interactive transaction.** It rejects `BEGIN TRANSACTION`, and `batch()` is its only
unit of atomicity. `db.transaction(...)` therefore buffers every write and flushes it as one
`batch()` at commit — atomic, and rolled back whole if any statement fails. Two consequences to plan
around:

- **Reads inside a transaction do not see that transaction's own writes.** They run immediately
  against committed state. Read what you need first, then write.
- **`create()` inside a transaction needs an explicit primary key.** A deferred `INSERT` cannot hand
  a generated key back to a caller awaiting `create()` before the flush, so it throws rather than
  returning a row with a missing id. Outside a transaction `create()` uses `RETURNING *` and gives
  you the real persisted row, generated columns included.

Values are always bound; table and column names are validated and quoted, and any statement that
would exceed D1's 100-bound-parameter limit is refused with an error naming the count rather than
failing inside D1.

Migrations stay a `wrangler d1 migrations` concern — the adapter has no `migrate()`.

D1 honours the same two portable refusal rules `@setu-ts/database-plugin` answers: a primary-key
change through `update` (or `updateWhere`) is refused with `PrimaryKeyChangeError` (`400`) instead
of moving the row, and a cursor D1 cannot use — malformed, made under a different sort, or of the
wrong shape for the target — is refused with `InvalidCursorError` (`400`) before any query runs.
Both classes are exported from `@setu-ts/common`.

## Vectorize

`VectorizeVectorStore` serves `CAPABILITIES.VECTOR_STORE` from the current `Vectorize` binding. It
implements the `IVectorStoreAdapter` contract from `@setu-ts/common`, so register it with
`VectorStorePlugin` from `@setu-ts/vector-store-plugin`; the two packages never import each other.

```typescript
import { VectorizeVectorStore } from '@setu-ts/cloudflare-plugin';
import type { VectorizeIndexLike } from '@setu-ts/cloudflare-plugin';
import { VectorStorePlugin } from '@setu-ts/vector-store-plugin';

export const vectorStore = VectorStorePlugin({
  adapter: new VectorizeVectorStore({ index: env.DOCUMENTS_INDEX as VectorizeIndexLike }),
  collections: [{ name: 'documents', dimensions: 768, filterable: { tag: 'string' } }],
});
```

Create the index with cosine distance, and a metadata index for every declared filterable field,
before the first write:

```bash
npx wrangler vectorize create documents --dimensions=768 --metric=cosine
npx wrangler vectorize create-metadata-index documents --property-name=tag --type=string
```

One adapter serves one index, so it serves one collection: declaring a second collection on the same
`VectorizeVectorStore` fails registration with `VectorOperationUnsupportedError`.

The scope is the namespace. Vector ids are global to an index, so the stored id is
`vectorRecordKey(subtle, scope, id)` and the caller's id travels in metadata: two tenants writing
the same id do not overwrite each other. `ensureCollection` checks only the binding's reported
dimensions — the current API does not report the metric — so the `--metric cosine` flag is the only
guarantee of matching distance. A filter on a field without a metadata index is not refused by the
binding; the query may just return fewer matches.

Vectorize cannot delete by namespace or by filter. `replaceSource` and `deleteScope` throw
`VectorOperationUnsupportedError` rather than being emulated: upsert deterministic ids and delete
the stale ones yourself, or give each tenant group its own index. Writes are applied asynchronously,
so a read may not see a write yet. One index holds 50,000 namespaces on Workers Paid (1,000 on
Free), which caps the tenants a single index can serve. Vectorize stores at most 10 KiB of metadata
per vector, and the record's content travels in it, so a record whose metadata, content included,
exceeds 10 KiB as JSON throws `VectorRecordError` before any record of the write is sent.

## Durable Objects — realtime backplane and distributed lock

Both features need a Durable Object class **your application exports**, plus a wrangler stanza. No
plugin option can export a class on your behalf, so this is wiring you write once.

### The class you export

This package ships the behaviour as two plain cores. Your class extends `DurableObject` and
delegates — that keeps `cloudflare:workers` out of the package, which matters because the specifier
is unresolvable on every other runtime and would break type-checking everywhere.

```typescript
import { DurableObject } from 'cloudflare:workers';
import { DistributedLockObjectCore, RealtimeBackplaneObjectCore } from '@setu-ts/cloudflare-plugin';

export class RealtimeBackplaneObject extends DurableObject {
  #core = new RealtimeBackplaneObjectCore(this.ctx);

  override fetch(request: Request): Promise<Response> {
    return this.#core.fetch(request);
  }
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.#core.webSocketMessage(ws, message);
  }
  webSocketClose(ws: WebSocket, code: number, reason: string): void {
    this.#core.webSocketClose(ws, code, reason);
  }
  webSocketError(ws: WebSocket): void {
    this.#core.webSocketError(ws);
  }
}

export class DistributedLockObject extends DurableObject {
  #core = new DistributedLockObjectCore(this.ctx);

  override fetch(request: Request): Promise<Response> {
    return this.#core.fetch(request);
  }
}
```

### The wrangler stanza

```toml
[[durable_objects.bindings]]
name = "REALTIME"
class_name = "RealtimeBackplaneObject"

[[durable_objects.bindings]]
name = "LOCKS"
class_name = "DistributedLockObject"

[exports.RealtimeBackplaneObject]
type = "durable-object"
storage = "sqlite"

[exports.DistributedLockObject]
type = "durable-object"
storage = "sqlite"
```

`storage = "sqlite"` is required on the Workers Free plan. The older `migrations` +
`new_sqlite_classes` flow still works, but a Worker can use only one of the two flows — do not mix
them.

### Realtime backplane

```typescript
CloudflarePlugin({ env, waitUntil, durableObject: { binding: 'REALTIME', topic: 'chat' } });
```

That registers `CAPABILITIES.REALTIME_BACKPLANE`, which `websocket-plugin` and `sse-plugin` resolve
on their own. Register **either** this arm or `RealtimeBackplanePlugin`, never both: the kernel
rejects two providers of one capability token.

**Rooms on Workers need this arm.** workerd ties every socket to the request that accepted it, and
touching a socket from another request throws. A room therefore never writes to its members from
whichever request broadcasts. Each WebSocket connection opens its own link to the topic's hub object
from its own request; a broadcast goes out once, and every link delivers it to its own connection
when that connection is a member of the room. Without the arm, `ws.room()` and `ws.peek()` throw
`WebSocketRoomsUnavailableError` on Workers; single-socket routes keep working.

- **Ordering.** A broadcast from inside a member's handler (as `setu g ws-route` writes it, with
  `except: connection`) travels over that member's link, so one member's frames arrive in order. The
  exception is a link still opening whose 1 MiB queue budget the next frame would pass: that frame
  goes through the hub and can arrive before the queued ones. A broadcast from a route has no sender
  connection: it is POSTed to the hub, with no order relative to members' frames, as with any
  cross-replica backplane.
- **Cost.** The hub sends every frame of a topic to every link of that topic, so one topic per
  application area keeps fan-out small. The hub object's soft limit is 1,000 requests per second,
  which route broadcasts count against.
- **`room.size` is this isolate's count** of open members, as everywhere else.
- **While a link opens** it queues up to 64 frames and 1 MiB of frame data. A broadcast that would
  pass the byte budget, or is above the hub's 32 MiB cap, goes through the hub's HTTP publish
  instead, where the hub refuses one above the cap with 413 and the failure is logged.
- **A lost link** reopens up to three times (0.5 s, 1 s, 2 s apart), then logs
  `cloudflare: backplane link lost` once and stays closed.

**SSE channels** use one isolate-level socket to the hub, for receiving only. A channel publish is
POSTed to the hub, so publishes from concurrent requests never touch a socket another request owns.
The hub sends the frame back to the publisher's socket too, and the replica drops it by its own
`origin`. Three limits remain:

- A replica hears frames only once its socket has joined the hub. The socket opens on the first SSE
  stream or publish, so frames published before then do not reach it.
- The socket belongs to the request that opened it. On local workerd it keeps receiving after that
  request has answered. That is unverified on the platform.
- Other replicas may receive one replica's frames out of order. Each publish is its own call to the
  hub, and the platform orders calls only within one stub. A stub, like a socket, cannot be kept
  across requests: reusing one lost frames on local workerd.

Two applications sharing one namespace must set different `topic` values, or each receives the
other's frames.

Subscriber throws and returned promise rejections are isolated through common's shared dispatch. The
default reporter reads the logger at call time: first failure per handler at warn, repeats at debug
with a count, and recovery at info. Errors use `describeError`, so CR/LF cannot forge log lines;
frame data is never logged. A directly constructed `DurableObjectBackplane` accepts
`onHandlerError(error, frame)` in `DurableObjectBackplaneOptions` to receive every failure instead
of default logging. Hook and logger failures are swallowed.

### Distributed lock

A Durable Object binding exists only inside a Worker, so the lock is taken from Worker code: a
route, a queue or cron handler, or another Durable Object. A Node or Deno process cannot hold the
binding; a replica set outside Workers uses the scheduler's Redis lock. `SchedulerPlugin` itself
refuses to register on Workers (`SchedulerUnavailableError`, naming `WorkersCron`), so this lock is
not handed to it there.

```typescript
import { CAPABILITIES, type IRuntimeServices } from '@setu-ts/common';
import { DurableObjectLock, type ICloudflareBindings } from '@setu-ts/cloudflare-plugin';

app.router.post('/reports/run', {
  handler: async (ctx) => {
    const bindings = ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);
    const lock = new DurableObjectLock(bindings.durableObject('LOCKS'), {
      runtime: ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME),
      keyPrefix: 'reports:',
      binding: 'LOCKS',
    });
    const token = await lock.acquire('nightly', 60_000);
    if (token === null) return ctx.response.status(409).text('already running');
    try {
      // ... the work only one caller may do at a time ...
      return ctx.response.status(204).send();
    } finally {
      await lock.release('nightly', token);
    }
  },
});
```

The TTL is a whole number of milliseconds from 1 to 2,147,483,647 (about 24.8 days). Anything else
(`Infinity`, `NaN`, zero, a negative or fractional value) throws a `RangeError` before any I/O, and
the object answers 400 for it too.

One Durable Object per lock key. Correctness comes from the platform rather than an algorithm: a
Durable Object processes one event at a time and holds back delivery while a storage operation runs,
so the read-compare-write is atomic with no transaction and no Redlock-style quorum. The holder is
persisted in the object's storage, never in memory, because an object is evicted after 70–140
seconds of inactivity and a lock TTL routinely outlives that.

A non-2xx from the object **throws** rather than reporting "not acquired" — a 404 means the binding
points at the wrong class, and folding that into contention would silently disable every scheduled
job.

## Calling another Worker

A service binding is a direct call to another Worker in the same account, with no public URL:

```toml
[[services]]
binding = "BILLING"
service = "billing-worker"

# A Durable Object class another Worker owns is bound with script_name.
[[durable_objects.bindings]]
name = "REALTIME"
class_name = "RealtimeBackplaneObject"
script_name = "chat-worker"
```

```typescript
import { CAPABILITIES } from '@setu-ts/common';
import type { ICloudflareBindings } from '@setu-ts/cloudflare-plugin';

app.router.get('/invoices/:id', {
  handler: async (ctx) => {
    const bindings = ctx.services.get<ICloudflareBindings>(CAPABILITIES.CLOUDFLARE);
    const response = await bindings.service('BILLING').fetch(
      new Request(`https://billing/invoices/${ctx.params['id'] ?? ''}`),
    );
    return ctx.response.status(response.status).json(await response.json());
  },
});
```

- **Deploy the bound Worker first.** A deploy whose `[[services]]` or `script_name` names a Worker
  that does not exist yet fails.
- **Nothing crosses the call by itself.** Headers such as `traceparent` or `Authorization` reach the
  other Worker only when you send them; `@setu-ts/sdk` with its trace interceptor does that for you.
- **Local tests** list the other Worker in the generated harness, `createTestHarness({ workers })`.
- `bindings.service('NAME')` throws `CloudflareBindingMissingError` naming the binding when it is
  absent or is not a service binding.

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
- **R2 cannot presign.** `getSignedUrl` rejects. Serve the object through a route (`getStream` gives
  you a zero-copy download) or put a custom domain in front of the bucket.
- **Binding methods only work inside a request.** Cloudflare prohibits I/O in global scope. The
  plugin holds bindings at `register()` and never reads through them there, and the plugin's own
  health indicator performs no binding I/O. `VectorizeVectorStore.isHealthy()` does: it calls the
  index's `describe()` for `VectorStorePlugin`'s `vector-store` readiness indicator.
- **An unroutable queue message is retried, never acked while it has attempts left.** A body that is
  not one of this package's job envelopes, or a job name with no registered processor, goes back for
  redelivery and is reported through the logger. On its last attempt it is forwarded to the
  `deadLetterQueue` (or discarded with a warning when that is `false`).
- **`queue.addRecurring` throws.** Cloudflare Queues has no recurring message. Declare the schedule
  in `[triggers] crons` and let a `WorkersCron` handler enqueue the work.
- **There is no `IScheduler` on Workers, deliberately.** `every` and `delay` arm timers, and the
  isolate is evicted between invocations, so they would silently never fire; `pause`/`resume`/
  `remove` need state that does not survive an invocation; and `getNextRun` is owned by
  `wrangler.toml`. `WorkersCron` is a small honest surface instead of an `IScheduler` where six of
  eight methods throw.
- **A cron expression registered here but absent from `wrangler.toml` never fires.** Nothing in the
  process can read that file. `cron.expressions()` lets you assert your own coverage. An unmatched
  trigger fails the invocation; the logger you pass to `WorkersCron` adds a structured warning
  naming the registered expressions, but the outcome is the same without one. Matching is exact —
  whitespace is not normalized.
- **Only GET requests touch the edge cache.** The cache key is a URL, which the Cache API resolves
  as a GET request, so a `POST` to a cached path would otherwise be served the cached GET body and
  never reach your handler. Non-GET requests pass through with `X-Cache-Api: BYPASS`. This matters
  most if you add the middleware globally rather than to one GET route.
- **A failed cache write never fails your response.** `Cache.put` rejects for an oversized body or a
  quota error; the response is already built by then, so the failure is reported and the request
  succeeds uncached.
- **One `waitUntil` covers the kernel and this plugin.** Pass `waitUntil` from `cloudflare:workers`
  to `RuntimePlugin`: it keeps the kernel's `ctx.defer` cleanups alive after a client leaves, and
  `CloudflarePlugin` uses it for its own background work when its `waitUntil` option is omitted. An
  explicit `CloudflarePlugin({ waitUntil })` still works and wins.
- **The write lands with or without a `waitUntil` host.** When the plugin received no host the
  middleware awaits `Cache.put` itself before the response returns — the write delays the response
  instead of being abandoned when the isolate is released (V9-23). Passing `waitUntil` moves the
  write off the response path; the plugin warns at startup when it is missing on Workers.
- **`caches.default` is per-datacenter.** `cacheApiMiddleware` is a latency optimisation, not a
  shared store: a hit in one colo says nothing about another, and a `delete` does not evict
  globally. It reports under `X-Cache-Api`, so it composes with `cache-plugin`'s `cacheMiddleware`
  (which reports under `X-Cache` and reads a store every colo shares) rather than colliding with it.
- **The default key carries the resolved tenant and locale.** The key is a URL string the platform
  matches with no request headers, so `Vary` cannot separate entries here; `ctx.request.tenant` and
  `ctx.request.locale` are appended to the URL text as `setu-cache-tenant` and `setu-cache-locale`
  parameters instead. The middleware must run after the tenant and locale middleware (globally, at a
  higher priority number than theirs — 40 and 45 by default, or whatever `middlewarePriority` and
  `middleware.priority` are set to), and a request no key can keep apart from another — a fragment,
  un-normalized URL text, an unencodable id, or a reserved parameter on a request that lacks the
  value — is served uncached. A custom `key` must include both itself.
- **The edge cache refuses some responses, and the middleware skips them rather than failing.**
  Non-GET, 206, `Vary: *`, and `Set-Cookie` all make `caches.default.put` throw; those are checked
  first. Streaming responses are never cached.
- **The edge cache stores nothing per visitor** — the same rule as `cache-plugin`'s
  `cacheMiddleware`. `Cache-Control: private` (with or without a field list) or `no-store` is never
  stored. A request carrying `Authorization` or a cookie (any cookie by default; the
  `credentialCookies` option names the ones that count) is served only a stored response that says
  `public` and whose `Vary` names neither `Cookie` nor `Authorization`, and its own response is
  stored only on the same terms. A request carrying any cookie at all is never served an entry that
  varies on `Cookie`. A response the session plugin marked as one visitor's is never stored, and one
  it marked as cookie-dependent is stored only from a request carrying neither a cookie nor
  `Authorization`, with `Cookie` added to the stored `Vary`. Because the key is the URL, `Vary`
  cannot keep entries apart here, so the rule is checked when an entry is read as well as when it is
  written. `ttlSeconds` adds `max-age` only, never `public`. Cloudflare's Cache API page suggests
  `Cache-Control: private=Set-Cookie` to cache a response that sets a cookie; here that response is
  not stored (any `private` refuses it), and the middleware warns once naming the header. Drop
  `Set-Cookie` from cacheable responses instead.
- **Evicting after a write.** `purgeCacheApi({ url, tenant?, locales? })` deletes the entries the
  default key stored for a URL (each listed locale; the no-locale entry when none is listed) and
  returns how many it deleted. `cacheApiKey` gives the same key text. Eviction is local to the data
  center the Worker runs in, as `cache.delete` is; other locations keep their copy until it expires.
  With a custom `key`, delete with your own key.
- **A cache HIT is replayed as a stream**, so `app.inject()` cannot read its body — drive cached
  routes in tests with `app.fetch` and a web `Request`, which is what a Worker invokes anyway.
- **Not verified against a live Worker.** Every binding is exercised against a fake built from the
  documented signatures, including KV's 60-second floor and R2's void `delete`. CI has no Cloudflare
  account.

## Not in this package

- **Hyperdrive, Workers AI, Analytics Engine.** Reachable now through `bindings.get<T>('NAME')`;
  each becomes a first-class port only when an application needs one.

## Documentation

- [PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#api-reference-setu-tscloudflare-plugin)
- [ARCHITECTURE.md](https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md)

## License

MIT

## Exports

| Export                                    | Kind      |
| ----------------------------------------- | --------- |
| `assessCacheability`                      | function  |
| `asUpgradeResponse`                       | function  |
| `cacheApiKey`                             | function  |
| `cacheApiMiddleware`                      | function  |
| `CloudflarePlugin`                        | function  |
| `createDefaultDurableObjectWebSocketHost` | function  |
| `createMessagingHandler`                  | function  |
| `createQueueHandler`                      | function  |
| `createScheduledHandler`                  | function  |
| `isD1Database`                            | function  |
| `isDurableObjectNamespace`                | function  |
| `isKvNamespace`                           | function  |
| `isQueueProducer`                         | function  |
| `isR2Bucket`                              | function  |
| `isServiceBinding`                        | function  |
| `purgeCacheApi`                           | function  |
| `CloudflareBindingMissingError`           | class     |
| `CloudflareRemoteHandlerError`            | class     |
| `CloudflareRequestTimeoutError`           | class     |
| `CloudflareUnsupportedError`              | class     |
| `D1Adapter`                               | class     |
| `DistributedLockObjectCore`               | class     |
| `DurableObjectBackplane`                  | class     |
| `DurableObjectIdempotencyStore`           | class     |
| `DurableObjectLock`                       | class     |
| `IdempotencyObjectCore`                   | class     |
| `KvCacheStore`                            | class     |
| `KvSessionStore`                          | class     |
| `R2Storage`                               | class     |
| `RealtimeBackplaneObjectCore`             | class     |
| `ReplyInboxObjectCore`                    | class     |
| `VectorizeVectorStore`                    | class     |
| `WorkersBroker`                           | class     |
| `WorkersCron`                             | class     |
| `WorkersQueue`                            | class     |
| `BrokerRuntime`                           | interface |
| `CacheabilityInput`                       | interface |
| `CacheApiKeyInput`                        | interface |
| `CacheApiMiddlewareOptions`               | interface |
| `CacheClock`                              | interface |
| `CloudflarePluginOptions`                 | interface |
| `D1AdapterOptions`                        | interface |
| `D1EntityMapping`                         | interface |
| `D1Result`                                | interface |
| `DistributedLockObjectCoreOptions`        | interface |
| `DurableObjectArm`                        | interface |
| `DurableObjectBackplaneOptions`           | interface |
| `DurableObjectIdempotencyStoreOptions`    | interface |
| `DurableObjectLockOptions`                | interface |
| `DurableObjectMessageEvent`               | interface |
| `DurableObjectUpgradeResponse`            | interface |
| `DurableObjectWebSocketHost`              | interface |
| `DurableObjectWebSocketPair`              | interface |
| `ICacheApi`                               | interface |
| `ICloudflareBindings`                     | interface |
| `ID1Database`                             | interface |
| `ID1PreparedStatement`                    | interface |
| `IdempotencyObjectCoreOptions`            | interface |
| `IDurableObjectClientSocket`              | interface |
| `IDurableObjectNamespace`                 | interface |
| `IDurableObjectState`                     | interface |
| `IDurableObjectStorage`                   | interface |
| `IDurableObjectWebSocket`                 | interface |
| `IIdempotencyObjectState`                 | interface |
| `IKvNamespace`                            | interface |
| `IQueueMessage`                           | interface |
| `IQueueMessageBatch`                      | interface |
| `IQueueProducer`                          | interface |
| `IR2Bucket`                               | interface |
| `IR2Object`                               | interface |
| `IR2ObjectBody`                           | interface |
| `IScheduledController`                    | interface |
| `IServiceBinding`                         | interface |
| `JobIdSource`                             | interface |
| `KvCacheOptions`                          | interface |
| `KvCacheStoreOptions`                     | interface |
| `KvListOptions`                           | interface |
| `KvListResult`                            | interface |
| `KvPutOptions`                            | interface |
| `KvSessionStoreOptions`                   | interface |
| `MessagingHandlerOptions`                 | interface |
| `PurgeCacheApiTarget`                     | interface |
| `QueueHandlerOptions`                     | interface |
| `QueueSendOptions`                        | interface |
| `R2PutOptions`                            | interface |
| `R2StorageArm`                            | interface |
| `R2StorageOptions`                        | interface |
| `RealtimeBackplaneObjectCoreOptions`      | interface |
| `ReplyInboxBinding`                       | interface |
| `ReplyInboxObjectCoreOptions`             | interface |
| `VectorizeIndexLike`                      | interface |
| `VectorizeVectorLike`                     | interface |
| `VectorizeVectorStoreOptions`             | interface |
| `WorkersBrokerOptions`                    | interface |
| `WorkersCronOptions`                      | interface |
| `WorkersMessagingArm`                     | interface |
| `WorkersMessagingRpcArm`                  | interface |
| `WorkersQueueArm`                         | interface |
| `WorkersQueueOptions`                     | interface |
| `CacheRefusal`                            | type      |
| `CloudflareWorkerEnv`                     | type      |
| `CronHandler`                             | type      |
| `LoggerSource`                            | type      |
| `MessagingHandler`                        | type      |
| `QueueHandler`                            | type      |
| `RetryDelaySeconds`                       | type      |
| `ScheduledHandler`                        | type      |
| `WaitUntilHost`                           | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.

## The Durable Object idempotency store (M109a)

One Durable Object per idempotency store key — the tier-B store `@setu-ts/idempotency-plugin` can
use on Workers. The application exports the DO class and hands the store to the plugin; the object
owns the record, its lease and its alarm.

```toml
# wrangler.toml
[[durable_objects.bindings]]
name = "IDEMPOTENCY"
class_name = "IdempotencyObject"

[[migrations]]
tag = "v1"
new_sqlite_classes = ["IdempotencyObject"]
```

```typescript
import { DurableObject } from 'cloudflare:workers';
import { DurableObjectIdempotencyStore, IdempotencyObjectCore } from '@setu-ts/cloudflare-plugin';
import { IdempotencyPlugin } from '@setu-ts/idempotency-plugin';

// The Durable Object side — the class the binding names.
export class IdempotencyObject extends DurableObject {
  #core = new IdempotencyObjectCore(this.ctx);
  override fetch(request: Request): Promise<Response> {
    return this.#core.fetch(request);
  }
  override alarm(): Promise<void> {
    return this.#core.alarm();
  }
}

// The Worker side — one store, its `namespace` isolating this application's records.
const store = new DurableObjectIdempotencyStore(env.IDEMPOTENCY, { namespace: 'shop' });
app.register(IdempotencyPlugin({ store: { type: 'custom', store } }));
```

The store takes `namespace` (required), `keyPrefix` (default `'idempotency:'`), `binding` (for error
messages) and `timeoutMs` (default 5,000; `0` disables). It advertises `maxRecordBytes` of 120,000 —
under the KV-backed Durable Object value limit — and has no `isHealthy`, because probing it would
create and bill an object.

<!-- version:history -->

## D1 payload refusals (M119e, 0.11.0)

D1 `create`, `update` and `updateWhere` refuse invalid payload identifiers or unknown payload
columns with `UnknownPayloadFieldError` from `@setu-ts/common` (400). The SQLite unknown-column
mapping applies only when the reported column belongs to the payload; precondition-column errors
keep their existing behavior. A STRICT-table type refusal becomes `InvalidFieldValueError` (400).
Both HTTP details are fixed and contain no field names or supplied values.
