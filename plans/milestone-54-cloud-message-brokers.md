# Milestone 54 — Cloud Message Brokers (`@hono-enterprise/messaging-plugin` + `@hono-enterprise/queue-plugin`)

> **Status:** Planning. Branch: `feat/m54-cloud-message-brokers`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

The framework can serve on exactly one cloud's bus — Cloudflare Queues (M52b) — and reach none of the
three hyperscalers' own message buses. `MessagingBrokerType` is a closed switch
(`'memory' | 'redis-streams' | 'rabbitmq' | 'nats' | 'kafka'`) whose factory throws on anything else,
with no `'custom'` arm and no way to inject a broker instance, so an application on AWS, GCP, or Azure
cannot use its platform's bus through the committed `IMessageBroker` at all. M54 closes that gap with
the prerequisite extension point plus the three clouds' backends, split by what each cloud's bus
actually *is*: SQS is a queue (→ `IQueue`, the M52b precedent), while GCP Pub/Sub and Azure Service Bus
are topic/subscription pub/sub (→ `IMessageBroker`); AWS fan-out is the SNS→SQS pair, not one object.

- **In scope:**
  - A `'custom'` arm on `MessagingPluginOptions`, with the option type becoming a **discriminated
    union on `broker`** (the M30 `ChannelConfig` / M50 / M52c precedent) so a missing per-arm
    credential is a compile error rather than a startup throw.
  - GCP Pub/Sub and Azure Service Bus brokers implementing `IMessageBroker` (incl. the required
    `request`/`respond`) in `packages/messaging-plugin`.
  - An SQS adapter implementing the internal `QueueAdapter` seam (→ `IQueue` via `QueueService`) in
    `packages/queue-plugin`, plus an `SnsPublisher` for SNS→SQS fan-out.
  - A per-backend `openInbox` decision for request-reply on each new `IMessageBroker` backend, or an
    explicit documented refusal — the way Kafka did in M14d.
  - Inject-or-lazy cloud SDKs (`npm:` specifiers) with one injectable structural client facade per
    backend, one guarded real-import test per backend, and the branching around each lazy import
    unit-tested through the facade.
  - Runtime gating: each cloud backend throws a named, clear error on Cloudflare Workers (none of the
    three SDKs is Workers-portable — gRPC/long-poll, not `fetch`).
- **NOT this milestone:**
  - Live-cloud verification in CI — credentials cannot be exposed to fork PRs. Verification is
    fake-driven (recording client facades) plus guarded real-import tests that skip when the SDK is
    absent, stated plainly the way M52's "not verified against a live Worker" is. **Owned here.**
  - Kinesis, EventBridge, Azure Event Hubs — streaming, not brokered messaging. **Deferred
    indefinitely** (no owning milestone; out of the messaging/queue contracts).
  - Making `QueuePluginOptions` a full discriminated union. Only `MessagingPluginOptions` is mandated
    to become a union; SQS is added as an additive `'sqs'` adapter arm with a dedicated options bag.
    **Owned here (deliberate non-decision).**

## 1. Contracts verified from SOURCE (not names)

