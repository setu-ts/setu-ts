# Milestone 14b — Messaging Brokers (`@hono-enterprise/messaging-plugin`)

> **Status:** Planning. Branch: `feat/m14b-messaging-brokers`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.
>
> **Plan file naming note.** The canonical-plan gate (`scripts/plan-lint.ts`, regex
> `milestone-\d+-...`) cannot represent the `14b` suffix (digits then a dash), so this file is named
> `milestone-14-b-messaging-brokers.md`, which matches the gate and still encodes "Milestone 14b".
> The git branch keeps the conventional `feat/m14b-messaging-brokers` form.

## 0. Objective & scope

Milestone 14b completes the messaging capability by adding the three remaining production brokers —
RabbitMQ, NATS, and Kafka — to the **existing** `@hono-enterprise/messaging-plugin` package from
M14. Each broker implements the **committed, unchanged** `IMessageBroker` contract
([`packages/common/src/services/messaging.ts`](packages/common/src/services/messaging.ts)) plus the
internal `MessageBrokerAdapter.isReady()` seam already implemented by `InMemoryBroker` and
`RedisStreamsBroker`. They are selected through the existing `MessagingPlugin({ broker })` option —
**no new capability token, no `common` change**. `common` is not touched in this milestone.

This milestone is the "no-stubs" counterpart to M14: every broker lands with the full inject-or-lazy
client seam and a guarded real `import('npm:<pkg>')` test, mirroring `RedisStreamsBroker` exactly.
The M10 failure mode (adapters that echo input and return `[]` at 90% coverage) is the explicit
anti-goal: each broker is driven through a recording fake that asserts the **real transport calls**
and reads the delivered payload back, plus one guarded real-import test that exercises the lazy-load
function.

- **In scope:**
  - `RabbitMqBroker` — AMQP 0-9-1 via `npm:amqplib@0.10.x` (topic exchange + queues, per-message
    ack/nack).
  - `NatsBroker` — NATS **JetStream** via `npm:nats@2.x` (durable consumers, ack/nak).
  - `KafkaBroker` — Kafka via `npm:kafkajs@2.x` (producer/consumer, consumer groups, offset commit
    gated on handler success).
  - Extend `MessagingBrokerType` to include the three new broker ids; widen
    `MessagingPluginOptions.client`; add per-broker internal option types.
  - Extend the plugin's backend selection and the barrel; per-broker recording-fake unit tests +
    guarded real-import tests + fixtures.
  - Documentation corrections/additions in `PUBLIC_API.md`, `ARCHITECTURE.md`, `ROADMAP.md` in the
    **same PR** (incl. resolving the `PUBLIC_API.md` staleness found in §2).
- **NOT this milestone:**
  - Live-broker integration tests (a running RabbitMQ/NATS/Kafka) — deferred; the project bar is
    recording-fake + guarded real-import, matching M14's RedisStreams precedent (see §9).
  - RabbitMQ dead-letter exchanges, JetStream advisories/limits/stream replication tuning, Kafka
    transactions/exactly-once, schema registry, TLS/SASL auth options — deferred (configurable later
    via options).
  - Any change to `IMessageBroker` or a new capability token — none (the contract is fixed; brokers
    reuse `CAPABILITIES.MESSAGING`).

## 1. Contracts verified from SOURCE (not names)

Every reference below was opened in the committed source and cited at file:line. External npm
packages cite the specifier plus the API surface the design relies on; the guarded real-import test
(§6) confirms the load path resolves.

