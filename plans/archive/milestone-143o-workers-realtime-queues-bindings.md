# Milestone 143o — Workers: Realtime, Durable Objects, Queues and Bindings (`@setu-ts/cloudflare-plugin`, `@setu-ts/websocket-plugin`, `@setu-ts/runtime` Workers adapter)

> **Status:** Complete (implemented inline; decisions in §12). Branch:
> `feat/m143o-workers-realtime-queues-bindings`. `develop` and `main` are protected: all work
> (implementation and fixes) stays on this one branch until it merges via ONE PR into `develop`;
> part 1 (realtime) precedes part 2 in commit order (§14). **Implementation:** inline by Claude, not
> Codex, by the maintainer's choice (relayed by the coordinator, 2026-11-23), so M143q can use Codex
> without the two sharing one lock. Review, docs-claims, the audit and the gates are unchanged.

## 0. Objective & scope

The Workers lane's only letter of the `v0.13.0` smoke closeout (ROADMAP "Milestone 143o"). After it,
a WebSocket room on Workers works for any number of members, on one Worker and across two Workers
sharing one Durable Object namespace, and keeps working after members leave; a clean close is
answered at once; a Workers job that exhausts its attempts reaches `onFailed` and a dead-letter
queue instead of being deleted (discarded only where the application set `deadLetterQueue: false`);
the edge cache can be evicted after a write and never stores a per-visitor response; a binding of
the wrong kind fails at boot by name; the lock refuses a TTL that is not a positive whole number of
milliseconds; service bindings and the lock's real use are documented; and a trace crosses Workers
messaging. The boundary: this letter edits only `packages/cloudflare-plugin`,
`packages/websocket-plugin`, `packages/runtime/src/adapters/workers`, their tests and READMEs, one
additive file in `packages/common`, and the shared files every PR touches. Everything is proved on
local `workerd` only; no Cloudflare account exists.

