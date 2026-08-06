# Milestone 54 — Cloud Message Brokers (`@hono-enterprise/messaging-plugin` + `@hono-enterprise/queue-plugin`)

> **Status:** Completed. Branch: `feat/m54-cloud-message-brokers`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

The framework can serve on exactly one cloud's bus — Cloudflare Queues (M52b) — and reach none of
the three hyperscalers' own message buses. `MessagingBrokerType` is a closed switch
(`'memory' | 'redis-streams' | 'rabbitmq' | 'nats' | 'kafka'`) whose factory throws on anything
else, with no `'custom'` arm and no way to inject a broker instance, so an application on AWS, GCP,
or Azure cannot use its platform's bus through the committed `IMessageBroker` at all. M54 closes
that gap with the prerequisite extension point plus the three clouds' backends, split by what each
cloud's bus actually _is_: SQS is a queue (→ `IQueue`, the M52b precedent), while GCP Pub/Sub and
Azure Service Bus are topic/subscription pub/sub (→ `IMessageBroker`); AWS fan-out is the SNS→SQS
pair, not one object.

- **In scope:**
  - A `'custom'` arm on `MessagingPluginOptions`, with the option type becoming a **discriminated
    union on `broker`** (the M30 `ChannelConfig` / M50 / M52c precedent) so a missing per-arm
    credential is a compile error rather than a startup throw. The union carries a **default arm**
    (§3.1) so `MessagingPlugin()` and `MessagingPlugin({})` stay valid — three in-repo callers make
    a bare call and one of them is a `deno check`-ed CLI drift gate.
  - GCP Pub/Sub and Azure Service Bus brokers implementing `IMessageBroker` (incl. the required
    `request`/`respond`) in `packages/messaging-plugin`.
  - An SQS adapter implementing the internal `QueueAdapter` seam (→ `IQueue` via `QueueService`) in
    `packages/queue-plugin`, plus an `SnsPublisher` for SNS→SQS fan-out.
  - A per-backend `openInbox` decision for request-reply on each new `IMessageBroker` backend
    (§3.7), resolved the way Kafka did in M14d — a shared reply **topic** as the address, since the
    address must be publishable through the broker's own `publish`.
  - Inject-or-lazy cloud SDKs via the M25/M28/M29 **`adapt(module)` / `load(module)` seam** over a
    **domain-shaped port** per backend (NOT an SDK-shaped structural facade — §3.8), one guarded
    real-import test per backend that adapts the REAL module and asserts it satisfies the port, and
    the load branching unit-tested through the injection seam.
  - Runtime gating: each cloud backend throws a named, exported error on Cloudflare Workers (none of
    the three SDKs is Workers-portable — gRPC/AMQP/long-poll, not `fetch`).
  - **SQS verified against a real SQS-compatible server** (ElasticMQ) in CI, the M53 pattern: the
    SQS mapping carries the milestone's only bespoke claim/settle/attempt logic and is the one
    backend with a credential-free emulator that is a single container (§3.9).
- **NOT this milestone:**
  - Live-cloud verification against real AWS/GCP/Azure accounts — credentials cannot be exposed to
    fork PRs. Stated plainly the way M52's "not verified against a live Worker" is. **Owned here.**
  - Pub/Sub and Service Bus emulators in CI — declined with cause in §3.9; those two backends ship
    fake-driven plus guarded real-import, and the plan says so in one voice (§9 agrees).
  - Kinesis, EventBridge, Azure Event Hubs — streaming, not brokered messaging. **Deferred
    indefinitely** (no owning milestone; out of the messaging/queue contracts).
  - Making `QueuePluginOptions` a full discriminated union. Only `MessagingPluginOptions` is
    mandated to become a union; SQS is added as an additive `'sqs'` adapter arm with a dedicated
    options bag. **Owned here (deliberate non-decision).**
  - Creating cloud-side resources. No backend creates a topic or a queue (§3.6): they must
    pre-exist, the Kafka `replyTopic` precedent. The single exception is the per-instance RPC reply
    **subscription**, which is per-process and cannot pre-exist (§3.7).

## 1. Contracts verified from SOURCE (not names)