| Reference | Source (file:line) | Verified surface / fact |
| --- | --- | --- |
| `IMessageBroker` | `packages/common/src/services/messaging.ts:98` | `connect`/`disconnect`/`publish<T>`/`subscribe<T>`/`request<TReq,TRes>`/`respond<TReq,TRes>`. `request` and `respond` are **REQUIRED members** (not optional) — every broker, including the two new ones, must implement them. `SubscribeOptions.queue?` is the load-balance group. |
| `IQueue` | `packages/common/src/services/queue.ts:79` | `add<T>(name,data,opts): Promise<string>` / `process<T>(name,processor,opts): void` / `addRecurring<T>(name,data,opts): Promise<void>`. `AddJobOptions.{delayMs?,maxAttempts?}`, `ProcessOptions.concurrency?`, `RecurringOptions.cron`. |
| `MessageBrokerAdapter` (internal) | `packages/messaging-plugin/src/brokers/message-broker.ts:11` | `extends IMessageBroker` and adds `isReady(): boolean`. Intentionally **not** barrel-exported; the health indicator reads it. |
| `MessagingBrokerType` (closed switch) | `packages/messaging-plugin/src/interfaces/index.ts:88` | `'memory' \| 'redis-streams' \| 'rabbitmq' \| 'nats' \| 'kafka'` — no `'custom'`, no cloud arms. Widened here to add `'pubsub' \| 'service-bus'`. |
| `MessagingPluginOptions` (flat) | `packages/messaging-plugin/src/interfaces/index.ts:95` | A flat interface: `broker?`, `name?`, `serializer?`, `url?`, `client?` (closed union of 4 client types), `defaultQueue?`, `pollIntervalMs?`, `blockSizeMs?`, `exchangeName?`, `streamName?`, `brokers?`, `clientId?`, `replyTopic?`. Becomes a discriminated union here. |
| `MessagingPlugin` factory (closed switch) | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:74` | `options = {}`; `brokerType = options.broker ?? 'memory'`; one big `if/else if` building each broker; `throw new Error('Unknown broker type')` at `:145`; `await broker.connect()` then `ctx.services.register<IMessageBroker>(token, broker)`; health indicator reports `{ broker: brokerType }`; `onClose` → `disconnect`. Multi-instance via `name` → token `messaging.<name>` (`createCapabilityToken`, `:30`). |
| `OpenInbox` / `ReplyInbox` seam | `packages/messaging-plugin/src/brokers/inbox.ts:47` / `:28` | `OpenInbox = (onReply) => Promise<ReplyInbox>`; `ReplyInbox.{address, close()}`. `createTopicInbox({subscribe,uuid})` (`:84`) mints a fresh `rr.inbox.<uuid>` topic per call — for brokers whose topics are cheap and per-instance-addressable. |
| `RequestReplyDeps.openInbox` (required) | `packages/messaging-plugin/src/brokers/request-reply-core.ts:68` | `RequestReplyCore` needs `publish`/`subscribe`/`uuid`/`setTimeout`/`clearTimeout`/`openInbox`. RPC rides `rr.req.<topic>` (`:40`), disjoint from plain pub/sub. A broker gains RPC by delegating `request`/`respond` here and supplying its own `openInbox`. |
| `KafkaBroker` custom-openInbox + inject-or-lazy precedent | `packages/messaging-plugin/src/brokers/kafka-broker.ts:32` | `loadKafkajs()` = `await import('npm:kafkajs@2.x')`; `validateClient` (`:43`); `resolveClient(brokers,clientId,injected?)` inject-or-lazy (`:65`); supplies its OWN `OpenInbox` over a shared reply topic + per-instance consumer group `rr-inbox-<uuid>` instead of `createTopicInbox`. This is the per-backend openInbox decision the new backends owe. |
| Guarded real-import test pattern | `packages/messaging-plugin/test/unit/redis-real-import.test.ts:16` | Guard on env var + `try { await import('npm:ioredis@5.x') }`; SKIP-log if absent; construct the broker with NO injected client so the production load path runs; assert a real round trip. Each new backend ships one of these. |
| `QueueAdapter` (internal seam) | `packages/queue-plugin/src/adapters/queue-adapter.ts:20` | `connect`/`disconnect`/`isReady`/`enqueue<T>(job)`/`reserve<T>(name,limit,nowMs)`/`ack`/`requeue(name,id,availableAtMs,attempts)`/`deadLetter(name,id,nowMs)`/`storeRecurring`/`fetchRecurringDue`/`advanceRecurring`. Claim-based: `reserve` claims, `ack`/`requeue`/`deadLetter` settle. Intentionally **not** barrel-exported. |
| `QueuePlugin` factory (switch) | `packages/queue-plugin/src/plugin/queue-plugin.ts:45` | `adapter = options?.adapter ?? 'memory'`; `switch` over memory/redis/rabbitmq; wraps adapter in `QueueService` (retry/backoff/cron/poll); `service.connect()`; `ctx.services.register<IQueue>(token, service)`; health via `service.createHealthIndicator()`; `onClose` → `disconnect`. Multi-instance via `name` → `queue.<name>`. Default branch `throw new Error('Unknown queue adapter')` (`:87`). |
| `RabbitMqQueue` inject-or-lazy + in-memory recurring precedent | `packages/queue-plugin/src/adapters/rabbitmq-queue.ts:31` | `loadAmqplib()` = `import('npm:amqplib@0.10.x')`; `validateClient` (`:43`); `resolveClient(url,injected?)` (`:64`); implements `QueueAdapter` with poll-based `basicGet`, per-message TTL+DLX for delay/requeue, **in-memory recurring** (non-durable, matching `MemoryQueue`), per-name `he.queue.<n>.ready/.delay/.dead` topology. SQS mirrors this pattern (poll `ReceiveMessage`, `ChangeMessageVisibility` backoff, in-memory recurring, explicit dead-letter). |
| `QueuePluginOptions` (flat) | `packages/queue-plugin/src/interfaces/index.ts:136` | `adapter?: QueueAdapterType`, `name?`, `url?`, `client?: IRedisQueueClient \| IAmqpQueueConnection` (closed union), `defaultMaxAttempts?`, `pollIntervalMs?`, `prefix?`. Adds an `'sqs'` adapter + `sqs?: SqsQueueOptions` bag here. |
| `WorkersQueue` direct-`IQueue` precedent (NOT followed for SQS) | `packages/cloudflare-plugin/src/queues/workers-queue.ts:122` | Implements `IQueue` directly (not `QueueAdapter`) because Cloudflare Queues are **push**-based (a `queue()` handler drives dispatch), so `QueueService`'s poll loop cannot drive them; `addRecurring` throws (`:202`). SQS is **poll**-based (`ReceiveMessage`), so SQS uses the `QueueAdapter`+`QueueService` path like `RabbitMqQueue`, NOT the direct-`IQueue` path. Cited to prevent re-deriving the wrong precedent. |
| Capability-token grammar | `packages/common/src/tokens.ts` (`createCapabilityToken`) | Lowercase kebab + dot namespacing; colons illegal. `messaging.<name>` and `queue.<name>` already follow it. **No new token** this milestone — `CAPABILITIES.MESSAGING` and `CAPABILITIES.QUEUE` are reused; multi-instance keeps the `.<name>` derivation. |
| Per-package test net grants (M53 lesson) | `packages/messaging-plugin/deno.json:11`, `packages/queue-plugin/deno.json:11` | `test.permissions.net` is endpoint-scoped to the Redis loopback. A CLI/manifest `net` list **replaces** the package block, so any new grant lives in each package's own manifest, scoped to the cloud endpoints the guarded tests actually hit — NOT a loopback-wide or root-level grant (M53: ioredis retries forever on `ECONNREFUSED`). |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| # | Conflict | Resolution (picked side) | Doc deliverable (same PR) |
| -- | --- | --- | --- |
| C1 | `PUBLIC_API.md:2702` documents `MessagingPluginOptions` as a **flat** interface; ROADMAP M54 mandates a **discriminated union on `broker`** with a `'custom'` arm. | Pick the union (ROADMAP side). It is a source-shaping, pre-1.0 **breaking** change to a published option type, recorded in CHANGELOG. Common call shapes (`MessagingPlugin({ broker: 'redis-streams', url })`) stay valid because each option sits on its own arm. | Rewrite the `MessagingPluginOptions` block + the messaging Exports table in `PUBLIC_API.md`; add a CHANGELOG BREAKING entry. |
| C2 | `ARCHITECTURE.md:1257`/`:1259` messaging "Responsibilities"/"Public API" list **only** in-memory + Redis Streams brokers, omitting RabbitMQ/NATS/Kafka (already shipped in M14b/M14c) and now Pub/Sub + Service Bus. | Pick the full, current broker set. | Update the messaging-plugin ARCHITECTURE row to name all seven brokers + the `'custom'` arm + the error classes. |
| C3 | `PUBLIC_API.md:2824` + `ARCHITECTURE.md` carry the M14c note that `request`/`respond` are broker-capability-dependent; source (`messaging.ts:98`) makes them **required** on every `IMessageBroker`, and all five existing brokers implement them. | Pick SOURCE: `request`/`respond` are mandatory; the two new brokers implement them too (§3.7). | Clarify the request-reply note in `PUBLIC_API.md` to state every backend implements RPC; remove any "depends on broker" hedge. |
| C4 | `PUBLIC_API.md:2932`/`:2933` + `ARCHITECTURE.md:1271` queue surface is `'memory' \| 'redis' \| 'rabbitmq'` with no SQS/SNS. | Pick the widened set: add `'sqs'` + `SqsQueue` + `SnsPublisher`. | Update the queue Exports table + ARCHITECTURE queue row to add SQS + SNS + the new option types. |
| C5 | `ROADMAP.md:5744` packages line says "plus `packages/queue-plugin` for SQS" but does not name where SNS lives. | Pick: SNS lives in `packages/queue-plugin` alongside SQS (the SNS→SQS pair is one cloud's queue story; `queue-plugin` already pairs the producer/consumer halves). `messaging-plugin` holds only the two `IMessageBroker` backends. | Add the SNS placement note to the M54 ROADMAP section; flip its deliverable checkboxes + the Progress row on merge. |

## 3. Design decisions

### 3.1 `MessagingPluginOptions` → discriminated union on `broker` + `'custom'` arm

- **Decision:** `MessagingPluginOptions` becomes a discriminated union keyed on `broker`. `name?` and
  `serializer?` are shared across arms (a `MessagingCommonOptions` base); every other option lives only
  on the arm that consumes it. The union adds arms `{ broker: 'pubsub' }`, `{ broker: 'service-bus' }`,
  and `{ broker: 'custom'; instance: IMessageBroker }`. `MessagingBrokerType` widens to include
  `'pubsub' | 'service-bus'` (the `'custom'` arm is handled by the union, not by the literal type). The
  `client?` field per arm is typed to **that arm's** facade (not the old closed union of four).
- **Why:** a missing per-arm credential becomes a compile error (M30/M50/M52c precedent), and the
  `'custom'` arm finally lets an application inject any `IMessageBroker` — the extension point the four
  peer plugins (`feature-flags`, `database`, `realtime-backplane`, `service-discovery`) already ship.
  The `instance: IMessageBroker` (the public common port) is taken rather than the internal
  `MessageBrokerAdapter`, so the public surface never depends on an internal type.
- **Test home:** `test/unit/messaging-plugin.test.ts` — a per-arm selection test (each `broker` value
  builds the right class and registers it) plus a compile-shape assertion that `{ broker: 'pubsub' }`
  without `projectId`/`client` is a type error (asserted by a fixture that is `deno check`-ed).

### 3.2 GCP Pub/Sub broker (`GcpPubSubBroker`, `IMessageBroker`)

- **Decision:** `GcpPubSubBroker implements MessageBrokerAdapter` in
  `packages/messaging-plugin/src/brokers/pubsub-broker.ts`. SDK is inject-or-lazy
  `npm:@google-cloud/pubsub@4.x` behind an exported structural facade `IPubSubClient` (the minimal
  shape: `topic(name)`, `subscription(name)`, `createTopic?`, `close`) — inject a real `PubSub`, or
  lazy-load, or inject a fake. `publish` → `topic.publishMessage`; `subscribe` → ensure a subscription
  on the topic (created if absent, named from `options.queue` or a per-subscriber id) and pump its
  message stream into the handler, ack/nack on the platform message. `connect`/`disconnect` own the
  client lifecycle. Implements the mandatory `request`/`respond` by delegating to `RequestReplyCore`
  (§3.7).
- **Why:** Pub/Sub maps cleanly onto `IMessageBroker` (topics + subscriptions); §12.2 inject-or-lazy
  keeps the heavy SDK out of the dependency graph and testable without a project; the facade mirrors
  `IKafkaFactory`/`IAmqpConnection`.
- **Test home:** `test/unit/pubsub-broker.test.ts` (recording `IPubSubClient` fake: publish→subscribe
  round trip, ack-on-success / nack-on-failure, subscription creation, `request`/`respond` round trip)
  + `test/unit/pubsub-real-import.test.ts` (guarded: skip when `@google-cloud/pubsub` absent).

### 3.3 Azure Service Bus broker (`ServiceBusBroker`, `IMessageBroker`)

- **Decision:** `ServiceBusBroker implements MessageBrokerAdapter` in
  `packages/messaging-plugin/src/brokers/service-bus-broker.ts`. SDK is inject-or-lazy
  `npm:@azure/service-bus@7.x` behind an exported structural facade `IServiceBusClient`
  (`createSender(topic)`, `createReceiver(topic, {subscription})`, `close`). `publish` →
  `sender.sendMessages`; `subscribe` → a receiver on the topic's subscription pumping messages into the
  handler with `completeMessage`/`abandonMessage`. `request`/`respond` delegate to `RequestReplyCore`
  (§3.7).
- **Why:** Service Bus maps cleanly onto `IMessageBroker` (topics + subscriptions); same inject-or-lazy
  + facade rationale as §3.2.
- **Test home:** `test/unit/service-bus-broker.test.ts` (recording `IServiceBusClient` fake: round
  trip, complete/abandon, `request`/`respond`) + `test/unit/service-bus-real-import.test.ts`
  (guarded).

### 3.4 SQS adapter (`SqsQueue`, `IQueue` via the internal `QueueAdapter` seam)

- **Decision:** `SqsQueue implements QueueAdapter` (the **internal** seam, not a direct `IQueue`) in
  `packages/queue-plugin/src/adapters/sqs-queue.ts`, selected via
  `QueuePlugin({ adapter: 'sqs', sqs: { ... } })` and wrapped by `QueueService` — **mirroring
  `RabbitMqQueue` (M15b), NOT `WorkersQueue` (M52b)**, because SQS is poll-based and fits the
  claim/reserve model. SDK is inject-or-lazy `npm:@aws-sdk/client-sqs@3.x` behind a structural facade
  `ISqsClient` (`sendMessage`, `receiveMessage`, `deleteMessage`, `changeMessageVisibility`, `close`).
  Mapping: `enqueue` → `SendMessage` (DelaySeconds from `delayMs`); `reserve` → `ReceiveMessage`
  (VisibilityTimeout as the claim); `ack` → `DeleteMessage`; `requeue` → `ChangeMessageVisibility`
  (backoff seconds); `deadLetter` → `DeleteMessage` of the source + `SendMessage` to a configured
  dead-letter queue URL (`sqs.deadLetterQueueUrl`); `storeRecurring`/`fetchRecurringDue`/
  `advanceRecurring` are **in-memory** (the `RabbitMqQueue` precedent — non-durable, matching
  `MemoryQueue`). `SqsQueue` is also exported standalone (app-constructable) like `RabbitMqQueue`.
- **Why:** reuses `QueueService`'s backend-agnostic retry/backoff/cron/poll/health machinery; the
  claim-based seam matches SQS's receive→complete/abandon model; in-memory recurring is the established
  non-durable behavior. (`WorkersQueue` is direct-`IQueue` only because Cloudflare Queues are
  push-based — that reason does not apply to SQS.)
- **Test home:** `test/unit/sqs-queue.test.ts` (recording `ISqsClient` fake: enqueue→reserve→ack,
  requeue backoff visibility, dead-letter to DLQ, in-memory recurring due/advance, `delayMs`→seconds)
  + `test/unit/sqs-real-import.test.ts` (guarded: skip when `@aws-sdk/client-sqs` absent).

### 3.5 SNS→SQS fan-out (`SnsPublisher`)

- **Decision:** `SnsPublisher` is an exported, app-constructed helper class in
  `packages/queue-plugin/src/sns/sns-publisher.ts` that publishes a message to an SNS topic, behind a
  structural facade `ISnsClient` (`publish`, `createTopic?`, `close`) with inject-or-lazy
  `npm:@aws-sdk/client-sns@3.x`. Fan-out is AWS-side: the application subscribes one or more SQS queues
  to the topic (infra), each consumed by its own `SqsQueue`. **`SnsPublisher` is NOT an
  `IMessageBroker`** — SNS publish has no in-process `subscribe` (consumption is SQS = `IQueue`), so the
  AWS pub/sub story is the documented SNS+SQS *pair*, not one composite broker.
- **Why:** matches the ROADMAP's "SQS fits `IQueue`, AWS pub/sub is the SNS→SQS pair, so it is two
  adapters"; avoids inventing a composite `IMessageBroker` the contract and ROADMAP do not call for.
- **Test home:** `test/unit/sns-publisher.test.ts` (recording `ISnsClient` fake: publish payload
  shape, topic resolution) + the guarded real-import coverage folded into `sqs-real-import.test.ts`
  (shared AWS-SDK-availability guard).

### 3.6 Runtime gating — non-Workers-portable SDKs

- **Decision:** each cloud backend checks `runtime.platform() === 'cloudflare-workers'` at the start of
  `connect()` and throws a **named, clear error** before any SDK load attempt. Messaging throws the
  newly-exported `CloudBrokerUnavailableError` (`packages/messaging-plugin/src/errors.ts`) naming the
  backend and the SDK specifier and stating the backend is not Workers-portable; `SqsQueue.connect()`
  throws a plain `Error` with the same shape. This is fail-fast at `app.start()` (brokers connect
  eagerly during `register()`), not a silent no-op — the CLAUDE.md "a lazily-loaded dep must actually
  load" / no-silent-no-op rules forbid a no-op shim that swallows the misconfiguration.
- **Why:** none of the three SDKs runs on Workers (gRPC / HTTP-long-poll, not `fetch`); a throw at
  connect() surfaces the configuration error at the earliest point, the M45 `WorkerPoolUnavailableError`
  pattern (register, throw when the platform cannot support it). A documented throw is chosen over the
  ROADMAP's "no-op or throw" because a silent no-op would publish into a void.
- **Test home:** `test/unit/pubsub-broker.test.ts`, `test/unit/service-bus-broker.test.ts`, and
  `test/unit/sqs-queue.test.ts` each assert `connect()` rejects with the named/message error when given
  a fake runtime whose `platform()` returns `'cloudflare-workers'`.

### 3.7 Per-backend `openInbox` decision for request-reply

- **Decision:** both `GcpPubSubBroker` and `ServiceBusBroker` delegate `request`/`respond` to the
  shared `RequestReplyCore` and supply a **transport-specific `OpenInbox`** (not the generic
  `createTopicInbox`): each lazily opens ONE per-instance reply resource — a Pub/Sub **subscription**
  (GCP) / a Service Bus **subscription** (Azure) on a reply topic — whose address travels as the
  request envelope's `replyTo`, and `close()` deletes that subscription on `disconnect()`. Service
  Bus's native `ReplyTo`/`SessionId`/`CorrelationId` is **deliberately NOT used**; RPC rides the shared
  `rr.req.<topic>` channel and the same in-envelope correlation as the other five brokers, so a plain
  `subscribe()` consumer never sees a request envelope and a responder never swallows a subscriber's
  message (the M14d property).
- **Why:** `request`/`respond` are required on `IMessageBroker`, so every backend owes an inbox; the
  transport-specific inbox (rather than `createTopicInbox`) is required because a Pub/Sub / Service Bus
  "subscription" is a durable resource that must be created and torn down, and the inbox address is a
  subscription name, not a bare topic. Declining Service Bus native reply keeps one RPC implementation
  across all seven brokers and preserves the channel-separation invariant — the explicit per-backend
  decision the ROADMAP asks each backend to make, the way Kafka did in M14d.
- **Test home:** `test/unit/pubsub-broker.test.ts` and `test/unit/service-bus-broker.test.ts` — a
  `request`→`respond` round trip through the recording fake asserting the reply subscription is
  created, the reply lands on it, and it is closed on `disconnect()`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol | Kind | Consumer / real code path that READS it |
| --- | --- | --- |
| `MessagingPlugin` (updated signature) | factory | Application registration; `messaging-plugin.test.ts` selects each arm. |
| `GcpPubSubBroker` | class | `MessagingPlugin({ broker: 'pubsub' })` branch; standalone construction; `pubsub-broker.test.ts`. |
| `ServiceBusBroker` | class | `MessagingPlugin({ broker: 'service-bus' })` branch; standalone; `service-bus-broker.test.ts`. |
| `CloudBrokerUnavailableError` | class | Cloud-backend `connect()` on Workers; consumer `instanceof`; gating tests. |
| `IPubSubClient` | type (facade) | `pubsub-broker.ts` constructor param; injection fakes; `pubsub-broker.test.ts`. |
| `IServiceBusClient` | type (facade) | `service-bus-broker.ts` constructor param; injection fakes; `service-bus-broker.test.ts`. |
| `PubSubOptions`, `ServiceBusOptions` | type | The `'pubsub'` / `'service-bus'` arms of `MessagingPluginOptions`. |
| `MessagingPluginOptions` (union), `MessagingBrokerType` (widened) | type | `MessagingPlugin` param + PUBLIC_API. |
| `SqsQueue` | class | `QueuePlugin({ adapter: 'sqs' })` branch; standalone; `sqs-queue.test.ts`. |
| `SnsPublisher` | class | Application fan-out wiring; `sns-publisher.test.ts`. |
| `ISqsClient`, `ISnsClient` | type (facade) | `SqsQueue` / `SnsPublisher` params; injection fakes; their tests. |
| `SqsQueueOptions`, `SnsPublisherOptions` | type | `QueuePluginOptions.sqs` / `SnsPublisher` ctor. |
| `QueuePluginOptions` (sqs bag added), `QueueAdapterType` (`'sqs'` added) | type | `QueuePlugin` + PUBLIC_API. |

### 4.1 Options — every option names its consumer

| Option | Consumer | Behavior (per implementation) |
| --- | --- | --- |
| `MessagingPluginOptions.broker: 'pubsub'` | `MessagingPlugin` factory | Builds `GcpPubSubBroker`. |
| `PubSubOptions.projectId` / `.credentials?` / `.client?` / `.topicPrefix?` | `GcpPubSubBroker` | Resolve the SDK client (inject-or-lazy) and scope topic names. Missing `projectId` with no injected `client` is a compile error (union arm). |
| `MessagingPluginOptions.broker: 'service-bus'` | `MessagingPlugin` factory | Builds `ServiceBusBroker`. |
| `ServiceBusOptions.connectionString` / `.client?` / `.topicPrefix?` | `ServiceBusBroker` | Resolve the SDK client (inject-or-lazy). Missing `connectionString` with no `client` is a compile error. |
| `MessagingPluginOptions.broker: 'custom'` + `instance: IMessageBroker` | `MessagingPlugin` factory | Registers the injected instance under `messaging`/`messaging.<name>`; health reports `{ broker: 'custom' }`. |
| `QueuePluginOptions.adapter: 'sqs'` | `QueuePlugin` factory | Builds `SqsQueue` and wraps it in `QueueService`. |
| `SqsQueueOptions.client?` / `.queueUrl` / `.deadLetterQueueUrl?` / `.visibilityTimeoutSeconds?` / `.maxDelaySeconds?` | `SqsQueue` | Resolve the SQS client (inject-or-lazy), target queue, DLQ, claim visibility, delay cap. |
| `SnsPublisherOptions.client?` / `.topicArn` / `.region?` | `SnsPublisher` | Resolve the SNS client (inject-or-lazy) and target topic. |

## 5. Implementation files

| File | Purpose |
| --- | --- |
| `packages/messaging-plugin/src/brokers/pubsub-broker.ts` | `GcpPubSubBroker implements MessageBrokerAdapter` — inject-or-lazy `npm:@google-cloud/pubsub@4.x` via `IPubSubClient`; publish/subscribe; transport-specific `OpenInbox`; `request`/`respond` via `RequestReplyCore`. |
| `packages/messaging-plugin/src/brokers/service-bus-broker.ts` | `ServiceBusBroker implements MessageBrokerAdapter` — inject-or-lazy `npm:@azure/service-bus@7.x` via `IServiceBusClient`; publish/subscribe; transport-specific `OpenInbox`; `request`/`respond` via `RequestReplyCore`. |
| `packages/messaging-plugin/src/brokers/cloud-gate.ts` | Shared `assertNotCloudflareWorkers(runtime, backend, sdkSpecifier)` helper used by both cloud brokers. |
| `packages/messaging-plugin/src/errors.ts` (modified) | Add exported `CloudBrokerUnavailableError`. |
| `packages/messaging-plugin/src/interfaces/index.ts` (modified) | `MessagingPluginOptions` → discriminated union; widen `MessagingBrokerType`; add `IPubSubClient`, `IServiceBusClient`, `PubSubOptions`, `ServiceBusOptions`. |
| `packages/messaging-plugin/src/plugin/messaging-plugin.ts` (modified) | Union-arm dispatch; add `pubsub`/`service-bus`/`custom` branches; `custom` registers the injected instance. |
| `packages/messaging-plugin/src/index.ts` (modified) | Export the two brokers, the two facades, the new option types, `CloudBrokerUnavailableError`. |
| `packages/queue-plugin/src/adapters/sqs-queue.ts` | `SqsQueue implements QueueAdapter` + `validateClient`; inject-or-lazy `npm:@aws-sdk/client-sqs@3.x` via `ISqsClient`; poll/requeue/deadLetter/in-memory recurring. |
| `packages/queue-plugin/src/sns/sns-publisher.ts` | `SnsPublisher` + `ISnsClient`; inject-or-lazy `npm:@aws-sdk/client-sns@3.x`. |
| `packages/queue-plugin/src/interfaces/index.ts` (modified) | Add `'sqs'` to `QueueAdapterType`; add `SqsQueueOptions`, `SnsPublisherOptions`, `ISqsClient`, `ISnsClient`, `ISqsMessage` shapes. |
| `packages/queue-plugin/src/plugin/queue-plugin.ts` (modified) | Add `'sqs'` switch branch building `SqsQueue` + `QueueService` from `options.sqs`. |
| `packages/queue-plugin/src/index.ts` (modified) | Export `SqsQueue`, `SnsPublisher`, and the new option/facade types. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file | src covered | Key assertions (and the signature each call type-checks against) |
| --- | --- | --- |
| `packages/messaging-plugin/test/unit/pubsub-broker.test.ts` | `pubsub-broker.ts`, `cloud-gate.ts` | publish→subscribe round trip via recording `IPubSubClient`; subscription created if absent; ack-on-success / nack-on-failure; `request`/`respond` round trip through the reply subscription; `connect()` throws `CloudBrokerUnavailableError` on a `cloudflare-workers` runtime. Calls type-check against `IMessageBroker` (`messaging.ts:98`) and `IPubSubClient`. |
| `packages/messaging-plugin/test/unit/service-bus-broker.test.ts` | `service-bus-broker.ts`, `cloud-gate.ts` | publish→subscribe round trip via recording `IServiceBusClient`; complete/abandon; `request`/`respond` round trip; Workers-gating throw. Against `IMessageBroker` + `IServiceBusClient`. |
| `packages/messaging-plugin/test/unit/pubsub-real-import.test.ts` | `pubsub-broker.ts` lazy path | Guarded: skip when `@google-cloud/pubsub` absent; else construct `GcpPubSubBroker` with NO injected client so `loadPubSub()` runs for real; assert the client loads (no network assertion — credentials are out of scope). |
| `packages/messaging-plugin/test/unit/service-bus-real-import.test.ts` | `service-bus-broker.ts` lazy path | Guarded real-import of `@azure/service-bus`, same shape. |
| `packages/messaging-plugin/test/unit/messaging-plugin.test.ts` (extended) | `messaging-plugin.ts`, `interfaces/index.ts` | Per-arm selection: each `broker` value builds the right class and registers under the right token; `'custom'` registers the injected `IMessageBroker`; health reports the backend; unknown arm is exhaustive (union). |
| `packages/messaging-plugin/test/unit/barrel-exports.test.ts` (extended) | `index.ts` | Asserts the new exports are present and types are exported. |
| `packages/queue-plugin/test/unit/sqs-queue.test.ts` | `sqs-queue.ts` | enqueue→reserve→ack; `delayMs`→DelaySeconds; `requeue`→`ChangeMessageVisibility` backoff; `deadLetter`→source delete + DLQ send; in-memory `storeRecurring`/`fetchRecurringDue`/`advanceRecurring`; `connect()` rejects on `cloudflare-workers`. Against `QueueAdapter` (`queue-adapter.ts:20`) + `ISqsClient`. |
| `packages/queue-plugin/test/unit/sns-publisher.test.ts` | `sns-publisher.ts` | `publish` sends the documented SNS payload via recording `ISnsClient`; topic resolution. Against `ISnsClient`. |
| `packages/queue-plugin/test/unit/sqs-real-import.test.ts` | `sqs-queue.ts`, `sns-publisher.ts` lazy paths | Guarded real-import of `@aws-sdk/client-sqs` (and, sharing the guard, `@aws-sdk/client-sns`); skip when absent. |
| `packages/queue-plugin/test/unit/queue-plugin.test.ts` (extended) | `queue-plugin.ts` | `'sqs'` branch builds `SqsQueue` wrapped in `QueueService` and registers under `queue`/`queue.<name>`. |
| `packages/queue-plugin/test/unit/barrel-exports.test.ts` (extended) | `index.ts` | Asserts `SqsQueue`, `SnsPublisher`, and new types are exported. |
| `test/fixtures` additions | fakes | `fake-pubsub-client.ts`, `fake-service-bus-client.ts`, `fake-sqs-client.ts`, `fake-sns-client.ts` — recording fakes reproducing each facade's real shape. |

> Coverage bar: every new and modified `src` file ≥90% branch/function/line. The guarded real-import
> tests' load branches are additionally unit-covered through the injection seam (the recording-fake
> tests exercise the inject path; the `resolveClient` inject-vs-lazy branch is asserted directly).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m54-cloud-message-brokers, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # both packages are already published members; run on the committed tree
deno task release:verify <version>
```