| Reference                                     | Source (file:line)                                                                                                                                                                                                                                                                | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IMessageBroker`                              | [`packages/common/src/services/messaging.ts:70`](packages/common/src/services/messaging.ts)                                                                                                                                                                                       | Exactly `connect(): Promise<void>` (74), `disconnect(): Promise<void>` (78), `publish<T>(topic, message): Promise<void>` (86), `subscribe<T>(topic, handler, options?): Promise<ISubscription>` (96-100). No widening, no extra public methods.                                                                                                                                                                                                                                                                                                                                                                          |
| `MessageMetadata`                             | [`packages/common/src/services/messaging.ts:14`](packages/common/src/services/messaging.ts)                                                                                                                                                                                       | `readonly topic: string` + optional `messageId?: string`, `timestamp?: Date`, `headers?: Readonly<Record<string,string>>`. Brokers populate what the transport exposes; nothing beyond.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MessageHandler<T>`                           | [`packages/common/src/services/messaging.ts:33`](packages/common/src/services/messaging.ts)                                                                                                                                                                                       | `(message: T, metadata: MessageMetadata) => void \| Promise<void>`; broker `await`s it and gates ack on resolution/rejection.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `SubscribeOptions`                            | [`packages/common/src/services/messaging.ts:43`](packages/common/src/services/messaging.ts)                                                                                                                                                                                       | Only `queue?: string`. NATS durable name, Kafka `groupId`, and RabbitMQ queue name all reuse this one field — **no new subscribe option** is added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `ISubscription`                               | [`packages/common/src/services/messaging.ts:53`](packages/common/src/services/messaging.ts)                                                                                                                                                                                       | `unsubscribe(): Promise<void>` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `MessageBrokerAdapter` (internal)             | [`packages/messaging-plugin/src/brokers/message-broker.ts:11`](packages/messaging-plugin/src/brokers/message-broker.ts)                                                                                                                                                           | `extends IMessageBroker` + `isReady(): boolean` (18). The new brokers `implements MessageBrokerAdapter`. **Not** exported from the barrel (matches M14).                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MessagingBrokerType`                         | [`packages/messaging-plugin/src/interfaces/index.ts:44`](packages/messaging-plugin/src/interfaces/index.ts)                                                                                                                                                                       | Currently `'memory' \| 'redis-streams'`; **extended** to add `'rabbitmq' \| 'nats' \| 'kafka'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `MessagingPluginOptions`                      | [`packages/messaging-plugin/src/interfaces/index.ts:51`](packages/messaging-plugin/src/interfaces/index.ts)                                                                                                                                                                       | `broker?`, `name?`, `serializer?`, `url?`, `client?: IRedisStreamsClient` (86), `defaultQueue?`, `pollIntervalMs?`, `blockSizeMs?`. `client` is **widened** to a union (§3.6); `url`/`client` reused; new flat options added (§4.1).                                                                                                                                                                                                                                                                                                                                                                                     |
| `RedisStreamsOptions`                         | [`packages/messaging-plugin/src/interfaces/index.ts:115`](packages/messaging-plugin/src/interfaces/index.ts)                                                                                                                                                                      | The precedent for a per-broker **internal** option type (url, client, defaultQueue, pollIntervalMs, blockSizeMs, logger). `RabbitMqOptions`/`NatsOptions`/`KafkaOptions` follow it.                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `IRedisStreamsClient`                         | [`packages/messaging-plugin/src/interfaces/index.ts:16`](packages/messaging-plugin/src/interfaces/index.ts)                                                                                                                                                                       | Precedent for an internal structural client type, used by `validateClient`; **not** barrel-exported. `IAmqpConnection`/`INatsConnection`/`IKafkaFactory` follow it.                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `CAPABILITIES.MESSAGING`                      | [`packages/common/src/tokens.ts:55`](packages/common/src/tokens.ts)                                                                                                                                                                                                               | `'messaging'`. Reused unchanged; named instances use `createCapabilityToken('messaging.<name>')`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `createCapabilityToken` grammar               | [`packages/common/src/tokens.ts:139`](packages/common/src/tokens.ts)                                                                                                                                                                                                              | lowercase kebab segments + dot namespacing; colons illegal. **No new token is introduced**, so no grammar exercise is needed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `IRuntimeServices` (clock/timer)              | [`packages/common/src/runtime.ts:131`](packages/common/src/runtime.ts)                                                                                                                                                                                                            | `uuid()` (131), `now()` (147), `setInterval` (176), `clearInterval` (182). Message ids/timestamps and any timers go through these — no `Date.now()`, no global timers (CLAUDE.md "Never mix clocks"; AI_GUIDELINES §4).                                                                                                                                                                                                                                                                                                                                                                                                  |
| `ISerializer`                                 | [`packages/messaging-plugin/src/serializers/serializer.ts:13`](packages/messaging-plugin/src/serializers/serializer.ts)                                                                                                                                                           | `serialize<T>(value): string` (22), `deserialize<T>(payload): T` (32). Injected into each broker exactly as in `RedisStreamsBroker`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `RedisStreamsBroker` seam (reference)         | [`packages/messaging-plugin/src/brokers/redis-streams-broker.ts:18`](packages/messaging-plugin/src/brokers/redis-streams-broker.ts)                                                                                                                                               | `loadIoredis()` lazy `await import('npm:ioredis@5.x')` (18-21); `validateClient(client): client is …` checks the exact methods (30-41); file-local `resolveClient(url, injected?)` prefers injected then lazy-loads (52-67); class `implements MessageBrokerAdapter` with `#ready`/`#client`, ack-on-success / no-ack-on-failure (277-284). Each new broker mirrors this shape.                                                                                                                                                                                                                                          |
| Plugin backend selection                      | [`packages/messaging-plugin/src/plugin/messaging-plugin.ts:80`](packages/messaging-plugin/src/plugin/messaging-plugin.ts)                                                                                                                                                         | `register()` builds the broker by `brokerType`, builds the per-broker options **assigning only defined values** to satisfy `exactOptionalPropertyTypes` (93-103), `await broker.connect()`, `ctx.services.register<IMessageBroker>(token, broker)`, health via `broker.isReady()` (116-121), `ctx.lifecycle.onClose(() => broker.disconnect())` (125-127). New branches reuse this exact wiring.                                                                                                                                                                                                                         |
| Barrel exports                                | [`packages/messaging-plugin/src/index.ts:35`](packages/messaging-plugin/src/index.ts)                                                                                                                                                                                             | Broker classes + option types exported; internal structural client types and `MessageBrokerAdapter` are **not**. M14b adds the three broker classes + three option types only.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Recording-fake test precedent                 | [`packages/messaging-plugin/test/unit/redis-streams-broker.test.ts:33`](packages/messaging-plugin/test/unit/redis-streams-broker.test.ts) + [`packages/messaging-plugin/test/fixtures/fake-ioredis-client.ts:22`](packages/messaging-plugin/test/fixtures/fake-ioredis-client.ts) | Fake records every call; tests assert the real transport call (publish → `xadd`), read back seeded payloads, and assert ack-on-success / no-ack-on-failure. Each new broker test mirrors this.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Guarded real-import precedent                 | [`packages/messaging-plugin/test/unit/redis-streams-broker.test.ts:597`](packages/messaging-plugin/test/unit/redis-streams-broker.test.ts)                                                                                                                                        | Build the broker with **no** injected client + a non-existent endpoint, call `connect()`, assert it rejects — which enters the real `await import('npm:ioredis@5.x')` path so the lazy-load function is covered regardless of install. Each new broker gets exactly one such test.                                                                                                                                                                                                                                                                                                                                       |
| `amqplib` API                                 | `npm:amqplib@0.10.x`                                                                                                                                                                                                                                                              | `connect(url): Promise<Connection>`; `Connection.createChannel(): Promise<Channel>`; `Connection.close(): Promise<void>`; `Channel.assertExchange/assertQueue/bindQueue/publish/consume/ack/nack/close/cancel`. Messages carry `content: Buffer`, `fields.routingKey`, `properties.messageId`/`timestamp`/`headers`. Per-message ack via `channel.ack(msg)`; reject-without-requeue via `channel.nack(msg, false, false)` — the real signature is `nack(message, allUpTo = false, requeue = true)`, so the third arg MUST be `false` to avoid requeue (omitting it requeues). Confirmed by the guarded real-import test. |
| `nats` API                                    | `npm:nats@2.x`                                                                                                                                                                                                                                                                    | `connect({servers}): Promise<NatsConnection>`; `NatsConnection.jetstream()` (sync) / `.jetstreamManager()` (**async — returns a `Promise`, must be `await`ed**) / `.close()`; JetStream `js.publish(subject, data)`; durable consumers via `jsm.consumers.add` / `consumer.consume({callback})`; messages carry `.ack()` / `.nak()` / `.seq` / `.info.timestamp`. **Core NATS has no per-message ack** → JetStream is mandatory (§3.4).                                                                                                                                                                                  |
| `kafkajs` API                                 | `npm:kafkajs@2.x`                                                                                                                                                                                                                                                                 | `new Kafka({clientId, brokers})`; `kafka.producer()` + `producer.connect()`/`.send({topic, messages})`/`.disconnect()`; `kafka.consumer({groupId})` + `consumer.connect()`/`.subscribe({topic})`/`.run({eachMessage})`/`.stop()`/`.disconnect()`. Offsets auto-commit after `eachMessage` resolves; a thrown `eachMessage` prevents the commit and redelivers. `message.value` is `Buffer`, `message.offset`/`.timestamp`/`.key` available.                                                                                                                                                                              |
| AI_GUIDELINES: inject-or-lazy                 | [`AI_GUIDELINES.md:687`](AI_GUIDELINES.md) (and :792)                                                                                                                                                                                                                             | Heavy deps (broker clients) are never bundled; adapters accept an injected client, and when none is supplied, lazily `import()` an `npm:` specifier, failing with a clear error if absent.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| AI_GUIDELINES: runtime confinement / no-`any` | [`AI_GUIDELINES.md:221`](AI_GUIDELINES.md) (and :513, :945)                                                                                                                                                                                                                       | No `process`/`Deno`/`Bun`/`globalThis` in plugins; runtime ops via `IRuntimeServices`; no `any` types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ROADMAP M14b scope                            | [`ROADMAP.md:1723`](ROADMAP.md)                                                                                                                                                                                                                                                   | Deliverables: three brokers with inject-or-lazy seam + guarded real-import; recording fakes asserting real transport calls + ack-on-success / no-ack-on-failure; `MessagingBrokerType` + plugin + barrel; 90%+ per-file; docs in same PR.                                                                                                                                                                                                                                                                                                                                                                                |
| ARCHITECTURE messaging                        | [`ARCHITECTURE.md:1199`](ARCHITECTURE.md) (and :2307)                                                                                                                                                                                                                             | messaging-plugin responsibilities/Public API/Rules; transport adapters follow `implements IMessageBroker`. M14b extends the responsibilities/Public API rows.                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Resolution (picked side)                                                                                                                                                                                                                                               | Doc deliverable (same PR)                                       |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------- |
| C1 | `PUBLIC_API.md` documents `MessagingPluginOptions` as `{ broker: 'memory' \| 'redis-streams'` (required); `name?`; `version?`; `options?: { url; defaultQueue } }` ([`PUBLIC_API.md:1301`](PUBLIC_API.md)). The committed source shape is different and richer ([`packages/messaging-plugin/src/interfaces/index.ts:51`](packages/messaging-plugin/src/interfaces/index.ts)): `broker?` (optional, `MessagingBrokerType`, defaults `'memory'`), flat `url?`/`client?`/`defaultQueue?`/`pollIntervalMs?`/`blockSizeMs?`/`serializer?`, and **no `version`/nested-`options` field at all**. | The **source is the truth**; `PUBLIC_API.md` was stale/aspirational. Rewrite the `MessagingPluginOptions` block in `PUBLIC_API.md` to match the real shape (including M14b's widened `client` union and new flat options from §4.1), and document all five broker ids. | `PUBLIC_API.md` "Messaging → Plugin Options" rewrite (same PR). |
| C2 | `PUBLIC_API.md` "Exports" lists only `InMemoryBroker` + `RedisStreamsBroker` ([`PUBLIC_API.md:1400`](PUBLIC_API.md)). M14b adds three broker classes + three option types.                                                                                                                                                                                                                                                                                                                                                                                                                | Add the new exports to the documented list (and note internal structural client types are intentionally not exported).                                                                                                                                                 | `PUBLIC_API.md` "Exports" update (same PR).                     |
| C3 | `ROADMAP.md` M14b brief ([`ROADMAP.md:1753`](ROADMAP.md)) describes Kafka as "manual offset commit"; `kafkajs`'s `eachMessage` does not expose a per-message commit call — the idiomatic way to gate commit on handler success is auto-commit-on-resolve with throw-on-failure (§3.5).                                                                                                                                                                                                                                                                                                    | Pick the auto-commit-on-resolve + throw-on-failure model (§3.5) and document it; the ROADMAP "manual commit" phrasing is reconciled to "offset commit is gated on handler success" in the docs deliverable.                                                            | `ROADMAP.md` M14b + `PUBLIC_API.md` Kafka note (same PR).       |

No other committed-doc conflicts were found (checked `ARCHITECTURE.md` messaging rows :1199-1209 —
consistent with the source).

## 3. Design decisions

### 3.1 The inject-or-lazy client seam (one mechanism per broker, mirroring Redis)

- **Decision:** Each broker ships three file-local helpers exactly like `RedisStreamsBroker`:
  `loadX()` doing `await import('npm:<pkg>@<pin>)` and returning the constructor/factory;
  `validateClient(client): client is IXxx` checking the **exact** methods that broker calls;
  `resolveClient(opts, injected?)` preferring an injected client (validated) and otherwise
  lazy-loading. `validateClient` is exported from the broker file for direct unit test;
  `loadX`/`resolveClient` stay file-local; the structural client types live in `interfaces/index.ts`
  and are **not** barrel-exported (same as `IRedisStreamsClient`).
- **Why:** This is the committed M14 pattern and the AI_GUIDELINES §12.2 inject-or-lazy rule; it
  keeps the heavy client out of the bundle and makes the branching unit-testable through the
  injection seam.
- **When the lazy import succeeds / fails:** `loadX()` resolves when the package is installed in the
  workspace cache; when absent, the dynamic `import('npm:<pkg>')` rejects with a module-resolution
  error. For all three transports, `connect()` with no injected client and a non-existent endpoint
  also rejects during the real connect handshake — so the guarded real-import test (§6) always
  enters `loadX()` and covers the lazy-load branch regardless of whether the package is installed.
- **Test home:** each broker's `validateClient` test (rejects null/non-object/partial; accepts full
  shape), the "resolveClient prefers injected client" test, and the one guarded real-import test.

