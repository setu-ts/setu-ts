# Milestone 52b — Cloudflare Queues, Cron Triggers, and the Cache API (`@hono-enterprise/cloudflare-plugin`)

> **Status:** Planning. Branch: `feat/m52b-cloudflare-platform-handlers`. `main` is protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

M52 reaches every Cloudflare binding and serves the two committed ports (`ICacheStore` from KV,
`IStorage` from R2) that need nothing beyond a request-scoped call. The remaining platform features
share one shape: they need a **module-level handler export** from the application's Worker that the
framework has no contract for. M52b closes that for the two handlers that are pure additions inside
`cloudflare-plugin` — `queue` and `scheduled` — and adds the platform's own response cache, which
needs no handler at all. Each is reachable from an application by exporting one more member beside
`fetch`.

- **In scope:** a `WorkersQueue` satisfying the committed `IQueue` over a Queues producer binding
  plus `createQueueHandler` for the `queue` export; a `WorkersCron` registry plus
  `createScheduledHandler` for the `scheduled` export; a `cacheApiMiddleware` over `caches.default`
  honouring the platform's own refusals; the `queue` arm on `CloudflarePluginOptions`; doc
  deliverables.
- **NOT this milestone:**
  - **D1 and the `common` data-access contract promotion → M52c.** The seam a backend implements is
    `IDatabaseAdapter`, declared inside `packages/database-plugin` (`adapters/adapter.ts:51`), and
    `DatabasePlugin`'s `createAdapter` is a closed three-arm switch (`database-plugin.ts:135`) with
    no external arm. Shipping D1 means promoting `DataSource` + `NormalizedQuery` +
    `IDatabaseAdapter` into `common` and reconciling `ITransaction` with D1's batch-only atomicity —
    a contract decision spanning three packages.
  - **Durable Objects — the DO-backed `IRealtimeBackplane` and the DO-backed distributed lock →
    M52d.** Both need the application to export a DO class plus a wrangler migration stanza, and the
    backplane specifically needs each replica to hold a WebSocket to the DO because Durable Objects
    expose no pub/sub primitive.
  - **Hyperdrive, Vectorize, Workers AI, Analytics Engine.** Each is already reachable through
    `bindings.get<T>(name)`; promoted to a first-class port only when an application needs one.
  - **Running any of this against a live Cloudflare account.** CI holds no Cloudflare credentials;
    M39 owns deployment manifests. The README states which paths are unverified against a real
    Worker, exactly as M52's does.

## 1. Contracts verified from SOURCE (not names)