Forbidden-construct grep (must be empty, comments excepted) for each touched package:
`grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/messaging-plugin/src packages/queue-plugin/src`

## 8. Risks & mitigations

- **Cloud SDK API drift vs. the structural facade** → each facade names the exact methods the broker
  calls (`sendMessage`/`receiveMessage`/`topic.publishMessage`/`sender.sendMessages`/…), verified
  against the SDK's current shape; the recording fakes reproduce that shape so a drift is caught by the
  unit tests, and the guarded real-import test confirms the lazy load resolves.
- **Pub/Sub / Service Bus reply resource leaks** → the transport-specific `OpenInbox` opens exactly one
  per-instance reply subscription lazily, and `disconnect()` deletes it via `RequestReplyCore.close()`
  (which already awaits an in-flight open); the broker tests assert creation + teardown.
- **Double dead-handling on SQS (QueueService attempts vs. SQS ApproximateReceiveCount)** →
  `QueueService`'s attempt counter is authoritative: `ack` deletes (stops redelivery), `deadLetter`
  deletes the source AND sends to the DLQ, so the platform's own RedrivePolicy is documented as
  complementary (configure `maxReceiveCount` ≥ the plugin `defaultMaxAttempts`); a test pins the
  dead-letter path.
- **Breaking the published `MessagingPluginOptions` type** → pre-1.0, ROADMAP-mandated, recorded as a
  CHANGELOG BREAKING entry and PUBLIC_API rewrite; common call shapes stay valid because each option
  lives on its own union arm.
- **M53-style net-grant footgun** → no new package-wide `net` grant; guarded tests skip when the SDK is
  absent, and any emulator grant is endpoint-scoped in the package manifest, never loopback-wide.

## 9. Out of scope

- Live-cloud CI verification (AWS/GCP/Azure credentials) — emulator/manual only, stated plainly. Owned
  here as a documented limitation.
- Kinesis / EventBridge / Azure Event Hubs — streaming, not brokered; no owning milestone.
- A composite AWS `IMessageBroker` — AWS pub/sub is the documented SNS+SQS pair (`SnsPublisher` +
  `SqsQueue`), not one broker.
- Full `QueuePluginOptions` discriminated-union refactor — only `MessagingPluginOptions` is mandated;
  SQS is an additive `'sqs'` arm with a dedicated options bag.
- Making SQS a direct `IQueue` — declined; SQS is poll-based and uses the `QueueAdapter`+`QueueService`
  path like `RabbitMqQueue`. (`WorkersQueue`'s direct-`IQueue` shape is push-only and does not apply.)