### 3.2 RabbitMQ: topic-exchange model + ack-on-success / nack-on-failure

- **Decision:** `RabbitMqBroker` maps the contract onto an AMQP **topic exchange**. `connect()`
  resolves the `amqplib` `Connection` (injected, and when none supplied `await loadAmqplib()(url)`)
  and opens one `Channel`. `publish(topic, msg)` does
  `channel.assertExchange(exchangeName, 'topic')` (idempotent) then
  `channel.publish(exchangeName, topic, Buffer.from(serialized), { messageId, timestamp, headers })`.
  `subscribe(topic, handler, { queue })` asserts a queue — named `options.queue` for
  competing-consumers load balancing, and an exclusive server-named queue when `queue` is omitted
  (fanout to every subscriber) — `bindQueue(queue, exchangeName, topic)`, then
  `channel.consume(queue, onMsg, { noAck: false })`. On `await handler(...)` success →
  `channel.ack(msg)`; on rejection → `channel.nack(msg, false, false)` (signature
  `nack(message, allUpTo, requeue)`; the third arg `false` means **no requeue**, avoiding a
  poison-message hot-loop — note `requeue` defaults to `true`, so the arg cannot be omitted;
  dead-letter exchange wiring is out of scope, §9). `messageId`/`timestamp`/`headers` are read from
  `msg.properties` when present, falling back to `runtime.uuid()` / `new Date(runtime.now())`.
  `disconnect()` cancels consumers, closes the channel, then `connection.close()`.
  `ISubscription.unsubscribe()` cancels just that consumer (and deletes its exclusive queue when one
  was created).