| Reference                        | Source (file:line)                                                      | Verified surface / fact                                                                                                                                                                                                 |
| -------------------------------- | ----------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IQueue`                         | `packages/common/src/services/queue.ts:79`                              | Exactly three methods: `add<T>(name, data, options?): Promise<string>`, `process<T>(name, processor, options?): void` (SYNCHRONOUS, returns `void`), `addRecurring<T>(name, data, options): Promise<void>`.             |
| `IJob`                           | `packages/common/src/services/queue.ts:14`                              | `readonly id: string`, `name: string`, `data: T`, `attempts: number`. All four readonly; `attempts` is documented as **1 on first delivery**, which matches Cloudflare's `Message.attempts`.                            |
| `AddJobOptions`                  | `packages/common/src/services/queue.ts:39`                              | `delayMs?: number` (MILLISECONDS) and `maxAttempts?: number`. Cloudflare's `delaySeconds` is seconds — a unit conversion, not a pass-through.                                                                           |
| `ProcessOptions`                 | `packages/common/src/services/queue.ts:51`                              | Only `concurrency?: number`, "jobs processed concurrently by this worker (default 1)".                                                                                                                                  |
| `RecurringOptions`               | `packages/common/src/services/queue.ts:61`                              | Only `cron: string`. No interval arm — so `addRecurring` has exactly one shape to refuse.                                                                                                                               |
| `IScheduler`                     | `packages/common/src/services/scheduler.ts:83`                          | EIGHT methods: `cron`, `every`, `delay`, `pause`, `resume`, `remove`, `getNextRun`. Six of them are unimplementable on Workers (see §3.4), which is why this milestone does not claim the port.                         |
| `ICacheStore`                    | `packages/common/src/services/cache.ts:19`                              | `get`/`set`/`delete`/`has`/`clear`. A **key/value** store — the Cache API caches whole `Response`s keyed by `Request`, so it is not an `ICacheStore` backend. Confirms the ROADMAP's "belongs beside a middleware".     |
| `IResponse.snapshot()`           | `packages/common/src/http.ts:176`                                       | Discriminated union on `streaming`; `headers` is the **live** `Headers`, explicitly not a defensive copy, and must be treated as read-only.                                                                             |
| `IResponse.stream()`             | `packages/common/src/http.ts:175`                                       | `stream(body: ReadableStream<Uint8Array>): HandlerResult` — the replay path for a cached `Response.body`.                                                                                                               |
| `IServiceRegistry.has/get`       | `packages/common/src/registry.ts:113`, `:96`                            | `has(token): boolean` exists, and `get` **throws** when unregistered — so the optional `waitUntil` lookup must be guarded by `has`, never by catching.                                                                  |
| `IApplication.services`          | `packages/common/src/plugin.ts:418`                                     | `readonly services: IServiceRegistry` is on the application, so `createQueueHandler(app)` needs no kernel import — `IApplication` is a `common` type.                                                                   |
| `ICloudflareBindings`            | `packages/cloudflare-plugin/src/bindings/binding-registry.ts:43`        | Already carries `queue(name): IQueueProducer` and `waitUntil(promise)`. Neither needs adding.                                                                                                                           |
| `IQueueProducer`                 | `packages/cloudflare-plugin/src/bindings/facades.ts:264`                | Already shipped by M52: `send(body, options?)` and `sendBatch(messages)`; `QueueSendOptions` is `{ contentType?, delaySeconds? }` with delay documented 0–86400. The **consumer** half is what M52b adds.               |
| `resolveWaitUntil`               | `packages/cloudflare-plugin/src/background/wait-until.ts:60`            | Attaches a rejection handler on BOTH paths and takes a `LoggerSource` **thunk**, because `ctx.logger` resolves lazily. The Cache API put reuses this via `ICloudflareBindings.waitUntil`, not a second implementation.  |
| `CloudflareUnsupportedError`     | `packages/cloudflare-plugin/src/errors.ts:63`                           | Already exists and is already the package's "no counterpart on the binding" error (`getSignedUrl`, unprefixed `clear()`). `addRecurring` and the six `IScheduler` gaps reuse it — no new error class.                   |
| `cacheMiddleware` precedent      | `packages/cache-plugin/src/middleware/cache-middleware.ts:122`          | The committed streaming guard: `if (snapshot.streaming) { header('X-Cache','MISS'); return; }`. M52b's middleware mirrors it and must NOT use `X-Cache`, which this middleware already owns (conflict C2).              |
| `PLUGIN_PRIORITY`                | `packages/common/src/plugin.ts` (imported at `cloudflare-plugin.ts:19`) | `CloudflarePlugin` already registers at `PLUGIN_PRIORITY.HIGH`; the `queue` arm changes nothing about ordering.                                                                                                         |
| Cloudflare `MessageBatch`        | Cloudflare Queues docs (consumer handler)                               | `{ queue: string, messages: readonly Message[], ackAll(), retryAll(options?) }`; `Message` is `{ id, timestamp, body, attempts, ack(), retry(options?) }`. `attempts` is 1 on first delivery.                           |
| Cloudflare `ScheduledController` | Cloudflare Cron Triggers docs                                           | `{ scheduledTime: number, cron: string, noRetry() }`. `cron` is the **exact expression string from `wrangler.toml`**, which is the only key a dispatcher can match on.                                                  |
| Cloudflare `Cache.put` refusals  | Cloudflare Cache API docs                                               | `put()` **throws** for: a non-GET request, status `206`, a response carrying `Vary: *`, and a response carrying `Set-Cookie` unless `Cache-Control: private=Set-Cookie` is set. `caches.default` is **per-datacenter**. |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                       | Resolution (picked side)                                                                                                                                                                                                                                                                 | Doc deliverable (same PR)                                                                                                                                              |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md` §M52b scopes D1, Queues, Cron, Durable Objects and the Cache API into ONE milestone. D1 alone spans a `common` contract promotion plus `database-plugin`; the DO backplane is its own design.                                                     | **Split, at the maintainer's direction:** M52b = Queues + Cron + Cache API (this plan); M52c = D1 + the `common` data-access promotion; M52d = Durable Objects (backplane AND lock). Honours AI_GUIDELINES §8.4.                                                                         | Rewrite the ROADMAP §M52b section to this scope; add §M52c and §M52d sections; add `52c` and `52d` rows to the Progress Tracking table beside the re-scoped `52b` row. |
| C2 | `cache-plugin`'s `cacheMiddleware` writes `X-Cache: HIT\|MISS` (`cache-middleware.ts:80,123,137`). A second response-cache middleware writing the same header would make the two indistinguishable when both are installed — which is a supported composition. | The Cache API middleware writes **`X-Cache-Api`**, never `X-Cache`. The two layers are genuinely different (edge colo cache vs. application KV/memory store) and an operator needs to tell a hit in one from a hit in the other.                                                         | Document the header and the two-layer composition in the package README and the PUBLIC_API Cloudflare section.                                                         |
| C3 | `ROADMAP.md` §M52b specifies `createQueueHandler(app)` but leaves the cron factory's argument unstated, and asks for "the decision on whether a Workers `IScheduler` can honour runtime `schedule()` calls at all".                                            | `createQueueHandler(app)` is kept as written. `createScheduledHandler` takes a `WorkersCron`, **not** the app, because §3.4 decides the cron registry does not claim `CAPABILITIES.SCHEDULER` and therefore is not in the registry to resolve. The asymmetry follows from that decision. | State both signatures and the reason for the asymmetry in the ROADMAP §M52b rewrite, the README, and PUBLIC_API.                                                       |
| C4 | `facades.ts:220` and `:301` JSDoc say a first-class D1 backend and the DO backplane/lock "are M52b".                                                                                                                                                           | They are M52c and M52d respectively, per C1. Leaving the JSDoc is exactly the docs-must-match-behaviour defect the checklist names.                                                                                                                                                      | Correct both JSDoc blocks in `facades.ts` to name M52c / M52d.                                                                                                         |
| C5 | `CLAUDE.md` "Current status" records M52 as "complete (PR pending)"; it merged as **PR #111** (`origin/main` `71c1a66`).                                                                                                                                       | Record the real PR number. The status line is a committed claim about merged work and is currently wrong.                                                                                                                                                                                | Fix the M52 status line to "complete (PR #111)" alongside the M52b entry, in this PR.                                                                                  |

