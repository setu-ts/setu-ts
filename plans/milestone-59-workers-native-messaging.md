# Milestone 59 — Workers-Native Messaging (`@setu-ts/cloudflare-plugin`, `@setu-ts/cli`)

> **Status:** Planning. Branch: `feat/m59-workers-native-messaging`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

`CAPABILITIES.MESSAGING` is the last capability token the framework cannot serve on Cloudflare
Workers. `cloudflare-plugin` already registers `QUEUE`, `CACHE`, `STORAGE`, `DATABASE` and
`REALTIME_BACKPLANE`; all ten `messaging-plugin` brokers need a socket or a socket-bound SDK, and
`cloud-gate.ts` hard-refuses Pub/Sub and Service Bus on Workers by name. This milestone adds
`WorkersBroker` — the committed `IMessageBroker` over a Cloudflare Queues producer binding for
`publish`, a consumer-side dispatch table for `subscribe`, and an **opt-in** Durable Object reply
inbox for `request`/`respond` — and replaces the CLI microservice template's unconditional Workers
refusal with a runtime-aware arm that swaps `MessagingPlugin`/`QueuePlugin` for `CloudflarePlugin`.

- **In scope:** `WorkersBroker`, its queue wire envelope, its subscription table, its consumer
  dispatch (`createMessagingHandler`), the DO-backed reply inbox (`ReplyInboxObjectCore` plus the
  replica-side inbox and correlation manager), the `messaging` arm on `CloudflarePluginOptions`, an
  `isQueueProducer` binding guard, the CLI `runtimeSwaps` template field with the microservice
  Workers arm, and verification against real workerd via `wrangler dev`.