- **Why:** A topic exchange is the AMQP-native fit for `topic`-string pub/sub; the `queue` option
  maps cleanly to AMQP queue semantics (competing consumers vs. fanout). `nack(msg, false, false)`
  is the safe failure choice that is unambiguously testable (handler throws → no `ack`, a `nack`
  with `requeue=false` is recorded).
- **Test home:** `rabbitmq-broker.test.ts` — publish asserts the real
  `publish(exchange, topic, buffer)` call; subscribe consumes a seeded message, invokes the handler,
  and records `ack` on success; a failing handler records a `nack` and no `ack`; read-back asserts
  the deserialized payload the handler received equals what was published.

### 3.3 NATS: JetStream is mandatory (core NATS does not fit the contract)

- **Decision:** `NatsBroker` uses **JetStream** (durable, ack-based), not core NATS. `connect()`
  resolves a `NatsConnection` (injected, and when none supplied
  `await loadNats()({ servers: url })`), obtains `jsm = await nc.jetstreamManager()` (async in
  `nats@2.x`) and ensures the stream exists (`jsm.streams.info(streamName)`; on not-found,
  `jsm.streams.add({ name: streamName, subjects: ['>'] })` — a single catch-all stream so any topic
  works), then `js = nc.jetstream()`. `publish(topic, msg)` does
  `js.publish(topic, new TextEncoder().encode(serialized))`. `subscribe(topic, handler, { queue })`
  ensures a durable consumer named `options.queue ?? 'messaging-<runtime.uuid()>'` with
  `filter_subject: topic`, then pushes messages through `consumer.consume({ callback })`. On handler
  success → `msg.ack()`; on rejection → `msg.nak()` (JetStream redelivers after its backoff — no
  hot-loop). `messageId = String(msg.seq)`, `timestamp = new Date(msg.info.timestamp)`; `headers`
  from the message when present. `disconnect()` stops consumers and `nc.close()`;
  `ISubscription.unsubscribe()` stops that consumer.