| Reference                                                                | Source (file:line)                                                                                                                                                                                      | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMessageBroker`                                                         | `packages/common/src/services/messaging.ts:98`                                                                                                                                                          | `connect`/`disconnect`/`publish<T>`/`subscribe<T>`/`request<TReq,TRes>`/`respond<TReq,TRes>`. `request` and `respond` are **REQUIRED members** (not optional) — every broker, including the two new ones, must implement them. `SubscribeOptions.queue?` is the load-balance group.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `IQueue`                                                                 | `packages/common/src/services/queue.ts:79`                                                                                                                                                              | `add<T>(name,data,opts): Promise<string>` / `process<T>(name,processor,opts): void` / `addRecurring<T>(name,data,opts): Promise<void>`. `AddJobOptions.{delayMs?,maxAttempts?}`, `ProcessOptions.concurrency?`, `RecurringOptions.cron`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `MessageBrokerAdapter` (internal)                                        | `packages/messaging-plugin/src/brokers/message-broker.ts:11`                                                                                                                                            | `extends IMessageBroker` and adds `isReady(): boolean`. Intentionally **not** barrel-exported; the health indicator reads it. A `'custom'` arm typed as the public `IMessageBroker` therefore does NOT satisfy it — see §3.5.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `MessagingBrokerType` (closed switch)                                    | `packages/messaging-plugin/src/interfaces/index.ts:88`                                                                                                                                                  | `'memory' \| 'redis-streams' \| 'rabbitmq' \| 'nats' \| 'kafka'` — no `'custom'`, no cloud arms. Widened here to add `'pubsub' \| 'service-bus' \| 'custom'` (all three are discriminant values the health payload reports, so the exported type must enumerate them).                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `MessagingPluginOptions` (flat)                                          | `packages/messaging-plugin/src/interfaces/index.ts:95`                                                                                                                                                  | A flat interface, EVERY member optional: `broker?`, `name?`, `serializer?`, `url?`, `client?` (closed union of 4 client types), `defaultQueue?`, `pollIntervalMs?`, `blockSizeMs?`, `exchangeName?`, `streamName?`, `brokers?`, `clientId?`, `replyTopic?`. All-optional is why `{}` is currently a valid argument — see §3.1. Becomes a discriminated union here.                                                                                                                                                                                                                                                                                                                                                   |
| `MessagingPlugin` factory (closed switch)                                | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:74`                                                                                                                                           | Signature is `options: MessagingPluginOptions = {}` — **the default value is itself a union member**, so an arm-only union breaks the factory's own declaration. `brokerType = options.broker ?? 'memory'`; one `if/else if` chain; `throw new Error('Unknown broker type')` at `:145`; `await broker.connect()` INSIDE `register()` (so a connect-time throw fails `app.start()`); then `ctx.services.register<IMessageBroker>(token, broker)`; health indicator at `:152` calls `broker.isReady()` and reports `{ broker: brokerType }`; `onClose` → `disconnect`. Multi-instance via `name` → token `messaging.<name>` (`:31`).                                                                                   |
| Bare-call sites of `MessagingPlugin` (would break without a default arm) | `packages/starters/microservice-starter/src/app.ts:29`, `packages/starters/microservice-starter/README.md:70`, `packages/cli/src/templates/microservice.ts:34` → `packages/cli/src/commands/new.ts:162` | The starter calls `MessagingPlugin(options.messaging)` where the argument is `MessagingPluginOptions \| undefined`; its README documents `messaging: {}`; the CLI microservice wiring carries NO `args`, and the renderer emits `` `${p.symbol}(${… ?? ''})` `` — i.e. literally `MessagingPlugin()` — into every scaffolded microservice project, which the CLI e2e drift gate then `deno check`s. M50b recorded the same property for `ServiceDiscoveryPluginOptions` ("no default arm, so a bare call does not type-check") and is why THAT wiring carries an `args` string.                                                                                                                                      |
| `OpenInbox` / `ReplyInbox` seam                                          | `packages/messaging-plugin/src/brokers/inbox.ts:47` / `:28`                                                                                                                                             | `OpenInbox = (onReply) => Promise<ReplyInbox>`; `ReplyInbox.{address, close()}`. `createTopicInbox({subscribe,uuid})` (`:84`) mints a fresh `rr.inbox.<uuid>` topic per call and subscribes with `{ queue: address }` — for brokers whose topics are cheap and per-instance-addressable.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RequestReplyCore` — **the address must be publishable**                 | `packages/messaging-plugin/src/brokers/request-reply-core.ts:68`, `:88`, `:161`, `:210`                                                                                                                 | `RequestReplyDeps` needs `publish`/`subscribe`/`uuid`/`setTimeout`/`clearTimeout`/`openInbox`. The request envelope carries `replyTo: inbox.address` (`:161`) and the responder returns the reply with **the broker's own publish**: `await this.#deps.publish(replyTo, response)` (`:210`). A `ReplyInbox.address` is therefore whatever `publish()` accepts — a TOPIC. Neither Pub/Sub nor Service Bus can publish _to a subscription_, so an inbox addressed by subscription name cannot work (this corrected the original §3.7). RPC rides `rr.req.<topic>` (`:40`), disjoint from plain pub/sub. `close()` (`:220`) rejects every in-flight request and awaits an in-flight open before tearing the inbox down. |
| `KafkaBroker` custom-openInbox + inject-or-lazy precedent                | `packages/messaging-plugin/src/brokers/kafka-broker.ts:31`, `:43`, `:65`, `:158-166`                                                                                                                    | `loadKafkajs()` = `await import('npm:kafkajs@2.x')`; `validateClient`; `resolveClient(brokers,clientId,injected?)`. `#openReplyInbox` returns `{ address: this.#replyTopic, close: () => subscription.unsubscribe() }` — the address is the **shared reply topic**, read under a per-instance consumer group `rr-inbox-<uuid>`; replies for other instances arrive here too and are dropped by correlation-id lookup, an O(instances) fan-out that needs no admin API. Both new backends follow this shape (§3.7).                                                                                                                                                                                                   |
| Domain-shaped port + `adapt`/`load` seam (the pattern followed here)     | `packages/mail-plugin/src/providers/ses-provider.ts:20`, `:57`, `:74`, `:143`; `packages/storage-plugin/src/providers/s3-provider.ts:20-23`, `:108`, `:203`                                             | The repo's cloud-SDK pattern is NOT an SDK-shaped structural facade. A `XxxSdkModule` type declares only the constructors used (`SESv2Client`, `SendEmailCommand: new (input: Record<string, unknown>) => unknown`); a PURE `adaptXxxModule(mod, options)` returns the plugin's OWN domain port (`ISesClient.sendEmail(message: OutgoingMail)`); `loadXxxModule()` is a one-line `import('npm:@aws-sdk/client-sesv2@^3') as unknown as XxxSdkModule`; the provider calls `adapt(await load())` on first connect. Specifier form is `@^3`. This is what §3.8 adopts, and it is why no port here mirrors an SDK signature.                                                                                             |
| Guarded real-import test pattern                                         | `packages/messaging-plugin/test/unit/redis-real-import.test.ts:16`                                                                                                                                      | Guard on env var + `try { await import('npm:ioredis@5.x') }`; SKIP-log if absent; construct with NO injected client so the production load path runs; assert a real round trip. The cloud equivalents cannot round-trip without credentials, so they assert the adapted REAL module satisfies the port (§6).                                                                                                                                                                                                                                                                                                                                                                                                         |
| `QueueAdapter` (internal seam)                                           | `packages/queue-plugin/src/adapters/queue-adapter.ts:20`                                                                                                                                                | `connect`/`disconnect`/`isReady`/`enqueue<T>(job)`/`reserve<T>(name,limit,nowMs)`/`ack(name,id)`/`requeue(name,id,availableAtMs,attempts)`/`deadLetter(name,id,nowMs)`/`storeRecurring`/`fetchRecurringDue`/`advanceRecurring`. Claim-based: `reserve` claims, `ack`/`requeue`/`deadLetter` settle. `reserve` is **per job name**. Intentionally **not** barrel-exported.                                                                                                                                                                                                                                                                                                                                            |
| `StoredJob` — no transport handle field                                  | `packages/queue-plugin/src/interfaces/index.ts:95`                                                                                                                                                      | `{ id, name, data, attempts, maxAttempts, availableAtMs }`. There is NO field for a transport-level claim token, so an adapter whose settle calls need one (SQS `ReceiptHandle`) must hold it adapter-side, keyed by `id` — §3.4.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `QueueService` poll loop — reserve is per registered name                | `packages/queue-plugin/src/services/queue-service.ts:232`, `:250`, `:257`                                                                                                                               | `for (const [name, reg] of this.#processors.entries())` … `await this.#adapter.reserve<unknown>(name, limit, now)`. So an adapter is asked for ONE name's jobs at a time and must not return another name's — which is why a single shared SQS queue URL does not fit the seam (§3.4). It then forces `attempts: storedJob.attempts === 0 ? 1 : storedJob.attempts` and otherwise trusts the adapter's value.                                                                                                                                                                                                                                                                                                        |
| `runJob` — the adapter must PERSIST the new attempt count                | `packages/queue-plugin/src/processors/job-processor.ts:60-71`, `:73-80`                                                                                                                                 | On failure: `if (storedJob.attempts < storedJob.maxAttempts)` → `requeue(name, id, runtime.now() + computeBackoffMs(attempts+1), attempts+1)`, else `deadLetter`. The count the next `reserve` returns is what decides retry-vs-dead-letter, so an adapter that cannot persist `attempts` must source it from the platform — §3.4.                                                                                                                                                                                                                                                                                                                                                                                   |
| `computeBackoffMs` caps at 30 s                                          | `packages/queue-plugin/src/retry/retry-strategy.ts:38-45`, `:12`, `:17`                                                                                                                                 | `min(1000 * 2^(attempts-1), 30000)`. So a requeue delay is always ≤30 s — inside SQS's 43 200 s `VisibilityTimeout` ceiling. Only `AddJobOptions.delayMs` is caller-supplied and unbounded, which is where SQS's 900 s `DelaySeconds` ceiling bites (§3.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `QueuePlugin` factory (switch)                                           | `packages/queue-plugin/src/plugin/queue-plugin.ts:45`, `:87`                                                                                                                                            | `adapter = options?.adapter ?? 'memory'`; `switch` over memory/redis/rabbitmq; wraps the adapter in `QueueService` (retry/backoff/cron/poll); `service.connect()`; `ctx.services.register<IQueue>(token, service)`; health via `service.createHealthIndicator()`; `onClose` → `disconnect`. Multi-instance via `name` → `queue.<name>`. Default branch throws `Unknown queue adapter`.                                                                                                                                                                                                                                                                                                                               |
| `RabbitMqQueue` per-NAME topology + in-memory recurring precedent        | `packages/queue-plugin/src/adapters/rabbitmq-queue.ts:31`, `:43`, `:64`, `:110`, `:357`                                                                                                                 | `loadAmqplib()`; `validateClient`; `resolveClient(url,injected?)`; implements `QueueAdapter` with poll-based `basicGet`, per-message TTL + dead-letter-exchange for delay/requeue, **in-memory recurring** (non-durable, matching `MemoryQueue`), and **per-name** `he.queue.<n>.ready/.delay/.dead` queues. The per-name part is the precedent SQS follows with a per-name queue URL map (§3.4).                                                                                                                                                                                                                                                                                                                    |
| `QueuePluginOptions` (flat)                                              | `packages/queue-plugin/src/interfaces/index.ts:136`; `QueueAdapterType` at `:131`                                                                                                                       | `adapter?: QueueAdapterType` (`'memory' \| 'redis' \| 'rabbitmq'`), `name?`, `url?`, `client?: IRedisQueueClient \| IAmqpQueueConnection` (closed union), `defaultMaxAttempts?`, `pollIntervalMs?`, `prefix?`. Adds an `'sqs'` adapter value + an `sqs?: SqsQueueOptions` bag here; the `client?` union is NOT widened (the SQS client is injected inside its own bag).                                                                                                                                                                                                                                                                                                                                              |
| `WorkersQueue` direct-`IQueue` precedent (NOT followed for SQS)          | `packages/cloudflare-plugin/src/queues/workers-queue.ts:122`, `:202`                                                                                                                                    | Implements `IQueue` directly (not `QueueAdapter`) because Cloudflare Queues are **push**-based (a `queue()` handler drives dispatch), so `QueueService`'s poll loop cannot drive them; `addRecurring` throws. SQS is **poll**-based (`ReceiveMessage`), so SQS uses the `QueueAdapter`+`QueueService` path like `RabbitMqQueue`. Cited to prevent re-deriving the wrong precedent.                                                                                                                                                                                                                                                                                                                                   |
| `ISerializer` is string-in / string-out                                  | `packages/messaging-plugin/src/serializers/serializer.ts:22`, `:32`                                                                                                                                     | `serialize<T>(value: T): string` / `deserialize<T>(payload: string): T`. Pub/Sub is a BYTES transport (below), so the byte↔string conversion is a named design decision, not an implementation detail (§3.6).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `RuntimePlatform`                                                        | `packages/common/src/types.ts:33`; `IRuntimeServices.platform()` at `packages/common/src/runtime.ts:239`                                                                                                | `'node' \| 'deno' \| 'bun' \| 'cloudflare-workers'`. `platform()` is the gate signal (§3.10). M45 gated on capability ABSENCE (`ctx.runtime.workers !== undefined`) because it had an optional runtime member to test; there is no runtime member for a cloud SDK, so the platform string is the only signal available.                                                                                                                                                                                                                                                                                                                                                                                              |
| Existing messaging error classes                                         | `packages/messaging-plugin/src/errors.ts:15`, `:29`, `:55`                                                                                                                                              | `RequestTimeoutError`, `RemoteHandlerError`, `MessagingNotSupportedError` (deprecated, retained). New classes join this file with the same `this.name = '…'` convention.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Per-package test net grants (M53 lesson)                                 | `packages/messaging-plugin/deno.json:11`, `packages/queue-plugin/deno.json:11`                                                                                                                          | `test.permissions.net` is endpoint-scoped to the Redis loopback. A CLI/manifest `net` list **replaces** the package block, so a new grant lives in the package's own manifest, endpoint-scoped. `queue-plugin` gains the ElasticMQ endpoint (§3.9); `messaging-plugin` gains nothing (its guarded tests reach no network).                                                                                                                                                                                                                                                                                                                                                                                           |

### 1.1 External-package facts verified against the registry and the shipped `.d.ts`

| Fact                                                                                                                                                                                                | Verified from                                                                                  | Consequence for this plan                                                                                                                                                                                                                                                                                                                                                               |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `@google-cloud/pubsub` latest is **6.0.0** (5.x exists in between); `engines.node >= 22`                                                                                                            | `registry.npmjs.org/@google-cloud%2fpubsub`                                                    | Pin `npm:@google-cloud/pubsub@^6`. An earlier draft said `@4.x`, two majors stale. The `engines` floor is recorded as a §8 risk, not enforced by Deno.                                                                                                                                                                                                                                  |
| Pub/Sub publish is `topic.publishMessage(message: MessageOptions)`, where `MessageOptions = PubsubMessage & { json?: any }`                                                                         | `@google-cloud/pubsub@6.0.0/build/src/topic.d.ts:510`, `:41`                                   | The adapter publishes `{ data }` with the serializer's string encoded to bytes; `json` is declined because it bypasses `ISerializer`.                                                                                                                                                                                                                                                   |
| Subscription creation is `topic.createSubscription(name, options?)` — on the **Topic**, not the client                                                                                              | `topic.d.ts:158-160`                                                                           | The `PubSubSdkModule`/port must reach a topic object; the RPC inbox creates its subscription there (§3.7).                                                                                                                                                                                                                                                                              |
| Delivery is `subscription.on('message', (m) => …)`; settle is `message.ack()` / `message.nack()`; `message.data` is a Node **`Buffer`**                                                             | `subscription.d.ts:66`; `subscriber.d.ts:221`, `:261`, `:135`                                  | Consumption is event-emitter-shaped, not a promise, and the payload arrives as bytes. Both are absorbed by the adapter so the port stays promise-shaped and string-shaped (§3.8), and no plugin source names `Buffer` (`TextDecoder` instead).                                                                                                                                          |
| `subscription.close()` and `subscription.delete()` both exist                                                                                                                                       | `subscription.d.ts:257` and the `delete` overloads                                             | `close()` stops delivery; `delete()` removes the cloud resource. The RPC inbox does BOTH on teardown (§3.7); a plain `unsubscribe()` only closes.                                                                                                                                                                                                                                       |
| `@azure/service-bus` latest is **7.9.5** — `@^7` is current                                                                                                                                         | `registry.npmjs.org/@azure%2fservice-bus`                                                      | Pin `npm:@azure/service-bus@^7`.                                                                                                                                                                                                                                                                                                                                                        |
| `ServiceBusClient.createReceiver` overloads are `(queueName, options?)` and `(topicName, subscriptionName, options?)` — two POSITIONAL strings                                                      | `@azure/service-bus@7.9.5/types/latest/service-bus.d.ts:1624`, `:1653`                         | An earlier draft's facade wrote `createReceiver(topic, { subscription })`, which is not the SDK's shape and would silently bind the queue overload (receiving from the topic name as if it were a queue). Absorbed by the adapter (§3.8). `createSender(queueOrTopicName, options?)` at `:1749`; `sendMessages(...)` at `:2517`; `completeMessage`/`abandonMessage` at `:2286`/`:2309`. |
| `ServiceBusClient` **cannot create or delete a subscription** — `createSubscription`/`deleteSubscription` live on `ServiceBusAdministrationClient`, a separate class                                | `service-bus.d.ts:1554` (client members) vs `:940`, `:1270`, `:1383`                           | This is the M14d Kafka situation verbatim (`IKafkaFactory` exposes no `admin()`). Since a per-instance reply subscription is unavoidable for Service Bus RPC (§3.7), the `ServiceBusSdkModule` declares the administration client too, and a creation failure throws a named error naming the `Manage` right.                                                                           |
| `@aws-sdk/client-sqs` / `client-sns` are v3 (`3.1103.0`), command-shaped: `SendMessageCommand`, `ReceiveMessageCommand`, `DeleteMessageCommand`, `ChangeMessageVisibilityCommand`, `PublishCommand` | `dist-types/commands/index.d.ts` of both packages                                              | The v3 client has `send(command)`, not `sendMessage(...)`. An SDK-shaped facade with per-operation methods would describe SDK **v2**. The repo's `adaptAwsS3Module` / `adaptSesModule` command style is followed exactly (§3.8), with `@^3` specifiers.                                                                                                                                 |
| `ReceiveMessageRequest.AttributeNames` is **deprecated** in favour of `MessageSystemAttributeNames`; `ApproximateReceiveCount` is a system attribute; `Message.ReceiptHandle` is typed **optional** | `@aws-sdk/client-sqs@3.1103.0/dist-types/models/models_0.d.ts:1202`, `:1280`, `:1144`, `:1500` | The adapter requests `MessageSystemAttributeNames: ['ApproximateReceiveCount']` (not the deprecated field), reads the attempt count from it (§3.4), and treats a message with no `ReceiptHandle` as unclaimable rather than `!`-asserting.                                                                                                                                              |
| SQS ceilings: `SendMessage.DelaySeconds` ≤ **900**; `VisibilityTimeout` ≤ **43 200**                                                                                                                | AWS SQS API limits, consistent with `models_0.d.ts:1683`, `:114`                               | `delayMs` above 900 s cannot be expressed and is a THROW, not a clamp (a clamp runs a job early — the M52b rounding rule). Requeue backoff is ≤30 s (§1) so the visibility ceiling is never reached.                                                                                                                                                                                    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                   | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                                              | Doc deliverable (same PR)                                                                                                                                                                                                                         |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `PUBLIC_API.md:2702` documents `MessagingPluginOptions` as a **flat, all-optional** interface; ROADMAP M54 mandates a **discriminated union on `broker`** with a `'custom'` arm.                                                                                                                           | Pick the union (ROADMAP side), **with a default arm** so the currently-documented bare and empty call shapes keep working (§3.1). It is a source-shaping, pre-1.0 **breaking** change for a caller who passes a widened variable, recorded in CHANGELOG; it is NOT breaking for `MessagingPlugin()`, `MessagingPlugin({})`, or any single-arm literal, and §6 pins each of those with a test.                                                         | Rewrite the `MessagingPluginOptions` block + the messaging Exports table in `PUBLIC_API.md`; add a CHANGELOG entry that states exactly which call shapes break and which do not.                                                                  |
| C2 | `ARCHITECTURE.md:1257`/`:1259` messaging "Responsibilities"/"Public API" list **only** in-memory + Redis Streams brokers, omitting RabbitMQ/NATS/Kafka (shipped in M14b/M14c) and now Pub/Sub + Service Bus.                                                                                               | Pick the full, current broker set.                                                                                                                                                                                                                                                                                                                                                                                                                    | Update the messaging-plugin ARCHITECTURE row to name all seven brokers + the `'custom'` arm + the error classes.                                                                                                                                  |
| C3 | `PUBLIC_API.md:2826` states request-reply "is available on **all five** brokers"; after this milestone there are seven, and the `'custom'` arm makes RPC the injected instance's responsibility.                                                                                                           | Pick source: `request`/`respond` are required members of `IMessageBroker` (`messaging.ts:98`), so the count becomes **seven** and a custom instance owes its own implementation. (An earlier draft claimed this line carried a "depends on the broker" hedge; grep over `PUBLIC_API.md` and `ARCHITECTURE.md` finds no such hedge anywhere — `:2824` is the deprecated-`MessagingNotSupportedError` row. The conflict is a stale count, not a hedge.) | Update the "Broker support" note to seven brokers, name the two new ones, and add the sentence that a `'custom'` instance must implement `request`/`respond` because the contract requires them.                                                  |
| C4 | `PUBLIC_API.md:2932` lists `QueueAdapterType` as `'memory' \| 'redis' \| 'rabbitmq'`; `ARCHITECTURE.md:1272` (the queue **Rules** row — an earlier draft cited `:1271`, which is "Extension Points") names only Memory/Redis/RabbitMQ, and the queue "Public API" row at `:1270` lists no adapters at all. | Pick the widened set: add `'sqs'` + `SqsQueue` + `SnsPublisher`.                                                                                                                                                                                                                                                                                                                                                                                      | Update the queue Exports table + the ARCHITECTURE queue **Public API** and **Rules** rows to add SQS + SNS + the new option/port types.                                                                                                           |
| C5 | `ROADMAP.md:5742` packages line says "plus `packages/queue-plugin` for SQS" but does not name where SNS lives.                                                                                                                                                                                             | Pick: SNS lives in `packages/queue-plugin` alongside SQS (the SNS→SQS pair is one cloud's queue story; `queue-plugin` already pairs producer/consumer halves). `messaging-plugin` holds only the two `IMessageBroker` backends.                                                                                                                                                                                                                       | Add the SNS placement note to the M54 ROADMAP section; flip its deliverable checkboxes + the Progress row, update the CLAUDE.md "Current status" entry and "Next milestone" pointer, and `git mv` this plan to `plans/archive/` — all in this PR. |
| C6 | `ROADMAP.md` M54 says runtime gating is "a documented no-op or throw on Cloudflare Workers".                                                                                                                                                                                                               | Pick the **throw**, both packages, both with an exported named class (§3.10). A silent no-op would publish into a void, which the CLAUDE.md no-silent-shim rule forbids.                                                                                                                                                                                                                                                                              | Record the resolution in the ROADMAP M54 section so the merged doc does not read as if a no-op were acceptable.                                                                                                                                   |

## 3. Design decisions

### 3.1 `MessagingPluginOptions` → discriminated union on `broker`, **with a default arm**

- **Decision:** `MessagingPluginOptions` becomes a union keyed on `broker` over a shared
  `MessagingCommonOptions` base (`name?`, `serializer?`). Arms: `MemoryArm` (`broker?: 'memory'` —
  the discriminant is OPTIONAL on this arm alone), `RedisStreamsArm`, `RabbitMqArm`, `NatsArm`,
  `KafkaArm`, `PubSubArm`, `ServiceBusArm`, and `CustomArm`
  (`broker: 'custom'; instance:
  IMessageBroker`). Every non-default arm requires its `broker`
  literal, and each arm carries ONLY the options its backend reads — `client?` is typed to that
  arm's port rather than the old closed union of four. `MessagingBrokerType` widens to all eight
  literals, including `'custom'`, so the health payload's `{ broker }` value is always a member of
  the exported type.
- **Why the default arm is load-bearing, not a convenience:** the factory's own signature is
  `options: MessagingPluginOptions = {}` (`messaging-plugin.ts:74`), so `{}` must remain a union
  member for the declaration to compile. Beyond that, three committed call sites make a bare call
  (§1, "Bare-call sites"), and the third is `deno check`-ed by the CLI e2e drift gate — a union
  without a default arm turns a green gate red in `packages/cli`, and would additionally break a
  published starter's documented `messaging: {}` shape. M50b hit exactly this for
  `ServiceDiscoveryPluginOptions` and paid for it with an `args` string in the template; here the
  default arm is the cheaper and less invasive answer, and it means **no starter, CLI, app, or
  README edit is required by this change**. Making `broker` optional on the memory arm only is what
  keeps the union discriminating: any object with a `broker` literal still resolves to exactly one
  arm.
- **Why a union at all:** a missing per-arm credential becomes a compile error (M30/M50/M52c
  precedent), and the `'custom'` arm finally lets an application inject any `IMessageBroker` — the
  extension point four peer plugins already ship. `instance` takes the public `IMessageBroker`, not
  the internal `MessageBrokerAdapter`, so the public surface never depends on an internal type (§3.5
  handles the `isReady` consequence).
- **Test home:** `test/unit/messaging-plugin.test.ts` — per-arm selection (each `broker` value
  builds the right class and registers under the right token) plus three explicit regression cases
  pinning `MessagingPlugin()`, `MessagingPlugin({})`, and `MessagingPlugin(undefined)` as valid and
  memory-backed. Negative typing (`{ broker: 'pubsub' }` with no credentials and no `client` is a
  type error) is asserted with `// @ts-expect-error` in the same file — the repo's existing
  negative-type idiom (`multi-tenancy-plugin`, `sse-plugin`, `validation-plugin` all use it), which
  fails the gate if the code ever starts compiling. A separate "fixture that is `deno check`-ed"
  cannot express this: a file the gate type-checks may not contain a type error.

### 3.2 GCP Pub/Sub broker (`GcpPubSubBroker`, `IMessageBroker`)

- **Decision:** `GcpPubSubBroker implements MessageBrokerAdapter` in
  `packages/messaging-plugin/src/brokers/pubsub-broker.ts`, over the domain port `IPubSubTransport`
  (§3.8) — inject a port, or lazy-load and adapt `npm:@google-cloud/pubsub@^6`.
  `publish(topic, msg)` → serialize to string → `TextEncoder` → `topic.publishMessage({ data })`.
  `subscribe(topic,
  handler, options)` → attach to the subscription named
  `options.queue ?? defaultQueue`, creating it on the topic when absent, and pump `on('message')`
  into the handler: `message.ack()` after the handler resolves, `message.nack()` when it throws (so
  a failed delivery is redelivered rather than silently dropped). `on('error')` reports through the
  optional logger. `connect`/`disconnect` own the client lifecycle; `disconnect` closes every
  subscription and the client, and awaits `RequestReplyCore.close()`. `request`/`respond` delegate
  to `RequestReplyCore` (§3.7).
- **Why:** Pub/Sub maps cleanly onto `IMessageBroker` (topics + subscriptions), and the
  subscription-per-consumer-group shape is what `SubscribeOptions.queue` already means for the other
  brokers. §12.2 inject-or-lazy keeps the SDK out of the published dependency graph.
- **Behavior stated so a test may assert it:** the broker creates **no topics** (§3.6); publishing
  to a missing topic surfaces the SDK's NOT_FOUND, and `subscribe` fails the same way, because
  `createSubscription` needs the topic to exist. It DOES create the subscription named by
  `options.queue` when absent, since that is a per-consumer-group resource an application cannot
  always pre-provision — and it does NOT delete it on `disconnect` (it is shared and durable). The
  single subscription this broker deletes is the per-instance RPC inbox (§3.7).
- **Test home:** `test/unit/pubsub-broker.test.ts` (recording `IPubSubTransport` fake: publish →
  subscribe round trip, subscription created only when absent, ack on success, nack on handler
  throw, no topic creation attempted, `disconnect` closes) + `test/unit/pubsub-adapter.test.ts` (the
  PURE `adaptPubSubModule` over a fake SDK module: asserts `publishMessage` receives bytes carrying
  the serialized string, `Buffer`-shaped inbound data decodes without naming `Buffer`, the
  emitter-to-promise bridge, and `ack`/`nack` routing) + `test/unit/pubsub-real-import.test.ts`
  (guarded — §6).

### 3.3 Azure Service Bus broker (`ServiceBusBroker`, `IMessageBroker`)

- **Decision:** `ServiceBusBroker implements MessageBrokerAdapter` in
  `packages/messaging-plugin/src/brokers/service-bus-broker.ts`, over the domain port
  `IServiceBusTransport` (§3.8) — inject a port, or lazy-load and adapt `npm:@azure/service-bus@^7`.
  `publish` → `createSender(topic).sendMessages({ body })` with the serializer's string as the body.
  `subscribe(topic, handler, options)` → `createReceiver(topicName,
  subscriptionName)` — TWO
  positional strings, per `service-bus.d.ts:1653` — where the subscription name is
  `options.queue ?? defaultQueue`, then `receiver.subscribe({ processMessage, processError })` with
  `completeMessage` on success and `abandonMessage` on a handler throw. Senders and receivers are
  cached per topic/subscription and closed on `disconnect`, which also awaits
  `RequestReplyCore.close()`. `request`/`respond` delegate to `RequestReplyCore` (§3.7).
- **Why:** Service Bus topics + subscriptions map onto `IMessageBroker` the same way Pub/Sub's do;
  same inject-or-lazy rationale.
- **Behavior stated so a test may assert it:** the broker creates **no topics and no ordinary
  subscriptions** — `ServiceBusClient` cannot (§1.1), and reaching for the administration client on
  the ingress path would demand `Manage` rights for every ordinary subscribe. Both must pre-exist,
  documented in PUBLIC_API the way Kafka's `replyTopic` prerequisite is. The administration client
  is used for exactly one thing: the per-instance RPC reply subscription (§3.7).
- **Test home:** `test/unit/service-bus-broker.test.ts` (recording `IServiceBusTransport` fake:
  round trip, complete on success / abandon on throw, sender+receiver caching and close on
  `disconnect`) + `test/unit/service-bus-adapter.test.ts` (the PURE `adaptServiceBusModule` over a
  fake SDK module: asserts `createReceiver` is called with `(topicName, subscriptionName)`
  positionally — the regression test for the shape an earlier draft got wrong — and that
  `processMessage`/`processError` are wired) + `test/unit/service-bus-real-import.test.ts` (guarded
  — §6).

### 3.4 SQS adapter (`SqsQueue`, `IQueue` via the internal `QueueAdapter` seam)

- **Decision:** `SqsQueue implements QueueAdapter` (the **internal** seam, not a direct `IQueue`) in
  `packages/queue-plugin/src/adapters/sqs-queue.ts`, selected via
  `QueuePlugin({ adapter: 'sqs',
  sqs: { … } })` and wrapped by `QueueService` — mirroring
  `RabbitMqQueue` (M15b), NOT `WorkersQueue` (M52b), because SQS is poll-based and fits the
  claim/reserve model. Port `ISqsTransport` (§3.8) over `npm:@aws-sdk/client-sqs@^3`, command-shaped
  like `adaptAwsS3Module`.
- **One queue URL per job name.** `SqsQueueOptions.queues: Record<string, string>` maps job name →
  queue URL, and `deadLetterQueues?: Record<string, string>` maps name → DLQ URL. **This replaces an
  earlier draft's single `queueUrl`, which does not fit the seam:** `QueueService` calls
  `reserve(name, limit, now)` once per registered processor name (`queue-service.ts:232-250`), and
  SQS has no selective receive, so one shared queue would hand name `a`'s poll the messages of name
  `b` with no way to filter server-side and no defined disposition for the mismatch. Per-name queues
  are also exactly what `RabbitMqQueue` does with `he.queue.<n>.ready/.delay/.dead`. A name absent
  from the map throws `SqsQueueNotConfiguredError` naming the job name and the configured names, at
  the `enqueue`/`reserve` call — fail loudly rather than dropping jobs into nowhere. Queues must
  pre-exist (§3.6).
- **Mapping.** `enqueue` → `SendMessage` with the job envelope
  `{ v: 1, id, name, data, maxAttempts }` as the body and
  `DelaySeconds = ceil(max(0, availableAtMs − now) / 1000)`; a delay above SQS's 900 s ceiling
  **throws** `SqsDelayTooLongError` rather than clamping, because a clamp runs the job early (the
  M52b never-early rule) — and `computeBackoffMs` caps at 30 s, so only a caller-supplied
  `AddJobOptions.delayMs` can reach it. `reserve` → `ReceiveMessage` with
  `MaxNumberOfMessages = min(limit, 10)` (the API ceiling — a `limit` above 10 yields at most 10 per
  poll, which the poll loop simply revisits), `VisibilityTimeout = visibilityTimeoutSeconds ?? 30`
  as the claim, and `MessageSystemAttributeNames: ['ApproximateReceiveCount']` (NOT the deprecated
  `AttributeNames`). `ack` → `DeleteMessage`. `requeue` → `ChangeMessageVisibility` with
  `VisibilityTimeout = ceil(max(0, availableAtMs − now) / 1000)`. `deadLetter` → `SendMessage` to
  the name's DLQ **then** `DeleteMessage` of the source (that order, so a failed DLQ send leaves the
  message claimable rather than destroying it); a name with no configured DLQ logs and deletes,
  documented, since the alternative is an infinite redelivery loop.
  `storeRecurring`/`fetchRecurringDue`/`advanceRecurring` are **in-memory** — the `RabbitMqQueue`
  precedent, non-durable, matching `MemoryQueue`.
- **`attempts` comes from the platform, and `requeue`'s `attempts` argument is deliberately not
  persisted.** An SQS message body is immutable, so `ChangeMessageVisibility` cannot carry the
  incremented count; `reserve` therefore sets
  `StoredJob.attempts = Number(ApproximateReceiveCount)`. That is authoritative across restarts and
  across competing consumers, which an adapter-side counter is not, and it reproduces the memory
  adapter's ladder exactly: receive 1 → attempts 1 → fail → requeue → receive 2 → attempts 2 → fail
  → requeue → receive 3 → attempts 3, `3 < 3` is false → dead-letter, i.e. `defaultMaxAttempts`
  total attempts. The `attempts` parameter is documented in JSDoc as unused by this adapter with
  that reasoning, so it reads as a decision rather than an oversight (the memory adapter's
  documented-throw precedent for a member an implementation cannot support). **The count is
  approximate by design:** a worker that dies mid-job lets visibility lapse, which SQS counts as
  another receive, so a job may dead-letter one attempt early. That is inherent to at-least-once SQS
  delivery and is documented, not worked around. This replaces an earlier draft's "QueueService's
  attempt counter is authoritative", which is unimplementable on SQS.
- **Receipt handles live adapter-side.** `StoredJob` has no transport-handle field
  (`interfaces/index.ts:95`), so `reserve` records `id → { receiptHandle, claimExpiresAtMs }` in an
  internal `Map` keyed by the envelope's `id`, and `ack`/`requeue`/`deadLetter` look it up. Entries
  are deleted on every settle and swept when `claimExpiresAtMs` has passed, so the map is bounded by
  in-flight work. A settle for an unknown or expired id reports through the optional logger and
  resolves without calling SQS — the claim has already lapsed and the message will be redelivered,
  so throwing would only convert a recoverable redelivery into a `QueueService` settlement error. A
  received message with no `ReceiptHandle` (the field is optional in the SDK types) is skipped and
  reported rather than `!`-asserted.
- **Why not a direct `IQueue`:** reuses `QueueService`'s backend-agnostic
  retry/backoff/cron/poll/health machinery, and the claim-based seam matches SQS's
  receive→delete/visibility model. (`WorkersQueue` is direct-`IQueue` only because Cloudflare Queues
  are push-based; that reason does not apply.)
- **Test home:** `test/unit/sqs-queue.test.ts` (recording `ISqsTransport` fake — enqueue → reserve →
  ack; per-name queue URL selection and the unconfigured-name throw; `delayMs` → `DelaySeconds`
  rounding and the >900 s throw; `limit > 10` clamped to 10; requeue → `ChangeMessageVisibility`
  seconds; dead-letter ordering, and the DLQ-send-fails case leaving the source undeleted; missing
  DLQ logs-and-deletes; `attempts` read from `ApproximateReceiveCount` across a
  reserve→requeue→reserve ladder up to dead-letter; unknown/expired receipt handle; missing
  `ReceiptHandle` skipped; in-memory recurring due/advance; `connect()` rejects on
  `cloudflare-workers`) + `test/unit/sqs-adapter.test.ts` (PURE `adaptSqsModule` over a fake SDK
  module: asserts each of the four commands is constructed with the documented input, and that
  `MessageSystemAttributeNames` is used rather than `AttributeNames`) + the real-server e2e in §3.9.

### 3.5 The `'custom'` arm and the health indicator

- **Decision:** the factory's `broker` variable stays `MessageBrokerAdapter`, and the `'custom'` arm
  passes its `IMessageBroker` through an internal `asBrokerAdapter(instance)`: when the instance
  already exposes a callable `isReady`, it is returned unchanged and its own readiness is reported;
  otherwise it is wrapped in a thin adapter whose `isReady()` returns a flag set true when
  `connect()` resolves and false after `disconnect()`. Health reports `{ broker: 'custom' }` with
  `status` from that value.
- **Why this needs deciding in the plan:** the health indicator calls `broker.isReady()`
  (`messaging-plugin.ts:152`) while the public `IMessageBroker` has no such member
  (`messaging.ts:98`), so the arm does not type-check without an answer, and an answer improvised at
  implementation time would most likely be a hardcoded `'up'` — a health probe that can never report
  down. Reporting connect-resolved/disconnect-run is the honest floor, and honouring a real
  `isReady` when the instance has one means a custom adapter is not penalised for being complete.
- **Test home:** `test/unit/messaging-plugin.test.ts` — one custom instance WITH `isReady` (its
  value is what health reports, both true and false) and one WITHOUT (down before connect, up after,
  down after the `onClose` disconnect).

### 3.6 Resource creation, and payload encoding

- **Decision (creation):** no backend in this milestone creates a topic, an SQS queue, or an
  ordinary subscription. Topics/queues must pre-exist and the requirement is documented per backend
  in PUBLIC_API, the way Kafka's `replyTopic` prerequisite already is. Two carve-outs, both named:
  Pub/Sub creates the **consumer-group subscription** `options.queue` names when absent (§3.2), and
  both cloud brokers create their **per-instance RPC reply subscription** (§3.7) — that one cannot
  pre-exist because its name contains a per-process uuid.
- **Why:** creation is a control-plane operation needing elevated rights (SQS `CreateQueue`, Pub/Sub
  admin, Service Bus `Manage`), it is quota-limited, and a framework that silently provisions cloud
  resources on boot is worse than one that fails naming what is missing. Kafka set this precedent in
  M14d for exactly the same reason.
- **Decision (encoding):** `ISerializer` is string→string (`serializer.ts:22`). Pub/Sub is a bytes
  transport whose inbound `message.data` is a Node `Buffer` (`subscriber.d.ts:135`), so the
  **adapter** — never the broker — converts: `new TextEncoder().encode(str)` outbound and
  `new TextDecoder().decode(bytes)` inbound, typing the boundary as `Uint8Array` so no plugin source
  names `Buffer` (a `Buffer` IS a `Uint8Array`, so the real SDK's value passes through unchanged).
  Pub/Sub's `{ json }` publish option is declined: it would bypass the configured `ISerializer`,
  splitting one capability across two encodings. Service Bus takes the serialized string directly as
  `body`.
- **Test home:** `test/unit/pubsub-adapter.test.ts` asserts a round trip through
  `TextEncoder`/`TextDecoder` with a non-ASCII payload (so a latin-1 shortcut fails), and that the
  adapter never touches `json`. Absence of topic creation is asserted in each broker test
  (§3.2/§3.3) by a fake that fails the test if a create call arrives.

### 3.7 Per-backend `openInbox` for request-reply — a shared reply **topic**, per-instance subscription

- **Decision:** both new brokers delegate `request`/`respond` to the shared `RequestReplyCore` and
  supply their own `OpenInbox`, shaped like Kafka's (`kafka-broker.ts:158-166`) rather than
  `createTopicInbox`: the inbox **address is a shared reply topic** (`replyTopic`, default
  `'messaging.replies'`, which must pre-exist), and the per-instance resource is a **subscription on
  that topic** named `rr-inbox-<uuid>`, created lazily on the first `request()` and deleted on
  `disconnect()` via `RequestReplyCore.close()`. Replies for other instances arrive at this
  subscription too and are dropped by the core's correlation-id lookup — an O(instances) fan-out
  that needs no per-request addressing. Pub/Sub creates and deletes it through
  `topic.createSubscription` / `subscription.delete()` (`topic.d.ts:159`); Service Bus does so
  through `ServiceBusAdministrationClient.createSubscription` / `deleteSubscription`
  (`service-bus.d.ts:1270`/`:1383`), and a failure there throws `ReplyInboxUnavailableError` naming
  the topic and the `Manage` right, so a missing permission is a clear message on the first RPC call
  rather than a timeout. RPC continues to ride the shared `rr.req.<topic>` channel with in-envelope
  correlation, so a plain `subscribe()` consumer never sees a request envelope (the M14d property).
- **Why the address is a topic, not a subscription:** the responder returns its reply through the
  broker's own publish — `await this.#deps.publish(replyTo, response)`
  (`request-reply-core.ts:210`), with `replyTo = inbox.address` (`:161`). Publishing targets a topic
  on both platforms (`topic.publishMessage`, `createSender(queueOrTopicName)`); neither can publish
  _to_ a subscription. An earlier draft specified a subscription-name address, which would have made
  RPC non-functional on both new brokers while every fake that accepted any string still passed.
  `createTopicInbox` is unusable for the opposite reason: it mints a per-instance **topic**, and a
  cloud topic is a durable, quota-limited, admin-created resource — the same objection Kafka
  recorded.
- **Why not Service Bus native reply:** `ReplyTo`/`SessionId`/`CorrelationId` would need `publish`
  to carry a session id, which the core's address-only contract cannot express, and it would give
  Service Bus a second RPC implementation while the other six brokers share one. A pre-existing
  **shared** reply subscription was also rejected: a shared subscription load-balances, so a reply
  could be delivered to an instance that is not waiting for it and be dropped, making RPC fail
  intermittently under more than one replica — which is precisely why the per-instance resource is
  unavoidable and why Service Bus needs the administration client at all.
- **Test home:** `test/unit/pubsub-broker.test.ts` and `test/unit/service-bus-broker.test.ts` — a
  `request` → `respond` round trip through the recording fake asserting (a) the reply subscription
  is created exactly once across two `request()` calls, (b) the envelope's `replyTo` is the reply
  **topic**, (c) a reply carrying a foreign correlation id is dropped without settling the caller,
  (d) `disconnect()` deletes the subscription, and (e) a creation failure surfaces
  `ReplyInboxUnavailableError`.

### 3.8 SDK integration: domain-shaped port + `adapt(module)` / `load(module)`

- **Decision:** each backend defines its own **domain port** in the plugin's vocabulary and a pure
  `adaptXxxModule(mod, options)` that builds that port from a declared `XxxSdkModule` type, with
  `loadXxxModule()` a one-line `import('npm:…@^N')`. Ports, in full:
  `IPubSubTransport { publish(topic, bytes): Promise<void>; open(topic, subscription, onMessage):
  Promise<IPubSubSubscription>; createSubscription(topic, subscription): Promise<void>;
  deleteSubscription(subscription): Promise<void>; close(): Promise<void> }`;
  `IServiceBusTransport { send(topic, body): Promise<void>; open(topic, subscription, onMessage):
  Promise<IServiceBusSubscription>; createSubscription(topic, subscription): Promise<void>;
  deleteSubscription(topic, subscription): Promise<void>; close(): Promise<void> }`;
  `ISqsTransport { send(queueUrl, body, delaySeconds?): Promise<void>; receive(queueUrl, max,
  visibilitySeconds): Promise<readonly SqsReceivedMessage[]>; delete(queueUrl, receiptHandle):
  Promise<void>; changeVisibility(queueUrl, receiptHandle, seconds): Promise<void>; close():
  Promise<void> }`;
  `ISnsTransport { publish(topicArn, body): Promise<string | undefined>; close():
  Promise<void> }`.
  Message settle is a promise-shaped callback pair on the port (`{ payload, ack(), nack() }`), so no
  emitter leaks upward.
- **Why not the SDK-shaped structural facades an earlier draft specified:** three of them did not
  match the shipped SDKs. `ISqsClient { sendMessage, receiveMessage, … }` describes AWS SDK **v2**;
  v3's client has `send(command)` (§1.1).
  `IServiceBusClient.createReceiver(topic, { subscription })` is not an overload the SDK has, and
  would silently bind `(queueName, options?)`. And no facade could carry subscription creation for
  Service Bus at all, since that lives on a different class. The repo already solved this shape
  problem: `adaptSesModule` / `adaptAwsS3Module` (`ses-provider.ts:57`, `s3-provider.ts:108`)
  declare only the constructors they use and return a domain port. Following it also makes the
  byte/string boundary (§3.6), the emitter→promise bridge, the `Buffer` avoidance, and the
  two-positional-argument `createReceiver` all **pure, unit-testable adapter code** instead of
  untestable SDK-shaped guesswork — which is what turns §8's "drift is caught by the tests" from a
  claim into a mechanism.
- **Test home:** one `*-adapter.test.ts` per backend driving `adaptXxxModule` over a fake SDK module
  (§3.2/§3.3/§3.4), plus the guarded real-import tests (§6) which adapt the REAL module and assert
  the result satisfies the port.

### 3.9 Verification: SQS against a real server, Pub/Sub and Service Bus fake-driven

- **Decision:** SQS is verified against **ElasticMQ** (`softwaremill/elasticmq-native`), an
  SQS-API-compatible server, in a CI service container with `SQS_ENDPOINT_URL` set — the M53 Redis
  pattern, including the endpoint-scoped `net` grant in `packages/queue-plugin/deno.json` and an
  `ALLOW_SKIP`-style refusal to let the check pass silently when the endpoint is configured. Pub/Sub
  and Service Bus emulators are **declined** and those two backends ship fake-driven plus guarded
  real-import, stated in the CHANGELOG and PUBLIC_API as "not verified against a live backend", the
  way M52 states it for Workers.
- **Why the split:** SQS carries every bespoke claim/settle/attempt decision in this milestone
  (§3.4) — per-name queues, receipt-handle bookkeeping, `ApproximateReceiveCount` as the attempt
  ladder, visibility-timeout backoff, dead-letter ordering — and M37b/M53 both show that this exact
  class of adapter logic passes a fake and fails a real server (the `ZRANGEBYSCORE`-without-`LIMIT`
  defect, the ioredis eager-connect defect). ElasticMQ needs no credentials and is one container.
  The other two are not comparable: the Pub/Sub emulator ships inside the `gcloud` SDK and needs a
  JVM, and the Azure Service Bus emulator requires accepting a licence and a SQL Edge sidecar — two
  multi-container additions to CI for backends whose logic is a thin translation over a pure,
  fully-unit-tested adapter. Declining them is recorded here rather than left to §9 so the plan says
  one thing in one place; an earlier draft claimed "fake-driven" in §0 and "emulator/manual only" in
  §9.
- **Test home:** `packages/queue-plugin/test/e2e/sqs-elasticmq.test.ts` — guarded on
  `SQS_ENDPOINT_URL`; creates two real queues plus a DLQ; drives the plugin's public `IQueue`
  surface through a real `createApplication`; asserts a job added under one name is processed under
  that name and NOT visible to the other name's processor (the per-name isolation §3.4 exists for),
  that a failing job retries with a real visibility-timeout backoff and lands in the real DLQ after
  `defaultMaxAttempts`, and that `attempts` observed by the processor climbs 1→2→3. Plus a CI-wiring
  pin consolidated into `test/apps-gate.test.ts` (the existing `real-backend CI wiring` block)
  rather than a new package-local file — it asserts `packages/queue-plugin/deno.json`'s scoped `net`
  grant covers the ElasticMQ `9324` endpoint alongside the Redis wiring, so dropping the grant turns
  the suite red instead of silently skipping the e2e (the M53 code-review lesson).

### 3.10 Runtime gating — non-Workers-portable SDKs

- **Decision:** each cloud backend checks `runtime.platform() === 'cloudflare-workers'`
  (`common/src/types.ts:33`, `runtime.ts:239`) at the START of `connect()`, before any SDK load
  attempt, and throws a named exported class: `CloudBrokerUnavailableError` from
  `packages/messaging-plugin/src/errors.ts` and `QueueBackendUnavailableError` from a new
  `packages/queue-plugin/src/errors.ts`, each naming the backend and the npm specifier and stating
  that the backend is not Workers-portable. Both are barrel-exported.
- **Why:** none of the three SDKs runs on Workers (gRPC, AMQP over TLS sockets, long-poll — not
  `fetch`). `connect()` is awaited inside `register()` (`messaging-plugin.ts:143`), so the throw
  fails `app.start()` — the earliest possible point, the M45 `WorkerPoolUnavailableError` shape. A
  no-op is refused (C6): publishing into a void is exactly the silent-shim failure the CLAUDE.md
  lazy-load rule forbids. Both packages get a NAMED class so a consumer can `instanceof` each; an
  earlier draft gave messaging a class and SQS a plain `Error` with no stated reason.
- **Test home:** `test/unit/pubsub-broker.test.ts`, `test/unit/service-bus-broker.test.ts`, and
  `test/unit/sqs-queue.test.ts` each assert `connect()` rejects with the named class, and with a
  message naming the backend and specifier, when given a fake runtime whose `platform()` returns
  `'cloudflare-workers'` — and that no SDK load was attempted (the fake module loader records calls
  and must show none).

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                      | Kind          | Consumer / real code path that READS it                                                                                                                                        |
| ------------------------------------------------------------------------------------ | ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MessagingPlugin` (updated signature)                                                | factory       | Application registration; `messaging-plugin.test.ts` selects each arm; the bare-call regression cases (§3.1).                                                                  |
| `GcpPubSubBroker`                                                                    | class         | `MessagingPlugin({ broker: 'pubsub' })` branch; standalone construction; `pubsub-broker.test.ts`.                                                                              |
| `ServiceBusBroker`                                                                   | class         | `MessagingPlugin({ broker: 'service-bus' })` branch; standalone; `service-bus-broker.test.ts`.                                                                                 |
| `adaptPubSubModule`, `loadPubSubModule`                                              | functions     | `GcpPubSubBroker.connect()` lazy path; `pubsub-adapter.test.ts` (pure, fake SDK module); `pubsub-real-import.test.ts` (real module). Mirrors `adaptSesModule`/`loadSesModule`. |
| `adaptServiceBusModule`, `loadServiceBusModule`                                      | functions     | `ServiceBusBroker.connect()`; `service-bus-adapter.test.ts`; `service-bus-real-import.test.ts`.                                                                                |
| `CloudBrokerUnavailableError`                                                        | class         | Both cloud brokers' `connect()` on Workers (§3.10); consumer `instanceof`; gating tests.                                                                                       |
| `ReplyInboxUnavailableError`                                                         | class         | Both cloud brokers' `openInbox` when reply-subscription creation fails (§3.7); consumer `instanceof`; RPC tests.                                                               |
| `IPubSubTransport`, `IPubSubSubscription`                                            | types (ports) | `pubsub-broker.ts` constructor param and `adaptPubSubModule` return; injection fakes; `pubsub-broker.test.ts`.                                                                 |
| `IServiceBusTransport`, `IServiceBusSubscription`                                    | types (ports) | `service-bus-broker.ts` param and `adaptServiceBusModule` return; injection fakes; its tests.                                                                                  |
| `PubSubOptions`, `ServiceBusOptions`                                                 | types         | The `'pubsub'` / `'service-bus'` arms of `MessagingPluginOptions`; each broker's constructor.                                                                                  |
| `MessagingPluginOptions` (union), `MessagingBrokerType` (widened to 8)               | types         | `MessagingPlugin` param; the health payload's `{ broker }` value; `microservice-starter`'s `messaging?` arm; PUBLIC_API.                                                       |
| `SqsQueue`                                                                           | class         | `QueuePlugin({ adapter: 'sqs' })` branch; standalone; `sqs-queue.test.ts`; the ElasticMQ e2e.                                                                                  |
| `SnsPublisher`                                                                       | class         | Application fan-out wiring; `sns-publisher.test.ts`.                                                                                                                           |
| `adaptSqsModule`, `loadSqsModule`, `adaptSnsModule`, `loadSnsModule`                 | functions     | `SqsQueue`/`SnsPublisher` lazy paths; their `*-adapter.test.ts`; `aws-real-import.test.ts`.                                                                                    |
| `ISqsTransport`, `SqsReceivedMessage`, `ISnsTransport`                               | types (ports) | `SqsQueue`/`SnsPublisher` params; injection fakes; their tests.                                                                                                                |
| `QueueBackendUnavailableError`, `SqsQueueNotConfiguredError`, `SqsDelayTooLongError` | classes       | `SqsQueue.connect()` on Workers; an unmapped job name; a `delayMs` above 900 s (§3.4); consumer `instanceof`; their tests.                                                     |
| `SqsQueueOptions`, `SnsPublisherOptions`                                             | types         | `QueuePluginOptions.sqs` / `SnsPublisher` ctor.                                                                                                                                |
| `QueuePluginOptions` (`sqs` bag added), `QueueAdapterType` (`'sqs'` added)           | types         | `QueuePlugin` + PUBLIC_API + `microservice-starter`'s `queue?` arm.                                                                                                            |

### 4.1 Options — every option names its consumer

| Option                                                                     | Consumer                                     | Behavior (per implementation)                                                                                                                                                                                                                          |
| -------------------------------------------------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `MessagingPluginOptions` memory arm — `broker?: 'memory'`                  | `MessagingPlugin` factory                    | The default arm. Keeps `MessagingPlugin()`, `MessagingPlugin({})`, `MessagingPlugin(undefined)`, and the factory's own `= {}` default valid (§3.1).                                                                                                    |
| `broker: 'pubsub'`                                                         | `MessagingPlugin` factory                    | Builds `GcpPubSubBroker`.                                                                                                                                                                                                                              |
| `PubSubOptions.projectId`                                                  | `GcpPubSubBroker` → `adaptPubSubModule`      | Passed to `new PubSub({ projectId })` on the lazy path. Required on the arm unless `client` is supplied, so a missing value is a compile error.                                                                                                        |
| `PubSubOptions.credentials?`                                               | `adaptPubSubModule`                          | Passed through to the SDK constructor when present; omitted → SDK's own ADC discovery.                                                                                                                                                                 |
| `PubSubOptions.client?: IPubSubTransport`                                  | `GcpPubSubBroker` ctor                       | Injected port; when present no SDK load happens (the inject branch a unit test drives directly).                                                                                                                                                       |
| `PubSubOptions.defaultQueue?`                                              | `GcpPubSubBroker.subscribe`                  | Subscription name used when `SubscribeOptions.queue` is absent. Default `'messaging-consumers'`, matching the other brokers.                                                                                                                           |
| `PubSubOptions.replyTopic?`                                                | `GcpPubSubBroker` RPC inbox (§3.7)           | Shared reply topic; must pre-exist. Default `'messaging.replies'`, matching Kafka.                                                                                                                                                                     |
| `broker: 'service-bus'`                                                    | `MessagingPlugin` factory                    | Builds `ServiceBusBroker`.                                                                                                                                                                                                                             |
| `ServiceBusOptions.connectionString`                                       | `ServiceBusBroker` → `adaptServiceBusModule` | Passed to `new ServiceBusClient(...)`. Required on the arm unless `client` is supplied.                                                                                                                                                                |
| `ServiceBusOptions.adminConnectionString?`                                 | `adaptServiceBusModule`                      | Connection string for `ServiceBusAdministrationClient`, used ONLY for the per-instance reply subscription (§3.7). Defaults to `connectionString`; exists because reply-subscription creation needs `Manage` while ordinary publish/subscribe does not. |
| `ServiceBusOptions.client?: IServiceBusTransport`                          | `ServiceBusBroker` ctor                      | Injected port; suppresses the SDK load.                                                                                                                                                                                                                |
| `ServiceBusOptions.defaultQueue?` / `.replyTopic?`                         | `ServiceBusBroker`                           | Subscription name default; shared reply topic (must pre-exist). Same defaults as Pub/Sub.                                                                                                                                                              |
| `broker: 'custom'` + `instance: IMessageBroker`                            | `MessagingPlugin` factory                    | Registers the instance under `messaging`/`messaging.<name>` via `asBrokerAdapter` (§3.5); health reports `{ broker: 'custom' }` with status from the instance's own `isReady` when it has one, else connect-state.                                     |
| `QueuePluginOptions.adapter: 'sqs'` + `sqs: SqsQueueOptions`               | `QueuePlugin` factory                        | Builds `SqsQueue` and wraps it in `QueueService`. A `'sqs'` adapter with no `sqs` bag is a compile error via the additive-bag requirement documented in PUBLIC_API and pinned by a `@ts-expect-error` case.                                            |
| `SqsQueueOptions.queues: Record<string, string>`                           | `SqsQueue.enqueue`/`reserve`                 | Job name → queue URL. An unmapped name throws `SqsQueueNotConfiguredError` (§3.4). Queues must pre-exist.                                                                                                                                              |
| `SqsQueueOptions.deadLetterQueues?: Record<string, string>`                | `SqsQueue.deadLetter`                        | Job name → DLQ URL. Absent for a name → the dead job is logged and deleted, documented.                                                                                                                                                                |
| `SqsQueueOptions.visibilityTimeoutSeconds?`                                | `SqsQueue.reserve`                           | `VisibilityTimeout` on `ReceiveMessage` — how long a claim holds. Default 30.                                                                                                                                                                          |
| `SqsQueueOptions.region?` / `.credentials?` / `.endpoint?`                 | `adaptSqsModule`                             | Passed to `new SQSClient({...})` on the lazy path. `endpoint` is what points the adapter at ElasticMQ in the e2e (§3.9) — an option with a real consumer, not a courtesy.                                                                              |
| `SqsQueueOptions.client?: ISqsTransport`                                   | `SqsQueue` ctor                              | Injected port; suppresses the SDK load.                                                                                                                                                                                                                |
| `SnsPublisherOptions.topicArn` / `.region?` / `.credentials?` / `.client?` | `SnsPublisher`                               | Target topic; SDK constructor arguments on the lazy path; injected port.                                                                                                                                                                               |

## 5. Implementation files

| File                                                                  | Purpose                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/messaging-plugin/src/brokers/pubsub-broker.ts`              | `GcpPubSubBroker implements MessageBrokerAdapter` + `PubSubSdkModule`, `adaptPubSubModule`, `loadPubSubModule` (`npm:@google-cloud/pubsub@^6`); publish/subscribe over `IPubSubTransport`; reply-topic `OpenInbox`; `request`/`respond` via `RequestReplyCore`.              |
| `packages/messaging-plugin/src/brokers/service-bus-broker.ts`         | `ServiceBusBroker implements MessageBrokerAdapter` + `ServiceBusSdkModule` (client AND administration client), `adaptServiceBusModule`, `loadServiceBusModule` (`npm:@azure/service-bus@^7`); reply-topic `OpenInbox`; RPC via `RequestReplyCore`.                           |
| `packages/messaging-plugin/src/brokers/cloud-gate.ts`                 | Shared `assertNotCloudflareWorkers(runtime, backend, sdkSpecifier)` throwing `CloudBrokerUnavailableError`; used by both cloud brokers.                                                                                                                                      |
| `packages/messaging-plugin/src/brokers/custom-adapter.ts`             | `asBrokerAdapter(instance: IMessageBroker): MessageBrokerAdapter` (§3.5).                                                                                                                                                                                                    |
| `packages/messaging-plugin/src/errors.ts` (modified)                  | Add `CloudBrokerUnavailableError`, `ReplyInboxUnavailableError`.                                                                                                                                                                                                             |
| `packages/messaging-plugin/src/interfaces/index.ts` (modified)        | `MessagingPluginOptions` → discriminated union with a default arm; widen `MessagingBrokerType` to 8 literals; add `IPubSubTransport`/`IPubSubSubscription`/`IServiceBusTransport`/`IServiceBusSubscription`, `PubSubOptions`, `ServiceBusOptions`; per-arm `client?` typing. |
| `packages/messaging-plugin/src/plugin/messaging-plugin.ts` (modified) | Union-arm dispatch; `pubsub`/`service-bus`/`custom` branches; `custom` registers via `asBrokerAdapter`; health payload typed `MessagingBrokerType`.                                                                                                                          |
| `packages/messaging-plugin/src/index.ts` (modified)                   | Export the two brokers, four adapt/load functions, two ports (+ their subscription types), the new option types, both new error classes.                                                                                                                                     |
| `packages/queue-plugin/src/adapters/sqs-queue.ts`                     | `SqsQueue implements QueueAdapter` + `SqsSdkModule`, `adaptSqsModule`, `loadSqsModule` (`npm:@aws-sdk/client-sqs@^3`); per-name queue URLs, receipt-handle map, `ApproximateReceiveCount` attempts, visibility backoff, DLQ ordering, in-memory recurring.                   |
| `packages/queue-plugin/src/sns/sns-publisher.ts`                      | `SnsPublisher` + `SnsSdkModule`, `adaptSnsModule`, `loadSnsModule` (`npm:@aws-sdk/client-sns@^3`).                                                                                                                                                                           |
| `packages/queue-plugin/src/errors.ts` (new)                           | `QueueBackendUnavailableError`, `SqsQueueNotConfiguredError`, `SqsDelayTooLongError`.                                                                                                                                                                                        |
| `packages/queue-plugin/src/interfaces/index.ts` (modified)            | Add `'sqs'` to `QueueAdapterType`; add `SqsQueueOptions`, `SnsPublisherOptions`, `ISqsTransport`, `SqsReceivedMessage`, `ISnsTransport`.                                                                                                                                     |
| `packages/queue-plugin/src/plugin/queue-plugin.ts` (modified)         | Add the `'sqs'` switch branch building `SqsQueue` + `QueueService` from `options.sqs`.                                                                                                                                                                                       |
| `packages/queue-plugin/src/index.ts` (modified)                       | Export `SqsQueue`, `SnsPublisher`, the four adapt/load functions, the ports, the option types, the three error classes.                                                                                                                                                      |
| `packages/queue-plugin/deno.json` (modified)                          | Add the ElasticMQ endpoint to the endpoint-scoped `test.permissions.net` list (§3.9).                                                                                                                                                                                        |
| `.github/workflows/ci.yml` (modified)                                 | Add the ElasticMQ service container + job-level `SQS_ENDPOINT_URL` (§3.9), the M53 Redis pattern.                                                                                                                                                                            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                    | src covered                                                       | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `messaging-plugin/test/unit/pubsub-broker.test.ts`                           | `pubsub-broker.ts` (broker half), `cloud-gate.ts`                 | publish→subscribe round trip via recording `IPubSubTransport`; subscription created only when absent; ack on success, nack on handler throw; no topic-creation call ever made; `request`/`respond` round trip — inbox created once across two requests, `replyTo` is the reply TOPIC, foreign correlation id dropped, deleted on `disconnect`, creation failure → `ReplyInboxUnavailableError`; `connect()` rejects `CloudBrokerUnavailableError` on a `cloudflare-workers` fake runtime with no load attempted. Against `IMessageBroker` (`messaging.ts:98`) + `IPubSubTransport`. |
| `messaging-plugin/test/unit/pubsub-adapter.test.ts`                          | `pubsub-broker.ts` (`adaptPubSubModule` half)                     | PURE adapter over a fake `PubSubSdkModule`: `publishMessage` receives `{ data }` bytes carrying the serialized string; non-ASCII round trip through `TextEncoder`/`TextDecoder`; `json` never used; `Buffer`-shaped inbound data decodes; `on('message')`→promise bridge; `ack`/`nack` routing; `createSubscription` on the TOPIC object; `close`.                                                                                                                                                                                                                                  |
| `messaging-plugin/test/unit/service-bus-broker.test.ts`                      | `service-bus-broker.ts` (broker half), `cloud-gate.ts`            | round trip via recording `IServiceBusTransport`; complete on success, abandon on throw; sender/receiver caching and close on `disconnect`; the same five RPC assertions as Pub/Sub; Workers gating throw with no load attempted.                                                                                                                                                                                                                                                                                                                                                    |
| `messaging-plugin/test/unit/service-bus-adapter.test.ts`                     | `service-bus-broker.ts` (`adaptServiceBusModule` half)            | PURE adapter over a fake `ServiceBusSdkModule`: `createReceiver` called with `(topicName, subscriptionName)` POSITIONALLY (the regression test for `service-bus.d.ts:1653`); `createSender(topic).sendMessages({ body })`; `processMessage`/`processError` wired; administration client used for create/delete subscription and NOT for ingress; `adminConnectionString` default.                                                                                                                                                                                                   |
| `messaging-plugin/test/unit/pubsub-real-import.test.ts`                      | `pubsub-broker.ts` lazy path                                      | Guarded: skip-log when `@google-cloud/pubsub` is absent; else `adaptPubSubModule(await loadPubSubModule(), { projectId: 'demo' })` and assert every `IPubSubTransport` member is a function — i.e. the REAL SDK satisfies the port. No network.                                                                                                                                                                                                                                                                                                                                     |
| `messaging-plugin/test/unit/service-bus-real-import.test.ts`                 | `service-bus-broker.ts` lazy path                                 | Same shape for `@azure/service-bus`, with a WELL-FORMED dummy connection string (`Endpoint=sb://…;SharedAccessKeyName=…;SharedAccessKey=…`), because `new ServiceBusClient` throws on a malformed one.                                                                                                                                                                                                                                                                                                                                                                              |
| `messaging-plugin/test/unit/messaging-plugin.test.ts` (extended)             | `messaging-plugin.ts`, `custom-adapter.ts`, `interfaces/index.ts` | Per-arm selection for all eight arms; `MessagingPlugin()` / `({})` / `(undefined)` are valid and memory-backed (§3.1); `'custom'` registers the injected instance, with and without its own `isReady`, and health reflects each (§3.5); health payload `{ broker }` for every arm; `@ts-expect-error` cases for a credential-less `'pubsub'` arm, a credential-less `'service-bus'` arm, and `'custom'` with no `instance`.                                                                                                                                                         |
| `messaging-plugin/test/unit/messaging-errors.test.ts` (extended)             | `errors.ts`                                                       | Both new classes: `name`, message content (backend + specifier for the gate error; topic + `Manage` for the inbox error), and `instanceof Error`.                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `messaging-plugin/test/unit/barrel-exports.test.ts` (extended)               | `index.ts`                                                        | The new value exports are present and the new types are exported.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `messaging-plugin/test/integration/messaging-integration.test.ts` (extended) | `messaging-plugin.ts` end-to-end                                  | Through a REAL `createApplication` (the file already does this at `:6`): a `'custom'` instance resolves from `CAPABILITIES.MESSAGING` and its health indicator reports; a `'pubsub'` arm with an injected port publishes and receives; a bare `MessagingPlugin()` boots. This is the M51 lesson — the per-arm unit file drives a hand-rolled context, so an arm can pass there and be unreachable through the kernel.                                                                                                                                                               |
| `queue-plugin/test/unit/sqs-queue.test.ts`                                   | `sqs-queue.ts` (adapter half), `errors.ts`                        | The full §3.4 list: enqueue→reserve→ack; per-name URL selection + unmapped-name throw; `delayMs` rounding and the >900 s throw; `limit > 10` clamped; requeue visibility seconds; dead-letter ordering incl. DLQ-send-fails leaving the source undeleted, and missing-DLQ log-and-delete; the `ApproximateReceiveCount` attempt ladder 1→2→3→dead-letter; unknown/expired receipt handle resolves without an SQS call; missing `ReceiptHandle` skipped; in-memory recurring; Workers gating throw. Against `QueueAdapter` (`queue-adapter.ts:20`) + `ISqsTransport`.                |
| `queue-plugin/test/unit/sqs-adapter.test.ts`                                 | `sqs-queue.ts` (`adaptSqsModule` half)                            | PURE adapter over a fake `SqsSdkModule`: each of the four commands constructed with the documented input; `MessageSystemAttributeNames` used, deprecated `AttributeNames` absent; `endpoint`/`region`/`credentials` reach the client constructor; `close` → `destroy`.                                                                                                                                                                                                                                                                                                              |
| `queue-plugin/test/unit/sns-publisher.test.ts`                               | `sns-publisher.ts`                                                | `publish` sends the documented payload via recording `ISnsTransport`; topic resolution; the pure `adaptSnsModule` over a fake module constructs `PublishCommand` with `{ TopicArn, Message }`.                                                                                                                                                                                                                                                                                                                                                                                      |
| `queue-plugin/test/unit/aws-real-import.test.ts`                             | `sqs-queue.ts`, `sns-publisher.ts` lazy paths                     | Guarded: skip-log when the AWS SDKs are absent; else adapt BOTH real modules and assert each port's members are functions. Shared guard, both packages' specifiers named.                                                                                                                                                                                                                                                                                                                                                                                                           |
| `queue-plugin/test/unit/queue-plugin.test.ts` (extended)                     | `queue-plugin.ts`                                                 | The `'sqs'` branch builds `SqsQueue` wrapped in `QueueService` and registers under `queue`/`queue.<name>`; health indicator present; `onClose` disconnects.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `queue-plugin/test/unit/barrel-exports.test.ts` (extended)                   | `index.ts`                                                        | New value and type exports present.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `test/apps-gate.test.ts` (extended — real-backend CI wiring)                 | none (gate wiring)                                                | Consolidates the ElasticMQ CI-wiring pin into the existing workspace gate rather than a new package-local file: asserts `packages/queue-plugin/deno.json`'s scoped `net` grant covers the `9324` endpoint alongside the Redis `6379` grant, so removing the grant fails the suite instead of silently skipping the e2e (§3.9, the M53 code-review lesson). No package-local `ci-wiring.test.ts` was created.                                                                                                                                                                        |
| `queue-plugin/test/e2e/sqs-elasticmq.test.ts`                                | `sqs-queue.ts` against a real server                              | §3.9: two real queues + a DLQ; through a real `createApplication` and the public `IQueue`; per-name isolation; real retry backoff; real DLQ landing after `defaultMaxAttempts`; `attempts` 1→2→3 observed by the processor.                                                                                                                                                                                                                                                                                                                                                         |
| `queue-plugin/test/integration/queue-integration.test.ts` (extended)         | `queue-plugin.ts` end-to-end                                      | The `'sqs'` arm through a real `createApplication` with an injected `ISqsTransport`: `add` → processor runs → job read back, so the arm is proven reachable through the kernel even when ElasticMQ is absent.                                                                                                                                                                                                                                                                                                                                                                       |
| `test/fixtures` additions (both packages)                                    | fakes                                                             | `fake-pubsub-transport.ts`, `fake-pubsub-sdk-module.ts`, `fake-service-bus-transport.ts`, `fake-service-bus-sdk-module.ts`, `fake-sqs-transport.ts`, `fake-sqs-sdk-module.ts`, `fake-sns-transport.ts`, `fake-sns-sdk-module.ts`. Every SDK-module fake reproduces the shipped `.d.ts` shape verified in §1.1 — in particular `createReceiver(topicName, subscriptionName)` and v3 command constructors — because a fake that accepts anything is how the corrected defects would have shipped green (the M53 `zrangebyscore: () => []` lesson).                                    |

> Coverage bar: every new and modified `src` file ≥90% branch/function/line, read ANSI-stripped from
> the per-file table. Each backend's file is split across a broker/adapter test pair precisely so
> the lazy-load branch is the only line behind a guarded test; the inject-vs-lazy branch itself is
> asserted directly by passing and omitting `client`.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m54-cloud-message-brokers, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test              # run BOTH with SQS_ENDPOINT_URL set and unset (M53's both-conditions bar)
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # both packages are already published members; run on the COMMITTED tree
deno task release:verify <version>
```

Forbidden-construct grep (must be empty, comments excepted) for each touched package — run it on the
FILE, not only through grep, since M50 shipped a raw NUL byte that made `grep -rn` skip a source
file silently and report a false pass:

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" \
  packages/messaging-plugin/src packages/queue-plugin/src
file packages/messaging-plugin/src/brokers/*.ts packages/queue-plugin/src/adapters/*.ts   # all "text"
grep -rn "Buffer" packages/messaging-plugin/src   # must be empty (§3.6)
```

Evidence to paste when handing back: the per-file coverage table, both grep results, the `file`
output, the exit status of both publish gates, and the ElasticMQ e2e output under both conditions.

## 8. Risks & mitigations

- **Cloud SDK API drift** → the SDK surface is confined to a declared `XxxSdkModule` constructor
  list and one pure `adaptXxxModule` (§3.8), so a drift is a compile error in one file rather than a
  runtime surprise spread through a broker; the SDK-module fakes reproduce the shapes verified in
  §1.1, and the guarded real-import tests assert the REAL module still satisfies the port. Three
  shapes an earlier draft had wrong (`createReceiver`, v3 command-vs-method clients, admin-only
  subscription creation) are each pinned by a named assertion.
- **`@google-cloud/pubsub@^6` declares `engines.node >= 22`** → not enforced by Deno, and the
  guarded test will surface a resolution failure as a skip rather than a false pass. If the SDK
  proves unimportable under Deno, the guarded test stays skipped and the lazy path is unverified —
  which is why the inject path, the adapter, and the branching are all separately unit-tested and
  why the limitation is stated in PUBLIC_API rather than implied.
- **Reply-subscription leaks** → the inbox opens exactly one per-instance subscription lazily and
  `disconnect()` deletes it through `RequestReplyCore.close()`, which already awaits an in-flight
  open (`request-reply-core.ts:220-236`); both broker tests assert creation-once and deletion. A
  process killed without `disconnect` leaves an orphan subscription — documented, with the Pub/Sub
  `expirationPolicy` and Service Bus `autoDeleteOnIdle` named as the operator-side mitigation.
- **SQS attempt counting is approximate** → `ApproximateReceiveCount` advances on a lapsed
  visibility as well as a real failure, so a worker that dies mid-job can cost a job one attempt.
  Inherent to at-least-once delivery, documented in PUBLIC_API, and pinned by the ladder test so the
  intended behaviour is at least exact for the normal path.
- **SQS redrive policy vs plugin attempts** → the platform's own `maxReceiveCount` must be ≥
  `defaultMaxAttempts`, else SQS moves a message to its own DLQ before the plugin dead-letters it.
  Documented as a deployment prerequisite (the plugin cannot read queue attributes without extra
  IAM), and the ElasticMQ e2e configures it explicitly so the interaction is exercised rather than
  assumed.
- **Breaking the published `MessagingPluginOptions` type** → pre-1.0 and ROADMAP-mandated; the
  default arm (§3.1) keeps every documented call shape valid, three regression tests pin them, and
  the CHANGELOG entry states exactly which shape does break (a caller holding a widened variable).
  The CLI drift gate and the starter are the two things that would have gone red; both are named in
  §1 and neither needs an edit.
- **M53-style net-grant footgun** → the ElasticMQ grant is endpoint-scoped inside
  `packages/queue-plugin/deno.json`, never a CLI/root `--allow-net` list (which REPLACES the package
  block) and never loopback-wide (ioredis-style infinite retry against a refused port hung M53's
  runner for 110 s). `messaging-plugin` gains no grant at all.
- **A guarded test that silently never runs** → `test/apps-gate.test.ts`'s `real-backend CI wiring`
  block pins the CI service, port, env var, and grant (§3.9); the suite is run under both conditions
  per §7.

## 9. Out of scope

- Live AWS/GCP/Azure account verification — credentials cannot be exposed to fork pull requests.
  Stated as a documented limitation in CHANGELOG and PUBLIC_API, the way M52's "not verified against
  a live Worker" is.
- Pub/Sub and Azure Service Bus **emulators** in CI — declined with cause in §3.9 (JVM/`gcloud` and
  licence-plus-SQL-Edge multi-container additions, for backends that are a thin translation over a
  fully unit-tested pure adapter). SQS **is** verified against ElasticMQ; the split is deliberate
  and the two statements agree.
- Kinesis / EventBridge / Azure Event Hubs — streaming rather than brokered; no owning milestone.
- A composite AWS `IMessageBroker` — AWS pub/sub is the documented SNS+SQS pair (`SnsPublisher` +
  `SqsQueue`), not one broker.
- Full `QueuePluginOptions` discriminated-union refactor — only `MessagingPluginOptions` is
  mandated; SQS is an additive `'sqs'` arm with a dedicated options bag.
- Making SQS a direct `IQueue` — declined; SQS is poll-based and uses the `QueueAdapter` +
  `QueueService` path like `RabbitMqQueue`. (`WorkersQueue`'s direct-`IQueue` shape is push-only.)
- Creating cloud resources (topics, SQS queues, ordinary subscriptions) — declined in §3.6; only the
  per-instance RPC reply subscription and Pub/Sub's consumer-group subscription are created.
- A `serviceDiscovery`-style starter arm for the new backends, and CLI template wiring for them —
  the default arm (§3.1) means no starter or CLI change is needed by this milestone, and adding
  cloud arms to a starter would bundle a credential-requiring backend into a curated default.