- **In scope:** V13-195, V13-196, V13-197, V13-201, V13-202, V13-203, V13-204, V13-205, V13-206,
  V13-209, V13-210, V13-219; the Workers halves of V13-220 (owned by M143m), V13-218 (owned by
  M143h), V13-111 and V13-135 (owned by M143a, its hand-over X6 and X7 and the PR #609 addendum),
  V13-41 and V13-200 (owned by M143i, its hand-over). Folded in from hand-overs received after the
  draft (§0.5): workerd's `cancel()` on a replayed Cache API body (M143i), the `createDnsResolver`
  line in the Workers runtime comment (#613), and the README sentence that `WorkersBroker` gives no
  fan-out subscription (M143p §11). By decision: `static-plugin`'s `Vary` replacement (D10, an
  out-of-lane edit until the lanes table lists it) and V13-217's R2 half (D11, after #614 merges).
- **NOT this milestone:** every generated file in `packages/cli` (M143j, §11 lists the exact line
  per row); `docs/` outside `docs/upgrading.md` (M143n, §11); the SQS halves of V13-220 (M143m); the
  `database-plugin` classifier half of V13-218 (M143h); (the `kernel`, `common` and `RuntimePlugin`
  half of V13-200 IS in this letter, by the maintainer's D3 decision: an out-of-lane edit, flagged
  in §3.18 and the PR); `sse-plugin`, which no lane lists and which has the same request-ownership
  defect on Workers (§9, reported to the maintainer); `scheduler-plugin`'s memory and Redis locks,
  whose invalid-TTL behaviour disagrees with the fixed Durable Object lock (§9, no lane owns that
  package).

### 0.1 Row map

| Row                    | Sev               | Decision      | Files (src)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Test file(s)                                                                                                                                                                                                                                                                                                                                         |
| ---------------------- | ----------------- | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| V13-195                | High              | §3.1, §3.2    | `websocket-plugin/src/services/websocket-service.ts`, `src/rooms/request-bound-rooms.ts` (new), `src/rooms/room-registry.ts`, `src/plugin/websocket-plugin.ts`, `src/errors/websocket-errors.ts`, `src/heartbeat/heartbeat.ts`; `runtime/src/adapters/workers/cf-ws-upgrader.ts`; `cloudflare-plugin/src/realtime/durable-object-backplane.ts`, `src/realtime/connection-link.ts` (new), `src/durable-objects/realtime-backplane-object.ts`; `common/src/services/realtime-links.ts` (new) | `websocket-plugin/test/unit/request-bound-rooms.test.ts`, `test/integration/request-bound-backplane.test.ts`; `runtime/test/unit/cf-ws-upgrader.test.ts`; `cloudflare-plugin/test/unit/realtime/connection-link.test.ts`, `test/unit/durable-objects/realtime-backplane-object.test.ts`; `cloudflare-plugin/test/e2e/workerd-realtime-rooms.test.ts` |
| V13-196                | High              | §3.1, §3.3    | `cloudflare-plugin/src/realtime/durable-object-backplane.ts`; `websocket-plugin/src/services/websocket-service.ts`                                                                                                                                                                                                                                                                                                                                                                         | `cloudflare-plugin/test/unit/realtime/durable-object-backplane.test.ts`; `websocket-plugin/test/unit/websocket-service.test.ts`; the workerd e2e above                                                                                                                                                                                               |
| V13-197                | High              | §3.4 (D2, D8) | `cloudflare-plugin/src/queues/workers-queue.ts`, `src/options.ts`, `src/plugin/cloudflare-plugin.ts`                                                                                                                                                                                                                                                                                                                                                                                       | `cloudflare-plugin/test/unit/queues/workers-queue.test.ts`, `test/integration/queue-plugin.test.ts`, `test/e2e/workerd-queue-dead-letter.test.ts`                                                                                                                                                                                                    |
| V13-201                | Medium            | §3.5          | `cloudflare-plugin/src/bindings/facades.ts`, `src/bindings/binding-registry.ts`                                                                                                                                                                                                                                                                                                                                                                                                            | `cloudflare-plugin/test/unit/bindings/facades.test.ts`, `binding-registry.test.ts`                                                                                                                                                                                                                                                                   |
| V13-202                | Medium            | §3.6          | `cloudflare-plugin/src/cache-api/cache-api-key.ts` (new), `src/cache-api/cache-api-middleware.ts`, `src/index.ts`                                                                                                                                                                                                                                                                                                                                                                          | `cloudflare-plugin/test/unit/cache-api/cache-api-key.test.ts`, `cache-api-middleware.test.ts`, `test/integration/cache-api-middleware.test.ts`                                                                                                                                                                                                       |
| V13-203                | Medium            | §3.7          | `runtime/src/adapters/workers/cf-ws-upgrader.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                           | `runtime/test/unit/cf-ws-upgrader.test.ts`; the workerd realtime e2e (close timing)                                                                                                                                                                                                                                                                  |
| V13-204                | Medium            | §3.8          | `cloudflare-plugin/src/lock/durable-object-lock.ts`, `src/durable-objects/distributed-lock-object.ts`                                                                                                                                                                                                                                                                                                                                                                                      | `cloudflare-plugin/test/unit/lock/durable-object-lock.test.ts`, `test/unit/durable-objects/distributed-lock-object.test.ts`                                                                                                                                                                                                                          |
| V13-205                | Medium            | §3.9          | README only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | `test/docs-gate.test.ts` fences (existing gate)                                                                                                                                                                                                                                                                                                      |
| V13-206                | Medium            | §3.10         | README; `cloudflare-plugin/src/lock/durable-object-lock.ts` JSDoc `@example`                                                                                                                                                                                                                                                                                                                                                                                                               | docs gate                                                                                                                                                                                                                                                                                                                                            |
| V13-209                | Medium            | §3.11         | README, `AGENT_CARD.md`                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | docs gate                                                                                                                                                                                                                                                                                                                                            |
| V13-210                | Medium            | §3.12         | `cloudflare-plugin/src/messaging/workers-broker.ts`, `src/messaging/message-envelope.ts`, `src/plugin/cloudflare-plugin.ts`                                                                                                                                                                                                                                                                                                                                                                | `cloudflare-plugin/test/unit/messaging/workers-broker-publish.test.ts`, `workers-broker-dispatch.test.ts`, `message-envelope.test.ts`, `test/integration/rpc-round-trip.test.ts`                                                                                                                                                                     |
| V13-219                | Low               | §3.13         | `cloudflare-plugin/src/cron/workers-cron.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                               | `cloudflare-plugin/test/unit/cron/workers-cron.test.ts`                                                                                                                                                                                                                                                                                              |
| V13-220 half           | Low               | §3.14         | `workers-queue.ts`, `options.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `workers-queue.test.ts`                                                                                                                                                                                                                                                                                                                              |
| V13-111 half           | (M143a)           | §3.15         | `cloudflare-plugin/src/cache-api/cacheability.ts`, `cache-api-middleware.ts`                                                                                                                                                                                                                                                                                                                                                                                                               | `cacheability.test.ts`, `cache-api-middleware.test.ts`, `test/unit/cache-api/credential-rule-parity.test.ts` (new)                                                                                                                                                                                                                                   |
| V13-135 half           | (M143a)           | §3.16         | README only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | docs gate                                                                                                                                                                                                                                                                                                                                            |
| V13-41 half            | (M143i)           | §3.17         | `runtime/src/adapters/workers/cf-ws-upgrader.ts`, `cf-http-adapter.ts`                                                                                                                                                                                                                                                                                                                                                                                                                     | `runtime/test/unit/cf-ws-upgrader.test.ts`, `cf-http-adapter.test.ts`                                                                                                                                                                                                                                                                                |
| V13-200 half           | (M143i)           | §3.18         | `common/src/runtime.ts`; `kernel/src/context/deferred.ts`, `src/context/request-context.ts`, `src/application/application.ts`; `runtime/src/adapters/workers/cf-runtime.ts`, `src/adapters/shared/runtime-services-factory.ts`, `src/plugin/runtime-plugin.ts`, `src/services/cross-runtime.ts` (D3, out of lane)                                                                                                                                                                          | `runtime/test/unit/cf-runtime.test.ts`; the workerd probe in §7                                                                                                                                                                                                                                                                                      |
| V13-218 half           | (M143h)           | §3.19         | `cloudflare-plugin/src/database/d1-data-source.ts` (after M143h's error classes land)                                                                                                                                                                                                                                                                                                                                                                                                      | `cloudflare-plugin/test/unit/database/d1-data-source.test.ts`                                                                                                                                                                                                                                                                                        |
| Cache body cancel      | (M143i hand-over) | §3.20         | `cache-api-middleware.ts` only if the probe shows a `cancel()` that does not settle                                                                                                                                                                                                                                                                                                                                                                                                        | workerd probe; `test/response-stream-cancel-inventory.test.ts`                                                                                                                                                                                                                                                                                       |
| Runtime comment        | (#613 hand-over)  | §3.21         | `runtime/src/adapters/workers/cf-runtime.ts` (comment)                                                                                                                                                                                                                                                                                                                                                                                                                                     | `runtime/test/unit/cf-runtime.test.ts`                                                                                                                                                                                                                                                                                                               |
| Workers fan-out note   | (M143p hand-over) | §3.22         | README only                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | docs gate                                                                                                                                                                                                                                                                                                                                            |
| `static-plugin` `Vary` | (D10)             | §3.23         | `static-plugin/src/handler/static-handler.ts`                                                                                                                                                                                                                                                                                                                                                                                                                                              | `static-plugin/test/unit/static-handler.test.ts`                                                                                                                                                                                                                                                                                                     |
| V13-217 half           | (M143r, D11)      | §3.24         | `cloudflare-plugin/src/storage/r2-storage.ts`, `src/errors.ts`, `src/index.ts`                                                                                                                                                                                                                                                                                                                                                                                                             | `cloudflare-plugin/test/unit/storage/r2-storage.test.ts`                                                                                                                                                                                                                                                                                             |

### 0.2 Reproduction reads (what the code does today, and why the symptom follows)

All twelve rows reproduce by reading the source on `develop` `d2ec1aef1`; none was re-run here (no
suite and no `wrangler dev` in this planning pass). Re-checked on `develop` `712369753` (after M143a
#609, M143i #611 and the Core follow-up #613): no file under `packages/cloudflare-plugin/src`,
`packages/websocket-plugin/src` or `packages/runtime/src/adapters/workers` changed, so every line
cited below for those packages stands. The runner evidence is under
`~/Projects/hono-enterprise-published-smoke/v0.13.0/part28/x116…x118/out/`.

- **V13-195, root cause.** workerd binds every I/O object to the request (`IoContext`) that created
  it; Cloudflare's error reference names the error and says I/O objects "created in the context of
  one request handler cannot be accessed from a different request's handler"
  (developers.cloudflare.com/workers/observability/errors/). Each client socket is accepted inside
  its own upgrade request (`runtime/src/adapters/workers/cf-ws-upgrader.ts:173`,
  `cf-http-adapter.ts:113-121`). The plugin keeps every accepted connection in one isolate-level
  `Room` set (`websocket-plugin/src/rooms/room-registry.ts:73`) and touches all members from
  whichever request is running: `Room.size` and `broadcastLocal` read `member.isOpen`
  (`room-registry.ts:96-104`, `:158`), which reads the native `readyState`
  (`websocket-connection.ts:82-83` through
  `runtime/src/adapters/shared/web-socket-transport.ts:132`), and `broadcastLocal` calls
  `member.send` (`:165`). From a route, the first read throws (the 500). From member A's `onMessage`
  (A's request), `send` to member B throws, the `catch` at `:166-172` drops B from the room
  silently, so B never hears A and nothing is logged. In a 200-member room every member's first
  foreign broadcast evicts the others it touches. The premise in `durable-object-backplane.ts:72-82`
  and the 0.2.0 CHANGELOG (`CHANGELOG.md:10558`) that "members are client sockets in the same
  isolate" is wrong: the unit of ownership is the request.
- **V13-196, root cause.** Four defects. (1) The backplane's isolate-wide socket is opened by
  `connect()` from the request of whichever connection first joins a room
  (`websocket-service.ts:693-703`, called through `room-registry.ts:267`), so it belongs to that
  request: its message listener (`durable-object-backplane.ts:173-175`) runs in a request whose
  member has gone, and delivering to the new member's socket throws (the `subscriber failed` warn).
  (2) `#backplaneOpening` is set once and cleared only when `connect()` rejects
  (`websocket-service.ts:697-699`), so a later join never reopens. (3) A publish from the new
  member's request throws on `socket.send`; `publish()` retires the socket and logs without
  resending (`durable-object-backplane.ts:202-213`), so the first message is lost. (4) `#retire`
  drops the reference without closing the socket (`:255-259`), so the hub keeps one more socket per
  turnover (4 to 29 measured) and fans every frame out to it.
- **V13-197, root cause.** `WorkersQueue.process` keeps only `concurrency`
  (`workers-queue.ts:184-189`), so `onFailed` is never stored or called. `#runOne` acks a message
  whose `attempts > maxAttempts` (`:274-283`), which deletes it, because Cloudflare's `ack()` is
  final and a dead-letter queue receives only messages the platform itself exhausts after
  `max_retries` (developers.cloudflare.com/queues/configuration/batching-retries/: "Messages are
  deleted, or written to a dead-letter queue (DLQ) if one is configured"). A `maxAttempts` above
  `max_retries + 1` is never reached because the platform stops first; the adapter cannot read
  `max_retries` from the binding.
- **V13-201.** `isKvNamespace` checks `get`, `put`, `delete`, `list` (`facades.ts:430-432`), all of
  which an R2 bucket also has, so `kv()` accepts an R2 binding and the cache arm's `get` returns
  R2's `null`. `d1()` and `service()` cast without a guard (`binding-registry.ts:204-206`,
  `:216-218`).
- **V13-202.** The stored key is the URL plus `setu-cache-tenant`/`setu-cache-locale` query text
  that only the private `defaultKey` builds (`cache-api-middleware.ts`, `defaultKey` and
  `KEY_DISCRIMINATORS`); the barrel exports no key builder and no eviction (`index.ts:144-148`), so
  `caches.default.delete(url)` misses.
- **V13-203.** The adapter's `close` listener only forwards the event (`cf-ws-upgrader.ts:179-182`)
  and never answers the peer's close frame. At the scaffold's `compatibility_date = "2025-09-01"`
  (`packages/cli/src/templates/project-files.ts:2558`) the runtime leaves the reply to the Worker;
  Cloudflare documents automatic replies behind `web_socket_auto_reply_to_close` from compatibility
  date 2026-04-07 (developers.cloudflare.com/durable-objects/best-practices/websockets/).
- **V13-204.** `#call` sends `JSON.stringify({ token, ttlMs })` (`durable-object-lock.ts:106-109`,
  `:139-141`): `Infinity` and `NaN` become `null`; the object stores `expiresAt: now + ttlMs`
  (`distributed-lock-object.ts:116`), so `now + null` is `now` and `0` or a negative value expire at
  once. The object validates nothing, while its sibling `IdempotencyObjectCore` refuses anything but
  a positive integer (`idempotency-object.ts:93-95`).
- **V13-205.** README line 196 sets `max_batch_size = 1`; the broker runs up to
  `DISPATCH_CONCURRENCY = 10` handlers of a batch at once (`workers-broker.ts:61`), so a batch of
  one serializes every RPC.
- **V13-206.** README lines 428-441 present the lock for a "Node/Deno replica set" holding
  `env.LOCKS`, which exists only inside a Worker; on Workers `SchedulerPlugin` refuses to register.
- **V13-209.** `service(name)` exists on `ICloudflareBindings` (`binding-registry.ts:216`) and in
  the README export table only; no README section, card entry or stanza names `[[services]]` or
  `script_name`.
- **V13-210.** `WorkersBroker.publish` writes the caller's headers into the envelope
  (`workers-broker.ts:258-286`, `message-envelope.ts:50-53`) but adds no `traceparent`, and
  `parsePublishOptions` refuses `traceparent` from the caller as reserved
  (`common/src/services/messaging.ts:99-147`, `:305-307`). Every other broker gets it from
  `messaging-plugin`'s `TracedBroker` (`messaging-plugin/src/tracing/traced-broker.ts:60-70`), which
  a Workers project does not install. `RequestOptions` is `{ timeoutMs }` only
  (`messaging.ts:431-437`).
- **V13-219.** `dispatch` throws
  `new AggregateError(failures, 'cloudflare-cron: one or more handlers failed')`
  (`workers-cron.ts:167`): the message carries neither the expression nor any handler's message, so
  with no logger the platform's uncaught-error line is all there is.

### 0.3 Compared with (sibling code and established frameworks)

Looked up 2026-11-22. A cell marked "not verified" was not read at a primary source in this pass.

| Decision                                        | This plan                                                                                                                                                                                                           | Repository siblings                                                                                                                                                                                                      | Established frameworks and platform docs                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Verdict                                                                                                                                              |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| Where a room's sockets live on Workers (§3.1)   | Client sockets stay in the Worker request that accepted them; each connection gets its own link to the topic's hub Durable Object, opened in its own request; a member is only ever written to from its own request | Redis and `messaging` backplane transports: in-process rooms per replica, one subscription per process (`realtime-backplane-plugin`)                                                                                     | Cloudflare: "A single Durable Object instance can coordinate between multiple clients", the Worker only proxies the upgrade (DO WebSockets best practices). PartyServer: the server class extends `DurableObject`, one instance per room name, `broadcast(message, exclude)` (partyserver README). Cloudflare Agents: an Agent is a Durable Object (not verified). Socket.IO: rooms are two in-process maps per server, a Redis adapter crosses servers (socket.io rooms docs). Hono on Workers: `upgradeWebSocket` per request, no rooms (hono.dev websocket helper) | **Camps split**; D1 decided (a) by the maintainer 2026-11-22: sockets stay in-process with a relay, as Socket.IO and this repo's other transports do |
| Order of one member's broadcasts (§3.2)         | Kept when the broadcast names its sender as `except` (what `setu g ws-route` writes) or runs inside that member's handler; otherwise unordered, like a cross-replica publish                                        | Redis transport keeps one process's publish order                                                                                                                                                                        | Cloudflare stub API: no ordering guarantee between different stubs (developers.cloudflare.com/durable-objects/api/stub/); a WebSocket keeps order                                                                                                                                                                                                                                                                                                                                                                                                                     | Matches the platform's guarantees; stated in the README                                                                                              |
| Exhausted Workers job (§3.4)                    | `onFailed` before the final disposition; a dead-letter producer, or an explicit `false` that discards with a warning; `process()` refuses when neither is configured (D8)                                           | memory/Redis/RabbitMQ call `onFailed` before `deadLetter` (`queue-plugin/src/processors/job-processor.ts:178-197`); M143p's rule for SQS: "dead-lettered or handed to `onFailed`, never deleted" (ROADMAP M143p outcome) | Cloudflare Queues: without a DLQ "messages that reach the retry limit are deleted permanently"; a DLQ is "like any other queue" and "can be produced to" (dead-letter-queues page). BullMQ: a failed job moves to the failed set, kept or removed by settings (docs.bullmq.io retrying-failing-jobs). NestJS: job kept "in the failed set" by default (per runner report X116-1, not re-read)                                                                                                                                                                         | Matches siblings and the platform                                                                                                                    |
| `maxAttempts` above `max_retries + 1` (§3.4)    | Capped at `maxRetries + 1`, one warning per job name                                                                                                                                                                | queue-plugin honours any value; M143p's SQS adapter clamps to `maxReceiveCount - 1` and warns once per name (M143p §3.3 step 5)                                                                                          | Cloudflare: the platform stops at `max_retries` (default 3)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | **Decided** (D2 (b), 2026-11-22)                                                                                                                     |
| Retry spacing (§3.14)                           | Optional `retryDelaySeconds` (number or function of the attempt); absent keeps the queue's `retry_delay`                                                                                                            | queue-plugin: exponential, 1 s base, 30 s cap (`retry-strategy.ts:12-45`)                                                                                                                                                | Cloudflare `message.retry({ delaySeconds })` with per-message delay overriding `retry_delay` (batching-retries page); BullMQ fixed, exponential and custom backoff (bullmq docs)                                                                                                                                                                                                                                                                                                                                                                                      | Matches; name aligned with M143m (D5)                                                                                                                |
| Dead store that cannot be proved (§3.4)         | Refuse at `process()` unless `deadLetterQueue` names a producer or is `false`                                                                                                                                       | M143p §3.3: SQS refuses a consumed name with no provable target; `false` opt-out                                                                                                                                         | See §12 D8 (primary sources)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | Matches M143p; D8                                                                                                                                    |
| Edge cache eviction (§3.6)                      | Export the key builder the middleware uses and a `purgeCacheApi` helper; local data center only                                                                                                                     | `cache-plugin` exposes its store for deletes                                                                                                                                                                             | Cloudflare `cache.delete` "only purges content of the cache in the data center that the Worker was invoked" (workers runtime-apis cache). Next.js `revalidatePath`, ASP.NET Core `EvictByTagAsync`, Spring `@CacheEvict`, NestJS `cacheManager.del` (per runner report X116-4, not re-read)                                                                                                                                                                                                                                                                           | Matches (path-level eviction); tags out of scope (§9)                                                                                                |
| Per-visitor responses in the edge cache (§3.15) | M143a's rule applied to a URL-keyed cache                                                                                                                                                                           | `cacheMiddleware` §3.12 of M143a (credentialed request rule, `credentialCookies`)                                                                                                                                        | Symfony HttpCache, Rack::Cache, Varnish (M143a plan §10 table, read at source there)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Matches M143a by construction                                                                                                                        |
| Lock TTL validity (§3.8)                        | Refuse anything but a whole number from 1 to 2,147,483,647 ms, at the client and in the object                                                                                                                      | `IdempotencyObjectCore` positive integer, 400 (`idempotency-object.ts:93-95`); scheduler memory lock holds forever for `Infinity`, Redis lock throws                                                                     | node-redlock: refuses a non-integer duration ("Duration must be an integer value in milliseconds."), accepts 0, negatives and `Infinity` (node-redlock `src/index.ts`)                                                                                                                                                                                                                                                                                                                                                                                                | Stricter than redlock on purpose: "hold forever" is not a lock contract any implementation here honours the same way                                 |
| Close handshake (§3.7)                          | The adapter answers the peer's close frame with its code                                                                                                                                                            | Node `ws` and Deno answer automatically                                                                                                                                                                                  | Cloudflare: with `web_socket_auto_reply_to_close` (compat date 2026-04-07 or later) calling `close()` is optional (DO WebSockets page)                                                                                                                                                                                                                                                                                                                                                                                                                                | Matches                                                                                                                                              |
| Trace across Workers messaging (§3.12)          | Framework `traceparent` in the envelope, receive span parented from it                                                                                                                                              | `TracedBroker` for every other broker (`traced-broker.ts:60-131`)                                                                                                                                                        | W3C Trace Context; OpenTelemetry messaging conventions (not verified this pass)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Matches siblings                                                                                                                                     |
| Workers WebSocket ceiling (§3.17)               | Reported once when the configured limit is 0 or above 32 MiB                                                                                                                                                        | M143i's `WebSocketCeilingReport` for Bun 16 MiB, Deno 64 MiB                                                                                                                                                             | Cloudflare: incoming messages capped at 32 MiB (33,554,432 bytes), close 1009 (2025-10-31 changelog; workers runtime-apis websockets)                                                                                                                                                                                                                                                                                                                                                                                                                                 | Matches M143i                                                                                                                                        |

### 0.4 What this letter builds on (all merged on `develop`)

- **M143i (#611).** Ships `runtime/src/adapters/shared/websocket-ceiling.ts`
  (`WebSocketCeilingReport`, one warn per server) and `HttpAdapterOptions.reportError`
  (`shared/adapter-options.ts:38-47`); the kernel's abort-time cleanup
  (`kernel/src/context/deferred.ts` `wrapDeferredStream`, which since its CodeRabbit round listens
  to the request signal for every wrapped body, `application.ts:2180-2240`). Its hand-over gives
  M143o V13-41 (the Workers ceiling) and V13-200, already measured on local workerd with
  `enable_request_signal`: a synchronous cleanup runs on abort, an asynchronous cleanup's
  continuation after a timer is cut off (§3.18, D3).
- **M143a (#609).** Adds to `common`: `PER_VISITOR_RESPONSE_STATE_KEY`
  (`services/per-visitor-response.ts`), `COOKIE_DEPENDENT_RESPONSE_STATE_KEY`
  (`services/cookie-dependent-response.ts`) and the quote-aware `cacheControlDirectives`
  (`cache-control.ts:22`). Its `cacheMiddleware` rule
  (`cache-plugin/src/middleware/cache-middleware.ts`, `isCredentialed` `:244`, `isPrivate` `:259`,
  `carriesCookie`, `withVaryCookie`, `servableWithCookies` `:293`) is the rule §3.15 applies to the
  URL-keyed Cache API.
- **Core follow-up (#613).** Adds `IRuntimeServices.createDnsResolver?`
  (`common/src/runtime.ts:463`), absent on Workers; the Workers runtime's comment listing what it
  omits is updated here (§3.21).
- **M143r (#614, open).** Touches no package of this lane. It adds `StorageObjectNotFoundError` to
  `common` and offers V13-217's R2 half to this letter (D11); nothing here depends on it unless D11
  is accepted, and then only after #614 merges.
- **M143p part B (branch `feat/m143p-queued-work-and-frames`, not merged).** Its §3.15 rule for
  every queue adapter (one `onFailed`, then a dead store, or a refusal when none can be proved) is
  the rule §3.4 applies to `WorkersQueue`; its `SubscribeOptions.fanOut` / `ISubscription.fanOut`
  contract does not touch this lane's code (§3.22).

### 0.5 Hand-overs received, and what became of each

| From                       | Item                                                                                                                                      | Disposition                                                                                                                                                                             |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| M143a X6 (+ #609 addendum) | Cache API rule: `private`/`no-store`, credentialed requests, cookie-varying entries, `Vary: *`, both state keys, `cacheControlDirectives` | Scope, §3.15                                                                                                                                                                            |
| M143a X7                   | KV eventual consistency for `KvSessionStore`/`KvCacheStore`                                                                               | Scope, §3.16                                                                                                                                                                            |
| M143a (no owner)           | `static-plugin` replaces `Vary` (`static-handler.ts:298`, `:417`, `:447`, `:480`)                                                         | Out of lane: `static-plugin` is in no lane. D10                                                                                                                                         |
| M143a (completeness)       | `cache-api-middleware.ts:332` replays `Vary` wholesale                                                                                    | Declined: the replayed `Vary` is the stored response's own, which already carried every field the response varied on when it was stored; nothing is lost on a HIT, which ends the chain |
| M143i                      | V13-41: Workers WebSocket ceiling report                                                                                                  | Scope, §3.17                                                                                                                                                                            |
| M143i                      | V13-200: async `ctx.defer` cleanup cut short on workerd                                                                                   | Measured by M143i; fix needs a Core contract member. D3                                                                                                                                 |
| M143i                      | `cache-api-middleware.ts:344`: confirm workerd's `cancel()` on the replayed body settles                                                  | Scope, §3.20 (workerd probe, inventory row)                                                                                                                                             |
| M143i                      | Streamed RPC reply wrapped with no signal, so `stop()` waits the drain bound on workerd                                                   | Declined: fixed in Core by #611's CodeRabbit round (`wrapDeferredStream` listens to the request signal for every wrapped body, `application.ts:2186-2193`); nothing left for this lane  |
| M143i                      | Response-stream-cancel inventory rows                                                                                                     | Scope for this lane's one row (§3.20); the inventory has no other `cloudflare-plugin`, `websocket-plugin` or Workers-adapter row                                                        |
| M143p part B §11           | `WorkersQueue` gets the exhausted-job rule                                                                                                | Scope, §3.4 (D2 as decided, D8 for the unprovable dead store)                                                                                                                           |
| M143p part B §11           | README: `WorkersBroker` subscriptions carry no `fanOut` marker; the Durable Object backplane is the Workers answer                        | Scope, §3.22                                                                                                                                                                            |
| #613                       | `cf-runtime.ts:54` comment should list `createDnsResolver`                                                                                | Scope, §3.21                                                                                                                                                                            |
| M143r                      | V13-217 R2 half: R2 throws `StorageObjectNotFoundError`                                                                                   | Not in M143o's rows; D11                                                                                                                                                                |

## 1. Contracts verified from SOURCE (not names)

| Reference                                                               | Source (file:line)                                                                                                  | Verified surface / fact                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IRealtimeBackplane`                                                    | `packages/common/src/services/realtime.ts:106-154`                                                                  | `origin`, `connect()`, `publish(frame)`, `subscribe(handler)`, `close()`, optional `isHealthy()`. `publish` must not redeliver to the publisher's own handlers (`:118-126`). No per-connection member.                                                                                                                               |
| `RealtimeFrame`                                                         | `packages/common/src/services/realtime.ts:41-77`                                                                    | `kind` (`'ws-room' \| 'sse-channel'`), `origin`, `name`, `data` (string), optional `binary`, optional `exceptId`.                                                                                                                                                                                                                    |
| `WebSocketRoom`                                                         | `packages/common/src/services/websocket.ts:222-262`                                                                 | `name`, `size` (sync number, "currently open members"), `add`, `remove`, `broadcast(data, { except })`, `broadcastJson`. All synchronous `void`.                                                                                                                                                                                     |
| `IWebSocketService`                                                     | `packages/common/src/services/websocket.ts:424-494`                                                                 | `route`, `room`, `peek`, optional `routeUpgrade`, `available`, `connectionCount`, `roomCount`. No limit member.                                                                                                                                                                                                                      |
| `WebSocketEventSink.maxMessageBytes`                                    | `packages/common/src/services/websocket.ts:82-114`                                                                  | Optional per-sink limit; `onOpen(transport)`, `onMessage`, `onClose`, `onError`.                                                                                                                                                                                                                                                     |
| `IWebSocketConnection`                                                  | `packages/common/src/services/websocket.ts:164-201`                                                                 | `id` (from `runtime.uuid()`), `isOpen`, `send`, `close`, `data`.                                                                                                                                                                                                                                                                     |
| `RuntimePlatform` / `platform()`                                        | `packages/common/src/types.ts:26`; `common/src/runtime.ts:338`                                                      | `'cloudflare-workers'` is a value; plugins already branch on it (`scheduler-plugin`, `cloudflare-plugin/src/plugin/cloudflare-plugin.ts` warn on `platform() === 'cloudflare-workers'`).                                                                                                                                             |
| `IRuntimeServices.reportError?`                                         | `packages/common/src/runtime.ts:332`                                                                                | Optional last-resort record sink; Workers implements it with `console.error(JSON.stringify(record))` (`runtime/src/adapters/workers/cf-runtime.ts`).                                                                                                                                                                                 |
| `HttpAdapterOptions.reportError`                                        | `packages/runtime/src/adapters/shared/adapter-options.ts:38-47`                                                     | Passed to every adapter factory, including `'cloudflare-workers'` (`runtime/src/plugin/runtime-plugin.ts:168`, built at `:257-294`). `CloudflareWorkersHttpAdapter` reads only `options.maxBodyBytes` today (`cf-http-adapter.ts:147-149`).                                                                                          |
| `WebSocketCeilingReport`                                                | `packages/runtime/src/adapters/shared/websocket-ceiling.ts:28-70`                                                   | `new WebSocketCeilingReport(ceiling, platform, reportError)`, `check(sink)` reports once when `maxMessageBytes` is 0 or above the ceiling: `{ level: 'warn', msg: 'WebSocket message limit exceeds the runtime ceiling', configured, ceiling, platform }`. Internal to `runtime`; the Workers adapter imports it within the package. |
| Workers upgrader                                                        | `packages/runtime/src/adapters/workers/cf-ws-upgrader.ts:169-188`; `cf-http-adapter.ts:113-128` (`#performUpgrade`) | `accept()`, `message`/`close`/`error` listeners, `sink.onOpen(createWebSocketTransport(socket))`; close never answered.                                                                                                                                                                                                              |
| Workers runtime services                                                | `packages/runtime/src/adapters/workers/cf-runtime.ts:49-77`                                                         | The comment at `:54` lists `fs`, `workers`, `dns`, `onSignal` as deliberately absent; `createDnsResolver` (#613) and `onFatalError` (#611) are absent too and unlisted. No `waitUntil` member exists on `IRuntimeServices` (checked: no `waitUntil` in `common/src`, `kernel/src`, `runtime/src`).                                   |
| Shared transport                                                        | `packages/runtime/src/adapters/shared/web-socket-transport.ts:123-140`                                              | `readyState` reads the native socket's numeric `readyState` on every call. Core lane; not edited.                                                                                                                                                                                                                                    |
| `WebSocketConnection.isOpen`                                            | `packages/websocket-plugin/src/connection/websocket-connection.ts:78-84`                                            | `!this.#closed && this.#transport.readyState === 'open'`.                                                                                                                                                                                                                                                                            |
| `Room` / `RoomRegistry`                                                 | `packages/websocket-plugin/src/rooms/room-registry.ts:71-193`, `:201-383`                                           | Membership `Set`; `broadcastLocal` sends to each member and drops one whose `send` throws (`:164-172`); `onMemberJoined` fires on every join (`:267`).                                                                                                                                                                               |
| `#openBackplane`                                                        | `packages/websocket-plugin/src/services/websocket-service.ts:693-704`                                               | Latch cleared only on rejection.                                                                                                                                                                                                                                                                                                     |
| Startup notice                                                          | `packages/websocket-plugin/src/plugin/websocket-plugin.ts:136-147`                                                  | Names only `RealtimeBackplanePlugin` `'redis'`/`'messaging'`; never `CloudflarePlugin({ durableObject })`.                                                                                                                                                                                                                           |
| `HeartbeatSweeper`                                                      | `packages/websocket-plugin/src/heartbeat/heartbeat.ts` (`start`, `tick`)                                            | One shared interval touching every connection; on Workers every foreign `send` throws into the swallowing `catch`.                                                                                                                                                                                                                   |
| `DurableObjectBackplane`                                                | `packages/cloudflare-plugin/src/realtime/durable-object-backplane.ts:95-302`                                        | One isolate socket; `CONNECT_URL` `/connect`; own-origin drop in `#receive` (`:297`).                                                                                                                                                                                                                                                |
| `RealtimeBackplaneObjectCore`                                           | `packages/cloudflare-plugin/src/durable-objects/realtime-backplane-object.ts:71-175`                                | Stateless; `acceptWebSocket`; `webSocketMessage` re-broadcasts verbatim to every socket but the sender; `fetch` refuses non-upgrade with 426.                                                                                                                                                                                        |
| DO WebSocket attachment and limits                                      | developers.cloudflare.com/durable-objects/best-practices/websockets/ ; /durable-objects/platform/limits/            | `serializeAttachment` max 16,384 bytes; received message max 32 MiB; soft limit 1,000 requests per second per object.                                                                                                                                                                                                                |
| Workers connection limit                                                | developers.cloudflare.com/workers/platform/limits/                                                                  | Six connections "simultaneously waiting for response headers" per invocation; outbound WebSockets count while waiting; an open socket after 101 is not waiting.                                                                                                                                                                      |
| `WorkersQueue`                                                          | `packages/cloudflare-plugin/src/queues/workers-queue.ts:122-364`                                                    | `process` keeps `concurrency` only; `#runOne` acks exhausted; `retry()` with no delay (`:244`, `:310`).                                                                                                                                                                                                                              |
| `IQueueMessage`                                                         | `packages/cloudflare-plugin/src/bindings/facades.ts:300-326`                                                        | `id`, `body`, `attempts` (1 on first delivery), `ack()`, `retry({ delaySeconds? })`.                                                                                                                                                                                                                                                 |
| `ProcessOptions.onFailed`                                               | `packages/common/src/services/queue.ts:84-106`                                                                      | Called once "immediately before it is dead-lettered", with the final `attempts` and the last error; a throwing callback is logged and swallowed.                                                                                                                                                                                     |
| `AddJobOptions.maxAttempts`                                             | `packages/common/src/services/queue.ts:60-63`                                                                       | "Maximum attempts before the job is dead-lettered."                                                                                                                                                                                                                                                                                  |
| `CloudflarePluginOptions` arms                                          | `packages/cloudflare-plugin/src/options.ts`                                                                         | `WorkersQueueArm { binding, name?, maxDelaySeconds? }`; `DurableObjectArm { binding, name?, topic? }`; `waitUntil?`.                                                                                                                                                                                                                 |
| `BindingRegistry`                                                       | `packages/cloudflare-plugin/src/bindings/binding-registry.ts:150-238`                                               | `kv`, `r2`, `queue`, `durableObject` guarded; `d1`, `service` cast; `waitUntil(promise)`.                                                                                                                                                                                                                                            |
| Shape guards                                                            | `packages/cloudflare-plugin/src/bindings/facades.ts:411-495`                                                        | `hasMethods`; `isKvNamespace` (get/put/delete/list), `isR2Bucket` (head/get/put/delete), `isD1Database` (prepare/batch, already used by `D1Adapter` at `d1-adapter.ts:171`).                                                                                                                                                         |
| `cacheApiMiddleware`                                                    | `packages/cloudflare-plugin/src/cache-api/cache-api-middleware.ts`                                                  | Options `cache`, `key`, `bypass`, `cacheableStatuses`, `ttlSeconds`; private `defaultKey`; stores via `bindings.waitUntil` unless hostless.                                                                                                                                                                                          |
| `assessCacheability`                                                    | `packages/cloudflare-plugin/src/cache-api/cacheability.ts:72-84`                                                    | Refusals `method`, `status`, `partial-content`, `vary-star`, `set-cookie`. Exported with `CacheRefusal`.                                                                                                                                                                                                                             |
| `allowsSetCookie`                                                       | `cacheability.ts:105-111`                                                                                           | Plain comma split; `private=set-cookie` (case-insensitive) lets a `Set-Cookie` response be stored (the platform strips the cookie).                                                                                                                                                                                                  |
| Replay                                                                  | `cache-api-middleware.ts:320-348`                                                                                   | `match` then `replay`: headers copied with `header()` (`Set-Cookie` appended), body passed through with `response.stream(cached.body)` (`:344`). The HIT path never reads the request's cookies or `Authorization`.                                                                                                                  |
| `PER_VISITOR_RESPONSE_STATE_KEY`, `COOKIE_DEPENDENT_RESPONSE_STATE_KEY` | `common/src/services/per-visitor-response.ts`, `cookie-dependent-response.ts`                                       | `ctx.state` keys set to `true` by `session-plugin`; exported from `@setu-ts/common`.                                                                                                                                                                                                                                                 |
| `cacheControlDirectives`                                                | `common/src/cache-control.ts:22`                                                                                    | Lowercased directive names, quote-aware; `undefined` for an unclosed quote.                                                                                                                                                                                                                                                          |
| `cacheMiddleware` rule (M143a)                                          | `cache-plugin/src/middleware/cache-middleware.ts:1-27` (module JSDoc), `:86-125`, `:164-197`, `:244-321`            | The rule §3.15 restates; `cache-plugin` is Web lane and is not edited.                                                                                                                                                                                                                                                               |
| Stream-cancel inventory                                                 | `test/response-stream-cancel-inventory.test.ts:211-219`                                                             | Row for `cache-api-middleware.ts`: `cancelSettles: 'unknown'`, hand-over to M143o.                                                                                                                                                                                                                                                   |
| `DurableObjectLock`                                                     | `packages/cloudflare-plugin/src/lock/durable-object-lock.ts:60-156`                                                 | `acquire(key, ttlMs)`, `release(key, token)`; non-2xx answer becomes `CloudflareUnsupportedError`. Structurally the scheduler's `acquire(key, ttlMs): Promise<string \| null>` (`scheduler-plugin/src/interfaces/index.ts:33`).                                                                                                      |
| `DistributedLockObjectCore`                                             | `packages/cloudflare-plugin/src/durable-objects/distributed-lock-object.ts:80-137`                                  | `/acquire` stores `{ token, expiresAt: now + ttlMs }`; `/release` by token.                                                                                                                                                                                                                                                          |
| `WorkersBroker`                                                         | `packages/cloudflare-plugin/src/messaging/workers-broker.ts:61`, `:258-286`                                         | `DISPATCH_CONCURRENCY = 10`; publish envelope with caller headers.                                                                                                                                                                                                                                                                   |
| Trace helpers                                                           | `packages/common/src/trace-context.ts:11`, `:46`, `:67-70`; `common/src/services/telemetry.ts:199`                  | `TRACEPARENT_HEADER`, `parseTraceparentToContext`, `contextToTraceparent`, `ITelemetryService.withSpan(name, fn, options)` with `parentContext`.                                                                                                                                                                                     |
| `WorkersCron.dispatch`                                                  | `packages/cloudflare-plugin/src/cron/workers-cron.ts:140-168`                                                       | `AggregateError` with a fixed message.                                                                                                                                                                                                                                                                                               |
| `describeError`                                                         | `packages/common/src/errors/describe-error.ts:51`                                                                   | One-line, bounded, CR/LF-safe rendering.                                                                                                                                                                                                                                                                                             |
| `d1WriteRefusal`                                                        | `packages/cloudflare-plugin/src/database/d1-data-source.ts:241-263`                                                 | Maps unknown column and STRICT type only.                                                                                                                                                                                                                                                                                            |
| `createCapabilityToken`                                                 | `packages/common/src/tokens.ts:418-445`                                                                             | `TOKEN_PATTERN` kebab-case with dot segments. This plan adds **no** token (checked; the link seam rides the existing `REALTIME_BACKPLANE`, `tokens.ts:197`).                                                                                                                                                                         |
| Lane test harness for workerd                                           | `packages/cli/test/e2e/workers-bundle-e2e.test.ts:134-229`                                                          | The repo's only workerd-backed tests: CLI-lane, scaffold from the overlay, `npx wrangler dev`. `wrangler` is not a devDependency anywhere in the workspace (checked `pnpm-lock.yaml`: only an optional peer of `@react-router/dev`). The template pins `wrangler: '~4.148.0'` (`project-files.ts:1862`).                             |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                             | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                                | Doc deliverable (same PR)                                                                                                                                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1  | `cloudflare-plugin/README.md:397-410`, `durable-object-backplane.ts:72-82` JSDoc and the 0.2.0 CHANGELOG say room members are "client sockets in the same isolate"; workerd ties them to the request | The platform wins. The README and JSDoc describe per-connection links (§3.1); the old CHANGELOG entry is history and is not edited                                                                                                                                                                                                                                                                                                      | README "Realtime backplane" rewritten; JSDoc rewritten; CHANGELOG `0.14.0` entry names the correction                                                                                                        |
| C2  | `websocket-plugin/README.md:21-28` lists Workers with no caveat; rooms do not work there without the Durable Object arm                                                                              | Code changes (§3.1, §3.2) and the README states the requirement                                                                                                                                                                                                                                                                                                                                                                         | README "Runtime support" row and a "Rooms on Workers" section                                                                                                                                                |
| C3  | `common/src/services/queue.ts:62`, `:88-104` and the queue-plugin README ("dead-lettered by every adapter", `README.md:292`) against `WorkersQueue` acking                                           | Code changes to honour the contract (§3.4): `onFailed` once, on the final attempt, with the processor's error; the job reaches a producer unless the application chose `false`. `false` discards, as M143p's SQS `false` does; the `common` JSDoc and the queue-plugin README sentence that say "dead-lettered by every adapter" are the Core and Messaging lanes' to word, and M143p's §3.3a already raises the same `false` exception | cloudflare-plugin README queue section gains `maxRetries`, `deadLetterQueue`, the reserve delivery and `onFailed`; hand-over (§11) to M143p/Core for the "every adapter" sentence, shared with SQS's `false` |
| C4  | `facades.ts:419-432` comment says the KV guard catches an R2 bucket                                                                                                                                  | Code changes (§3.5)                                                                                                                                                                                                                                                                                                                                                                                                                     | none beyond the code                                                                                                                                                                                         |
| C5  | README line 196 (`max_batch_size = 1`) against the scaffold comment that omits it                                                                                                                    | README moves to `max_batch_size = 10` with the reason; the template half is M143j                                                                                                                                                                                                                                                                                                                                                       | README queue stanza                                                                                                                                                                                          |
| C6  | README lines 428-441 and the `DurableObjectLock` JSDoc `@example` present a use that cannot be built                                                                                                 | README and JSDoc show the lock from a Worker route and inside a Durable Object; the "Node/Deno replica set" sentence is removed                                                                                                                                                                                                                                                                                                         | README "Distributed lock"; JSDoc                                                                                                                                                                             |
| C7  | `messaging-plugin/README.md:1459-1461` says `WorkersBroker` drops `traceparent`                                                                                                                      | After §3.12 the sentence is false; that README is Messaging lane                                                                                                                                                                                                                                                                                                                                                                        | Hand-over to M143p (§11)                                                                                                                                                                                     |
| C8  | `docs/runtime-deployment.md:560` "Raw sockets (WebSocket) ✅" for Workers and `:604-608` accessor list without `service`/`durableObject`                                                             | Docs lane                                                                                                                                                                                                                                                                                                                                                                                                                               | Hand-over to M143n (§11)                                                                                                                                                                                     |

## 3. Design decisions

### 3.1 Rooms on Workers: request-bound connections with one link each (V13-195, V13-196)

- **Decision (D1 (a), decided by the maintainer 2026-11-22):** client sockets stay in the Worker
  request that accepted them. On `ctx.runtime.platform() === 'cloudflare-workers'` the
  `WebSocketService` runs in **request-bound mode**: no code ever writes to, reads the native state
  of, or closes a connection from a request other than its own. Delivery between members goes
  through the topic's hub Durable Object over a **link**: one outbound WebSocket per connection,
  opened in that connection's own request.
  1. **The seam (additive `common` file).** `packages/common/src/services/realtime-links.ts` adds
     `IRealtimeConnectionLink` (`publish(frame): boolean`, `close(): void`),
     `IRealtimeLinkBackplane extends IRealtimeBackplane` (adds
     `openConnectionLink(connectionId, deliver): IRealtimeConnectionLink` and
     `publishViaHub(frame): Promise<void>`, an HTTP publish that needs no socket and so works from
     any request), and the guard
     `hasConnectionLinks(backplane): backplane is IRealtimeLinkBackplane`. No existing interface
     changes; the service is still registered under `CAPABILITIES.REALTIME_BACKPLANE` typed
     `IRealtimeBackplane`, and the guard narrows it.
  2. **Opening.** In request-bound mode with a link backplane, the sink's `onOpen` (which runs in
     the connection's own request) opens the link before the route's `onOpen` handler runs. Opening
     is asynchronous; `publish` calls made before the 101 from the hub arrive are queued in the link
     (bounded at 64 frames; beyond that the oldest is dropped and counted in one `warn` per link).
  3. **Membership stays local and in memory.** In request-bound mode `room.add`/`remove` touch only
     the isolate registry and do no I/O, so they work from any request: the registry is built
     without the `onMemberJoined` hook, so a join never calls `#openBackplane()` and the isolate
     socket (`connect()`, `websocket-service.ts:326-328`, `room-registry.ts:265-267`) is never
     opened. That removes V13-196 defect (1) on Workers rather than repairing it. The hub does no
     room filtering: it sends every frame of the topic to every link, and the link's `deliver`
     callback (running in the owning connection's request) delivers to its own connection only when
     that connection is a member of `frame.name`, is open, and is not `frame.exceptId`.
  4. **Broadcast.** `Room.broadcast` in request-bound mode never iterates other members. It
     publishes once: over the link §3.2 chooses when `link.publish` returns `true`, otherwise
     through `publishViaHub(frame)` (`POST /publish` to the hub stub, handed to `waitUntil` so a
     route that answers first does not cut it off). The hub sends a link's own frame to every socket
     but the sender (`realtime-backplane-object.ts:121`), so when the frame went over the **current
     dispatching connection's** link (§3.2 rule 1) and that connection is a member and not excluded,
     it is delivered to it locally. A POST reaches every link, the sender's included, so no local
     delivery happens on that path; the sender's own link delivers it.
  5. **`size`.** The Workers transport tracks its own state from events (§3.7), so `isOpen` and
     `room.size` never read the native socket. `size` stays the count of this isolate's open
     members, as documented today ("two things stay local by design").
  6. **Without a link backplane on Workers.** `ws.room()` and `ws.peek()` throw
     `WebSocketRoomsUnavailableError` naming `CloudflarePlugin({ durableObject })`; `ws.route()`
     still works for single-socket routes. The startup notice on Workers names the Durable Object
     arm instead of `RealtimeBackplanePlugin` (`websocket-plugin.ts:142`).
  7. **No isolate socket and no isolate subscription for rooms.** In request-bound mode the service
     neither connects the backplane nor subscribes to its isolate-level `subscribe()` for `ws-room`
     frames; `deliverRemoteFrame` is not used.
  8. **Heartbeat.** In request-bound mode the shared sweeper is not started; each connection's sink
     `onOpen` starts its own interval through `runtime.setInterval` (created in its own request, so
     its ticks run there) and clears it on close. Same payload, same idle rule.
  9. **Hub side.** `RealtimeBackplaneObjectCore` accepts links on `/link` (WebSocket, hibernation
     API, as `/connect` today) and adds `POST /publish`, which fans the body out verbatim to every
     accepted socket, bounded at 33,554,432 bytes (the platform's received-message ceiling; larger
     answers 413). `/connect` keeps serving the isolate-level path that `sse-plugin` uses.
  10. **Link loss.** A link whose socket closes or errors reopens from its own `close` listener (its
      own request), up to 3 times with 0.5 s, 1 s and 2 s delays through `runtime.setTimeout`, then
      logs one `warn` (`cloudflare: backplane link lost`, `{ topic, connection }`, no frame content)
      and stays closed. A link is closed when its connection closes, so the hub's socket count
      follows live connections.
- **Why:** it is the smallest change that satisfies the outcome with the programming model the
  framework already has: application handlers stay in the Worker's `ws.route()`; every write happens
  in the owning request, the only thing workerd allows. Terminating sockets in a Durable Object (the
  platform's guidance and PartyServer's model) would move application handler code into the Durable
  Object class, a new programming model; it is listed as the alternative in D1. Hub-side per-room
  filtering is not planned because joins would then need I/O from the joining request, which a join
  from a route cannot do; the cost (every frame to every link of a topic) is documented with the
  advice to use one topic per application area.
- **Test home:** `websocket-plugin/test/unit/request-bound-rooms.test.ts` (no foreign-context write
  under a fake that throws on cross-context I/O; `size` with no native read; refusal without a link
  backplane; per-connection heartbeat);
  `websocket-plugin/test/integration/request-bound-backplane.test.ts` (two fake isolates, 200
  members, sender included unless excepted, members leaving);
  `cloudflare-plugin/test/unit/realtime/connection-link.test.ts`;
  `cloudflare-plugin/test/unit/durable-objects/realtime-backplane-object.test.ts` (`/link`,
  `/publish`, 413); `cloudflare-plugin/test/e2e/workerd-realtime-rooms.test.ts` (§7).

### 3.2 Which link carries a broadcast (V13-195, ordering)

- **Decision:** a broadcast's publishing link is chosen in this order: (1) the connection whose sink
  event (`onOpen`, `onMessage`, `onClose`) the service is dispatching synchronously right now, set
  around the synchronous part of the handler call and cleared when it returns; (2) `options.except`,
  when it is a request-bound connection of this service with an open link (this covers a handler
  that broadcasts after an `await`, still inside its own request); (3) none, so the frame goes
  through `publishViaHub`. A `link.publish` that throws (rule 2 called from another request, such as
  a route) returns `false` and the frame falls to (3); this is counted and logged once per service
  at `debug`. Local self-delivery (§3.1 step 4) happens only under rule (1), and only after the link
  accepted the frame (`link.publish` returned `true`); otherwise the frame goes to the hub POST with
  no local delivery, and the POST reaches the sender's own link, so the sender receives it exactly
  once in both cases (as built; this replaces an earlier `exceptId` stamp).
- **Why:** frames on one WebSocket arrive in order; the stub API documents no order between stubs,
  so POSTs from different calls may reorder. Rule (1) covers the usual chat handler
  (`setu g ws-route` writes `broadcast(data, { except: connection })`,
  `cli/src/schematics/ws-route.ts:72`, where the current connection and `except` are the same); rule
  (2) covers the same call after an `await`. A broadcast from a route with no sender connection has
  no order relative to members' frames, which is what any cross-replica backplane gives. The README
  states it.
- **Test home:** `request-bound-rooms.test.ts` (rule order; rule 2 from a foreign request falls back
  and logs once at debug; self-delivery only under rule 1; a rule-1 fallback POST reaches the sender
  once, through its own link); `request-bound-backplane.test.ts` (200 frames from one member arrive
  in order at another).

### 3.3 The isolate-level backplane path (V13-196 defects 2 to 4)

- **Decision:** the isolate socket path (`connect()`, `publish()`, `subscribe()`) is kept for
  `sse-plugin` and non-Workers transports, unchanged in shape (request-bound rooms use
  `publishViaHub` and links instead, §3.1), and repaired: (2) `#openBackplane` clears its latch when
  the connect settles, resolved or rejected (`finally`), so the next join calls `connect()` again
  (every transport's `connect` is idempotent by contract, `realtime.ts:113-116`); (3)
  `DurableObjectBackplane.publish` whose `send` throws retires the socket, reopens once and resends
  the same frame once; a second failure is logged as today; (4) `#retire` closes the retired socket
  quietly before dropping it.
- **Why:** each is a defect on its own (X117-2 mechanism), and `sse-plugin` still uses this path.
- **Test home:** `cloudflare-plugin/test/unit/realtime/durable-object-backplane.test.ts` (resend
  once; retired socket closed; no hub socket left after 25 turnovers against the fake);
  `websocket-plugin/test/unit/websocket-service.test.ts` (a second join after a settled connect
  calls `connect` again).

### 3.4 An exhausted Workers job (V13-197)

The rule is M143p §3.15's, applied to Workers: a job that exhausts its attempts calls `onFailed`
once, then its payload reaches a dead store; a consumer that cannot prove a dead store refuses to
start (D8 for how it is proved). D2 is decided: a `maxAttempts` the platform cannot honour is
capped, with one warning per job name, never refused.

- **Decision:**
  1. `process` stores `onFailed` beside `concurrency`.
  2. Queue-arm options (and the same fields on `WorkersQueueOptions` for standalone use):
     - `maxRetries`: whole number 1 to 100, default 3 (the platform default). It must equal the
       consumer's `max_retries` in `wrangler.toml`, which the binding does not expose. Refused at
       `register()` (or in the constructor) outside 1 to 100 with a `RangeError`; 0 is refused
       because it leaves no delivery in reserve (step 4), so a failed dead-letter send would lose
       the job.
     - `deadLetterQueue`: the binding name of a Queues **producer** for the dead-letter queue, or
       `false` to discard exhausted jobs. A name is shape-checked with `registry.queue()` at
       `register()`, so a missing or wrong-kind binding fails at boot by name. `WorkersQueueOptions`
       takes `deadLetter?: IQueueProducer | false` instead of a name.
  3. **Refusal (the only one, D8).** `process()` throws `CloudflareUnsupportedError` when the queue
     has neither a `deadLetterQueue` producer nor `deadLetterQueue: false`, naming the job, the two
     ways past it, and that a `dead_letter_queue` in `wrangler.toml` alone cannot be detected by the
     adapter. Without one, carrying on would let the platform delete an exhausted job with nothing
     keeping it whenever `wrangler.toml` has no `dead_letter_queue`, which is the silent loss the
     maintainer's rule refuses. A Worker that only produces (never calls `process`) is never
     refused.
  4. **Budget, with one delivery in reserve, capped (D2 (b)).** The platform delivers a message at
     most `max_retries + 1` times. The adapter's budget is `maxRetries` when the envelope carries no
     `maxAttempts`, else `min(maxAttempts, maxRetries)`, so the platform's last delivery
     (`maxRetries + 1`) is always kept for a dead-letter forward that failed (step 5). The first
     time a job name's `maxAttempts` is capped in this isolate, the consumer warns once for that
     name (`cloudflare-queue: maxAttempts above what the queue retries; capped`, fields `job`,
     `maxAttempts`, `maxRetries`, `budget`, and the advice to raise `max_retries` in `wrangler.toml`
     and `maxRetries` together). The cap is applied at the consumer, because a producer may be a
     different Worker that does not know `maxRetries`. A lower `maxAttempts` is honoured. The
     default budget is therefore 3 processor runs on the default queue (it was 4 deliveries, all
     acked away at exhaustion); README and upgrade note say so.
  5. **Final failure** (`message.attempts >= budget` and the processor throws): call
     `onFailed(job, error)` guarded (a throw is logged and swallowed, as
     `queue-plugin/src/processors/job-processor.ts:350-377`), with the job as the processor received
     it and the error it threw — exactly once per job, as `common/src/services/queue.ts:88-104`
     contracts. Then settle:
     - with a producer: `send` the job envelope unchanged plus `failedAt` (`runtime.now()`),
       `attempts` and `error` (the processor error's `describeError` text, bounded, no stack), then
       `ack()`. A failed `send` logs at `error` (job, id, attempts, the send error's class; no
       payload) and calls `retry()`; the message comes back on a delivery past its budget (step 6);
     - with `false`: `ack()`, and one `warn` per discard
       (`cloudflare-queue: job discarded after N attempts; deadLetterQueue is false`, job, id,
       attempts, never the payload). `onFailed` runs first, as M143p's SQS `false` does (its §3.3a
       step 2).
  6. **Past budget on arrival** (`message.attempts > budget`): the processor is not run and
     `onFailed` is **not** called again (it ran on the final attempt, step 5; the adapter cannot
     tell otherwise, because `retry()` re-delivers the original body). The adapter forwards to the
     producer or discards (`false`) as in step 5. On this delivery the forward carries only
     `failedAt` and `attempts`, without the error text, so a payload near the Queues message size
     limit is not pushed over it by the metadata. If that forward fails on the platform's last
     delivery (`attempts >= maxRetries + 1`), the adapter logs at `error` that the job leaves the
     adapter's hands (job, id, attempts, the send error's class) and calls `retry()`: the platform
     then writes it to `wrangler.toml`'s `dead_letter_queue` or deletes it. That residual case (two
     failed producer sends in a row, the second on the last delivery, with no platform dead-letter
     queue) is the one loss the adapter cannot prevent; the README states it and recommends a
     platform `dead_letter_queue` as a second net. A message past budget whose final attempt never
     ran in this version (a budget lowered by a deploy) is forwarded without `onFailed` and logged
     at `warn` once per name; the README says so.
  7. **Unroutable messages** (no envelope, or no processor for the name) keep `retry()`; on
     `message.attempts >= maxRetries` they are forwarded to the producer (with `error` naming the
     reason; no `onFailed`, since no processor exists) or discarded with the warning when `false`,
     with the same reserve-delivery rule as step 6.
  8. The exhausted line keeps its level and gains no payload.
- **Why:** the committed contract says "attempts before the job is dead-lettered" and `onFailed` is
  "the only programmatic notice" (`common/src/services/queue.ts:60-106`); every sibling calls
  `onFailed` before dead-lettering (`job-processor.ts:178-197`); Cloudflare deletes a message the
  platform exhausts when no dead-letter queue is configured (batching-retries page), and a
  dead-letter queue is an ordinary queue a Worker can produce to (dead-letter-queues page). The
  framework comparison for D8 is in §12.
- **Test home:** `workers-queue.test.ts` (refusal at `process()` without a producer or `false`, and
  none for a producer-only queue; `maxRetries` validation; budget with and without `maxAttempts`;
  cap and its one warning per name, honoured lower budget; `onFailed` once on the final attempt and
  never earlier; producer send then ack; send failure: error log without payload, retry; `false`:
  ack and one warn per discard without payload; past-budget arrival; unroutable on its last attempt;
  a failed forward on the reserve delivery logged and retried; `maxRetries: 0` refused; `onFailed`
  never called twice for one job); `test/integration/queue-plugin.test.ts` (options through
  `CloudflarePlugin`; `deadLetterQueue` naming a KV binding refused at boot);
  `test/e2e/workerd-queue-dead-letter.test.ts` (§7).

### 3.5 Bindings of the wrong kind (V13-201)

- **Decision:** `isKvNamespace` keeps its four members (`get`, `put`, `delete`, `list`;
  `IKvNamespace` declares no more, `facades.ts:29-51`) and refuses a value that also has `head` or
  `createMultipartUpload` (R2-only members), so every existing KV double still passes. `d1()` uses
  `isD1Database`; `service()` requires `fetch` (`isServiceBinding`, new, internal export of
  `facades.ts` and re-exported beside the other guards). Each throws
  `CloudflareBindingMissingError.wrongShape(name, …)` as the other accessors do.
- **Why:** X116-3 and X118-8; the KV/R2 split is by members only one of them has.
- **Test home:** `facades.test.ts` (each guard against a KV, R2, D1, queue, DO and service fake);
  `binding-registry.test.ts` (`kv('R2')`, `d1('KV')`, `service('QUEUE')` refused by name).

### 3.6 Evicting the edge cache (V13-202)

- **Decision:** the middleware's key builder moves to `src/cache-api/cache-api-key.ts` as
  `cacheApiKey({ url, tenant?, locale? }): string | undefined`, and the middleware's default key
  calls it (one implementation). A new
  `purgeCacheApi({ url, tenant?, locales? }, options?: { cache?: ICacheApi }): Promise<number>`
  deletes the entry for each listed locale (an absent list deletes the no-locale entry only) and
  returns how many were deleted. It evicts in the current data center only, as `cache.delete` does;
  the README says so and says that an application with a custom `key` deletes with its own key.
- **Why:** an application can only evict what it can name; the key text is the contract. Tag
  eviction would need an index the Cache API does not have (§9).
- **Test home:** `cache-api-key.test.ts` (same text as the middleware stores, fragment and
  non-parsed URLs undefined); `cache-api-middleware.test.ts` (a HIT, then `purgeCacheApi`, then a
  MISS with the new body, per locale); `test/integration/cache-api-middleware.test.ts` (through a
  kernel app).

### 3.7 The Workers transport: tracked state and the close reply (V13-203, and §3.1 step 5)

- **Decision:** `cf-ws-upgrader.ts` builds its own transport instead of the shared one: `readyState`
  is a field (`'open'` after `accept()`, `'closing'` after a local `close()`, `'closed'` on the
  `close` or `error` event), never the native property. On the peer's `close` event the adapter
  calls `socket.close(code, reason)` when the server has not closed yet. Only a code a peer may send
  is echoed (1000 to 1003, 1007 to 1014, 3000 to 4999); every other code, the reserved 1004, 1005,
  1006 and 1015 and the unassigned 1016 to 2999 included, is answered with `1000`, because workerd
  throws for them and a swallowed throw would leave the 30 s hang; a throw (the runtime already
  replied, under `web_socket_auto_reply_to_close`) is swallowed. Then it forwards to `sink.onClose`.
- **Why:** X117-3 controls: answering takes 2 ms with code 1000; the newer compatibility date also
  fixes it, but a project on the scaffold's date would still hang 30 s. Reading the native state
  from a foreign request is the 500 in V13-195.
- **Test home:** `runtime/test/unit/cf-ws-upgrader.test.ts` (state transitions without native reads;
  close answered once with the mapped code; a throwing reply swallowed; local close then peer close
  not answered twice); workerd e2e (close event within 1 s, code 1000, at
  `compatibility_date = "2025-09-01"`).

### 3.8 Lock TTL (V13-204)

- **Decision:** `DurableObjectLock.acquire` throws
  `RangeError('DurableObjectLock: ttlMs must be a whole number of milliseconds from 1 to 2147483647')`
  for anything but `Number.isInteger(ttlMs) && ttlMs >= 1 && ttlMs <= 2_147_483_647`, before any
  I/O. The upper bound (about 24.8 days, the largest timer delay the runtimes accept) keeps
  `now + ttlMs` far inside the safe-integer range and refuses a TTL that means "hold forever".
  `DistributedLockObjectCore` answers `400` for the same refusal (defence in depth, as
  `idempotency-object.ts:93-95`), which the client surfaces as `CloudflareUnsupportedError`.
- **Why:** `Infinity` and `NaN` cannot cross JSON; a fractional value (0.5 gave 4 holders) is not a
  meaningful lease; one rule for client and object.
- **Test home:** `durable-object-lock.test.ts` (each refused value: `Infinity`, `NaN`, `0`, `-1`,
  `0.5`, `2147483648`; `1` and `2147483647` accepted); `distributed-lock-object.test.ts` (400 for a
  body with `null`, `0`, a string).

### 3.9 Request/reply batch size in the README (V13-205)

- **Decision:** the README stanza sets `max_batch_size = 10` and `max_batch_timeout = 0`, with one
  sentence: the broker runs up to ten handlers of a batch at once, so a batch of one makes every
  request wait for the one before it. The template half is M143j.
- **Why:** measured 50 of 50 in 1.4 s at 10 against 23 of 50 at 1 (local workerd only).
- **Test home:** the docs gate (`test/docs-gate.test.ts`) checks the fence.

### 3.10 The lock's documented use (V13-206)

- **Decision:** the README and the `@example` show the lock used from a Worker route and from inside
  a Durable Object, and say that a Node or Deno process cannot hold a Durable Object binding, so a
  replica set outside Workers uses the scheduler's Redis lock. The "Node/Deno replica set" sentence
  is removed.
- **Why:** X117-7; the only drivable use is the one documented.
- **Test home:** docs gate; the JSDoc example compiles in the fence gate.

### 3.11 Service bindings (V13-209)

- **Decision:** a README section and an agent-card entry "Calling another Worker": the
  `[[services]]` stanza, `bindings.service(name).fetch(...)`, `script_name` for a Durable Object
  class another Worker owns, the deploy order (the bound Worker must exist first), that nothing
  crosses the call by itself (use `@setu-ts/sdk` with its trace interceptor or copy the header), and
  that the generated test harness needs the other Worker listed in `createTestHarness({ workers })`.
- **Why:** X118-3: the binding works; only the documentation is missing.
- **Test home:** docs gate; agent-card byte budget check.

### 3.12 A trace across Workers messaging (V13-210)

- **Decision:** `WorkersBrokerOptions` gains `telemetry?: () => ITelemetryService | undefined` (a
  thunk, as `logger`), passed by `CloudflarePlugin` as
  `() => ctx.services.has(CAPABILITIES.TELEMETRY) ? ctx.services.get(...) : undefined`. With
  telemetry present, `publish` and `request` run inside a `producer` span and write the span's
  `traceparent` into a new optional envelope field `trace` (framework-owned, never merged with the
  caller's headers, so the reserved-name rule stays), and delivery runs the subscriber and responder
  inside a `consumer` span parented from it, the shape of `TracedBroker`. An envelope without
  `trace` is delivered as today. `RequestOptions.headers` is not added here (a committed `common`
  contract; D4).
- **Why:** seven brokers propagate through `TracedBroker`; the Workers envelope already carries
  framework fields.
- **Test home:** `workers-broker-publish.test.ts` (trace written with telemetry, absent without);
  `workers-broker-dispatch.test.ts` (consumer span parented; a malformed `trace` delivered
  untraced); `message-envelope.test.ts` (optional field); `test/integration/rpc-round-trip.test.ts`
  (request and responder share one trace id).

### 3.13 A throwing cron handler (V13-219)

- **Decision:** the `AggregateError` message becomes
  `cloudflare-cron: N handler(s) failed for '<cron>': <describeError of the first>` plus
  `; …and K more` when there are more; the full errors stay in `errors`.
- **Why:** with no logger this line is the only output; `describeError` bounds and escapes it.
- **Test home:** `workers-cron.test.ts` (message names the expression and the first error; CR/LF in
  a handler's message escaped; counts).

### 3.14 Retry spacing on the Workers queue (V13-220, Workers half)

- **Decision:** queue-arm option `retryDelaySeconds?: number | ((attempts: number) => number)`;
  `#runOne` and the unroutable path call `message.retry({ delaySeconds })` with it, bounded to 0 to
  `maxDelaySeconds`; a function that throws or returns a non-finite value falls back to no delay and
  logs once. Absent, `retry()` is called as today, so the queue's `retry_delay` applies.
- **Why:** X116-7; the platform takes a per-message delay.
- **Test home:** `workers-queue.test.ts`.

### 3.15 The Cache API stores nothing per visitor (V13-111, Workers half, M143a X6 and the #609 addendum)

- **Decision:** `cacheApiMiddleware` applies M143a's `cacheMiddleware` rule to a URL-keyed store.
  The Cache API key is the URL (plus the tenant and locale text), so `Vary` cannot separate entries
  (`cacheability.ts:55-66`): the rule has to hold on the **lookup** side as well as the store side.
  Terms, each with the same meaning as in `cache-middleware.ts`:
  - **credentialed**: the request carries `Authorization`, or a cookie that counts (any cookie by
    default; new option `credentialCookies: readonly string[]` names the ones that count, `[]`
    leaves only `Authorization`);
  - **carries a cookie**: any non-blank `Cookie` header, a nameless pair included, whether or not it
    counts;
  - **private**: `Cache-Control` read with `cacheControlDirectives` from `@setu-ts/common` holds
    `private` or `no-store`, or cannot be read (an unclosed quote is treated as private);
  - **varies on a credential**: `Vary` names `Cookie` or `Authorization`;
  - **cookie-dependent**: `ctx.state.get(COOKIE_DEPENDENT_RESPONSE_STATE_KEY) === true` after the
    handler, judged as if the response's `Vary` named `Cookie`.

  The rule:
  1. **Lookup.** A request that is credentialed or carries a cookie still calls `cache.match`, but a
     match is replayed only when the stored response does not vary on a credential and, for a
     credentialed request, says `public` and is not private. Otherwise the handler runs (a MISS) and
     the stored entry is left in place.
  2. **Store, any request.** Not stored when the response is private, carries `Vary: *` (existing
     platform refusal), or was produced with
     `ctx.state.get(PER_VISITOR_RESPONSE_STATE_KEY) === true`. The flag is read after `next()`, so a
     handler that marks the response `public` after the session plugin flagged it does not make it
     shareable.
  3. **Store, a request that is credentialed or carries a cookie.** Stored only when the response
     does not vary on a credential, is not cookie-dependent, and, for a credentialed request, says
     `public` in its own headers. "Its own" means the live response's headers, read before the
     `ttlSeconds` default is added to the stored copy. 3a. **The `ttlSeconds` default no longer says
     `public`.** `buildStoredResponse` (`cache-api-middleware.ts:359-360`) writes `max-age=N`
     instead of `public, max-age=N` into a stored copy whose origin sent no `Cache-Control`.
     Otherwise every entry stored from an anonymous request would read as `public` at step 1 and be
     replayed to a credentialed request, which `cacheMiddleware` never does (it adds nothing to the
     stored headers). Whether workerd's Cache API stores and expires a `max-age`-only entry is
     measured on workerd first (§7); if it does not, the stored copy records the origin's own
     `public` in an internal marker header (`x-setu-cache-origin-public`, stripped on replay) and
     step 1 reads that instead.
  4. **Store, a cookie-dependent response from a request with no cookie and no `Authorization`.**
     Stored with `Cookie` added to the stored copy's `Vary` (the live response is not changed), so
     step 1 never replays it to a request that carries a cookie.
  5. `assessCacheability` (response-only, exported) gains the refusal `'private'`, covering
     `private` (qualified or not), `no-store` and an unreadable `Cache-Control`, read with
     `cacheControlDirectives`; `CacheRefusal` is widened. `allowsSetCookie` is deleted:
     `'set-cookie'` is reported whenever `Set-Cookie` is present, and a response with
     `private=Set-Cookie` reports both `'set-cookie'` and `'private'`, so tests assert both. The
     request-dependent parts (steps 1, 3, 4 and the flag in step 2) live in the middleware, because
     `assessCacheability` sees no request and no `ctx.state`.
  6. **The `private=Set-Cookie` warning (D9 (b), maintainer 2026-11-23).** Any `private` refuses the
     store, as in `cacheMiddleware` (which refuses it silently, `cache-middleware.ts:258-264`,
     `:312-321`). The first time a `cacheApiMiddleware(...)` instance refuses a response whose
     `Cache-Control` names `Set-Cookie` in `private`'s field list, it warns through the registered
     logger:
     `cloudflare-cache-api: Cache-Control: private=Set-Cookie is not stored in the edge cache; any private directive refuses it, as cacheMiddleware does. Drop Set-Cookie from cacheable responses instead`,
     with the request path only (never the key), as `reportWriteFailure` does. The flag is a closure
     variable of the factory (once per instance, so once per isolate per instance on Workers); a
     refusal with no logger registered does not consume it. Detection is one local quote-aware parse
     of the `private` directive's argument (`cacheControlDirectives` returns names only):
     case-insensitive; matches the token form `private=Set-Cookie` and the quoted list
     `private="X-A, Set-Cookie"` with optional whitespace (RFC 9111 §5.2.2.7); an unclosed quote is
     private with no warning; `set-cookie` inside another directive's quoted argument does not
     match. The README says the same in one line, because Cloudflare's Cache API page recommends
     exactly that header for caching.

- **Why:** M143a's X6 hand-over; the same rule as `cacheMiddleware`, restated for a store whose key
  cannot carry `Vary`. `cache-plugin` is Web lane, so the rule is restated here, not imported; the
  parity test below is what keeps the two from drifting.
- **Test home:** `cacheability.test.ts` (`'private'` for `private`, `no-store`, `PRIVATE`, an
  unclosed quote; qualified `private=Set-Cookie` reports `'set-cookie'` and `'private'`);
  `cache-api-middleware.test.ts` (each lookup and store case above, including: HIT refused for a
  credentialed request on a non-`public` entry; HIT refused for a cookie-only request on a
  `Vary: Cookie` entry; per-visitor flag set by a middleware after a `public` header;
  cookie-dependent flag stored only cookie-less, with `Cookie` in the stored `Vary`; `ttlSeconds`
  does not make a credentialed response storable; the D9 warning: once per instance, token and
  quoted-list forms, case-insensitive, not for an unclosed quote or another directive's argument,
  not consumed with no logger, path only); `credential-rule-parity.test.ts` (new) runs a table of
  request/response/flag rows through both `cacheMiddleware` (devDependency on
  `@setu-ts/cache-plugin`, test only) and `cacheApiMiddleware`, asserting the same "served from
  cache" and "stored" outcome per row (outcomes, never refusal reasons); the table is data, each row
  naming the M143a test it mirrors. Rows that exercise what only `cacheMiddleware` has (coalescing
  on the non-cookie path, streaming refusal through the coalescer) are excluded and listed as
  excluded; one row stores with `ttlSeconds` from an anonymous request and asserts a credentialed
  request is not served it.

### 3.16 KV is outside the revocation guarantee (V13-135, Workers half, M143a X7)

- **Decision:** the README sections for `KvSessionStore` and `KvCacheStore` say that Workers KV
  changes "may take up to 60 seconds or more to be visible in other global network locations"
  (developers.cloudflare.com/kv/concepts/how-kv-works/), so a logout's revocation marker may not
  reach a request served elsewhere in that time, and name the Durable Object store as the strong
  option.
- **Test home:** docs gate.

### 3.17 The Workers WebSocket ceiling (V13-41, Workers half)

- **Decision:** `WORKERS_WS_MAX_MESSAGE_BYTES = 32 * 1024 * 1024` in `cf-ws-upgrader.ts`; the
  Workers server handle builds a
  `WebSocketCeilingReport(WORKERS_WS_MAX_MESSAGE_BYTES, 'cloudflare-workers', options.reportError)`
  and checks each accepted intent's sink before binding it. No limit is passed to the platform (it
  has no setting).
- **Test home:** `cf-ws-upgrader.test.ts`, `cf-http-adapter.test.ts` (one report for `0` and for
  above 32 MiB across two handshakes, none at or below).

### 3.18 Asynchronous `ctx.defer` cleanup on workerd (V13-200: its remaining half, Core and Workers)

- **Measured (M143i, local workerd, `enable_request_signal`):** on a client that leaves, the
  kernel's abort path runs a synchronous cleanup; an asynchronous cleanup's continuation after a
  timer is cut off, because the request's I/O context ends. The isolate stays alive only through
  `waitUntil`, which only the Worker entry (and `cloudflare-plugin`, through its injected
  `WaitUntilHost`) holds; the kernel cannot reach it.
- **Decision (D3 (a), maintainer 2026-11-23, built in this letter):** the Core half is an
  **out-of-lane edit** (`common`, `kernel`, `runtime/src/plugin` and `src/adapters/shared`), made
  here because no Core session is active; the PR body names it, and the security audit covers it.
  1. **Contract (additive member, existing interface).**
     `IRuntimeServices.waitUntil?(promise: Promise<unknown>): void` in `common/src/runtime.ts`,
     JSDoc: "Keeps the current invocation alive until `promise` settles, on a platform that may end
     an invocation once its response is done (Cloudflare Workers). Absent where a process outlives
     its requests (Node, Deno, Bun): there, work simply continues. The kernel hands it cleanup that
     runs after a response was handed back." `@since 0.14.0`. Absent rather than a no-op on the
     other runtimes, for the reason `cf-runtime.ts:54-59` gives for `onSignal`.
  2. **Workers member.** `CloudflareRuntimeOptions.waitUntil?: (promise: Promise<unknown>) => void`;
     `createCloudflareRuntimeServices` sets the member only when given.
     `CreateRuntimeServicesOptions` (`runtime-services-factory.ts:46`) and `RuntimePluginOptions`
     (`runtime-plugin.ts:58-78`, beside `env`) gain the same `waitUntil`, passed through to the
     Workers factory only (ignored, like `env`, on Deno, Node and Bun). The Worker entry passes
     `waitUntil` from `cloudflare:workers`, the value `CloudflarePlugin({ waitUntil })` already
     takes.
  3. **Kernel.** One internal helper in `kernel/src/context/deferred.ts`,
     `keepAlive(registry, promise)`: it resolves the runtime only through
     `registry.has(CAPABILITIES.RUNTIME)` then `get` (a registry without a runtime, as in kernel
     fixtures and `testing`'s mock context, simply skips it), calls `runtime.waitUntil?.(promise)`
     inside `try`/`catch`, and returns nothing. It is called **once per promise chain, at the site
     that creates the chain**, never inside `runDeferred`'s recursion: a `runDeferred` result
     already settles after every remaining cleanup (`deferred.ts:86`), and registering each step
     separately would race workerd ending the invocation between one registered step and the next. A
     missing or throwing runtime can never skip a cleanup, because `keepAlive` runs after the chain
     exists and never wraps it. The sites:
     - (a) `request-context.ts:220`, the late `defer`: `keepAlive(registry, result)` when
       `runDeferred` returns a promise;
     - (b) `wrapDeferredStream`'s `aborted()`: the `aborting` promise (cancel wait, then the
       cleanups), registered at the abort moment while the request's I/O context is live, because
       the cancel wait is unbounded and the cleanups' own `runDeferred` may run after the invocation
       ended;
     - (c) `#settleRequest`'s early-response branch, both places that create the handler drain
       (`application.ts` ~2176, `void this.#drainTracked(handle, pendingHandler).then(finish)`, and
       the streamed branch's `complete` ~2179): the composed promise is registered where it is
       created, e.g. `keepAlive(registry, this.#drainTracked(...).then(finish))`, because the
       streamed body is wrapped with `[]` cleanups and its `aborting` promise does not wait for the
       handler. The buffered path with an asynchronous cleanup (~2241) holds the response until the
       cleanup settles, so it needs no registration; a stream's normal end runs its cleanups inside
       `pull` before `close()`, while the response is still live. 3a. **D12 (b).**
       `CloudflarePlugin` resolves its `WaitUntilHost` as the explicit `waitUntil` option, else
       `ctx.runtime.waitUntil` when the runtime has one, else none (the hostless registry and its
       one startup warning on Workers). `cloudflare-plugin/src/plugin/cloudflare-plugin.ts`.
  4. **Bounds.** Cloudflare extends an invocation "for up to 30 seconds after the response is sent
     or the client disconnects" and cancels what is still pending then (workers runtime-apis context
     page). Each asynchronous cleanup is already bounded at 5,000 ms (`deferred.ts:12`); an abort
     that waits on a `cancel()` that never settles is cut at the platform's 30 s, which is the
     platform's limit, not a new one. `CLEANUP_STALL_WARN_MS` (`deferred.ts:15`) is also 30 s, so on
     Workers that warning may not fire before the platform cuts the wait; the JSDoc says so.
     Documented in the JSDoc and the Workers README section.
  5. **Which `waitUntil`.** On Workers the application is shared across requests
     (`withApplication`), so `RuntimePlugin` keeps one function per isolate. Only
     `import { waitUntil } from 'cloudflare:workers'` is correct there; it resolves the current
     request itself (Cloudflare: "works the same way as ctx.waitUntil()", changelog 2025-08-08;
     `cloudflare-plugin/src/options.ts:212-216` already relies on it). A `ctx.waitUntil.bind(ctx)`
     from one request would bind every later request to the first. The JSDoc and README say "the
     module import, never `ctx.waitUntil`", and the §7 probe proves the binding with two overlapping
     requests.
  6. **Lane bookkeeping.** ROADMAP's M143 rules send a change to an existing `common` contract to
     the Core lane first and list `kernel` and `runtime/src/plugin` under Core. This letter makes
     those edits by the maintainer's decision of 2026-11-23; §11 asks the coordinator to record the
     exception in the ROADMAP's M143o entry. The open Core-lane PR #612 touches none of these files
     (checked: its files list has no `runtime.ts`, kernel, `runtime-plugin.ts` or
     `cross-runtime.ts`). V13-200 closes with this PR (M143i shipped its other half in #611).
- **Test home:** `common`: a type test that `waitUntil` is optional;
  `runtime/test/unit/cf-runtime.test.ts` (member present with a host, absent without; the promise
  reaches the host); the `runtime` cross-runtime test (`mergeRuntimeServices` passes `waitUntil`
  through); `runtime/test/unit/create-runtime-services.test.ts` and `runtime-plugin.test.ts` (passed
  to the Workers factory only); `kernel/test/unit/deferred-abort.test.ts` (each of (a), (b), (c)
  hands its promise to a recording `waitUntil` exactly once per chain, not per step; none when
  absent; no runtime registered: cleanup still runs, no throw; a fake runtime without `waitUntil`; a
  throwing `waitUntil` still runs the cleanup; a test that fails without the change); the workerd
  probe (§7).

### 3.19 Foreign-key and NOT NULL on D1 (V13-218, Workers half)

- **Decision:** `d1WriteRefusal` maps SQLite's `FOREIGN KEY constraint failed` and
  `NOT NULL constraint failed: <table>.<column>` to the error classes M143h defines in `common` for
  the same conditions, attributed as the STRICT refusal is. This half is built only after M143h's
  classes are on `develop` (D6); until then nothing is changed.
- **Test home:** `d1-data-source.test.ts`.

### 3.20 A replayed Cache API body when the client leaves (M143i hand-over)

- **Decision:** measured first, on local workerd: a cached response replayed by `cacheApiMiddleware`
  through `response.stream(cached.body)` (`cache-api-middleware.ts:344`) to a client that
  disconnects mid-body, with a `ctx.defer` cleanup and `enable_request_signal`. The kernel waits for
  the body's `cancel()` before running the request's cleanups, with no time limit (M143i, option A).
  If workerd's `cancel()` on a Cache API body settles, the inventory row in
  `test/response-stream-cancel-inventory.test.ts:211-219` becomes `cancelSettles: 'always'` with the
  measurement as its evidence note and no code changes. If it does not settle, the middleware wraps
  the replayed body in a pass-through `ReadableStream` whose `cancel()` calls the source's
  `cancel()` and settles at once (the body is the platform's own stream, holding no request
  resource), and the row records `'always'` for the wrapper.
- **Test home:** the workerd probe (§7, recorded in the PR); `cache-api-middleware.test.ts` (if the
  wrapper is built: `cancel()` settles when the source's never does); the inventory test.

### 3.21 The Workers runtime's list of absent members (#613 hand-over)

- **Decision:** the comment at `cf-runtime.ts:54-59` lists every optional `IRuntimeServices` member
  Workers deliberately omits: `fs`, `workers`, `dns`, `createDnsResolver`, `onSignal` and
  `onFatalError`, with one clause each (no socket DNS; a Worker isolate is evicted, never signalled;
  the platform reports an uncaught error itself).
- **Test home:** none needed beyond the existing `cf-runtime.test.ts` assertions that those members
  are absent; one assertion is added for `createDnsResolver` and `onFatalError` if missing.

### 3.22 The `messaging` backplane transport on Workers (M143p hand-over)

- **Decision:** the `cloudflare-plugin` README's messaging and realtime sections say that
  `WorkersBroker` subscriptions carry no `fanOut` marker (M143p's `ISubscription.fanOut`), so
  `RealtimeBackplanePlugin({ transport: 'messaging' })` refuses to start on a Workers broker, and
  the Durable Object backplane (`CloudflarePlugin({ durableObject })`) is the Workers answer. No
  code: a Workers queue consumer is one per queue, so a fan-out subscription has no meaning there.
- **Test home:** docs gate. The sentence lands after M143p part B merges (the refusal it describes
  is M143p's); if this letter merges first, the sentence is written as M143p's behaviour with its PR
  number filled at merge time.

### 3.23 `static-plugin` appends `Vary` (conditional on D10)

- **Decision, only if D10 (a) is accepted:** `packages/static-plugin/src/handler/static-handler.ts`
  `:298`, `:417`, `:447`, `:480` call `appendHeader('Vary', 'Accept-Encoding')` instead of
  `header(...)`, so a CORS `Vary: Origin` set earlier in the chain survives on a static asset; the
  ROADMAP lanes table gains `static-plugin` under Workers (the coordinator's edit).
- **Test home:** `static-plugin/test/unit/static-handler.test.ts` (a response that already says
  `Vary: Origin` keeps it beside `Accept-Encoding`, on each of the four paths).

### 3.24 A missing R2 object answers 404 (V13-217 R2 half, conditional on D11)

- **Decision, only if D11 (a) is accepted and after #614 merges:** `R2Storage.get`/`getStream`
  (`r2-storage.ts:72`, `:87`) throw `StorageObjectNotFoundError` from `@setu-ts/common` (status hint
  404, fixed detail, key in `message` only), so R2 and every `storage-plugin` provider answer a
  missing object the same way. `CloudflareObjectNotFoundError` is removed from the barrel (a
  breaking export change in `0.14.0`, listed in §4); no compatibility alias, since there are no
  existing users to migrate.
- **Test home:** `cloudflare-plugin/test/unit/storage/r2-storage.test.ts` (the class, the 404 hint,
  the key absent from `detail`); `test/integration` through a kernel app (a 404 problem body).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** behaviour, not types, ships in minor `0.14.0`: on Workers `ws.room()`
and `ws.peek()` throw without the Durable Object arm; `WorkersQueue.process` refuses without a
`deadLetterQueue` (a producer name or `false`), and a `maxAttempts` above `maxRetries + 1` is capped
with a warning; `DurableObjectLock.acquire` refuses an invalid TTL; `cacheApiMiddleware` stops
serving and storing per-visitor responses; `CacheRefusal` gains `'private'` (an exhaustive `switch`
over it breaks); `isKvNamespace` refuses an R2-shaped value; with D11 (a), R2 throws
`StorageObjectNotFoundError` and `CloudflareObjectNotFoundError` leaves the barrel; a
`private=Set-Cookie` response is no longer stored (one warning); the `ttlSeconds` default writes
`max-age=N` without `public`. Additive: `IRuntimeServices.waitUntil?` (an optional member of an
existing interface; an implementor that builds an `IRuntimeServices` literal is unaffected). The hub
object needs no class change in the application (the core class gains endpoints).

| Exported symbol                                                                                                                | Kind                  | Consumer / real code path that READS it                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------ | --------------------- | --------------------------------------------------------------------------------------------------------------- |
| `IRealtimeConnectionLink` (common)                                                                                             | interface             | `WebSocketService` request-bound path calls `publish`/`close`; `ConnectionLink` implements it                   |
| `IRealtimeLinkBackplane` (common)                                                                                              | interface             | `DurableObjectBackplane` implements; `WebSocketService` calls `openConnectionLink` and `publishViaHub`          |
| `hasConnectionLinks` (common)                                                                                                  | function              | `WebSocketPlugin.register` and `WebSocketService` constructor choose request-bound delivery                     |
| `WebSocketRoomsUnavailableError` (websocket-plugin)                                                                            | class                 | thrown by `room()`/`peek()`; applications `instanceof` it; README                                               |
| `cacheApiKey` (cloudflare-plugin)                                                                                              | function              | `cacheApiMiddleware` default key; `purgeCacheApi`; an application with a custom key that wants the default text |
| `purgeCacheApi` (cloudflare-plugin)                                                                                            | function              | application write routes; README recipe; middleware integration test drives it through a kernel app             |
| `isServiceBinding` (cloudflare-plugin)                                                                                         | function              | `BindingRegistry.service`; exported beside the other guards for application checks                              |
| `IRuntimeServices.waitUntil?` (common, D3)                                                                                     | optional member       | kernel `keepAlive`; implemented by the Workers runtime                                                          |
| `CloudflareRuntimeOptions.waitUntil`, `CreateRuntimeServicesOptions.waitUntil`, `RuntimePluginOptions.waitUntil` (runtime, D3) | options               | the Workers factory; the Worker entry passes `cloudflare:workers`' `waitUntil`                                  |
| `CacheRefusal` (widened, `'private'`)                                                                                          | type                  | `assessCacheability` callers; the middleware                                                                    |
| `StorageObjectNotFoundError` use (D11 only)                                                                                    | class (from `common`) | `R2Storage.get`/`getStream` throw it; `CloudflareObjectNotFoundError` removed                                   |
| `WorkersQueueArm`, `WorkersQueueOptions` (widened)                                                                             | types                 | `CloudflarePlugin` builds `WorkersQueue` from them                                                              |
| `CacheApiMiddlewareOptions` (widened)                                                                                          | type                  | `cacheApiMiddleware`                                                                                            |
| `DurableObjectBackplaneOptions` (widened)                                                                                      | type                  | `CloudflarePlugin` passes `waitUntil`                                                                           |
| `WorkersBrokerOptions` (widened)                                                                                               | type                  | `CloudflarePlugin` passes `telemetry`                                                                           |

### 4.1 Options — every option names its consumer

| Option                                                                | Consumer                                              | Behavior (per implementation)                                                                                                      |
| --------------------------------------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `CloudflarePluginOptions.queue.maxRetries`                            | `WorkersQueue#runOne` budget and cap                  | Whole number 1 to 100, default 3; refused at `register()` otherwise (0 leaves no reserve delivery)                                 |
| `CloudflarePluginOptions.queue.deadLetterQueue`                       | `WorkersQueue.process` refusal; final-attempt path    | Producer binding name (shape-checked at `register()`) or `false` (discard, one warn per discard); absent: `process()` refuses (D8) |
| `CloudflarePluginOptions.queue.retryDelaySeconds`                     | `WorkersQueue` `retry({ delaySeconds })`              | Number or function of `attempts`; bounded to 0 to `maxDelaySeconds`; absent keeps `retry_delay`                                    |
| `CacheApiMiddlewareOptions.credentialCookies`                         | credentialed-request check (§3.15)                    | Default: any cookie counts; `[]`: only `Authorization`                                                                             |
| `DurableObjectBackplaneOptions.waitUntil`                             | `publishViaHub`                                       | Keeps a route's broadcast alive past the response; absent awaits the POST (hostless, as `cacheApiMiddleware` does)                 |
| `WorkersBrokerOptions.telemetry`                                      | `publish`, `request`, `dispatch` spans                | Thunk; absent or returning `undefined` means no spans and no `trace` field                                                         |
| `WorkersQueueOptions.maxRetries`, `.deadLetter`, `.retryDelaySeconds` | same as the arm (constructor form for standalone use) | `deadLetter` is the producer object or `false`, not a name                                                                         |

## 5. Implementation files

| File                                                                                                                            | Purpose                                                                                                                             |
| ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/realtime-links.ts` (new)                                                                          | Link interfaces and `hasConnectionLinks`                                                                                            |
| `packages/common/src/index.ts`                                                                                                  | Export lines for the three symbols (additive)                                                                                       |
| `packages/websocket-plugin/src/index.ts`                                                                                        | Export `WebSocketRoomsUnavailableError`                                                                                             |
| `packages/websocket-plugin/src/rooms/request-bound-rooms.ts` (new)                                                              | Request-bound broadcast, link table, publishing-link choice (§3.1, §3.2)                                                            |
| `packages/websocket-plugin/src/rooms/room-registry.ts`                                                                          | `Room` takes a delivery strategy; request-bound strategy never iterates members                                                     |
| `packages/websocket-plugin/src/services/websocket-service.ts`                                                                   | Mode selection, sink `onOpen` link and heartbeat, dispatch window, `#openBackplane` latch fix                                       |
| `packages/websocket-plugin/src/heartbeat/heartbeat.ts`                                                                          | Per-connection timer helper for request-bound mode                                                                                  |
| `packages/websocket-plugin/src/plugin/websocket-plugin.ts`                                                                      | No isolate subscription in request-bound mode; Workers notice text                                                                  |
| `packages/websocket-plugin/src/errors/websocket-errors.ts`                                                                      | `WebSocketRoomsUnavailableError`                                                                                                    |
| `packages/runtime/src/adapters/workers/cf-ws-upgrader.ts`                                                                       | Tracked-state transport, close reply, ceiling constant                                                                              |
| `packages/runtime/src/adapters/workers/cf-http-adapter.ts`                                                                      | Ceiling report per accepted intent                                                                                                  |
| `packages/runtime/src/adapters/workers/cf-runtime.ts`                                                                           | Absent-members comment (§3.21); `waitUntil` member (§3.18)                                                                          |
| `packages/common/src/runtime.ts` (out of lane, D3)                                                                              | `IRuntimeServices.waitUntil?`                                                                                                       |
| `packages/kernel/src/context/deferred.ts`, `src/context/request-context.ts`, `src/application/application.ts` (out of lane, D3) | `keepAlive` and its call sites                                                                                                      |
| `packages/runtime/src/services/cross-runtime.ts` (out of lane, D3)                                                              | `mergeRuntimeServices`' `Pick` gains `waitUntil`                                                                                    |
| `packages/runtime/src/adapters/shared/runtime-services-factory.ts`, `src/plugin/runtime-plugin.ts` (out of lane, D3)            | `waitUntil` option passed to the Workers factory                                                                                    |
| `packages/cloudflare-plugin/src/index.ts`                                                                                       | New exports                                                                                                                         |
| `packages/cloudflare-plugin/src/realtime/connection-link.ts` (new)                                                              | One link: open on `/link`, queue, deliver, reopen, close                                                                            |
| `packages/cloudflare-plugin/src/realtime/durable-object-backplane.ts`                                                           | `openConnectionLink`, POST `publish`, §3.3 fixes                                                                                    |
| `packages/cloudflare-plugin/src/durable-objects/realtime-backplane-object.ts`                                                   | `/link`, `POST /publish`, size bound                                                                                                |
| `packages/cloudflare-plugin/src/queues/workers-queue.ts`                                                                        | §3.4, §3.14                                                                                                                         |
| `packages/cloudflare-plugin/src/options.ts`                                                                                     | New queue-arm fields                                                                                                                |
| `packages/cloudflare-plugin/src/plugin/cloudflare-plugin.ts`                                                                    | Wires `maxRetries`, `deadLetterQueue`, `retryDelaySeconds`, `waitUntil`, `telemetry`                                                |
| `packages/cloudflare-plugin/src/bindings/facades.ts`                                                                            | Guards (§3.5)                                                                                                                       |
| `packages/cloudflare-plugin/src/bindings/binding-registry.ts`                                                                   | `d1`, `service` guarded                                                                                                             |
| `packages/cloudflare-plugin/src/cache-api/cache-api-key.ts` (new)                                                               | `cacheApiKey`, `purgeCacheApi`                                                                                                      |
| `packages/cloudflare-plugin/src/cache-api/cache-api-middleware.ts`                                                              | Uses `cacheApiKey`; credentialed rule                                                                                               |
| `packages/cloudflare-plugin/src/cache-api/cacheability.ts`                                                                      | `private`, `no-store` refusals                                                                                                      |
| `packages/cloudflare-plugin/src/lock/durable-object-lock.ts`                                                                    | TTL refusal; JSDoc example                                                                                                          |
| `packages/cloudflare-plugin/src/durable-objects/distributed-lock-object.ts`                                                     | 400 on invalid TTL                                                                                                                  |
| `packages/cloudflare-plugin/src/messaging/workers-broker.ts`, `message-envelope.ts`                                             | `trace` field and spans                                                                                                             |
| `packages/cloudflare-plugin/src/cron/workers-cron.ts`                                                                           | Aggregate message                                                                                                                   |
| `packages/cloudflare-plugin/src/database/d1-data-source.ts`                                                                     | Only after M143h (D6)                                                                                                               |
| `packages/cloudflare-plugin/src/storage/r2-storage.ts`, `src/errors.ts`                                                         | Only with D11 (a), after #614                                                                                                       |
| `packages/static-plugin/src/handler/static-handler.ts`                                                                          | Only with D10 (a)                                                                                                                   |
| `test/response-stream-cancel-inventory.test.ts` (root, no lane)                                                                 | The `cache-api-middleware.ts` row's `cancelSettles` and evidence (§3.20); M143i's hand-over names M143o as this row's owner         |
| `packages/cloudflare-plugin/package.json`                                                                                       | `wrangler` `~4.148.0` devDependency (D7); `@setu-ts/cache-plugin` `workspace:^` devDependency for the parity test                   |
| `packages/cloudflare-plugin/test/e2e/fixtures/workerd-two-workers/` (new)                                                       | Front Worker (framework-free), Worker A owning the classes, Worker B binding them by `script_name`; built from the workspace `dist` |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Unit and integration tests run on Node under Vitest with fakes. The fakes for request-bound sockets
reproduce the platform rule the X117 positive control measured (`pc/index.js`): a fake "request
context" sets a current-owner id, every fake socket records the owner that created it, and `send`,
`close` and `readyState` throw `Error('Cannot perform I/O on behalf of a different request')` when
the current owner differs. A test that passes against a fake without that rule would pass against
the current bug, so each request-bound test first asserts the fake throws for a foreign write.

| Test file                                                                                                                                                                                   | src covered                                                                          | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/realtime-links.test.ts` (new)                                                                                                                                             | `realtime-links.ts`                                                                  | `hasConnectionLinks` true only with a callable `openConnectionLink`                                                                                                                                                                                                                                                                                                 |
| `websocket-plugin/test/fixtures/request-bound-socket.ts` (new)                                                                                                                              | fixture                                                                              | the ownership rule above                                                                                                                                                                                                                                                                                                                                            |
| `websocket-plugin/test/unit/request-bound-rooms.test.ts` (new)                                                                                                                              | `request-bound-rooms.ts`, `room-registry.ts`, `websocket-service.ts`, `heartbeat.ts` | no foreign write in any path; `size` with no native read; link choice order (§3.2); fallback on a throwing link logs once at debug; self-delivery only under rule 1 and never with a POST; `except` honoured at the receiving link; `room()`/`peek()` throw `WebSocketRoomsUnavailableError` without a link backplane; per-connection heartbeat started and cleared |
| `websocket-plugin/test/integration/request-bound-backplane.test.ts` (new)                                                                                                                   | same, through `WebSocketPlugin` and a fake link backplane                            | two fake isolates, 100 members each: a member's broadcast reaches 199 others and itself; a route broadcast reaches 200; 25 turnovers leave the hub's link count equal to live members; 200 frames from one member arrive in order                                                                                                                                   |
| `websocket-plugin/test/unit/websocket-service.test.ts` (extended)                                                                                                                           | `websocket-service.ts`                                                               | `#openBackplane` reconnects after a settled connect; non-Workers mode unchanged                                                                                                                                                                                                                                                                                     |
| `websocket-plugin/test/unit/websocket-plugin.test.ts` (extended)                                                                                                                            | `websocket-plugin.ts`                                                                | Workers notice names the Durable Object arm; no isolate subscription in request-bound mode                                                                                                                                                                                                                                                                          |
| `websocket-plugin/test/unit/heartbeat.test.ts` (extended)                                                                                                                                   | `heartbeat.ts`                                                                       | per-connection timer                                                                                                                                                                                                                                                                                                                                                |
| `runtime/test/unit/cf-ws-upgrader.test.ts` (extended)                                                                                                                                       | `cf-ws-upgrader.ts`                                                                  | §3.7 and §3.17                                                                                                                                                                                                                                                                                                                                                      |
| `runtime/test/unit/cf-http-adapter.test.ts` (extended)                                                                                                                                      | `cf-http-adapter.ts`                                                                 | ceiling report once per server                                                                                                                                                                                                                                                                                                                                      |
| `cloudflare-plugin/test/unit/realtime/connection-link.test.ts` (new)                                                                                                                        | `connection-link.ts`                                                                 | opens on `/link`; queue bound 64 with one warn; delivers only member frames; reopen 3 times then one warn; close closes the socket                                                                                                                                                                                                                                  |
| `cloudflare-plugin/test/unit/realtime/durable-object-backplane.test.ts` (extended)                                                                                                          | `durable-object-backplane.ts`                                                        | §3.3; `publishViaHub` POSTs, handed to `waitUntil`, awaited when hostless; `publish()` stays the socket path                                                                                                                                                                                                                                                        |
| `cloudflare-plugin/test/unit/durable-objects/realtime-backplane-object.test.ts` (extended)                                                                                                  | `realtime-backplane-object.ts`                                                       | `/link` accepted with the hibernation API; `POST /publish` fans out verbatim; 413 above 33,554,432 bytes; `/connect` unchanged                                                                                                                                                                                                                                      |
| `cloudflare-plugin/test/unit/queues/workers-queue.test.ts` (extended)                                                                                                                       | `workers-queue.ts`                                                                   | §3.4, §3.14                                                                                                                                                                                                                                                                                                                                                         |
| `cloudflare-plugin/test/integration/queue-plugin.test.ts` (extended)                                                                                                                        | `cloudflare-plugin.ts`, `options.ts`                                                 | options reach the queue; `deadLetterQueue` naming a KV binding refused at boot                                                                                                                                                                                                                                                                                      |
| `cloudflare-plugin/test/unit/plugin/cloudflare-plugin.test.ts` (extended)                                                                                                                   | `cloudflare-plugin.ts`                                                               | `waitUntil` and `telemetry` thunks passed                                                                                                                                                                                                                                                                                                                           |
| `cloudflare-plugin/test/unit/bindings/facades.test.ts`, `binding-registry.test.ts` (extended)                                                                                               | `facades.ts`, `binding-registry.ts`                                                  | §3.5                                                                                                                                                                                                                                                                                                                                                                |
| `cloudflare-plugin/test/unit/cache-api/cache-api-key.test.ts` (new)                                                                                                                         | `cache-api-key.ts`                                                                   | §3.6                                                                                                                                                                                                                                                                                                                                                                |
| `cloudflare-plugin/test/unit/cache-api/cache-api-middleware.test.ts`, `cacheability.test.ts` (extended)                                                                                     | `cache-api-middleware.ts`, `cacheability.ts`                                         | §3.6, §3.15                                                                                                                                                                                                                                                                                                                                                         |
| `cloudflare-plugin/test/unit/cache-api/credential-rule-parity.test.ts` (new)                                                                                                                | `cache-api-middleware.ts`                                                            | one table through `cacheMiddleware` and `cacheApiMiddleware`, same outcome per row (`@setu-ts/cache-plugin` added as a test-only devDependency)                                                                                                                                                                                                                     |
| `runtime/test/unit/cf-runtime.test.ts` (extended)                                                                                                                                           | `cf-runtime.ts`                                                                      | `onFatalError` absent; `waitUntil` present with a host, absent without                                                                                                                                                                                                                                                                                              |
| `runtime/test/unit/create-runtime-services.test.ts`, `runtime-plugin.test.ts` (extended)                                                                                                    | factory, plugin                                                                      | `waitUntil` reaches the Workers factory only                                                                                                                                                                                                                                                                                                                        |
| `kernel/test/unit/deferred-abort.test.ts` (extended)                                                                                                                                        | `deferred.ts`, `application.ts`                                                      | §3.18 step 3 (a), (b), (c); throwing host; absent host                                                                                                                                                                                                                                                                                                              |
| `common/test/unit/` runtime type test (extended or new)                                                                                                                                     | `runtime.ts`                                                                         | `waitUntil` optional                                                                                                                                                                                                                                                                                                                                                |
| `cloudflare-plugin/test/unit/storage/r2-storage.test.ts`, `test/unit/errors.test.ts` (new) (D11 only)                                                                                       | `r2-storage.ts`, `errors.ts`                                                         | §3.24; `CloudflareObjectNotFoundError` removed                                                                                                                                                                                                                                                                                                                      |
| `static-plugin/test/unit/static-handler.test.ts` (extended, D10 only)                                                                                                                       | `static-handler.ts`                                                                  | §3.23                                                                                                                                                                                                                                                                                                                                                               |
| `test/response-stream-cancel-inventory.test.ts` (root, row edited)                                                                                                                          | inventory                                                                            | §3.20                                                                                                                                                                                                                                                                                                                                                               |
| `cloudflare-plugin/test/integration/cache-api-middleware.test.ts` (extended)                                                                                                                | middleware through a kernel app                                                      | purge after a write                                                                                                                                                                                                                                                                                                                                                 |
| `cloudflare-plugin/test/unit/lock/durable-object-lock.test.ts`, `durable-objects/distributed-lock-object.test.ts` (extended)                                                                | lock files                                                                           | §3.8                                                                                                                                                                                                                                                                                                                                                                |
| `cloudflare-plugin/test/unit/messaging/workers-broker-publish.test.ts`, `workers-broker-dispatch.test.ts`, `message-envelope.test.ts`, `test/integration/rpc-round-trip.test.ts` (extended) | broker files                                                                         | §3.12                                                                                                                                                                                                                                                                                                                                                               |
| `cloudflare-plugin/test/unit/cron/workers-cron.test.ts` (extended)                                                                                                                          | `workers-cron.ts`                                                                    | §3.13                                                                                                                                                                                                                                                                                                                                                               |
| `cloudflare-plugin/test/unit/barrel-exports.test.ts`, `websocket-plugin/test/unit/barrel-exports.test.ts`, `common/test/unit/barrel-exports.test.ts` (extended)                             | `index.ts` (three packages)                                                          | new exports present; D11: `CloudflareObjectNotFoundError` absent                                                                                                                                                                                                                                                                                                    |
| `websocket-plugin/test/unit/websocket-errors.test.ts` (extended or new)                                                                                                                     | `errors/websocket-errors.ts`                                                         | `WebSocketRoomsUnavailableError` name, message naming `CloudflarePlugin({ durableObject })`                                                                                                                                                                                                                                                                         |
| `cloudflare-plugin/test/unit/database/d1-data-source.test.ts` (extended, after D6)                                                                                                          | `d1-data-source.ts`                                                                  | §3.19                                                                                                                                                                                                                                                                                                                                                               |
| `cloudflare-plugin/test/e2e/workerd-realtime-rooms.test.ts` (new, guarded)                                                                                                                  | real path on workerd                                                                 | see §7                                                                                                                                                                                                                                                                                                                                                              |
| `cloudflare-plugin/test/e2e/workerd-queue-dead-letter.test.ts` (new, guarded)                                                                                                               | real path on workerd                                                                 | see §7                                                                                                                                                                                                                                                                                                                                                              |

The two workerd e2e files are the guarded REAL path: they skip off CI when the `wrangler` binary is
absent and fail on CI, as `workers-bundle-e2e.test.ts` does. They are not part of the Node coverage
measurement; every branch they reach is also covered by the fakes above.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m143o-workers-realtime-queues-bindings
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage cloudflare-plugin websocket-plugin runtime common --no-tooling   # edit loop
~/.local/bin/setu-suite-queue pnpm run ci:local     # once, on the final commit
~/.local/bin/setu-suite-queue pnpm run test:deno-lane
~/.local/bin/setu-suite-queue pnpm run release:publish --dry-run
~/.local/bin/setu-suite-queue pnpm run release:verify 0.13.0   # versions stay 0.13.0 until the release
```

**Proofs on local workerd (no Cloudflare account; recorded in the PR):**

- `workerd-realtime-rooms.test.ts`, one `wrangler dev -c front -c a -c b` session at the scaffold's
  `compatibility_date = "2025-09-01"`: two members on one Worker hear each other; 200 members (100
  per Worker) each receive a member's broadcast and a route broadcast; `room.size` answers 100 on
  each Worker (its local count, as documented); after 25 member turnovers on one Worker the hub's
  `getWebSockets().length` (read through a fixture-only route on A's object) equals live members
  (request-bound mode opens no isolate socket), and delivery continues; a killed client (no close
  frame) is dropped and its link closed; a clean close's `close` event arrives within 1 s with code
  1000; control: with the arm removed, `ws.room()` answers the named error.
- `workerd-queue-dead-letter.test.ts`: `max_retries = 3`, a `dead_letter_queue` in `wrangler.toml`,
  and a second queue bound as the arm's `deadLetterQueue` producer. An always-throwing job with
  `maxAttempts: 2` reaches the producer's consumer with its payload, `failedAt`, `attempts: 2` and
  the error text, and `onFailed` fires once; with `maxAttempts: 9` it is capped (one warning for the
  name) and reaches it after 3 deliveries; a producer that refuses the first forward (a fixture
  switch) gets it on the fourth, reserve delivery, with `onFailed` still once; with
  `deadLetterQueue: false` it is acked after 3 deliveries with one discard warning and no
  dead-letter queue receives it; with neither option `process()` throws at startup; control: a
  throw-once job reaches no dead-letter queue.
- The §3.20 probe: a replayed Cache API body cancelled by a client that leaves, with a `ctx.defer`
  cleanup, `enable_request_signal`: whether `cancel()` settles and the cleanup runs.
- The V13-205 batch measurement re-run with the README stanza.
- The §3.18 probe (unconditional; this PR's real-path proof of V13-200): an asynchronous `ctx.defer`
  cleanup after a timer completes when a client leaves mid-stream, with
  `RuntimePlugin({ waitUntil })` from `cloudflare:workers` and `enable_request_signal`; two
  overlapping requests that both leave each complete their own cleanup; control: the same Worker
  without `waitUntil` shows the cut-off.

**Not verifiable here:** anything on deployed Cloudflare: two isolates of one Worker, real
hibernation eviction of the hub, production queue consumer concurrency, `cache.delete` across data
centers, KV propagation delay, and the deploy order for mutual service bindings.

## 8. Risks & mitigations

- One hub socket per connection raises Durable Object traffic (every frame to every link of a topic)
  → documented, with one topic per application area; the soft limit of 1,000 requests per second per
  object applies to POST publishes, and the README says so.
- A link opened in a request that ends early (a connection that closes during the link's 101) → the
  link is closed by the connection's close handler; a late 101 closes the socket it receives.
- Workers outbound connection limit (six waiting for headers per invocation) → a connection opens
  one link; only the handshake counts.
- The fake ownership rule could drift from workerd → the workerd e2e is the arbiter and runs on CI.
- Adding `wrangler` to the workspace installs a large binary on every CI job → subject to D7; the
  e2e can run in one CI shard only.
- `credentialCookies` default (any cookie) makes analytics-cookie visitors uncacheable → same
  trade-off M143a accepted; README says so once.
- `process()` refusing without `deadLetterQueue` breaks an existing Workers consumer at startup →
  the error names both ways past it; upgrade note; the M143j template half writes the option.
  Between this merge and M143j's, CI stays green: no stock template calls `process()` on Workers
  (checked: no `.process(` in `packages/cli/src/templates` or `src/schematics`; the microservice
  template only wires `createQueueHandler` for `jobs`, `microservice.ts:149,165`), and the Workers
  CLI e2e tests (`workers-bundle-e2e`, `workers-install-e2e`) generate no job. A `setu g job`
  processor on a Workers project fails boot with the named error until M143j.
- `maxRetries` that disagrees with `wrangler.toml` `max_retries` cannot be detected → if lower than
  the platform's, the adapter dead-letters early (safe); if higher, the platform exhausts first and
  the job goes to `dead_letter_queue` or is deleted without `onFailed`. Default 3 equals the
  platform default; README and JSDoc say the two must match.
- The parity test imports `cache-plugin` (Web lane) as a test-only devDependency → it reads that
  package, never edits it; a change to M143a's rule fails this test, which is the intent.

## 9. Out of scope

- **SSE on Workers.** `sse-plugin` keeps its isolate-level registry and the isolate backplane path;
  a channel stream belongs to its request the same way, so `sse.channel()` on Workers very likely
  has V13-195's defect. No lane lists `sse-plugin`; reported to the maintainer (§11) for a lane
  decision before any code.
- **Hub-side per-room filtering and cluster-wide `size`.** Not needed for the outcome (§3.1 Why).
- **Tag eviction for the Cache API.** Needs an index the Cache API does not have.
- **`RequestOptions.headers`.** A committed `common` contract (D4).
- **The scheduler's memory and Redis locks' invalid-TTL behaviour.** `scheduler-plugin` is in no
  lane; reported (§11).
- **The bare-500 RPC errors (X117-5, widening V13-117).** Not in M143o's row list; reported to the
  maintainer for the ROADMAP (§11). V13-217's R2 half is D11.
- **`DISPATCH_CONCURRENCY` as an option.** Not a row.

## 10. Design security review

**Status:** written with the plan, before implementation; to be repeated on the committed tree.

- **Cross-Worker delivery.** The hub object is reachable only through a Durable Object binding in
  the same account (no public route); `/link` and `POST /publish` add no new external surface. Two
  applications sharing one namespace are separated only by `topic`, as today; the README keeps the
  warning. A link delivers only to its own connection and only for rooms that connection joined, so
  a frame for room X never reaches a non-member; a test asserts it under fakes and the workerd e2e
  asserts it with two rooms.
- **Untrusted input at the hub.** `POST /publish` bodies are bounded (413) and never parsed;
  link-side `#receive` keeps `isRealtimeFrame` and drops anything else. `exceptId` is advisory and
  can only reduce delivery.
- **Tenancy.** Room names are the application's; nothing here adds a tenant dimension or removes
  one. A request-bound mode bug that delivered across members would cross tenants in an application
  that names rooms by tenant: the "only members of `frame.name`" check is the control, with a
  negative control that a non-member link receives nothing.
- **Shared cache (V13-111 half).** The credentialed-request rule is a cross-user leak control on
  both sides of a URL-keyed store: a stored entry is never replayed to a request it was not safe for
  (lookup), and a per-visitor response is never stored (store), including one flagged by the session
  plugin after the handler marked it `public`, and one whose `ttlSeconds` default would have added
  `public`. The parity table with `cacheMiddleware` is its negative control set (each refused row
  stores nothing and serves nothing). Under D9 (b) no response carrying any `private` is stored.
- **`Vary` on static assets (D10 (a) only).** Appending keeps `Vary: Origin` from CORS, so a shared
  cache does not replay one origin's `Access-Control-Allow-Origin` to another.
- **Dead-letter payloads.** The DLQ copy carries the payload unchanged plus the bounded error
  message (`describeError`, no stack); no new egress beyond a producer binding the application
  configured. Logs (send failure, discard, cap) carry no payload; the send-failure log carries the
  error's class, not its message, since a producer error may quote the body.
- **Kernel `waitUntil` hand-off (D3).** Only promises the kernel already runs are handed over; no
  application value reaches the host, and a throwing host cannot skip a cleanup. The audit checks
  that a limit released through `ctx.defer` is still released when the host is present, absent or
  throws.
- **Trace header.** `trace` arrives from a producer in the same account; it is parsed by the
  existing strict `parseTraceparentToContext` and a malformed value is ignored.
- **Lock.** Refusing invalid TTLs closes a mutual-exclusion bypass (every caller held the key).

A **committed-tree security audit is required** before merge: the diff crosses the realtime delivery
boundary between Workers and the shared-cache boundary, run by a fresh Claude agent following
`.roo/skills/security-audit/SKILL.md` (never Codex), with positive and negative controls for: room
isolation across two Workers, the credentialed cache rule on lookup and store, the lock refusal, and
payload-free queue logs.

## 11. Hand-overs

- **M143j (templates).** V13-195: `setu g ws-route` on a Workers project writes a comment that rooms
  need `CloudflarePlugin({ durableObject })` and `setu add websocket` on Workers prints the arm.
  V13-203: Workers `wrangler.toml` `compatibility_date` moved to a date on or after 2026-04-07 (the
  adapter fix makes this optional, not required). V13-205:
  `packages/cli/src/templates/microservice.ts:183-185` `max_batch_size = 1` becomes `10`, and the
  `wrangler.toml` comment's consumer stanza gains it. V13-209: a commented `[[services]]` stanza
  with `script_name` notes in the Workers `wrangler.toml`, and the generated
  `test/support/server.ts` carries a comment that a bound Worker must be listed in
  `createTestHarness({ workers })`. V13-219: the generated `WorkersCron` comment shows
  `new WorkersCron({ logger })` (`project-files.ts:2626`). V13-197 (required, since `process()` now
  refuses without it): a Workers project that consumes a queue gets a second queue bound as the
  arm's `deadLetterQueue` producer in `wrangler.toml` and
  `CloudflarePlugin({ queue: { …, maxRetries: 3, deadLetterQueue: '<BINDING>' } })`, and the
  consumer stanza's `max_retries = 3` beside it.
- **M143n (docs).** `docs/runtime-deployment.md:560`: WebSocket on Workers needs the Durable Object
  arm for rooms; `:604-608`: add `service('NAME')` and `durableObject('NAME')`; any `docs/` page
  showing a Workers queue stanza uses `max_batch_size = 10` for request/reply.
- **M143p/M143m (Messaging).** `packages/messaging-plugin/README.md:1460-1461`: delete
  "`WorkersBroker` today drops the producer's `traceparent`"; after §3.12 it does not.
- **M143m (Messaging).** V13-220: the Workers half ships as `retryDelaySeconds` (number or function
  of the attempt); the SQS option should share that name and shape (D5).
- **Core lane and M143p (C3).** `common/src/services/queue.ts:62` and `:88-104` say an exhausted job
  is "dead-lettered" and `queue-plugin/README.md:292` says "by every adapter"; with SQS's and
  Workers' `deadLetterQueue(s): false` both now discard on request. Reword once for both adapters
  (Core for the JSDoc, Messaging for the README).
- **Core lane (D3, informational).** `IRuntimeServices.waitUntil?`, `RuntimePlugin({ waitUntil })`
  and the kernel's `keepAlive` were built here by the maintainer's decision (§3.18); Core owns them
  from the merge on. **M143j:** the generated Workers entry passes `waitUntil` from
  `cloudflare:workers` to `RuntimePlugin` once (D12: `CloudflarePlugin` falls back to it, so it need
  not be passed twice).
- **M143h (Data).** V13-218: the D1 message anchors are `FOREIGN KEY constraint failed` and
  `NOT NULL constraint failed: <table>.<column>`; M143o maps them once M143h's classes exist (D6).
- **Maintainer (ROADMAP and lanes).** M143o's "Half of a row owned elsewhere" should read V13-218
  (M143h); V13-220 (M143m); V13-111, V13-135 (M143a); V13-41, V13-200 (M143i). `sse-plugin` needs a
  lane decision (§9). `scheduler-plugin` lock TTL consistency has no lane. X117-5's RPC statuses
  have no letter that edits `cloudflare-plugin` other than this one; add them here or to a later
  letter. With D10 (a), the lanes table lists `static-plugin` under Workers. D3 (2026-11-23): the
  ROADMAP's M143o entry records that this letter edits `common/src/runtime.ts`, `kernel` and
  `runtime/src/plugin`, `src/adapters/shared`, `src/services` by the maintainer's decision.

## 12. Open decisions for the maintainer

**Recorded 2026-11-23 (maintainer, relayed by the coordinator).** D1 (a) and D2 (b) as decided on
2026-11-22. As recommended: D4 (a), D5 (`retryDelaySeconds`), D6 (a), D7 (a), D8 (a), D10 (a), D11
(a, after #614 merges). Changed: **D3 (a), with the Core half built inside this letter** as a
flagged out-of-lane edit (§3.18), covered by the security audit; **D9 (b) plus one warning** the
first time a response carrying `private=Set-Cookie` is refused, and a README line (§3.15 step 6);
**one branch and one PR**, part 1 (realtime) before part 2 in commit order (§14); the **D8 upgrade
note is required** in `docs/upgrading.md` and the CHANGELOG with the way out, beside every other
behaviour an existing application meets (§13). Implementation is inline. The text below keeps each
decision's options and evidence as they were put to the maintainer.

**D12, recorded 2026-11-23 (maintainer): (b).** `CloudflarePlugin` falls back to `runtime.waitUntil`
from `CAPABILITIES.RUNTIME` when its own `waitUntil` option is absent; an explicit option still
wins; the startup warning fires only when neither is present. One option on `RuntimePlugin` then
covers the kernel's cleanups and the plugin's background work. Compared with: Next.js `after()`
reads one platform `waitUntil` from a single request context
(nextjs.org/docs/app/api-reference/functions/after); Nitro has one `event.waitUntil`, which its own
cache refresh also uses (nitro.build cache docs); SvelteKit 3 imports it once from
`cloudflare:workers` (kit migrating-to-sveltekit-3); Hono exposes `c.executionCtx.waitUntil` for the
application only, with no framework consumer (hono.dev/docs/api/context). Every framework that does
its own after-response work has a single sink. Tests: one drives the plugin's background work and
the kernel's cleanup through the single `RuntimePlugin({ waitUntil })` (the "one capability, one
implementation" rule); one shows an explicit `CloudflarePlugin({ waitUntil })` winning over the
runtime's. Upgrade note: pass `waitUntil` to `RuntimePlugin`; an existing
`CloudflarePlugin({ waitUntil })` keeps working.

- **D1: where a room's sockets live on Workers.** **DECIDED by the maintainer, 2026-11-22: (a).**
  Terminating client sockets in a Durable Object per room, (b), is not built in this letter; it
  stays a candidate for a later milestone. (a) **Recommended:** sockets stay in the Worker request,
  one link per connection to the topic's hub (§3.1). Evidence: keeps `ws.route()` handlers where
  they are; repairs the backplane already shipped; Socket.IO's model (in-process rooms plus a
  cross-server adapter). Cost: no hibernation for client sockets, one hub socket per connection. (b)
  Terminate client sockets in a Durable Object per room and run the route's handlers there (the
  application exports a room class that hosts the handlers). Evidence: Cloudflare's guidance ("A
  single Durable Object instance can coordinate between multiple clients"), PartyServer (server
  class extends `DurableObject`, one per room), Cloudflare Agents (not verified). Gains hibernation
  and cluster-wide presence; costs a new programming model for Workers and a larger letter. (c)
  Refuse rooms on Workers: fails the ROADMAP outcome.
- **D2: a `maxAttempts` the platform cannot honour.** **DECIDED by the maintainer, 2026-11-22
  (revised the same day): (b), cap and warn once per job name.** The earlier choice, refuse at
  `add()`, is withdrawn. Rule: refuse only when carrying on would lose data silently; otherwise
  adjust, warn once and keep running. §3.4 steps 4 to 6 and its tests are written to (b).
- **D3: asynchronous cleanup on workerd (V13-200 half).** M143i measured it: an asynchronous
  cleanup's continuation after a timer is cut off when the client leaves. (a) **Recommended:** a
  Core follow-up PR adds optional `IRuntimeServices.waitUntil?(promise)` and the kernel hands an
  abort-time cleanup promise to it; this letter then implements the Workers member (§3.18). (b)
  Document that asynchronous `ctx.defer` cleanups are not guaranteed on Workers. Comparison table
  below (D3).

  | Framework          | After-response work on Workers-like platforms                                                                                                                                                                         | Source                                                                        |
  | ------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------- |
  | Cloudflare Workers | Work not passed to `waitUntil` "can be canceled when the invocation ends"; `waitUntil` extends up to 30 s; `import { waitUntil } from 'cloudflare:workers'` since 2025-08-08, "works the same way as ctx.waitUntil()" | developers.cloudflare.com/workers/runtime-apis/context/; changelog 2025-08-08 |
  | Next.js `after()`  | Built on a platform `waitUntil(promise)` read from a request context                                                                                                                                                  | nextjs.org/docs/app/api-reference/functions/after                             |
  | SvelteKit          | 2.x: `platform.ctx.waitUntil`; 3.x: import from `cloudflare:workers`                                                                                                                                                  | adapter-cloudflare `ambient.d.ts`; kit migrating-to-sveltekit-3               |
  | Nitro / Nuxt       | `event.waitUntil`, used for its own background cache refresh                                                                                                                                                          | unjs.io/blog/2023-08-25-nitro-2-6; nitro.build docs cache                     |
  | Hono               | `c.executionCtx.waitUntil`, application-called; no framework cleanup uses it                                                                                                                                          | hono.dev/docs/api/context                                                     |
  | This repo          | `CloudflarePlugin({ waitUntil })` / `bindings.waitUntil` for plugin work; the kernel has no handle                                                                                                                    | `cloudflare-plugin/src/options.ts:214-221`                                    |

  Every framework that runs its own after-response work on Workers routes it through `waitUntil`;
  none leaves it to chance. Not verified: whether the module-level import needs a compatibility
  date.

- **D4: `RequestOptions.headers` for Workers RPC (V13-210 remainder).** (a) **Recommended:** not in
  this letter; the framework `trace` field covers the row's trace half; application headers on
  `request()` go to Core as a contract change for all brokers. (b) Add it now through Core first.
- **D5: one retry-delay option name across Workers and SQS.** **Recommended:** `retryDelaySeconds`,
  number or function of the attempt, on both. M143m decides the SQS side.
- **D6: who defines the foreign-key and NOT NULL error classes.** (a) **Recommended:** M143h defines
  them in `common`; this letter maps D1 after they land (part 2 of §14, or a small follow-up on the
  Workers lane if part 2 has merged). (b) This letter adds them now and M143h reuses them.
- **D7: the workerd test harness.** (a) **Recommended:** `wrangler` `~4.148.0` (the template's pin)
  as a `cloudflare-plugin` devDependency and two guarded e2e files in one CI shard. Evidence: the
  only existing workerd tests are CLI-lane scaffold tests, which this lane cannot edit, and the Part
  26 gate requires each fix proved where it was found. (b) Prove on workerd by a recorded manual
  driver only and keep Node fakes as the suite's only tests. Evidence: avoids a large binary in
  every install; leaves no regression gate. Alternative checked: `@cloudflare/vitest-plugin`
  (successor of the deprecated `@cloudflare/vitest-pool-workers`) runs auxiliary Workers, Durable
  Objects and queue consumers in workerd, but "WebSockets with Durable Objects is not supported with
  per-file storage isolation" (its known-issues page) and auxiliary Workers must be prebuilt JS;
  `wrangler dev` with several `-c` configs is Cloudflare's documented way to reach a Durable Object
  by `script_name` across Workers (development-testing/multi-workers). Wrangler's current major is 4
  (`latest` 4.166.0); the pin stays the template's `~4.148.0` so the e2e matches what a scaffold
  runs.
- **D8: an exhausted Workers job when no dead store can be proved (V13-197).** The adapter cannot
  read `max_retries` or `dead_letter_queue` from the binding. (a) **Recommended:** `process()`
  refuses unless the queue arm names a `deadLetterQueue` producer or sets `deadLetterQueue: false`
  (discard, one warn per discard) — M143p §3.15's rule, and the same `false` opt-out shape as its
  SQS `deadLetterQueues`. (b) Trust the application: with neither option, `retry()` on the final
  attempt and let the platform's `dead_letter_queue` (if configured) take it; a missing one deletes
  the job without notice. (c) A third value, `deadLetterQueue: 'platform'`, declaring that
  `wrangler.toml` has a `dead_letter_queue` (unprovable, like SQS's explicit entry; `onFailed` still
  runs before the `retry()`).

  | Framework         | Exhausted job, nothing configured                                                                                                                                  | Opt-out                                 | Source                                                             |
  | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------- | ------------------------------------------------------------------ |
  | Cloudflare Queues | "Without a DLQ configured, messages that reach the retry limit are deleted permanently"; consumer cannot read `max_retries` (no field on `Message`/`MessageBatch`) | n/a                                     | queues/configuration/dead-letter-queues/; javascript-apis/         |
  | BullMQ            | Kept in the "failed" set                                                                                                                                           | `removeOnFail`                          | docs.bullmq.io/guide/queues/auto-removal-of-jobs                   |
  | Sidekiq           | Dead set (10,000 jobs / 6 months)                                                                                                                                  | `dead: false`                           | github.com/sidekiq/sidekiq/wiki/Error-Handling                     |
  | MassTransit       | Moved to the `_error` queue                                                                                                                                        | `DiscardFaultedMessages()` per endpoint | masstransit.massient.com/documentation/concepts/exceptions         |
  | Celery            | Task fails; only a FAILURE result in the result backend, message not kept                                                                                          | n/a                                     | docs.celeryq.dev userguide/tasks                                   |
  | This repo         | memory/Redis/RabbitMQ keep it; SQS (M143p §3.3) refuses a consumed name with no provable target, `false` discards                                                  | `false`                                 | `queue-plugin/src/processors/job-processor.ts:178-197`; M143p plan |

  Every keeper surveyed keeps the job by default and discards only on an explicit opt-out; the one
  platform that deletes by default is the one the adapter cannot inspect, so (a) refuses rather than
  inherit that default. (c) is offered because Cloudflare's own DLQ is the native answer; it costs a
  value the adapter must take on trust.

- **D9: the qualified `private=Set-Cookie` in the edge cache (V13-111 half).** (a) Keep the
  Cloudflare escape hatch: store a response whose only `private` is `private=Set-Cookie`. (b)
  **Recommended:** refuse any `private`, qualified or not, as `cacheMiddleware` does.

  | Cache                | `private=Set-Cookie`                                                                                                                     | Source                                         |
  | -------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------- |
  | RFC 9111 §5.2.2.7    | A shared cache "MAY store the remainder of the response message without those header fields"; notes caches often treat it as unqualified | rfc-editor.org/rfc/rfc9111 §5.2.2.7            |
  | Cloudflare Cache API | Advises "set `Cache-Control: private=Set-Cookie`"; whether the runtime strips the cookie is not stated (not verified)                    | workers/runtime-apis/cache/                    |
  | Varnish builtin.vcl  | Refused: regex `(?i:no-cache\|no-store\|private)` matches it                                                                             | varnish-cache `bin/varnishd/builtin.vcl`       |
  | nginx proxy_cache    | Refused: substring match on `private`                                                                                                    | nginx `src/http/ngx_http_upstream.c:5136-5141` |
  | Fastly               | "Fastly will not cache `private` content"; no qualified handling documented                                                              | fastly.com cache-freshness guide               |
  | This repo            | `cacheMiddleware` refuses any `private` (`cache-middleware.ts:259-264`, `:313-321`)                                                      | M143a                                          |

  (a) would also need its own parse of the qualified field, since `cacheControlDirectives` returns
  names only (`common/src/cache-control.ts:47`). Three of three shared caches surveyed refuse it,
  the platform's own stripping is undocumented, and (b) keeps the two middlewares identical, which
  the parity test needs.

- **D10: `static-plugin` replaces `Vary` (M143a hand-over).** `static-plugin` is in no lane. (a)
  **Recommended:** this letter takes it (§3.23), the coordinator adds `static-plugin` to the Workers
  lane first. (b) Route it to M143l (Web lane, after M143a) with the same lanes change. (c) Leave
  it. Behaviour comparison: Express `res.vary` "Add `field` to Vary" (express `lib/response.js`,
  jshttp/vary `index.js`); `@fastify/static` "Appends `accept-encoding` to the `Vary`" and
  `@fastify/cors` merges (fastify-static `index.js`, fastify-cors `vary.js`); Hono's `cors` uses
  `{ append: true }` (`src/middleware/cors/index.ts`); RFC 9110 §12.5.5 defines `Vary` as a list.
  Every one appends; the lane choice itself has no framework analogue.
- **D11: V13-217's R2 half (M143r hand-over).** Not in M143o's ROADMAP rows. (a) **Recommended:**
  take it after #614 merges (§3.24): R2 throws `common`'s `StorageObjectNotFoundError`, so a missing
  object answers 404 on every storage arm, and `CloudflareObjectNotFoundError` leaves the barrel (no
  existing users). (b) A later Workers letter. The sibling is `storage-plugin`'s `StorageService`
  after M143r; a lane/ownership choice has no framework analogue.

## 13. Docs deliverables

- `PUBLIC_API.md`: `IRealtimeConnectionLink`, `IRealtimeLinkBackplane`, `hasConnectionLinks` (common
  section); `WebSocketPlugin` section: request-bound mode on Workers,
  `WebSocketRoomsUnavailableError`, ordering rule; cloudflare-plugin section: queue-arm options,
  `cacheApiKey`, `purgeCacheApi`, `credentialCookies`, `isServiceBinding`, widened `CacheRefusal`,
  lock TTL rule, the `trace` envelope field.
- `CHANGELOG.md` `0.14.0`: one entry per row with the PR number; the breaking behaviour list of §4,
  matching the `docs/upgrading.md` entries one for one (the D8 refusal and its way out first).
- the cloudflare-plugin README's Workers section and `packages/runtime/README.md`'s `RuntimePlugin`
  options (out of lane, D3): pass `waitUntil` from `cloudflare:workers` (the module import, never
  `ctx.waitUntil`) to `RuntimePlugin` so asynchronous `ctx.defer` cleanups after a client leaves
  complete, up to the platform's 30 s.
- `PUBLIC_API.md` (D3): `IRuntimeServices.waitUntil?` in the common runtime section;
  `RuntimePluginOptions.waitUntil`, `CreateRuntimeServicesOptions.waitUntil`,
  `CloudflareRuntimeOptions.waitUntil` beside `env` (the `RuntimePlugin({ env })` example).
- `docs/upgrading.md` (REQUIRED, maintainer 2026-11-23), one entry per behaviour an existing
  application meets, each with its way out: **a Workers queue consumer refuses to start without
  `deadLetterQueue` (a producer binding name) or `deadLetterQueue: false`**; a `private=Set-Cookie`
  response is no longer stored by `cacheApiMiddleware` (drop `Set-Cookie` instead); with D11,
  `CloudflareObjectNotFoundError` is gone (catch `StorageObjectNotFoundError`); the `ttlSeconds`
  default no longer says `public`; pass `waitUntil` to `RuntimePlugin` on Workers; rooms on Workers
  need the Durable Object arm; `maxRetries` must match `max_retries`, and a larger `maxAttempts` is
  capped with a warning; `cacheApiMiddleware` and cookies (with `credentialCookies`); lock TTL;
  `CacheRefusal` members.
- `packages/cloudflare-plugin/README.md`: realtime backplane (C1), queue (C3, C5), distributed lock
  (C6), "Calling another Worker" (§3.11), edge cache eviction and credentials (§3.6, §3.15), KV
  consistency (§3.16).
- `packages/cloudflare-plugin/AGENT_CARD.md`: service bindings, rooms need the arm, DLQ options;
  within the card byte budget.
- `packages/websocket-plugin/README.md` and `AGENT_CARD.md`: runtime support row (C2), "Rooms on
  Workers".
- the Workers close reply and the 32 MiB ceiling go in the websocket-plugin README's "Rooms on
  Workers" section; `packages/runtime/README.md` is Core's and is not edited.
- ROADMAP Progress Tracking row and the `CLAUDE.md` status line; plan archived to `plans/archive/`.

## 14. Order of work (one branch, one PR — maintainer, 2026-11-23)

One branch, `feat/m143o-workers-realtime-queues-bindings`, and one PR. Commits in this order:

1. **Part 1, realtime on Workers:** V13-195, V13-196, V13-203, the V13-41 half, the workerd harness
   (D7).
2. **Part 2:** the D3 Core half and its Workers member (V13-200), V13-197, V13-201, V13-202,
   V13-204, V13-205, V13-206, V13-209, V13-210, V13-219, the V13-220, V13-111, V13-135 halves, §3.20
   to §3.23, and §3.24 once #614 has merged (otherwise a follow-up on this branch before the PR, or
   noted as pending in the PR).
3. Docs, upgrade notes, CHANGELOG, `PUBLIC_API.md`, status rows, plan archive.

The security audit runs once, on the committed tree, and covers room isolation, the credentialed
cache rule and the kernel's `waitUntil` hand-off. M143j waits for this PR.

## 15. Addendum (2026-11-24): three defects on `develop`, added to this branch

The maintainer asked for three defects the final review listed as pre-existing to be fixed here.
Each is measured, registered, given a CHANGELOG line and a test that fails on the old code.

- **V13-274 — 426 without `Upgrade`.** The two Durable Object hubs (`RealtimeBackplaneObjectCore`,
  `ReplyInboxObjectCore`) are the only framework code that answers 426. Both now send
  `Upgrade: websocket` and `Connection: Upgrade` (RFC 9110 §15.5.22); the reply inbox's 405 also
  gains `Allow: GET, POST` (§15.5.6), the same expression. Bun's own 426 (version mismatch) is Bun's
  server, not framework code.
- **V13-275 — High advisories in generated Workers projects.** Out-of-lane edit to the CLI lane's
  generated output, approved by the maintainer. A registry check showed a pin bump suffices: every
  wrangler from 4.153.0 pins a miniflare with undici 7.30.1 and sharp 0.35.5, so generated
  `overrides` were not needed. The scaffold pins `wrangler ~4.153.0` and
  `@cloudflare/workers-types ^5.20261023.1` (wrangler's peer floor); this package's devDependency,
  the realtime-clients example and the range table follow, and the repository's now-redundant
  `miniflare>undici`/`miniflare>sharp` overrides are removed (they would hold undici below a later
  miniflare's). `workers-install-e2e.test.ts` gains a lock-only `npm audit` of a generated manifest
  that fails on High or Critical advisories through wrangler or miniflare (fails at 4.148, passes at
  4.153).
- **Workers handshake status — measured; the maintainer chose (a).** The request assumed Workers'
  500 differed from Deno's 400 for the same failure. Raw-socket probes on all four runtimes show a
  client fault (missing `Sec-WebSocket-Key`) gets 400 everywhere, workerd answering it itself; the
  Workers catch (500) fires only when the platform cannot create the socket pair, the cause for
  which Node's catch also answers 500. Workers keeps its 500. `handshake-platform-faults.test.ts`
  pins that arm across the four adapters (500 Node and Workers; 501 where the path cannot upgrade),
  websocket-plugin's `handshake-refusals.test.ts` pins the client-fault arm on a real server on the
  Node and Deno lanes, and the workerd e2e pins a missing key's 400. `node-http-adapter.ts`'s
  comment no longer calls the Workers catch client-triggerable.
- **V13-276 — Deno's handshake validation.** Out-of-lane edit in `runtime`, approved by the
  maintainer. Deno upgraded a malformed key and a missing or unsupported version that Node's `ws`
  refuses. `adapters/shared/handshake-headers.ts` holds the `ws` 8.23.0 rules (key
  `/^[+/0-9A-Za-z]{22}==$/`; version 13 or 8, else 400 with `Sec-WebSocket-Version: 13, 8`) and the
  Deno adapter applies them before `Deno.upgradeWebSocket`. Version 8 stays accepted, as in `ws`.
- **V13-277 — upstream note.** Bun's and workerd's own 426 for an unsupported version carries no
  `Upgrade`, and workerd upgrades a malformed key. Both are the platform's handshake, so the
  websocket-plugin README names the difference and nothing changes in Setu.
- **V13-278 — a malformed handshake ran a Workers route's `onOpen`.** Found by the code review of
  the addendum and reproduced under wrangler 4.153.0: workerd invokes the Worker before it checks
  the handshake, so the adapter created and accepted the pair, `onOpen` ran (a room join, a
  broadcast, a `maxConnections` slot), and only then did workerd answer 400 or 426 and close
  with 1006. Comparison: Node (`ws`) and Deno (now) refuse before `onOpen`; Bun's `server.upgrade()`
  returns false, so `open` never fires; Hono's Workers adapter (`hono@4.13.18`,
  `adapter/cloudflare-workers/websocket.js`) checks only the `Upgrade` header and then creates the
  pair — it has no `onOpen` hook, but its `onClose` would fire. The maintainer chose (a): the
  Workers adapter applies the same check before `createPair`, version 13 only (workerd speaks only
  13): a malformed key gets 400, any other version 426 with `Sec-WebSocket-Version: 13` and
  `Upgrade: websocket`. `refuseHandshakeHeaders` takes the supported versions and names the header
  at fault; each adapter builds its own response. The platform-fault 500 catch is unchanged.
  `workers-handshake-refusal.test.ts` drives a kernel app on the Workers platform with a fake
  `WebSocketPair`: no `onOpen` or `onClose` for a bad key or version, and both fire without the
  check; `handshake-platform-faults.test.ts` gains the client faults the Deno and Workers adapters
  refuse themselves.
- **V13-278 follow-up — Worker-to-Worker sockets.** The code review of the pre-check found it
  refused the documented Worker-to-Worker pattern:
  `fetch(url, { headers: { Upgrade: 'websocket' } })` over a service binding or a Durable Object
  stub carries no key or version, and workerd completes it (101). Measured under wrangler 4.153.0:
  an edge request carries `request.cf`; a programmatic binding call has no `cf`, no key and no
  version; a client request forwarded through a gateway keeps `cf` and the client's (regenerated)
  key. The maintainer chose (a): skip the pre-check when `request.cf` is undefined and keep it for
  every request that carries `cf`, forwarded ones included. Comparison: Hono's Workers adapter
  checks only `Upgrade`; Cloudflare's docs say `cf` is absent in the dashboard preview
  (`workers/examples/accessing-the-cloudflare-object`); local Durable Object stub fetches lack `cf`
  (`prisma/reproduction-cf-do-fetch-broken`, the Wrangler 3.46 thread). Two limits are documented:
  the phantom join remains possible only where an edge request lacks `cf`, such as the dashboard
  preview; and `cf` on every production edge request is Cloudflare's documented behaviour,
  unverified here (no account). Tests: an edge request with a bad key or version is refused with no
  `onOpen` (app-level, `cf` set); a no-`cf` keyless call reaches `createPair` and answers 101
  (adapter table) and opens on real workerd over a binding (e2e, `/worker-to-worker`); a client
  request forwarded through the front Worker is still checked (e2e, no-key 400 with the open count
  unchanged); Setu's own Durable Object links (`connection-link.ts`, `reply-inbox.ts`) open sockets
  to the hub objects, which accept them directly, and the room e2e cases exercise them.
- **V13-278 follow-up — what local workerd shows (measured 2026-11-27, wrangler 4.153.0).** Two
  corrections to the WIP note: `new Request(url, request)` keeps `cf`; and the Worker-to-Worker 404s
  came from the kernel rule that an upgrade needs `Connection: Upgrade` as well as
  `Upgrade: websocket` (`isWebSocketUpgradeRequest` in `common`), pre-existing — whether to register
  or fix it (Core lane) is with the maintainer. With both headers the `cf` exemption works on real
  workerd. Logged at the app: for every raw client handshake, valid or not, the Worker receives `cf`
  set and a freshly generated valid key, because `wrangler dev` puts its proxy Worker in front and
  workerd rebuilds the handshake for that subrequest, as it does behind any gateway Worker. The
  pre-check therefore cannot act in local dev or behind a gateway. The maintainer chose (a) + (c):
  keep the pre-check, proven by the app-level fake-pair tests and their negative control; drop the
  three edge-refusal workerd cases; keep the workerd valid-handshake and Worker-to-Worker cases; and
  add a workerd case asserting the rebuilt handshake (`cf` set, a key other than the one sent,
  valid), so a wrangler change shows up. Production behaviour — whether Cloudflare passes the
  client's own handshake headers to the Worker — is unverified (no account), and the README says so.
- **Upgrade-only Worker-to-Worker sockets (maintainer decision: fix, no register row; out-of-lane
  edit approved in `common`, narrowed to `runtime`).** `isWebSocketUpgradeRequest` needs
  `Connection: Upgrade`, so Cloudflare's documented
  `fetch(url, { headers: { Upgrade: 'websocket' } })` never reached a Setu route (404). Precedent:
  Hono's Workers `upgradeWebSocket` checks only `Upgrade` (`hono@4.13.18`,
  `adapter/cloudflare-workers/websocket.js`). Measured on real servers (raw `GET /ws`,
  `Upgrade: websocket`, no `Connection`): today Node, Bun and Deno answer 404. With the shared check
  relaxed (patched `common`, rebuilt): Node 501 (Node never emits `upgrade` without `Connection`, so
  the kernel's intent reaches the fetch path, which cannot upgrade), Bun 101 with a key (Bun
  upgrades without `Connection: Upgrade`, against RFC 6455) and 400 without, Deno 400. So relaxing
  the shared rule would make the runtimes diverge and turn a clean 404 into a 501 or an
  RFC-violating 101; the narrower change keeps `common` as it is and lets the Workers adapter route
  an internal subrequest (no `cf`) carrying `Upgrade: websocket` as an upgrade by adding
  `Connection: Upgrade` to the request the kernel routes on. Edge requests are routed as sent.
  Tests: the workerd e2e opens a `?upgrade-only` socket over a service binding (101, `onOpen`); the
  app-level test opens an Upgrade-only internal request; the real-server table gets 404 for the same
  request on the Node and Deno lanes (Bun measured, not in a lane); a negative control without the
  routing change fails the Workers cases.
- **D11 built (after #614 merged into develop as `eb64aaefe`; merged here).** As §3.24 decided:
  `R2Storage.get`/`getStream` throw `StorageObjectNotFoundError` (common, 404 hint, fixed detail,
  key in `message` and `key` only); `CloudflareObjectNotFoundError` leaves `errors.ts` and the
  barrel, with no alias. Tests: `r2-storage.test.ts` (the class, `key`, the 404 hint, the key absent
  from the hint), `barrel-exports.test.ts` (the old name is gone), and `kernel-app.test.ts` (a route
  reading a missing object answers 404 through the kernel with the key absent from the body).
- **V13-117's Workers half (maintainer decision, from M143m's plan §3.1, D1).**
  `CloudflareRequestTimeoutError` and `CloudflareRemoteHandlerError` carried no status, so a Workers
  RPC fault surfaced as a masked 500. Both constructors now set M143m's hints through `common`'s
  `withHttpStatusHint`, as M143m does for `messaging-plugin`: a timeout `504` (`Gateway Timeout`,
  "No reply arrived in time; the request may have been handled."), a responder failure `502`
  (`Bad Gateway`, "The service that handled the request failed."). The topic, budget and remote
  message stay in `message` only. No fields are added (the classes keep their constructors). Tests
  in `rpc-round-trip.test.ts`: the hint fields on both classes; a kernel-app route whose responder
  throws a message carrying a secret answers 502 without it; one whose reply never arrives
  answers 504.
- **Second re-audit (at `c64381539`, failed on two findings, both fixed).** Medium: the Workers
  pre-check read the version with `Number()` (`ws`'s rule), so `0x0d`, `+13`, `1.3e1`, `13.0` and
  `013` passed the adapter while workerd compares the header to the string `13` and refuses them —
  the phantom `onOpen` for those spellings. `refuseHandshakeHeaders` now takes the platform's
  version rule: `WS_VERSION_RULE` (numeric 13 or 8, Deno) and `WORKERD_VERSION_RULE` (the untrimmed
  header is exactly `13`, Workers). Low: a gateway that forwards only the headers drops `cf` (one
  that forwards the `Request` keeps it); the README and the adapter comment now say so.
- **Review and third audit of the version fix.** `trim()` also strips the vertical tab, form feed
  and no-break space, which workerd keeps in the value, so `13\v`, `\f13` and `13\xa0` passed the
  adapter while workerd refuses them. The rule is now `raw === '13'` (spaces and tabs are stripped
  from a header value before the Worker sees it), with unit rows for those spellings.
- **CodeRabbit on #619, thread 4716760556: isolate-level publish goes through the hub (maintainer
  decision, option (b)).** `DurableObjectBackplane.publish` sent on the isolate socket, which
  belongs to the request that opened it. A publish from another request threw on `send`. That
  retired the socket, reopened it in the new request, and so on. Measured on local workerd, 20
  concurrent publishes from each of two Workers: on the old path the hub never received every frame
  (the e2e timed out waiting for them). `publish` now awaits `connect()` (the socket is kept for
  receiving), then `publishViaHub(frame)`: a `POST /publish` the hub fans out to every socket, the
  publisher's own included. The frame's existing `origin` (`RealtimeFrame.origin`, in `common` since
  0.2.0) drops that echo in `#receive`. No contract field is added: the out-of-lane `common` edit
  the decision allowed was not needed. A failed POST is logged, never thrown. A failed open still
  throws, as before.
  - **Comparison.**
    - Workers I/O ownership: an I/O object belongs to the request that created it, and touching it
      from another request throws.
    - Durable Object docs: the object, not the Worker, is the place to hold long-lived sockets, and
      a Worker reaches it per request through a stub `fetch`.
    - partyserver: a broadcast is a call on the object, never a write on another request's socket.
    - Hono's WebSocket helper and `ws`: a socket is used only from the code that owns it.
    - All of these send from the request at hand. A POST is the same shape: the stub is fetched from
      the publishing request.
  - **Developer impact.** None on the API: `sse-plugin` calls `publish` as before. Every publish is
    now one hub request, which counts against the object's soft limit of 1,000 requests a second, as
    route broadcasts already do.
  - **The receive side stays a documented limit.** The receiving socket still belongs to the request
    that opened it (the first SSE stream or publish). On local workerd it kept receiving after every
    request that opened it had answered: the e2e publishes five more frames 2 s later and the first
    Worker hears all of them, still on its one socket. On the platform this is unverified (no
    account). A replica also hears only the frames sent after its socket joined the hub: in the
    measurement, the second Worker missed the first Worker's earliest frames. Both are in the
    cloudflare README and PUBLIC_API.
  - **The self-echo rule on every transport.** `test/realtime-backplane-origin.test.ts` runs memory,
    messaging, Redis and Durable Object over one shared fake medium each, with four rows:
    - a publish reaches the other replica and never the publisher's own handlers;
    - a frame stamped with the receiver's own origin is dropped (a forged origin can only silence
      the replica it names);
    - a frame with no origin, or a non-string one, is dropped everywhere;
    - a third party's frame reaches both replicas. The memory transport delivered a frame with no
      origin. It now checks `isRealtimeFrame`, as the other three do.
  - **Tests.**
    - `durable-object-backplane.test.ts`: POST and no socket send, a socket that throws on send not
      retired, reopen after a close or an error, a refused POST logged, connect failure, a raced
      close.
    - `workerd-realtime-rooms.test.ts`: concurrent publishes, every frame at the hub, one open and
      no warnings on each Worker; then the receive measurement.
  - **Negative controls.** The old `publish` fails the e2e (frames missing at the hub) and four unit
    tests. The old memory `#deliver` fails the no-origin row. The restored tree passes.
  - **Ordering (code review of the change).** Cloudflare's stub page says there are no ordering
    guarantees between different stubs, and every POST takes a new stub. The old socket kept the
    order of one request's publishes. One cached stub per backplane was tried: on local workerd the
    concurrent e2e then lost frames at the hub, because a stub, like a socket, belongs to the
    request that made it. It was reverted. A 50-frame burst from one request arrived in order
    locally with a stub per POST, but the platform does not promise that, so no test asserts it.
    Cross-replica order is a documented limit (class doc, cloudflare README, PUBLIC_API).
  - **Two room objects with members under one name (code review of c6c71c983).** Workers counted a
    kept room's members through `isMember`, while `deliverRemote` on other runtimes reached only the
    room holding the name. A set of rooms "beside" the holder was tried and reverted: it split Node,
    because local broadcasts and remote frames reached different members.
    `RequestBoundRooms.closeAll` now guards its logger, so the service's catch around it was
    removed.
- **One member set per room name (maintainer decision, thread 4716760586; built inline with the
  user's OK).**
  - **Design.** The registry keeps `#sets`, each name's one member set, present only while the name
    has members. Every `Room` it creates is a handle: a module-private `WeakMap` gives it
    `current()` and `acquire()` onto its name's set, so `Room`'s constructor is unchanged. `add`
    acquires the set (a kept handle whose name was released puts itself back as the name's handle);
    `remove`, `has`, `size` and `broadcastLocal` read it. The reverse index maps a connection to
    names. `isMember` reads the set. This matches Socket.IO, Phoenix and Centrifugo, which key rooms
    by name only.
  - **Reclamation.** The last member's leave deletes the set and the name's handle. Never-joined
    handles are reclaimed on `evict`, but only while still the name's handle and with no set.
  - **Tests.** `room-registry.test.ts`:
    - the kept-object scenario with local and remote delivery once each;
    - a connection joined through both handles is one member;
    - the name is released through any handle;
    - an earlier handle cannot reclaim the name taken since;
    - `evict` and `clear` act on the shared set. `request-bound-rooms.test.ts`: the scenario in
      Workers mode, with no cross-request write. `workerd-realtime-rooms.test.ts`: on local workerd,
      a member and a route broadcast reach both members once, and `size` is 2.
  - **Changed assertion.** One existing test asserted that `peek` returned the kept object. With one
    set, both handles are equivalent, so it now asserts the members.
  - **Negative control.** The two-set registry fails six unit tests and the workerd e2e.
- **CodeRabbit on #619 (review body, connection-link.ts): link queue byte budget (maintainer
  decision (b), 1 MiB).** Application broadcasts were unbounded, so a link could queue 64 frames of
  up to the hub's 32 MiB cap each while it opened.
  - **Rule.** Beside the 64-frame bound, `LINK_QUEUE_BYTE_BUDGET` = 1,048,576 bytes of
    `frame.data.length`, a constant rather than an option. A frame that would take the queue past
    it, or one above `MAX_FRAME_BYTES` (now exported from the hub core) even on an open link, makes
    `publish` return `false`, and `RequestBoundRooms` POSTs it through `publishViaHub`. The hub
    answers 413 above the cap, which the backplane logs with `status: 413`. A drained, dropped or
    cleared frame gives its bytes back, and a full queue counts the oldest frame's bytes as freed
    before checking.
  - **Tests.** `connection-link.test.ts`: the budget boundary, the cap on an open link, bytes back
    after a drain and reopen, and bytes back from the count drop.
    `test/realtime-link-byte-budget.test.ts` (the real `RequestBoundRooms` and hub core): a frame
    above the budget goes by POST and is delivered; 20 × 100 KiB frames give 10 POSTs and every
    frame arrives; a frame above the cap gives the 413 log.
  - **Negative controls.** The count-only queue fails five of these. A `#shift` that keeps the bytes
    fails the two accounting tests.
- **Code review of the budget and one-set range.**
  - **The hub cap is measured right.** It is now the UTF-8 bytes of the serialized frame (the hub's
    unit), not characters of the payload.
  - **A sender gets its own refused broadcast.** When its link refuses a broadcast with no `except`,
    the sender gets it locally, before the transport as on every runtime. The hub's copy carries the
    sender as `exceptId`, so it never gets two.
  - **The ordering exception is documented.** Frames sent through the hub while queued ones wait can
    arrive first.
  - **The workerd e2e waits** for the name to empty on the server.
  - **Second pass, and the re-audit's one Low finding.**
    - **Sender with `except`.** When a broadcast's `except` names another member and the sender's
      link refuses it, the sender also gets it locally. The refusing link is not on the hub yet, or
      the hub refuses the frame, so no second copy reaches it.
    - **Size check order.** It refuses on `frame.data.length` before serializing, and a queued frame
      is never serialized for measuring. Only an open link's send measures the serialized bytes.
    - **Docs.** The websocket README now has the ordering exception. The storage class is named as
      `StorageService`'s for every provider. An old upgrade note points to the current Workers pins.
      The Workers limitations table names the Durable Object arm and the dead-letter target.