- **Why:** Core NATS is fire-and-forget with no per-message ack and no durability — it cannot honor
  the contract's "delivery + failure" requirement. JetStream is the NATS-native durable+ack model
  and bridges the gap cleanly; the plan states this explicitly rather than hand-waving delivery.
- **Test home:** `nats-broker.test.ts` — publish asserts the real `js.publish(subject, payload)`
  call (and stream-ensure on connect); subscribe delivers a seeded message to the handler, records
  `ack` on success and `nak` (no `ack`) on failure; read-back of the deserialized payload.

### 3.4 Kafka: offset commit gated on handler success via auto-commit + throw-on-failure

- **Decision:** `KafkaBroker` uses a `kafkajs` producer + per-subscription consumer. `connect()`
  resolves a `Kafka` factory (injected, and when none supplied
  `new (await loadKafkajs())({ clientId, brokers })`), creates the producer, and
  `await producer.connect()`. `publish(topic, msg)` does
  `producer.send({ topic, messages: [{ value: serialized, headers }] })`.
  `subscribe(topic, handler, { queue })` creates
  `consumer = factory.consumer({ groupId: options.queue ?? defaultGroupId })`,
  `await consumer.connect()`, `await consumer.subscribe({ topic })`, and
  `await consumer.run({ eachMessage: async ({ message }) => { … await handler(deserialized, metadata) … } })`.
  The commit model: kafkajs auto-commits the offset **after** `eachMessage` resolves, so success
  advances the offset (ack) and a **thrown** `eachMessage` prevents the commit so the message is
  redelivered (no-ack / at-least-once). The broker therefore does **not** call a per-message commit
  (the `eachMessage` API does not expose one); it relies on auto-commit-on-resolve +
  throw-on-failure, which is the idiomatic, faithful mapping.
  `messageId = '${partition}:${offset}'`, `timestamp = new Date(message.timestamp)`, `headers` from
  `message.headers` when present. `disconnect()` stops + disconnects every consumer and disconnects
  the producer; `ISubscription.unsubscribe()` stops that consumer.
- **Why:** This is the cleanest faithful mapping of ack-on-success / no-ack-on-failure onto kafkajs;
  the guarded recording fake asserts exactly: handler success → the run's eachMessage resolves (fake
  records a committed offset), handler failure → eachMessage rejects (fake records no commit).
- **Test home:** `kafka-broker.test.ts` — publish asserts the real
  `producer.send({ topic, messages })` call; subscribe runs eachMessage against a seeded message,
  records commit-on-success and no-commit-on-failure; read-back of the deserialized payload.

### 3.5 Options surface — extend the type, widen `client`, no dead options

- **Decision:**
  - `MessagingBrokerType` becomes `'memory' \| 'redis-streams' \| 'rabbitmq' \| 'nats' \| 'kafka'`.
  - `MessagingPluginOptions.client` is **widened** from `IRedisStreamsClient` to
    `IRedisStreamsClient | IAmqpConnection | INatsConnection | IKafkaFactory` so a user can inject
    any broker's client (a non-breaking widening for existing Redis callers).
  - New **flat** options on `MessagingPluginOptions`, each with a single named consumer:
    `exchangeName?` (RabbitMQ exchange, default `'messaging'`), `streamName?` (NATS JetStream
    stream, default `'MESSAGING'`), `brokers?: readonly string[]` (Kafka bootstrap brokers),
    `clientId?` (Kafka client id, default `'messaging-client'`). `url`/`client` are reused as in
    M14.
  - Internal per-broker option types `RabbitMqOptions`, `NatsOptions`, `KafkaOptions` (analogous to
    `RedisStreamsOptions`) hold exactly the fields each broker constructor reads; `register()`
    builds them by **assigning only defined values** (mirroring
    [`messaging-plugin.ts:93`](packages/messaging-plugin/src/plugin/messaging-plugin.ts)) to satisfy
    `exactOptionalPropertyTypes`.