## 3. Design decisions

### 3.1 A message envelope carries the job name, id, and attempt cap

- **Decision:** `WorkersQueue.add` sends `{ v: 1, name, id, data, maxAttempts? }` as the message
  body, with `id` from `runtime.uuid()`. `dispatch` validates the envelope with an internal
  `isJobEnvelope` guard, reads `name` to find the processor, and builds
  `IJob = { id: envelope.id, name, data: envelope.data, attempts: message.attempts }`.
- **Why:** `IQueue.process` dispatches **by job name** and `IQueue.add` returns a job **id**, but a
  Cloudflare message body is arbitrary JSON carrying neither, and `producer.send()` returns `void`
  so the platform hands back no id at all. `Message.id` exists but only at the consumer, so using it
  would make `add`'s returned id and `job.id` two different values — a lie by omission. One envelope
  fixes both. This is the M14c/M52 envelope precedent (`KvCacheStore`'s `{ v, e }`).
  `runtime.uuid()` rather than `crypto.randomUUID()` per AI_GUIDELINES §4.2, which is also why the
  queue is plugin-constructed (§3.3) — an application entry file has no `IRuntimeServices`.
- **Test home:** `test/unit/workers-queue.test.ts` — "add sends an envelope carrying the returned
  id" and "dispatch reads the name and payload back out of the envelope"; plus a non-envelope-body
  message retried rather than dropped.

### 3.2 A message whose name has no processor is retried, never acked

- **Decision:** `dispatch` calls `message.retry()` for a message whose envelope is unreadable or
  whose `name` has no registered processor, and reports it through the injected logger. A processor
  that throws also `retry()`s. A processor that resolves `ack()`s. A message whose
  `attempts >= maxAttempts` (from the envelope) is `ack()`ed without running the processor and
  reported as exhausted.
- **Why:** `ack()` on an unroutable message discards it permanently and silently, which is the
  failure mode a queue exists to prevent. `retry()` sends it back for the platform's own
  `max_retries`/dead-letter configuration to handle, which is where that policy already lives.
  `maxAttempts` is a per-message `AddJobOptions` field while Cloudflare's `max_retries` is
  queue-wide config, so enforcing the per-message cap at dispatch is the only place it can be
  honoured — this is what stops it being a dead option.
- **Test home:** `test/unit/workers-queue.test.ts` — four cases: unknown name → `retry` called and
  `ack` not; malformed body → same; processor throws → `retry`; `attempts` past `maxAttempts` →
  `ack` and processor never invoked.

### 3.3 The queue is plugin-constructed and reached through `CAPABILITIES.QUEUE`; the handler narrows with `instanceof`

- **Decision:** `CloudflarePluginOptions` gains `queue?: { binding: string; name?: string }`. The
  plugin builds `new WorkersQueue(registry.queue(binding), ctx.runtime, { logger })` and registers
  it under `instanceToken(CAPABILITIES.QUEUE, name)`. `createQueueHandler(app, options?)` resolves
  that token typed as `IQueue`, then narrows with `instanceof WorkersQueue`, throwing
  `CloudflareUnsupportedError` naming the token when the registered provider is some other `IQueue`.
- **Why:** `WorkersQueue` needs `runtime.uuid()` (§3.1), which only the plugin has. Resolving the
  token as `IQueue` and narrowing by a **runtime `instanceof`** on an exported class satisfies the
  token↔interface rule — it is a checked narrowing, not a cast to a different interface. The
  alternative (app-constructs, hands the instance to the plugin, `KvSessionStore` precedent) was
  rejected because it would push id generation into application code with no runtime services.
  Registration is opt-in and instance-named for the same reason `cache`/`storage` are: the kernel's
  plugin resolver rejects two providers of one token, so a KV queue must be able to sit beside a
  memory one.
- **Test home:** `test/integration/queue-plugin.test.ts` — a real kernel app registers the plugin
  with a fake producer binding, resolves `CAPABILITIES.QUEUE`, `add`s, and drives
  `createQueueHandler(app)` over a fake batch; plus a case registering a non-`WorkersQueue` under
  the token and asserting the named throw.

### 3.4 A Workers cron registry does NOT claim `CAPABILITIES.SCHEDULER`

- **Decision:** ship `WorkersCron`, a purpose-built registry with `on(expression, handler)`,
  `expressions()`, and `dispatch(controller)`. It is **app-constructed** (`new WorkersCron()`), is
  registered under no capability token, and implements no committed port.
  `createScheduledHandler(cron, options?)` takes it directly.
- **Why:** this is the decision the ROADMAP asks for, and the answer is no. Of `IScheduler`'s eight
  methods, `every` and `delay` are structurally impossible — a Worker isolate is evicted between
  invocations, so a `runtime.setInterval` armed in one invocation never fires in the next, which is
  also precisely why `scheduler-plugin` cannot run on Workers. `pause`, `resume` and `remove` need
  state that survives between invocations and there is none. `getNextRun` is owned by the
  `wrangler.toml` `[triggers]` block, not by the process. That leaves `cron()` alone as
  implementable, and an `IScheduler` where six of eight methods throw violates Liskov substitution
  (AI_GUIDELINES §1.1) and would break any code written against the port. A small honest surface
  beats a large dishonest one. `WorkersCron` needs no ids and no clock — it matches
  `controller.cron` against registered expressions — so app construction costs nothing, which is why
  it does not follow §3.3's plugin-constructed shape.
- **Test home:** `test/unit/workers-cron.test.ts` — dispatch routes by exact expression; an
  unmatched expression invokes no handler and is reported; a handler that throws does not prevent
  the others registered on the same expression from running. Plus a
  `test/unit/scheduled-handler.test.ts` case asserting the handler awaits every dispatched handler
  (a Cron Trigger invocation ends when the returned promise settles).

### 3.5 Cache API refusals are assessed here, not discovered by a thrown `put`

- **Decision:** a pure `assessCacheability({ method, status, headers, cacheableStatuses })` returns
  a `readonly CacheRefusal[]`. `cacheApiMiddleware` skips the `put` when the array is non-empty. The
  206 and `Vary: *` checks are **unconditional**, evaluated independently of `cacheableStatuses`.
- **Why:** `caches.default.put` throws for a non-GET request, status 206, `Vary: *`, and an
  uncleared `Set-Cookie`. Letting it throw inside a `waitUntil`-ed background task turns an ordinary
  uncacheable response into a logged background failure on every request. Checking first turns it
  into a documented skip. The 206 check must be unconditional because an operator can legitimately
  configure `cacheableStatuses: [200, 206]`, at which point the status check passes and only the
  explicit 206 rule stops the platform from throwing — a defensive check that is load-bearing rather
  than decorative. `Set-Cookie` is a refusal unless `Cache-Control` contains `private=Set-Cookie`,
  which is the platform's own documented escape hatch.
- **Test home:** `test/unit/cacheability.test.ts` — one case per refusal, one for the
  `private=Set-Cookie` escape hatch, one for `cacheableStatuses: [200, 206]` still refusing 206, and
  one clean case returning an empty array.

### 3.6 The Cache API handle is injected, with one internal default resolver

- **Decision:** an `ICacheApi` facade (`match`/`put`/`delete`) plus an internal
  `resolveCacheApi(globalScope?)` that reads `caches.default` structurally and returns `undefined`
  when it is absent. `cacheApiMiddleware` takes `cache?: ICacheApi`; with neither an injected handle
  nor a resolvable `caches.default`, the middleware **passes through** (calls `next()` and sets
  `X-Cache-Api: BYPASS`) rather than throwing.
- **Why:** `caches.default` is a Cloudflare-specific global with no module to import, so a direct
  read is untestable and would make the middleware explode on Deno, where `caches` exists but
  `caches.default` does not. One internal seam keeps the global read in a single unit-tested
  function and makes every branch of the middleware drivable from a fake. Passing through rather
  than throwing is the M24b runtime-gating precedent: an application composed for several targets
  should not fail to serve off Workers because an edge-only optimisation is unavailable.
- **Test home:** `test/unit/cache-api.test.ts` drives `resolveCacheApi` with a fake global carrying
  `caches.default`, one carrying `caches` without `default`, and one with no `caches` at all;
  `test/unit/cache-api-middleware.test.ts` asserts the pass-through path sets `BYPASS` and still
  calls `next()`.

### 3.7 The `put` rides `ICloudflareBindings.waitUntil` when it is registered

- **Decision:** the middleware resolves `CAPABILITIES.CLOUDFLARE` at request time **guarded by
  `ctx.services.has`**, and hands the `put` to `bindings.waitUntil(...)`. With the token
  unregistered it `await`s the `put` inline.
- **Why:** a cache write must not delay the response, and `waitUntil` is exactly the platform
  primitive for that — with `resolveWaitUntil`'s rejection reporting already attached, so a failed
  background write is logged rather than becoming an unhandled rejection. `has` rather than a
  `try`/`catch`, because `IServiceRegistry.get` throws on an unregistered token (`registry.ts:96`)
  and catching would also swallow a genuine error from the resolved service. Awaiting inline when
  the plugin is absent keeps the middleware standalone-usable and keeps the write from being
  silently dropped.
- **Test home:** `test/unit/cache-api-middleware.test.ts` — one case with a fake bindings service
  asserting the `put` promise reached `waitUntil` and the response was not blocked on it; one with
  the token absent asserting the `put` completed before the middleware returned.

### 3.8 A streaming response is not cached, and is not touched

- **Decision:** after `next()`, `snapshot().streaming === true` sets `X-Cache-Api: MISS` and returns
  without reading the body.
- **Why:** this is the committed M42 guard `cache-plugin` already implements
  (`cache-middleware.ts:122`). Teeing a live stream to feed the cache doubles the memory the stream
  exists to avoid and changes the response's flush timing; SSE and SSR responses are exactly the
  streams that would be hit.
- **Test home:** `test/unit/cache-api-middleware.test.ts` — a handler that calls
  `ctx.response.stream(...)`, asserting `put` was never called and the header is `MISS`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol             | Kind  | Consumer / real code path that READS it                                                                                                                                       |
| --------------------------- | ----- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `WorkersQueue`              | class | `CloudflarePlugin` constructs it for the `queue` arm; `createQueueHandler` narrows to it with `instanceof`; an application may construct one directly for a non-plugin setup. |
| `WorkersQueueOptions`       | type  | `WorkersQueue`'s constructor; the plugin passes `{ logger }`.                                                                                                                 |
| `createQueueHandler`        | fn    | The application's Worker module: `export default { fetch: app.fetch, queue: createQueueHandler(app) }`.                                                                       |
| `QueueHandlerOptions`       | type  | `createQueueHandler`'s second parameter — carries `name` to target `queue.<name>`.                                                                                            |
| `IQueueMessage`             | type  | `WorkersQueue.dispatch`'s per-message parameter; the shape a test fake and a real `Message` both satisfy.                                                                     |
| `IQueueMessageBatch`        | type  | `createQueueHandler`'s returned handler parameter; the shape a real `MessageBatch` satisfies.                                                                                 |
| `QueueHandler`              | type  | The return type of `createQueueHandler` — what the application assigns to its `queue` export.                                                                                 |
| `WorkersCron`               | class | The application constructs it, calls `on(...)`, and passes it to `createScheduledHandler`.                                                                                    |
| `CronHandler`               | type  | The callback `WorkersCron.on` accepts; an application writes one per trigger.                                                                                                 |
| `WorkersCronOptions`        | type  | `WorkersCron`'s constructor — carries `logger`, read on the unmatched-expression and handler-failure paths.                                                                   |
| `createScheduledHandler`    | fn    | The application's Worker module: `export default { fetch: app.fetch, scheduled: createScheduledHandler(cron) }`.                                                              |
| `IScheduledController`      | type  | `WorkersCron.dispatch`'s parameter; the shape a real `ScheduledController` satisfies.                                                                                         |
| `ScheduledHandler`          | type  | The return type of `createScheduledHandler` — what the application assigns to its `scheduled` export.                                                                         |
| `cacheApiMiddleware`        | fn    | The application adds it to a route or the global pipeline: `app.middleware.add(cacheApiMiddleware())`.                                                                        |
| `CacheApiMiddlewareOptions` | type  | `cacheApiMiddleware`'s parameter (§4.1).                                                                                                                                      |
| `ICacheApi`                 | type  | `CacheApiMiddlewareOptions.cache`, and the return of the internal resolver — the injection surface for a fake.                                                                |
| `CacheRefusal`              | type  | `assessCacheability`'s return element; read by the middleware's skip branch and asserted by its tests.                                                                        |
| `assessCacheability`        | fn    | `cacheApiMiddleware`'s pre-`put` check. Exported because it is the one honest way for an application to ask "would the edge cache this?" without attempting a write.          |
| `WorkersQueueArm`           | type  | `CloudflarePluginOptions.queue` (§4.1).                                                                                                                                       |

Nothing else is added to the barrel. `isJobEnvelope`, `JobEnvelope`, `resolveCacheApi` and
`instanceToken` stay internal — each has a real in-package consumer and no external one, so
exporting them would be surface with no reader.

### 4.1 Options — every option names its consumer

| Option                                        | Consumer                               | Behavior (per implementation)                                                                                                                                                                          |
| --------------------------------------------- | -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `CloudflarePluginOptions.queue.binding`       | `CloudflarePlugin.register`            | Read through `registry.queue(binding)`; an absent binding throws `CloudflareBindingMissingError` at `register()`, matching the `cache`/`storage` arms.                                                 |
| `CloudflarePluginOptions.queue.name`          | `instanceToken(CAPABILITIES.QUEUE, …)` | `'default'` (or omitted) claims the bare `queue` token; anything else derives `queue.<name>`. Also the value `QueueHandlerOptions.name` must match.                                                    |
| `WorkersQueueOptions.logger`                  | `WorkersQueue.dispatch`                | Reported on: unroutable message, malformed envelope, processor failure, attempts exhausted. Omitted means those paths are silent — which is why the plugin always passes one.                          |
| `WorkersQueueOptions.maxDelaySeconds`         | `WorkersQueue.add`                     | Defaults to 86400, the platform maximum. `add` with a `delayMs` exceeding it throws `CloudflareUnsupportedError` naming the cap rather than letting the platform reject the send.                      |
| `QueueHandlerOptions.name`                    | `createQueueHandler`                   | Selects which `queue.<name>` token to resolve. Omitted resolves the bare `CAPABILITIES.QUEUE`.                                                                                                         |
| `WorkersCronOptions.logger`                   | `WorkersCron.dispatch`                 | Reported on an expression with no registered handler and on a handler that rejects. Omitted means silent.                                                                                              |
| `CacheApiMiddlewareOptions.cache`             | `cacheApiMiddleware`                   | The injected `ICacheApi`. Omitted falls back to `resolveCacheApi()`; when that also yields nothing the middleware passes through with `X-Cache-Api: BYPASS` (§3.6).                                    |
| `CacheApiMiddlewareOptions.key`               | `cacheApiMiddleware`                   | Builds the cache key URL from the context. Omitted uses `ctx.request.url`, which is what the platform's own cache keys on.                                                                             |
| `CacheApiMiddlewareOptions.bypass`            | `cacheApiMiddleware`                   | Returning `true` calls `next()` and sets `X-Cache-Api: BYPASS`, reading neither nor writing the cache.                                                                                                 |
| `CacheApiMiddlewareOptions.cacheableStatuses` | `assessCacheability`                   | Defaults to `[200]`. A status outside it is a `'status'` refusal. Does **not** override the unconditional 206 rule (§3.5).                                                                             |
| `CacheApiMiddlewareOptions.ttlSeconds`        | `cacheApiMiddleware`                   | When set and the response carries no `Cache-Control`, a `Cache-Control: public, max-age=<n>` header is added to the **cached copy only**, since `caches.default` honours the response's own directive. |

## 5. Implementation files

| File                                     | Purpose                                                                                                                            |
| ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts` (edit)                    | Barrel exports for every symbol in §4.                                                                                             |
| `src/options.ts` (edit)                  | `WorkersQueueArm` and `CloudflarePluginOptions.queue`.                                                                             |
| `src/plugin/cloudflare-plugin.ts` (edit) | Build and register `WorkersQueue` for the `queue` arm; add its token to `provides`; pass `queue` to the health indicator.          |
| `src/health/indicator.ts` (edit)         | `CloudflareHealthInput.queue: boolean`, reported in `data`.                                                                        |
| `src/bindings/facades.ts` (edit)         | C4 JSDoc corrections only (D1 → M52c, Durable Objects → M52d). No shape change.                                                    |
| `src/queues/job-envelope.ts`             | `JobEnvelope`, `encodeJobEnvelope`, `isJobEnvelope` — the pure §3.1 codec. Internal.                                               |
| `src/queues/workers-queue.ts`            | `WorkersQueue implements IQueue` — `add`, `process`, `addRecurring` (throws), and `dispatch(batch)` with the §3.2 ack/retry rules. |
| `src/queues/queue-handler.ts`            | `IQueueMessage`, `IQueueMessageBatch`, `QueueHandler`, `QueueHandlerOptions`, `createQueueHandler`.                                |
| `src/queues/bounded-map.ts`              | `runBounded(items, limit, fn)` — the pure bounded-concurrency helper honouring `ProcessOptions.concurrency`. Internal.             |
| `src/cron/workers-cron.ts`               | `WorkersCron`, `CronHandler`, `WorkersCronOptions`, `IScheduledController`.                                                        |
| `src/cron/scheduled-handler.ts`          | `ScheduledHandler`, `createScheduledHandler`.                                                                                      |
| `src/cache-api/cache-api.ts`             | `ICacheApi` facade and the internal `resolveCacheApi(globalScope?)` (§3.6).                                                        |
| `src/cache-api/cacheability.ts`          | `CacheRefusal` and the pure `assessCacheability` (§3.5).                                                                           |
| `src/cache-api/cache-api-middleware.ts`  | `CacheApiMiddlewareOptions` and `cacheApiMiddleware`.                                                                              |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                       | src covered                                            | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------- | ------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/job-envelope.test.ts`                | `queues/job-envelope.ts`                               | `encodeJobEnvelope('send-email', 'id-1', { to: 'a' })` round-trips through `isJobEnvelope`; a bare object, `null`, a string, a wrong `v`, and a missing `name` all fail the guard. Types against `JobEnvelope`.                                                                                                                                                       |
| `test/unit/bounded-map.test.ts`                 | `queues/bounded-map.ts`                                | `runBounded` with `limit: 1` never overlaps; with `limit: 3` over 7 items peaks at exactly 3; a rejecting item does not abort the rest and its rejection is surfaced per item. Types against `runBounded<T>(items: readonly T[], limit: number, fn: (item: T) => Promise<void>): Promise<void>`.                                                                      |
| `test/unit/workers-queue.test.ts`               | `queues/workers-queue.ts`                              | `add` returns the envelope id and calls `producer.send` with `{ delaySeconds: 2 }` for `delayMs: 1500` (ceil); `delayMs` past `maxDelaySeconds` throws `CloudflareUnsupportedError`; `addRecurring` throws naming Cron Triggers; `process`'s `concurrency` is honoured; the four §3.2 ack/retry cases. Types against `IQueue`.                                        |
| `test/unit/queue-handler.test.ts`               | `queues/queue-handler.ts`                              | The returned handler resolves the bare token by default and `queue.reports` when `{ name: 'reports' }` is given; a registered non-`WorkersQueue` `IQueue` throws `CloudflareUnsupportedError` naming the token; the returned promise settles only after every message is acked. Types against `QueueHandler`.                                                         |
| `test/unit/workers-cron.test.ts`                | `cron/workers-cron.ts`                                 | `dispatch` routes by exact expression string; two handlers on one expression both run; a rejecting handler does not stop the others and is reported through the logger; an unmatched expression runs nothing and is reported; `expressions()` lists what was registered. Types against `IScheduledController`.                                                        |
| `test/unit/scheduled-handler.test.ts`           | `cron/scheduled-handler.ts`                            | The returned handler awaits every dispatched handler before resolving (a slow handler delays the returned promise); it forwards `controller.cron` unchanged. Types against `ScheduledHandler`.                                                                                                                                                                        |
| `test/unit/cache-api.test.ts`                   | `cache-api/cache-api.ts`                               | `resolveCacheApi` returns the handle from a fake global carrying `caches.default`; returns `undefined` for `caches` without `default`, for no `caches`, and for a `caches.default` missing `put`. Types against `ICacheApi`.                                                                                                                                          |
| `test/unit/cacheability.test.ts`                | `cache-api/cacheability.ts`                            | One case per refusal (`method`, `status`, `partial-content`, `vary-star`, `set-cookie`); `private=Set-Cookie` clears the `set-cookie` refusal; `cacheableStatuses: [200, 206]` still yields `partial-content` for 206; a clean GET 200 yields `[]`. Types against `assessCacheability`.                                                                               |
| `test/unit/cache-api-middleware.test.ts`        | `cache-api/cache-api-middleware.ts`                    | HIT replays status, headers and body and does **not** call `next()` (the mandatory short-circuit test); MISS calls `put`; a refusal skips `put`; a streaming response skips `put` (§3.8); `bypass` and the no-handle path set `BYPASS` and still call `next()`; `ttlSeconds` adds `Cache-Control` to the cached copy only. Uses `createTestContext`.                  |
| `test/unit/indicator.test.ts` (edit)            | `health/indicator.ts`                                  | Existing cases plus `queue: true`/`false` appearing in `data`.                                                                                                                                                                                                                                                                                                        |
| `test/integration/queue-plugin.test.ts`         | `plugin/cloudflare-plugin.ts`, `options.ts`            | A real kernel app (`createTestApp`) registers `CloudflarePlugin({ env, queue: { binding: 'JOBS' } })` with a fake producer; `app.services.get<IQueue>(CAPABILITIES.QUEUE)` resolves; `add` reaches the fake producer; `createQueueHandler(app)` dispatches the recorded body and the processor **reads the payload back**; `name: 'reports'` derives `queue.reports`. |
| `test/integration/cache-api-middleware.test.ts` | `cache-api/cache-api-middleware.ts`, `plugin/…`        | A real kernel app with `CloudflarePlugin` + the middleware on a route: first request MISS and the fake `ICacheApi` records a `put` handed to the plugin's `waitUntil`; second request HIT served from the fake with the handler never invoked.                                                                                                                        |
| `test/e2e/worker-exports.test.ts`               | `queues/queue-handler.ts`, `cron/scheduled-handler.ts` | Builds the module shape an application actually deploys — `{ fetch, queue, scheduled }` — and drives all three: a `fetch` returns 200, the `queue` export processes a batch enqueued through `IQueue.add` in the same test, and the `scheduled` export fires the handler registered for the trigger's expression.                                                     |

No external npm dependency is added, so the guarded real-import test the checklist requires for
external-dep code does not apply — the same reason M50 gives. The platform-global read that would
otherwise be untestable (`caches.default`) is behind the §3.6 seam and is unit-tested directly.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m52b-cloudflare-platform-handlers, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Plus the package's own end-of-task audit:

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" \
  packages/cloudflare-plugin/src   # must be empty
```

## 8. Risks & mitigations

- **None of this is verified against a live Cloudflare account.** CI holds no credentials, so every
  fake could agree with a wrong reading of the platform. → Every platform fact the design turns on
  is recorded in §1 with the behaviour it produced, the facades are structural so a real binding
  satisfies them without a cast, and the README states plainly which paths are unverified — the M52
  and M30b precedent. The e2e test drives the exact `{ fetch, queue, scheduled }` module shape a
  deployment uses, so the wiring is exercised even though the platform is not.
- **`caches.default` is per-datacenter**, so a HIT rate measured in one colo says nothing about
  another and a `delete` does not evict globally. → Documented in the middleware JSDoc, the README,
  and the PUBLIC_API section, next to the `X-Cache-Api` header that makes the layer visible.
- **A Cron Trigger expression can be registered on `WorkersCron` and never fire**, because the
  expression must also appear in `wrangler.toml` `[triggers]` and nothing in the process can see
  that file. → `WorkersCron.expressions()` exists so an application can assert its own coverage, the
  unmatched-expression path is reported through the logger rather than being silent, and the README
  documents that the two lists must agree.
- **A `queue` retry storm**: §3.2 retries an unroutable message, which against a queue with generous
  `max_retries` costs repeated invocations. → The logger report names the job name and the batch's
  queue on every retry, so the misconfiguration is visible immediately rather than only in the
  billing; and the alternative — a silent `ack` — loses the message, which is strictly worse.
- **`snapshot().headers` is the live `Headers`** (`http.ts:176`), so building the cached `Response`
  from it must not mutate it. → The middleware constructs `new Headers(snapshot.headers)` before
  adding the `ttlSeconds` `Cache-Control`, and a test asserts the response the client receives does
  not carry the header the cached copy does.

## 9. Out of scope

- **D1 and the `common` data-access contract promotion** — M52c, per conflict C1.
- **Durable Objects: the DO-backed `IRealtimeBackplane` and DO-backed distributed lock** — M52d, per
  conflict C1.
- **A `cloudflare` arm on any starter.** M36-series work; it needs a Workers-portability review of
  the whole plugin set, not just this package.
- **A CLI schematic for the `queue`/`scheduled` exports.** The
  `honoe new --runtime
  cloudflare-workers` template gains no new file here; wiring is documented
  in the README first, and templating it belongs with M52c/M52d once the full handler set is known.
- **Honouring Cloudflare's queue `max_retries` or dead-letter configuration from application code.**
  Those live in `wrangler.toml` and the platform enforces them; `AddJobOptions.maxAttempts` is
  enforced per message at dispatch (§3.2) and does not attempt to reconcile with them.