- **NOT this milestone:** HTTP-polling or WebSocket fallbacks for the existing ten brokers (rejected
  in the ROADMAP with cause — a Worker has no ambient loop to poll from). Lifting the Workers
  refusal on `scheduler-plugin` (settled by M52b). A `messaging` arm on `microservice-starter`
  (M50b's boundary: the CLI emits inline wiring and never imports a starter — unowned). Docker and
  Kubernetes objects for a Workers deployment (M39). Cross-_service_ pub/sub fan-out over a single
  queue (impossible on the platform — see §3.3; a topology needing it binds one queue per consumer,
  which the single-binding arm does not model, and no milestone owns it yet).

## 1. Contracts verified from SOURCE (not names)

| Reference                       | Source (file:line)                                                        | Verified surface / fact                                                                                                                                                                                                               |
| ------------------------------- | ------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMessageBroker`                | `packages/common/src/services/messaging.ts:98-168`                        | Exactly six members: `connect`, `disconnect`, `publish<T>(topic, message)`, `subscribe<T>(topic, handler, options?)`, `request<TReq,TRes>(topic, message, options?)`, `respond<TReq,TRes>(topic, handler, options?)`. No `isReady`.   |
| `SubscribeOptions`              | `packages/common/src/services/messaging.ts:43-46`                         | One member: `queue?: string` — "Consumer group / queue name for load-balanced delivery".                                                                                                                                              |
| `RequestOptions`                | `packages/common/src/services/messaging.ts:53-59`                         | One member: `timeoutMs?: number`, documented default `5000`.                                                                                                                                                                          |
| `MessageMetadata`               | `packages/common/src/services/messaging.ts:14-23`                         | `topic` required; `messageId?`, `timestamp?: Date`, `headers?` optional. So a broker populating only `topic`+`messageId`+`timestamp` is contract-complete.                                                                            |
| `ISubscription`                 | `packages/common/src/services/messaging.ts:81-86`                         | One member: `unsubscribe(): Promise<void>`.                                                                                                                                                                                           |
| `OpenInbox` / `ReplyInbox`      | `packages/messaging-plugin/src/brokers/inbox.ts:28-47`                    | **Lives inside `messaging-plugin`, not `common`.** §2.2/§3.3 forbid `cloudflare-plugin` importing it. Same for `RequestReplyCore` (`request-reply-core.ts:113`) and `RequestTimeoutError`/`RemoteHandlerError` (`errors.ts`). See C1. |
| `common` exports no error class | `grep 'class .*Error' packages/common/src` → empty                        | Promoting the two RPC errors into `common` is not available: §2.1 limits `common` to types, interfaces, constants and pure utilities, and it carries no error-class precedent.                                                        |
| `InMemoryBroker.publish`        | `packages/messaging-plugin/src/brokers/in-memory-broker.ts:24-27,105-130` | The in-repo semantic `WorkersBroker` must match: "fanout delivery to subscribers without a queue, and load-balanced (round-robin) delivery to subscribers within a queue".                                                            |
| `WorkersQueue.dispatch`         | `packages/cloudflare-plugin/src/queues/workers-queue.ts:230-314`          | The ack/retry discipline to mirror: exactly one disposition per message; `ack()` deliberately **outside** the processor `try` so a throwing ack is not reported as a processor failure.                                               |
| `createQueueHandler`            | `packages/cloudflare-plugin/src/queues/queue-handler.ts:78-108`           | Resolves the token lazily per invocation; `async` so a resolution failure is a rejection, not a synchronous throw; `instanceof` narrows within the resolved token rather than casting to another interface.                           |
| `IQueueProducer`                | `packages/cloudflare-plugin/src/bindings/facades.ts:265-281`              | `send(body, options?)`, `sendBatch(messages)`. `QueueSendOptions` = `contentType?`, `delaySeconds?`.                                                                                                                                  |
| `IQueueMessage` / `Batch`       | `packages/cloudflare-plugin/src/bindings/facades.ts:292-322`              | `id`, `body: unknown`, `attempts` (1 on first delivery), `ack()`, `retry(options?)`; batch carries `queue: string` and `messages`.                                                                                                    |
| `BindingRegistry.queue()`       | `packages/cloudflare-plugin/src/bindings/binding-registry.ts:208-210`     | Casts **unvalidated** — no `isQueueProducer` exists (`facades.ts` has `isKvNamespace`, `isR2Bucket`, `isD1Database`, `isDurableObjectNamespace` only). See C4.                                                                        |
| `IDurableObjectNamespace`       | `packages/cloudflare-plugin/src/bindings/facades.ts:367-382`              | `idFromName(name): unknown`, `get(id): IServiceBinding`. The stub is `fetch`-shaped.                                                                                                                                                  |
| `IDurableObjectState`           | `packages/cloudflare-plugin/src/durable-objects/do-facades.ts:141-165`    | `acceptWebSocket(ws)`, `getWebSockets()`, `storage`. `getWebSockets()` survives hibernation and is the only membership source of truth.                                                                                               |
| `asUpgradeResponse`             | `packages/cloudflare-plugin/src/durable-objects/do-facades.ts:213-228`    | Narrows a stub response to one carrying `webSocket`, throwing `CloudflareUnsupportedError` naming the binding. Reused verbatim by the reply inbox.                                                                                    |
| `instanceToken`                 | `packages/cloudflare-plugin/src/instance-token.ts:44-50`                  | `'default'` (or omitted) returns the bare token; anything else returns `createCapabilityToken('<base>.<name>')`.                                                                                                                      |
| `CloudflarePluginOptions`       | `packages/cloudflare-plugin/src/options.ts:136-175`                       | `env` required; `waitUntil?`, `requireBindings?`, `cache?`, `storage?`, `queue?`, `durableObject?`. Each arm is opt-in and instance-named; `provides` is computed from the arms present.                                              |
| `TemplateDefinition`            | `packages/cli/src/templates/registry.ts:334-345`                          | Extends `TemplateHost`; adds `name`, `description`, `unsupported`. **`TemplateHost.plugins` is a static `readonly Wiring[]` — there is no runtime-conditional plugin mechanism.** See C2.                                             |
| `MICROSERVICE_TEMPLATE`         | `packages/cli/src/templates/microservice.ts:98-119`                       | `unsupported: { 'cloudflare-workers': 'the messaging and queue plugins reach brokers over raw sockets…' }` — template-level and unconditional, exactly as the ROADMAP says.                                                           |
| `Wiring.workersArgs`            | `packages/cli/src/templates/project-files.ts:222-225`                     | On Workers the renderer prefers `workersArgs` over `args`; `RUNTIME_WIRING` uses it to pass `{ env }` (`rest.ts:33-35`).                                                                                                              |
| `workersEntry()`                | `packages/cli/src/templates/project-files.ts:291-330`                     | Emits `src/index.ts` with a lazily-memoised `boot(env)` and a single `fetch` export. No `queue` export and no parameters. See §3.10.                                                                                                  |
| `wrangler.toml` emission        | `packages/cli/src/templates/project-files.ts:696-720`                     | Fixed string; `compatibility_date = "2025-09-01"`; carries commented-out KV/R2 examples and no queue stanza.                                                                                                                          |
| Queues: one consumer per queue  | developers.cloudflare.com/queues/reference/how-queues-works/              | "each queue can only have one active consumer" — attaching a second is a publish-time error. Decides §3.3.                                                                                                                            |
| Queues: batch timeout range     | developers.cloudflare.com/queues/configuration/batching-retries/          | `max_batch_timeout` **0–60 s**, default 5; `max_batch_size` 1–100, default 10. Decides §3.8.                                                                                                                                          |
| Queues: limits                  | developers.cloudflare.com/queues/platform/limits/                         | Message size 128 KB; consumer wall clock 15 min; retries 100; `delaySeconds` ≤ 24 h; at-least-once delivery with possible duplicates.                                                                                                 |
| DO: no wall-clock cap           | developers.cloudflare.com/durable-objects/platform/limits/                | "No hard limit while the caller stays connected to the Durable Object." This is what makes a DO reply inbox viable at all.                                                                                                            |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                       | Doc deliverable (same PR)                                                                                                                                                           |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP M59 says the Workers inbox is "a third implementation of a seam that exists" via M14d's `openInbox`. **False by §2.2**: `OpenInbox`, `ReplyInbox` and `RequestReplyCore` live in `packages/messaging-plugin/src/brokers/`, and no plugin may import another. The seam is unreachable from `cloudflare-plugin`.  | `cloudflare-plugin` owns a purpose-built correlation manager (§3.5). This is **not** the §11.1 duplication case: the generic core carries the reply over the broker's own `publish`, while here the request rides the queue and the reply rides a Durable Object — different transports, different lifecycle. There is also no wire-compat requirement (§3.6). | Rewrite the ROADMAP M59 "`request`/`respond`" bullet to state the package boundary and the purpose-built core, so a reader does not re-raise the seam.                              |
| C2 | ROADMAP deliverable: "the microservice template's Workers refusal replaced by a runtime-aware arm". No such mechanism exists — `TemplateHost.plugins` is a static array (`registry.ts:240`).                                                                                                                            | Widen the template contract with `TemplateDefinition.runtimeSwaps` (§3.9). Declarative data, not a callback, so `--dry-run` stays exact and the swap is unit-testable without rendering a project.                                                                                                                                                             | PUBLIC_API CLI templates section gains the `runtimeSwaps` row; ROADMAP M59 deliverable amended to name the field.                                                                   |
| C3 | `IMessageBroker.request`'s JSDoc (`messaging.ts:129-149`) promises rejection with "a `RequestTimeoutError`" / "a `RemoteHandlerError`" — class identities owned by `messaging-plugin`, which a Workers app never registers.                                                                                             | `cloudflare-plugin` exports `CloudflareRequestTimeoutError` / `CloudflareRemoteHandlerError`, matching this package's three existing `Cloudflare*` error classes. Unambiguous per application: both providers claim `CAPABILITIES.MESSAGING`, so the kernel's duplicate-provider check guarantees exactly one is registered.                                   | Amend the two `common` JSDoc blocks to say the error _shape_ is the contract and the class is the registered provider's; PUBLIC_API Messaging + Cloudflare sections state the pair. |
| C4 | `facades.ts:402` states the guard family exists "to fail at `register()` with a name rather than at the first request with a bare `TypeError`", but `BindingRegistry.queue()` (`:208`) casts unvalidated — the exact hole M52c found on D1 and M52d on Durable Objects. This milestone makes `queue()` a second caller. | Add `isQueueProducer` (`hasMethods(value, ['send', 'sendBatch'])`) and validate in `registry.queue()`. A **behaviour change to the shipped M52b arm** — a mistyped `queue` binding now throws at `register()` instead of `TypeError` on first `add()` — and therefore flagged, CHANGELOG'd, and shipped as a fix rather than folded in silently.               | CHANGELOG entry under Fixed; PUBLIC_API Cloudflare bindings note.                                                                                                                   |
| C5 | ARCHITECTURE's package diagram and capability table list `cloudflare-plugin` as serving cache/storage/queue/database/realtime-backplane, with messaging Workers-refused.                                                                                                                                                | Add `MESSAGING` to the `cloudflare-plugin` row and record that it is now a **second provider** of that token (the M52d note for `REALTIME_BACKPLANE` is the precedent): an application registers `MessagingPlugin` **or** the Cloudflare `messaging` arm, never both.                                                                                          | ARCHITECTURE capability table + the note beside it.                                                                                                                                 |

## 3. Design decisions

### 3.1 Where `WorkersBroker` lives

- **Decision:** `packages/cloudflare-plugin`, as an opt-in `messaging` arm on
  `CloudflarePluginOptions`, instance-named through `instanceToken(CAPABILITIES.MESSAGING, name)` →
  bare `messaging` or `messaging.<name>`.
- **Why:** It needs `IQueueProducer` and `IDurableObjectNamespace`, both of which are this package's
  facades; putting it in `messaging-plugin` would force a duplicate facade set there and a
  cross-package resolution of `CAPABILITIES.CLOUDFLARE` whose _type_ still lives here. The
  instance-name convention is the shipped `cache.<name>` / `queue.<name>` precedent
  (`options.ts:20-24`), and it is what lets a Workers app run two brokers over two queues.
- **Test home:** `test/integration/messaging-arm.test.ts` — registers the arm under a name and
  resolves `messaging.orders`; a second test asserts the bare token when `name` is omitted.

### 3.2 `publish` — one producer binding, one JSON envelope

- **Decision:** `publish(topic, message)` calls
  `producer.send(encodeMessageEnvelope(topic, uuid(), message))` with the default
  `contentType: 'json'`. The envelope is `{ v: 1, kind: 'msg', topic, id, payload }`. No
  `delaySeconds` — `IMessageBroker.publish` has no delay parameter.
- **Why:** A Cloudflare queue has no topic concept, so the topic must travel in the body; carrying a
  version tag and a `kind` discriminant is what lets the same queue also carry RPC requests (§3.6)
  and lets a future widening be detected rather than misread. The id is minted from
  `ctx.runtime.uuid()` (§4.2 routes every runtime capability through `IRuntimeServices`), which is
  also why the plugin constructs the broker rather than the application.
- **Test home:** `test/unit/message-envelope.test.ts` (round trip + every guard rejection) and
  `test/unit/workers-broker-publish.test.ts` (asserts the exact body handed to a recording producer
  fake).

### 3.3 `subscribe` — a dispatch table driven by the `queue` export, not a live socket

- **Decision:** `subscribe` registers `{ topic, handler, queue? }` in an in-memory table and returns
  an `ISubscription` whose `unsubscribe` removes it. Delivery happens only when the application
  exports the handler `createMessagingHandler(app)` builds and the queue is declared as a consumer
  in `wrangler.toml`. Within one delivery, the table fans out to every queue-less subscriber and
  delivers to exactly one member per queue group, round-robin — matching `InMemoryBroker`
  (`in-memory-broker.ts:24-27`).
- **Why:** A Cloudflare queue consumer is a module-level export, not a callback the isolate holds
  open; this is the M52b `WorkersQueue.process` pattern applied to topics. The fan-out/round-robin
  split is not invention — it is the semantic the repo's reference broker already documents, and
  implementing anything else would make one contract mean two things. **Cross-service fan-out is out
  of reach and is documented rather than faked:** the platform allows exactly one active consumer
  per queue, so two Workers cannot both receive one published message. That is the honest scope of
  `publish` here, and PUBLIC_API says so in those words.
- **Test home:** `test/unit/subscription-table.test.ts` (fan-out to two queue-less subscribers;
  one-of-two within a group; round-robin across two deliveries; `unsubscribe` removes exactly one
  entry).

### 3.4 Consumer dispatch — one disposition per message, and the unroutable split

- **Decision:** `WorkersBroker.dispatch(batch)` mirrors `WorkersQueue.dispatch`'s discipline
  (exactly one `ack`/`retry`; `ack()` outside the handler `try`), with four routing outcomes:
  1. body is not a readable envelope → `retry()` + `logger.error` (a version skew or a foreign
     producer is a configuration problem, and the queue's own `max_retries`/DLQ is the right
     destination) — matching `WorkersQueue`;
  2. `kind: 'msg'` with **zero** subscribers → `ack()` + `logger.debug`;
  3. `kind: 'msg'` with subscribers, any handler throws → `retry()` + `logger.error`;
  4. `kind: 'rpc-req'` → §3.7.
- **Why:** (2) is the one place this deliberately departs from `WorkersQueue`, and the departure is
  the point: a job name with no processor is a mistake, but publishing to a topic nobody subscribes
  to is _ordinary pub/sub_. Retrying it would burn the 100-retry budget and dead-letter every
  fire-and-forget message the application ever sends.
- **Test home:** `test/unit/workers-broker-dispatch.test.ts` — one test per outcome, each asserting
  `ack`/`retry` call counts on a recording message fake, plus one asserting a throwing `ack` is not
  reported as a handler failure.

### 3.5 RPC correlation — a purpose-built manager, not the `messaging-plugin` core

- **Decision:** `src/messaging/request-correlation.ts` owns a `RequestCorrelation` class: a
  `Map<correlationId, { resolve, reject, timer }>`, `register(id, timeoutMs)`,
  `settle(replyEnvelope)`, and `rejectAll(reason)` called from `disconnect`. Timers come from
  `IRuntimeServices.setTimeout`/`clearTimeout`; the timeout default is `5000`, matching
  `RequestOptions`' documented default, overridable per arm via `rpc.defaultTimeoutMs`.
- **Why:** C1 — the shipped core is unreachable across the package boundary, and it is also the
  wrong shape here: it publishes replies through the broker's own `publish`, whereas this reply
  arrives pushed over a Durable Object socket that no `publish` call produced. A copy would have to
  be gutted to fit; a purpose-built 100-line manager is smaller and honest. Generation counting is
  carried over from the shipped core, because the bug it fixes (a `close()` landing while an inbox
  open is in flight) is transport-independent.
- **Test home:** `test/unit/request-correlation.test.ts` — resolve, remote-error reject, timeout
  reject, late reply after timeout is dropped, `rejectAll` clears every timer.

### 3.6 The RPC wire — a derived channel is unnecessary; the `kind` discriminant is the separation

- **Decision:** RPC requests ride the **same queue** as ordinary messages, separated by the
  envelope's `kind: 'rpc-req'` rather than by M14d's derived `rr.req.<topic>` channel. Reply
  envelopes never touch the queue at all.
- **Why:** M14d's derived channel exists because a request envelope published to `<topic>` leaked
  into plain `subscribe()` consumers of that topic. Here, routing is done by _this package's own
  dispatch_ reading `kind` before it consults the subscription table, so a plain subscriber
  structurally cannot observe a request and a responder cannot swallow a plain message. There is
  also no interop requirement to satisfy: no other broker in the repo speaks Cloudflare Queues, so
  the envelope is internal and nothing outside this package can be broken by its shape.
- **Test home:** `test/unit/workers-broker-dispatch.test.ts` — a `subscribe` handler on `orders`
  does NOT receive an `rpc-req` for `orders`, and a `respond` handler does not receive a plain
  publish.

### 3.7 The reply inbox — a Durable Object the caller holds a WebSocket to

- **Decision:** Opt-in `rpc: { binding, defaultTimeoutMs? }`. On the first `request()`, the broker
  opens a WebSocket to `namespace.get(idFromName('<inboxAddress>'))` where
  `inboxAddress = 'rr.inbox.' + runtime.uuid()`, and puts that address in the request envelope's
  `replyTo`. The responder side (running in a queue-consumer invocation, possibly in a **different**
  Worker binding the same namespace) computes the reply and `POST`s it to the same object via
  `stub.fetch`; `ReplyInboxObjectCore` broadcasts the body verbatim to every socket from
  `state.getWebSockets()`. Without the `rpc` arm, `request`/`respond` throw
  `CloudflareUnsupportedError` naming the arm and the binding to add.
- **Why:** A Worker isolate cannot hold an ambient inbox, but it _can_ hold a socket for the life of
  an awaited request, and Durable Objects have no wall-clock cap while the caller stays connected
  (§1). `POST`-to-deliver rather than a second socket keeps the responder side to one subrequest.
  The core holds **no membership in a field** — `acceptWebSocket` is the hibernation API, so the
  constructor may re-run — which is the M52d correctness requirement, not a simplification. Throwing
  without the arm rather than not registering `MESSAGING` follows this package's own
  `WorkersQueue.addRecurring` precedent (`workers-queue.ts:201-210`): a throw naming a concrete fix
  is honest, and four of six methods working with two configurable is not M52b's
  six-of-eight-with-no-alternative case.
- **Test home:** `test/unit/reply-inbox-object.test.ts` (upgrade accepted hibernatably; POST fans
  out to every socket; a **fresh core over the same state** still delivers, pinning
  hibernation-safety; non-upgrade non-POST → 426/405), `test/unit/reply-inbox.test.ts` (address
  shape, close unsubscribes), and `test/integration/rpc-round-trip.test.ts` (request → dispatch →
  reply → resolve, entirely through fakes wired to each other).

### 3.8 RPC latency is a configuration requirement, stated not implied

- **Decision:** PUBLIC_API and the package README require `max_batch_timeout = 0` (and recommend
  `max_batch_size = 1`) on any queue carrying RPC, and the CLI's generated `wrangler.toml` sets
  exactly that on the consumer stanza it emits.
- **Why:** The default `max_batch_timeout` is 5 s and `RequestOptions.timeoutMs` defaults to 5000,
  so on a default queue essentially every `request()` would time out — a configuration trap that
  would present as "RPC is broken". 0 is a documented legal value (§1).
- **Test home:** `test/unit/workers-arm.test.ts` in `packages/cli` asserts the emitted TOML contains
  the consumer stanza with `max_batch_timeout = 0`.

### 3.9 The CLI runtime swap — declarative data on the template

- **Decision:** New optional
  `TemplateDefinition.runtimeSwaps?: Readonly<Partial<Record<TargetRuntime, RuntimeSwap>>>` with
  `RuntimeSwap = { removePackages, addPlugins, workerExports?, wranglerToml? }`.
  `MICROSERVICE_TEMPLATE` gains a `cloudflare-workers` swap removing `messaging-plugin` and
  `queue-plugin`, adding `CloudflarePlugin` (with `workersArgs` carrying the `env` and both arms),
  declaring a `queue` worker export bound to `createMessagingHandler`, and appending the queue
  stanzas; its `unsupported['cloudflare-workers']` entry is deleted.
- **Why:** Data rather than a callback keeps `--dry-run` exact and makes the swap assertable without
  rendering a project. Removing by package name rather than index means a plugin added to
  `MICROSERVICE_ADDITIONS` later cannot silently shift the swap. The field is **optional**, so all
  four existing templates render byte-identically (a test pins that).
- **Test home:** `packages/cli/test/unit/runtime-swaps.test.ts` (swap applies on Workers only; the
  other three runtimes byte-identical; removing an absent package is an error, not a silent no-op)
  and the e2e in §6.

### 3.10 The Workers entry gains a `queue` export

- **Decision:** `workersEntry()` takes the resolved `WorkerExport[]` and renders one extra module
  export per entry, each reusing the existing memoised `boot(env)`:
  `async queue(batch, env) { booted ??= boot(env); const app = await booted; await createMessagingHandler(app)(batch); }`.
- **Why:** Cloudflare invokes a consumer through a module-level export; nothing in the kernel can
  express that, which is the same constraint `createQueueHandler`'s module JSDoc records. Reusing
  `boot` rather than starting a second app is required — two apps would mean two brokers and two
  dispatch tables, and the subscriptions registered on one would be invisible to the other.
- **Test home:** `packages/cli/test/e2e/workers-microservice.test.ts` — scaffold, repoint at this
  workspace, `deno check`, and assert the entry declares both exports.

### 3.11 Errors

- **Decision:** `CloudflareRequestTimeoutError` and `CloudflareRemoteHandlerError` are added to
  `src/errors.ts` and exported. `CloudflareUnsupportedError` is reused for the missing-`rpc`-arm
  refusal.
- **Why:** C3. The `Cloudflare*` prefix matches this package's three existing error classes and
  disambiguates in a monorepo where both packages are in scope.
- **Test home:** `test/unit/errors.test.ts` extension — each is an `Error` subclass with a `name`
  matching its class and a message naming the topic.

### 3.12 Health and lifecycle

- **Decision:** `createCloudflareIndicator` gains `messaging: boolean` and `rpc: boolean` detail
  fields. The plugin registers an `onShutdown` hook calling `broker.disconnect()` when the arm is
  present. **No binding I/O in the indicator**, matching M52's rule.
- **Why:** `disconnect()` closes the inbox socket and rejects in-flight requests; without the hook a
  shutdown leaves a live WebSocket to the Durable Object with nothing holding a reference — the
  defect M52d's `durableObject` arm already fixed the same way (`cloudflare-plugin.ts:184-186`).
- **Test home:** `test/integration/messaging-arm.test.ts` — `app.stop()` rejects a pending request
  and closes the socket fake.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                 | Kind       | Consumer / real code path that READS it                                                                                                          |
| ------------------------------- | ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `WorkersBroker`                 | class      | Constructed by `CloudflarePlugin`'s `messaging` arm; narrowed by `createMessagingHandler` via `instanceof` (the `createQueueHandler` precedent). |
| `WorkersBrokerOptions`          | type       | The constructor's third parameter; read by the plugin when building the broker.                                                                  |
| `createMessagingHandler`        | function   | The application's `queue` module export; emitted by the CLI Workers arm and by `apps/cloudflare/worker.ts`.                                      |
| `MessagingHandler`              | type       | The return type the application assigns to its `queue` export.                                                                                   |
| `MessagingHandlerOptions`       | type       | `{ name? }`, read by `createMessagingHandler` to pick the instance token.                                                                        |
| `ReplyInboxObjectCore`          | class      | Delegated to by the Durable Object class the **application** exports; `apps/cloudflare` exports one.                                             |
| `ReplyInboxObjectCoreOptions`   | type       | `{ createPair? }` — the injectable `DurableObjectWebSocketHost` seam, read by the core's constructor and by its unit test.                       |
| `WorkersMessagingArm`           | type       | `CloudflarePluginOptions.messaging`; read by the plugin's arm resolution.                                                                        |
| `WorkersMessagingRpcArm`        | type       | `WorkersMessagingArm.rpc`; read by the broker when opening an inbox.                                                                             |
| `CloudflareRequestTimeoutError` | class      | Thrown by `RequestCorrelation` on timeout; caught by application code via `instanceof` (C3).                                                     |
| `CloudflareRemoteHandlerError`  | class      | Thrown when a reply carries `ok: false`; same consumer.                                                                                          |
| `isQueueProducer`               | function   | Called by `BindingRegistry.queue()`; exported to match the four shipped guards, which the barrel already exports.                                |
| `RuntimeSwap` / `WorkerExport`  | type (CLI) | Read by `project-files.ts` when rendering plugins, the Workers entry, and `wrangler.toml`; declared by `MICROSERVICE_TEMPLATE`.                  |

**Not exported, deliberately:** `MessageEnvelope` and its guards, `SubscriptionTable`,
`RequestCorrelation`, `DurableObjectReplyInbox`, `deliverReply`. Each has exactly one in-package
caller and no application ever names one; exporting them would be surface with no consumer beyond
its own test.

### 4.1 Options — every option names its consumer

| Option                           | Consumer                                      | Behavior (per implementation)                                                                                                                                         |
| -------------------------------- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messaging.binding`              | `registry.queue(binding)` in `register()`     | Names the Queues producer binding. Absent or wrong-shaped → `CloudflareBindingMissingError` at `register()` (C4).                                                     |
| `messaging.name`                 | `instanceToken(CAPABILITIES.MESSAGING, name)` | `'default'`/omitted claims bare `messaging`; anything else derives `messaging.<name>`, which `MessagingHandlerOptions.name` must then match.                          |
| `messaging.rpc.binding`          | `registry.durableObject(binding)`             | Names the DO namespace serving reply inboxes. Its absence is what makes `request`/`respond` throw; present and wrong-shaped → `CloudflareBindingMissingError`.        |
| `messaging.rpc.defaultTimeoutMs` | `RequestCorrelation.register`                 | Reply budget when `RequestOptions.timeoutMs` is omitted. Defaults to `5000`, the value `RequestOptions` documents.                                                    |
| `WorkersBrokerOptions.logger`    | `dispatch`'s four report paths                | A **thunk**, not an `ILogger` — the M52b `WorkersQueueOptions.logger` defect: capturing `ctx.logger` at `register()` silences a logger registered imperatively later. |
| `RuntimeSwap.removePackages`     | `resolveHost` in `project-files.ts`           | Package names dropped from `plugins` on that runtime. A name not present throws at CLI build time (a template defect, caught by a unit test, never by a user).        |
| `RuntimeSwap.addPlugins`         | same                                          | Wirings appended after removal.                                                                                                                                       |
| `RuntimeSwap.workerExports`      | `workersEntry()`                              | Extra module exports rendered beside `fetch`, each reusing the memoised `boot(env)`.                                                                                  |
| `RuntimeSwap.wranglerToml`       | the `wrangler.toml` renderer                  | TOML appended verbatim, carrying the producer and consumer stanzas plus `max_batch_timeout = 0` (§3.8).                                                               |

## 5. Implementation files

| File                                                                   | Purpose                                                                               |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `packages/cloudflare-plugin/src/index.ts`                              | Barrel: the 13 symbols in §4.                                                         |
| `packages/cloudflare-plugin/src/options.ts`                            | `WorkersMessagingArm`, `WorkersMessagingRpcArm`, `CloudflarePluginOptions.messaging`. |
| `packages/cloudflare-plugin/src/errors.ts`                             | `CloudflareRequestTimeoutError`, `CloudflareRemoteHandlerError`.                      |
| `packages/cloudflare-plugin/src/bindings/facades.ts`                   | `isQueueProducer`.                                                                    |
| `packages/cloudflare-plugin/src/bindings/binding-registry.ts`          | `queue()` validates through it (C4).                                                  |
| `packages/cloudflare-plugin/src/messaging/message-envelope.ts`         | The queue wire union, encoders, and three guards.                                     |
| `packages/cloudflare-plugin/src/messaging/subscription-table.ts`       | Fan-out + per-group round-robin selection (§3.3).                                     |
| `packages/cloudflare-plugin/src/messaging/request-correlation.ts`      | Pending-request map, timeouts, generation (§3.5).                                     |
| `packages/cloudflare-plugin/src/messaging/reply-inbox.ts`              | Replica-side `DurableObjectReplyInbox`: open socket, `address`, `close`.              |
| `packages/cloudflare-plugin/src/messaging/reply-delivery.ts`           | Responder-side `deliverReply(namespace, replyTo, envelope)` over `stub.fetch`.        |
| `packages/cloudflare-plugin/src/messaging/workers-broker.ts`           | `WorkersBroker implements IMessageBroker` + `dispatch(batch)`.                        |
| `packages/cloudflare-plugin/src/messaging/messaging-handler.ts`        | `createMessagingHandler`.                                                             |
| `packages/cloudflare-plugin/src/durable-objects/reply-inbox-object.ts` | `ReplyInboxObjectCore` (upgrade + POST-deliver).                                      |
| `packages/cloudflare-plugin/src/plugin/cloudflare-plugin.ts`           | The `messaging` arm: token, `provides`, construction, `onShutdown`.                   |
| `packages/cloudflare-plugin/src/health/indicator.ts`                   | `messaging` / `rpc` detail fields.                                                    |
| `packages/cli/src/templates/registry.ts`                               | `RuntimeSwap`, `WorkerExport`, `TemplateDefinition.runtimeSwaps`.                     |
| `packages/cli/src/templates/microservice.ts`                           | The `cloudflare-workers` swap; `unsupported` entry deleted.                           |
| `packages/cli/src/templates/project-files.ts`                          | Swap application, `workersEntry(exports)`, `wrangler.toml` append.                    |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                            | src covered                                           | Key assertions (and the signature each call type-checks against)                                                                                                                                                                          |
| ---------------------------------------------------- | ----------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/message-envelope.test.ts`                 | `messaging/message-envelope.ts`                       | `encodeMessageEnvelope('t', 'id', {a:1})` round-trips; each guard rejects `null`, a non-object, a wrong `kind`, a wrong `v`, and a missing `topic`.                                                                                       |
| `test/unit/subscription-table.test.ts`               | `messaging/subscription-table.ts`                     | Two queue-less subscribers both selected; two in one group yield one, alternating across deliveries; a group plus a queue-less subscriber yield both; `remove` drops exactly one.                                                         |
| `test/unit/request-correlation.test.ts`              | `messaging/request-correlation.ts`                    | Resolve; `ok:false` → `CloudflareRemoteHandlerError`; timeout → `CloudflareRequestTimeoutError` (driven by an inert `IRuntimeServices` timer fake, never real time); a reply after timeout is dropped; `rejectAll` clears timers.         |
| `test/unit/reply-inbox.test.ts`                      | `messaging/reply-inbox.ts`                            | Address matches `rr.inbox.<uuid>`; `asUpgradeResponse` failure propagates as `CloudflareUnsupportedError`; `close()` closes the socket once and is idempotent.                                                                            |
| `test/unit/reply-delivery.test.ts`                   | `messaging/reply-delivery.ts`                         | `stub.fetch` receives a POST whose JSON body is the reply envelope; a non-2xx is reported through the logger thunk and does not throw (the responder must still ack).                                                                     |
| `test/unit/workers-broker-publish.test.ts`           | `messaging/workers-broker.ts` (produce half)          | `publish` hands the recording producer exactly the encoded envelope; `subscribe`/`unsubscribe` mutate the table; `request` without the `rpc` arm throws `CloudflareUnsupportedError` naming `rpc.binding`; same for `respond`.            |
| `test/unit/workers-broker-dispatch.test.ts`          | `messaging/workers-broker.ts` (consume half)          | The four §3.4 outcomes, each asserting `ack`/`retry` counts; §3.6's two isolation assertions; a throwing `ack` is not reported as a handler failure; an `rpc-req` with no responder sends an error reply and acks.                        |
| `test/unit/reply-inbox-object.test.ts`               | `durable-objects/reply-inbox-object.ts`               | Upgrade → 101 carrying a client socket, accepted via `acceptWebSocket`; POST fans out verbatim to every socket; **a fresh core over the same state still delivers** (hibernation); GET non-upgrade → 426; PUT → 405.                      |
| `test/unit/messaging-handler.test.ts`                | `messaging/messaging-handler.ts`                      | Resolves lazily per invocation; a non-`WorkersBroker` under the token rejects (not throws synchronously) with `CloudflareUnsupportedError`; a named instance resolves `messaging.<name>`.                                                 |
| `test/unit/binding-guards.test.ts` (extend)          | `bindings/facades.ts`, `bindings/binding-registry.ts` | `isQueueProducer` accepts `{send, sendBatch}` and rejects a KV-shaped object; `registry.queue()` on a wrong-shaped binding throws `CloudflareBindingMissingError.wrongShape`.                                                             |
| `test/unit/errors.test.ts` (extend)                  | `errors.ts`                                           | Both new classes: `instanceof Error`, `name`, message naming the topic.                                                                                                                                                                   |
| `test/unit/health-indicator.test.ts` (extend)        | `health/indicator.ts`                                 | `messaging`/`rpc` detail fields present and correct for arm-present and arm-absent.                                                                                                                                                       |
| `test/integration/messaging-arm.test.ts`             | `plugin/cloudflare-plugin.ts`                         | Real `createApplication` + `RuntimePlugin`; the arm registers under the bare and named tokens; `provides` includes it; a missing binding throws at `register()`; `app.stop()` rejects a pending request and closes the socket.            |
| `test/integration/rpc-round-trip.test.ts`            | the RPC path end to end (fakes wired to each other)   | A producer fake feeds `dispatch`, a DO namespace fake routes `deliverReply` into the inbox core, and the core pushes to the caller's socket fake: `await broker.request('sum', 2)` resolves to the responder's value.                     |
| `packages/cli/test/unit/runtime-swaps.test.ts`       | `templates/registry.ts`, swap application             | Swap applies only on `cloudflare-workers`; the three other runtimes render byte-identically to before this field; `removePackages` naming an absent package throws.                                                                       |
| `packages/cli/test/unit/workers-arm.test.ts`         | `templates/project-files.ts`                          | The emitted `wrangler.toml` carries producer + consumer stanzas with `max_batch_timeout = 0`; `src/index.ts` declares `fetch` and `queue`; `setu.config.ts` registers `CloudflarePlugin` and neither `MessagingPlugin` nor `QueuePlugin`. |
| `packages/cli/test/e2e/workers-microservice.test.ts` | the whole CLI path                                    | `setu new x --template microservice --runtime cloudflare-workers` is **accepted**; the project is repointed at this workspace and `deno check`s clean over every emitted file.                                                            |

**Guarded real-path test.** There is no npm dependency to load here, so §12.2's guarded-real-import
rule maps instead onto the platform: `apps/cloudflare` gains messaging coverage in its existing
`wrangler dev` harness (§7), which is the only place the real `env` binding, a real `MessageBatch`,
a real `WebSocketPair` and a real Durable Object stub are exercised.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m59-workers-native-messaging, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:apps        # apps/cloudflare drives the new surface through real workerd
git commit … && deno task publish:check && deno task release:verify 0.1.0-alpha.5
```

**Real-workerd bar (M52b/M52d precedent).** `apps/cloudflare` exports a `ReplyInboxObject` Durable
Object class and a `queue` handler, and its `smoke.ts` drives, against `wrangler dev`: a `publish`
observed arriving at a `subscribe` handler in a real consumer invocation; a message for an
unsubscribed topic acked rather than redelivered; and a full `request`/`respond` round trip whose
reply travels through a real Durable Object. Each check is verified to **discriminate** by breaking
the thing it tests and observing the failure. CI holds no Cloudflare account, so no live-deployment
claim is made or implied.

## 8. Risks & mitigations

- **Queue latency makes RPC time out in practice.** → §3.8 makes `max_batch_timeout = 0` a
  documented requirement and the CLI emits it; the workerd round trip measures the real elapsed time
  and the plan's bar is that it completes inside the default 5 s budget.
- **A hibernation-blind reply inbox passes every non-hibernating test.** M52d's most likely
  green-shipping failure, repeated here verbatim. → `ReplyInboxObjectCore` holds no field state and
  its test constructs a **fresh core over the same state** before delivering.
- **A contract-violating fake hides a real defect** (the M37b ioredis, M53 `zrangebyscore` and M55
  `Deno.FsFile.read` class). → Every fake in this milestone is cross-checked against the facade it
  stands for: the producer fake's `send` resolves `void`, the message fake's `attempts` starts at 1,
  and the socket fake requires `accept()` before `send` succeeds.
- **The CLI swap type-checks while emitting a broken string.** `Wiring.args`/`workersArgs` are
  rendered strings, invisible to the CLI's own `deno check` (the M50b trap). → The e2e in §6
  type-checks the _generated_ project, and is proven to discriminate by breaking the arm's option
  key and watching it fail.
- **Removing `unsupported['cloudflare-workers']` regresses a refusal users rely on.** → The swap is
  additive per runtime and the three other runtimes are pinned byte-identical; the refusal is
  replaced by a working composition, not silently dropped.

## 9. Out of scope

- **Cross-service pub/sub fan-out.** One active consumer per queue is a platform property (§1). A
  topology needing fan-out binds one queue per consumer; modelling that needs a multi-binding arm,
  which no milestone owns yet.
- **Pull (HTTP) queue consumers.** A different consumer type with its own ack protocol; nothing in
  the repo consumes one. Unowned.
- **A `messaging` arm on `microservice-starter`.** M50b's boundary — the CLI emits inline wiring and
  never imports a starter. Unowned.
- **Docker/Kubernetes objects for a Workers deployment.** M39.
- **Retiring `cloud-gate.ts`'s Pub/Sub and Service Bus refusals.** Those SDKs still need gRPC and
  AMQP; this milestone adds a native broker rather than unblocking them. M54 owns that file.