- **Why:** Reuses the M14 `url`/`client` pattern; every option names a consumer (no dead surface);
  the internal option types keep each broker's constructor signature parallel to
  `RedisStreamsBroker`.
- **Test home:** `messaging-plugin.test.ts` extended to drive backend selection for all three new
  broker ids through injected fakes, asserting the options are forwarded (e.g. `exchangeName`
  reaches `assertExchange`, `brokers`/`clientId` reach `new Kafka(...)`, `streamName` reaches
  stream-ensure).

### 3.6 Structural client types are internal (not exported)

- **Decision:** `IAmqpConnection`, `INatsConnection`, `IKafkaFactory` are declared in
  `interfaces/index.ts` (parallel to `IRedisStreamsClient`) and used by each broker's
  `validateClient` and per-broker option type. They are **not** re-exported from `src/index.ts`
  (matching `IRedisStreamsClient`, which the barrel omits). They remain importable from the file
  path for the unit tests/fixtures.
- **Why:** Keeps the public surface to broker classes + option types, exactly as M14 does for Redis.
- **Test home:** `barrel-exports.test.ts` asserts the three broker classes and three option types
  are exported **and** that the structural client types are not.

### 3.7 Clock, runtime, and lifecycle wiring

- **Decision:** Message ids use `runtime.uuid()` (and the transport id where it is authoritative —
  JetStream `seq`, Kafka `partition:offset`, AMQP `properties.messageId`); timestamps use the
  transport timestamp where available, otherwise `new Date(runtime.now())`. No `Date.now()`, no
  global `setTimeout`/`setInterval` outside `IRuntimeServices`. RabbitMQ/NATS/Kafka delivery is
  push/callback-driven (AMQP `consume`, NATS `consumer.consume({callback})`, Kafka
  `consumer.run({eachMessage})`), so **no** `runtime.setInterval` poll loop is added (only
  `RedisStreamsBroker` polls). Health + lifecycle reuse the plugin's existing `broker.isReady()`
  indicator and `onClose(() => broker.disconnect())` unchanged.
- **Why:** CLAUDE.md "Never mix clocks" + AI_GUIDELINES §4 runtime confinement; reuses M14 wiring.
- **Test home:** each broker test asserts `isReady()` is `false` before `connect()`, `true` after,
  `false` after `disconnect()`; `publish`/`subscribe` throw when not connected.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                           | Kind         | Consumer / real code path that READS it                                                                                                                                                                           |
| ----------------------------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RabbitMqBroker`                          | class        | `MessagingPlugin.register()` instantiates it when `broker === 'rabbitmq'` ([`messaging-plugin.ts:90`](packages/messaging-plugin/src/plugin/messaging-plugin.ts) switch extended); also direct user instantiation. |
| `NatsBroker`                              | class        | `MessagingPlugin.register()` instantiates it when `broker === 'nats'`.                                                                                                                                            |
| `KafkaBroker`                             | class        | `MessagingPlugin.register()` instantiates it when `broker === 'kafka'`.                                                                                                                                           |
| `RabbitMqOptions`                         | type         | `RabbitMqBroker` constructor param + `register()` builder; user-typed injected options.                                                                                                                           |
| `NatsOptions`                             | type         | `NatsBroker` constructor param + `register()` builder.                                                                                                                                                            |
| `KafkaOptions`                            | type         | `KafkaBroker` constructor param + `register()` builder.                                                                                                                                                           |
| `MessagingBrokerType` (extended)          | type         | `MessagingPluginOptions.broker` + the `register()` switch.                                                                                                                                                        |
| `MessagingPluginOptions.client` (widened) | option field | `resolveClient` of whichever broker is active; `register()` forwards it.                                                                                                                                          |

**Intentionally not exported** (internal, parallel to M14's `IRedisStreamsClient` /
`MessageBrokerAdapter`): `IAmqpConnection`, `INatsConnection`, `IKafkaFactory`, each broker's
`validateClient` (exported from its **file** for direct unit test, not from the barrel),
`loadAmqplib`/`loadNats`/`loadKafkajs`, the `resolveClient` helpers, and `MessageBrokerAdapter`.

### 4.1 Options — every option names its consumer

| Option                    | Consumer                                                                           | Behavior (per implementation)                                                                                                                      |
| ------------------------- | ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| `broker` (extended ids)   | `MessagingPlugin.register()` switch                                                | Selects `RabbitMqBroker` / `NatsBroker` / `KafkaBroker`; unknown id throws (existing behavior).                                                    |
| `url`                     | `RabbitMqBroker.connect`, `NatsBroker.connect` (and existing `RedisStreamsBroker`) | Passed to `amqplib.connect(url)` / `nats.connect({ servers: url })`.                                                                               |
| `client` (widened union)  | the active broker's `resolveClient`                                                | When present and `validateClient` passes, used directly and the lazy import is skipped.                                                            |
| `exchangeName`            | `RabbitMqBroker.publish` / `subscribe`                                             | `assertExchange(exchangeName, 'topic')` + `publish(exchangeName, …)` / `bindQueue(_, exchangeName, topic)`. Default `'messaging'`.                 |
| `streamName`              | `NatsBroker.connect`                                                               | `jsm.streams.info/add(streamName)`; default `'MESSAGING'`.                                                                                         |
| `brokers`                 | `KafkaBroker.connect`                                                              | `new Kafka({ clientId, brokers })`.                                                                                                                |
| `clientId`                | `KafkaBroker.connect`                                                              | `new Kafka({ clientId, brokers })`; default `'messaging-client'`.                                                                                  |
| `defaultQueue` (existing) | RabbitMQ/NATS/Kafka `subscribe`                                                    | Fallback durable/queue/groupId name when `SubscribeOptions.queue` is absent (Kafka groupId default `'messaging-consumers'` for parity with Redis). |

No option is declared without a reader; the existing M14 options (`serializer`, `pollIntervalMs`,
`blockSizeMs`) are unchanged and remain consumed by their original readers.

## 5. Implementation files

| File                             | Purpose                                                                                                                                                                                    |
| -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/brokers/rabbitmq-broker.ts` | `loadAmqplib()` / `validateClient()` / `resolveClient()` + `RabbitMqBroker implements MessageBrokerAdapter` (topic exchange, ack/nack, isReady).                                           |
| `src/brokers/nats-broker.ts`     | `loadNats()` / `validateClient()` / `resolveClient()` + `NatsBroker implements MessageBrokerAdapter` (JetStream durable consumers, ack/nak, isReady).                                      |
| `src/brokers/kafka-broker.ts`    | `loadKafkajs()` / `validateClient()` / `resolveClient()` + `KafkaBroker implements MessageBrokerAdapter` (producer/consumer, commit-on-success, isReady).                                  |
| `src/interfaces/index.ts`        | Extend `MessagingBrokerType`; widen `client`; add `IAmqpConnection`/`INatsConnection`/`IKafkaFactory` + `RabbitMqOptions`/`NatsOptions`/`KafkaOptions`. (types-only; no runtime branches.) |
| `src/plugin/messaging-plugin.ts` | Extend the `brokerType` switch with the three new branches (options built by assigning only defined values), reusing the existing connect/register/health/onClose wiring.                  |
| `src/index.ts`                   | Barrel: export the three broker classes + three option types; do not export the structural client types.                                                                                   |
| `PUBLIC_API.md`                  | Rewrite the `MessagingPluginOptions` block to the real shape (§2 C1); add new exports (C2); add the Kafka commit-model note (C3); add broker-id examples.                                  |
| `ARCHITECTURE.md`                | Extend the messaging-plugin responsibilities/Public API/Extension-Points/Rules rows (broker clients optional via `npm:`; JetStream note).                                                  |
| `ROADMAP.md`                     | Flip M14b deliverable checkboxes and reconcile the Kafka commit wording (§2 C3).                                                                                                           |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Every test file's first framework import is `import { describe, it } from '@std/testing/bdd';` with
assertions from `@std/expect`. `Deno.test` is banned in this repo — do not scaffold in it and
convert later. Fixtures live under `test/fixtures/` and are excluded from coverage.

| Test file                                                        | src covered                      | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | -------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/rabbitmq-broker.test.ts`                              | `src/brokers/rabbitmq-broker.ts` | `validateClient` rejects null/non-object/partial and accepts full shape; publish emits the real `channel.publish(exchangeName, topic, Buffer, opts)` with the serialized payload; `subscribe(topic, handler: MessageHandler<T>, options?: SubscribeOptions)` asserts a queue, binds it, consumes, and on a seeded message invokes the handler with the **read-back** deserialized payload, records `ack` on success, records `nack` (no `ack`) when the handler throws; `isReady()` transitions; `publish`/`subscribe` throw when not connected; `disconnect()` closes channel+connection; **one guarded real-import test**: construct with no injected client + `url: 'amqp://localhost:9999'`, assert `connect()` rejects (enters `loadAmqplib()`). |
| `test/unit/nats-broker.test.ts`                                  | `src/brokers/nats-broker.ts`     | `validateClient` edge cases; connect ensures the stream (`jetstreamManager().streams.info/add`); publish emits `js.publish(topic, Uint8Array)`; subscribe delivers a seeded message to the handler (read-back), records `ack` on success and `nak` on failure; durable name from `options.queue`; `isReady()` transitions; not-connected throws; `disconnect()` calls `nc.close()`; **one guarded real-import test**: no injected client + `url: 'nats://localhost:9999'`, `connect()` rejects (enters `loadNats()`).                                                                                                                                                                                                                                 |
| `test/unit/kafka-broker.test.ts`                                 | `src/brokers/kafka-broker.ts`    | `validateClient` edge cases; connect calls `producer.connect()`; publish emits `producer.send({ topic, messages: [{ value, headers }] })`; `subscribe` runs `eachMessage` against a seeded message (read-back), records a committed offset on handler success and no commit when `eachMessage` rejects; groupId from `options.queue`; `isReady()` transitions; not-connected throws; `disconnect()` stops+disconnects consumers and producer; **one guarded real-import test**: no injected client + `brokers: ['localhost:9999']`, `connect()` rejects (enters `loadKafkajs()`).                                                                                                                                                                     |
| `test/fixtures/fake-amqplib-client.ts`                           | (fixture)                        | Recording `FakeAmqpConnection` (`createChannel`→`FakeChannel` recording `assertExchange`/`assertQueue`/`bindQueue`/`publish`/`consume`/`ack`/`nack`/`close`/`cancel`) that delivers seeded messages through the `consume` callback.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/fixtures/fake-nats-client.ts`                              | (fixture)                        | Recording `FakeNatsConnection` (`jetstream()`/`jetstreamManager()`/`close()`) with fake `js.publish` and a push `consumer.consume({callback})` that delivers seeded messages exposing `ack`/`nak`/`seq`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `test/fixtures/fake-kafkajs-client.ts`                           | (fixture)                        | Recording `FakeKafkaFactory` (`producer()`/`consumer({groupId})`) with `producer.send`/`connect`/`disconnect` and `consumer.run({eachMessage})`/`subscribe`/`stop`/`disconnect` that drives seeded messages and tracks commit-on-resolve vs no-commit-on-reject.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/messaging-plugin.test.ts` (extend)                    | `src/plugin/messaging-plugin.ts` | Backend selection for `broker` `'rabbitmq'`/`'nats'`/`'kafka'` with injected fakes; asserts options are forwarded (`exchangeName`, `streamName`, `brokers`/`clientId`, `client`); asserts the options object is built without assigning `undefined` (exactOptionalPropertyTypes); health `isReady()` + `onClose` disconnect wired; unknown broker throws.                                                                                                                                                                                                                                                                                                                                                                                             |
| `test/unit/barrel-exports.test.ts` (extend)                      | `src/index.ts`                   | Asserts `RabbitMqBroker`, `NatsBroker`, `KafkaBroker`, `RabbitMqOptions`, `NatsOptions`, `KafkaOptions` are exported and that the structural client types are not.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `test/unit/messaging-plugin.test.ts` + broker tests (collective) | `src/interfaces/index.ts`        | types-only file; its declarations are exercised wherever the broker/plugin/barrel tests compile against `MessagingBrokerType`, the option types, and the structural client types.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

Per-file bar: every new `src/brokers/*.ts` file targets ≥90% branch/function/line, achieved with the
recording-fake tests above plus the guarded real-import test that covers the `loadX()` lazy-load
function (the branch that a skipped-only test would leave uncovered). The structural-client
`validateClient` branches are covered directly by their exported-function unit tests.

## 7. Verification gates

```bash
git branch --show-current        # MUST be feat/m14b-messaging-brokers, never main
deno task check:plan             # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage          # read ANSI-stripped per-file table; >=90% branch/function/line on every src file
```

After implementation, also grep for forbidden constructs the gates miss (CLAUDE.md "Before reporting
a task done"):

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/messaging-plugin/src
```

## 8. Risks & mitigations

- **Recording fake diverges from the real client shape → tests lie.** Mitigation: each fake is
  modeled on the real `amqplib`/`nats`/`kafkajs` method names and callback shapes, and the one
  guarded real-import test per broker exercises the real `import('npm:<pkg>')` path so the load
  function is never only covered by the fake.
- **`amqplib` ESM default-vs-named `connect`.** Mitigation: `loadAmqplib()` resolves `connect` from
  the module namespace defensively; the guarded real-import test confirms the resolved function is
  invoked.
- **NATS JetStream API surface is large.** Mitigation: the plan pins the exact calls used
  (`jetstreamManager().streams.info/add`, `js.publish`, `consumer.consume({callback})`,
  `msg.ack/nak`); the fake records precisely those, and the design picks JetStream deliberately
  (§3.3).
- **`eachMessage` has no per-message commit.** Mitigation: §3.4 commits on resolve and redelivers on
  throw; the fake asserts commit-on-success vs no-commit-on-failure, reconciling the ROADMAP "manual
  commit" wording (§2 C3).
- **Coverage of the lazy-load line is environment-gated.** Mitigation: the guarded real-import test
  enters `loadX()` with no injected client so the function is covered whether or not the package is
  installed (redis precedent at
  [`redis-streams-broker.test.ts:597`](packages/messaging-plugin/test/unit/redis-streams-broker.test.ts)).
- **`PUBLIC_API.md` is stale.** Mitigation: corrected as a named same-PR deliverable (§2 C1/C2).
- **`exactOptionalPropertyTypes` is on.** Mitigation: per-broker option objects are built by
  assigning only defined values (mirroring
  [`messaging-plugin.ts:93`](packages/messaging-plugin/src/plugin/messaging-plugin.ts)).

## 9. Out of scope

- Live-broker integration tests (running RabbitMQ/NATS/Kafka) — deferred; the project bar for
  transport adapters is recording-fake + guarded real-import (M14's RedisStreams precedent), not
  live backends.
- RabbitMQ dead-letter exchanges / priority queues / confirms channel; NATS core (non-JetStream)
  publishing, advisories, stream replication/limits; Kafka transactions, exactly-once, schema
  registry, SASL/TLS auth — all configurable later via options without contract changes.
- Any modification to `IMessageBroker`/`ISubscription`/`MessageHandler`/`MessageMetadata`/
  `SubscribeOptions` or a new capability token — none (owned by `common`, intentionally untouched).
- Per-message manual offset commit calls in Kafka — intentionally not used; §3.4 explains the chosen
  commit model.
