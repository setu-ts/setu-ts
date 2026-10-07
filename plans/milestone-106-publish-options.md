# Milestone 106 — Publish options (`@setu-ts/common`, `@setu-ts/messaging-plugin`, `@setu-ts/cloudflare-plugin`)

> **Status:** Planning. Branch: `feat/m106-publish-options`. `main` and `develop` are protected —
> all work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

`IMessageBroker.publish(topic, message)` takes no options, so a producer cannot say which messages
must stay in order, which re-send is a duplicate, or what metadata travels with a message. This
milestone adds an optional `PublishOptions` with `orderingKey`, `deduplicationId` and `headers`.
Each option maps to the broker's native primitive where one exists, and every option is also carried
as a transport header, so it is observable on every broker and never silently dropped. It is step 3
of the reliability order: the outbox relay (a later milestone) publishes at least once and needs a
per-aggregate ordering key and a stable deduplication ID to hand the broker.

- **In scope:**
  - `PublishOptions` and two header-name constants in `common`; the optional third parameter on
    `IMessageBroker.publish`.
  - Native mappings: Kafka message `key`, Pub/Sub `orderingKey`, NATS `Nats-Msg-Id`, Service Bus
    `messageId`. Header carriage on all seven `messaging-plugin` brokers and on `WorkersBroker`.
  - Option forwarding through `TracedBroker` and `PipelinedBroker`.
  - Validation, rejected by name, including the header names a broker or its server acts on (§3.4),
    and a design security review (§10).
  - `enableMessageOrdering` on both Pub/Sub arms (`PubSubMessagingOptionsInjected`,
    `PubSubMessagingOptionsProduction`) for subscriptions the transport creates.
  - `publishIntegrationEvent` passing the envelope ID as the deduplication ID, and accepting caller
    options.
  - An opt-in `orderingKey` selector on `defineIntegrationEvent`, so an event type can say which
    envelope field orders it (§3.7).
  - The documented ordering statement: `orderingKey` decides where a message is placed, not the
    order handlers finish in once a retry occurs (§3.8).
- **NOT this milestone:**
  - Awaiting NATS's JetStream acknowledgement — a defect in merged code, fixed first in #425 (§8),
    which this branch is rebased on.
  - Deriving `orderingKey` by default, now or in a later minor. It would re-partition existing Kafka
    producers, and none of the nine frameworks surveyed (§3.2) hard-codes one: derivation is always
    explicit configuration. The opt-in selector is the whole answer.
  - Options on `request()`/`respond()` (RPC is framework-internal correlation traffic).
  - The transactional outbox and the consumer inbox (later milestones, `ROADMAP.md` "Deferred
    reliability milestone").
  - Service Bus sessions: consuming a session-enabled subscription needs a session receiver, which
    this broker does not use (§3.3).
  - SNS/SQS in `queue-plugin`: a different contract (`IQueue`).

## 1. Contracts verified from SOURCE (not names)

| Reference                                      | Source (file:line)                                                                              | Verified surface / fact                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMessageBroker.publish`                       | `packages/common/src/services/messaging.ts:117`                                                 | `publish<T>(topic: string, message: T): Promise<void>` — no third parameter                                                                                                                                                                                                  |
| `MessageMetadata.headers`                      | `packages/common/src/services/messaging.ts:14-26`                                               | optional `Readonly<Record<string, string>>`; first-party brokers populate `{}` when no headers arrived                                                                                                                                                                       |
| `MessageBrokerAdapter.publishWithHeaders`      | `packages/messaging-plugin/src/brokers/message-broker.ts:41`                                    | internal header channel every broker already implements; `publish` delegates to it with `{}`                                                                                                                                                                                 |
| `TracedBroker.publish`                         | `packages/messaging-plugin/src/tracing/traced-broker.ts:45-69`                                  | adds `traceparent` and calls the inner `publishWithHeaders`                                                                                                                                                                                                                  |
| `PipelinedBroker.publish`                      | `packages/messaging-plugin/src/pipeline/pipelined-broker.ts:145`                                | decorator; must forward a new argument or drop it (the M70i dropped-argument class)                                                                                                                                                                                          |
| Kafka publish                                  | `packages/messaging-plugin/src/brokers/kafka-broker.ts:574-584`                                 | `send({ topic, messages: [{ value, headers }] })` — no `key`                                                                                                                                                                                                                 |
| NATS publish                                   | `packages/messaging-plugin/src/brokers/nats-broker.ts:497-540`                                  | `js.publish(subject, data, { headers })` awaited since #425; a refusal rejects naming the subject, the client error kept as `cause`                                                                                                                                          |
| `IPubSubTransport.publish` (exported)          | `packages/messaging-plugin/src/brokers/pubsub-broker.ts:146`, `index.ts:117`                    | `(topic, bytes, attributes?)`; the SDK adapter builds `pubsub.topic(topic)` per call (`:253`)                                                                                                                                                                                |
| `IServiceBusTransport.send` (exported)         | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:139`, `index.ts:125`               | `(topic, body, applicationProperties?)`; the adapter calls `sendMessages(message)` (`:474`)                                                                                                                                                                                  |
| RabbitMQ publish                               | `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts:670-700`                              | sets `messageId` from `runtime.uuid()` (`:689`), headers via properties                                                                                                                                                                                                      |
| Redis Streams publish                          | `packages/messaging-plugin/src/brokers/redis-streams-broker.ts:340-356`                         | header fields on the stream entry; a header named `payload` is silently DROPPED (`:353-354`), and dead-lettering appends `x-setu-source-id`/`x-setu-deliveries` (`:627-630`)                                                                                                 |
| In-memory publish                              | `packages/messaging-plugin/src/brokers/in-memory-broker.ts:157`                                 | resolves on dispatch hand-off (M89c); headers delivered as given                                                                                                                                                                                                             |
| `WorkersBroker.publish`                        | `packages/cloudflare-plugin/src/messaging/workers-broker.ts:254`                                | `encodePublishEnvelope(topic, id, payload)` (`message-envelope.ts:107`) — no header field                                                                                                                                                                                    |
| `defineIntegrationEvent`                       | `packages/messaging-plugin/src/integration/definition.ts`                                       | options object `{ type, version, topic, parse }`, each validated with a named `TypeError`; returns the same four fields — an optional fifth is source-compatible                                                                                                             |
| `publishIntegrationEvent`                      | `packages/messaging-plugin/src/integration/publish.ts:63`                                       | `(runtime, broker, definition, payload, metadata?)` → `broker.publish(topic, envelope)`                                                                                                                                                                                      |
| Envelope ID                                    | `packages/messaging-plugin/src/integration/envelope.ts:38`                                      | `readonly id: string`, producer-assigned, fresh per envelope; `aggregateId` optional (`:52`)                                                                                                                                                                                 |
| `TRACEPARENT_HEADER`                           | `packages/common/src/trace-context.ts:11`                                                       | `'traceparent'` — the framework-owned header a caller must not overwrite                                                                                                                                                                                                     |
| Kafka key → partition (measured 2026-10-07)    | real `apache/kafka:4.0.0`, kafkajs 2.2.4, 3 partitions                                          | 12 unkeyed messages spread over partitions 0,1,2; 3 keys × 10 messages each landed on ONE partition per key, in publish order                                                                                                                                                |
| NATS `msgID` (measured)                        | real `nats:2-alpine -js`, nats.js 2.29.3                                                        | second publish with the same `msgID` (and with a `Nats-Msg-Id` header) answered `duplicate: true`; stream held 1 copy each; `duplicate_window` default 120 s                                                                                                                 |
| NATS unmatched subject (measured)              | same                                                                                            | `js.publish` rejects (`503`); before #425 the broker resolved and the rejection was unhandled — fixed                                                                                                                                                                        |
| Pub/Sub `orderingKey` (measured)               | `google-cloud-cli:emulators`, `@google-cloud/pubsub@^6`                                         | publish with `orderingKey` accepted with and without `messageOrdering: true`; a non-ordering subscription received all messages                                                                                                                                              |
| Service Bus (measured)                         | `servicebus-emulator`, `@azure/service-bus@^7`, `docs/fixtures/servicebus-emulator-config.json` | `sessionId` on a non-session subscription delivered to a plain receiver; a repeated `messageId` delivered twice (no duplicate detection configured)                                                                                                                          |
| RabbitMQ reads its own `x-setu-*` names        | `rabbitmq-broker.ts:154`, `:1114-1141`                                                          | `x-setu-disposition-id` matches a returned message to its publish; `x-setu-attempt` is the retry count the consumer trusts; dead-lettering writes `x-setu-attempts`/`x-setu-topic`/`x-setu-error`                                                                            |
| RabbitMQ `CC`/`BCC`                            | `rabbitmq-broker.ts:1131-1134` (#421)                                                           | sender-selected routing keys in the message headers: the server delivers a copy to every queue they name, which is why the retry copy strips them                                                                                                                            |
| RabbitMQ server-owned headers (docs)           | rabbitmq.com dead-lettering, quorum queues, delayed-message plugin                              | the server writes `x-death`, `x-first-death-*`, `x-last-death-*` on dead-lettering and `x-delivery-count` on quorum-queue redelivery; the delayed-message exchange plugin delays by `x-delay`. Each is confirmed against RabbitMQ 4 during implementation (§10 obligation 1) |
| nats.js header rules (source)                  | `nats@2.29.3` `lib/nats-base-client/headers.js:35-60`, `:152-157`                               | a key character outside `0x21-0x7E`, or `:`, THROWS a `NatsError` that quotes the character; a value with CR/LF throws; a value is `trim()`med, so leading/trailing whitespace is silently altered on NATS alone                                                             |
| JetStream control headers (source)             | `nats@2.29.3` `lib/jetstream/*.js` (`PubHeaders`, `JsHeaders`)                                  | `Nats-Msg-Id`, `Nats-Expected-Stream`, `Nats-Expected-Last-Sequence`, `Nats-Expected-Last-Msg-Id`, `Nats-Expected-Last-Subject-Sequence`, `Nats-Rollup`: the server ACTS on these (dedup, publish preconditions, rollup purge where the stream allows it)                    |
| Pub/Sub attribute limits (docs, 2026-10-08)    | `docs.cloud.google.com/pubsub/quotas`                                                           | at most 100 attributes; key ≤ 256 bytes; value ≤ 1024 bytes. A reserved `goog` key prefix is stated only by third-party docs — measured against the emulator during implementation (§10)                                                                                     |
| Service Bus property limits (docs, 2026-10-08) | `learn.microsoft.com/…/service-bus-quotas`                                                      | message ID ≤ 128; each property ≤ 32 KB; ALL properties (user and system) ≤ 64 KB together                                                                                                                                                                                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                              | Resolution (picked side)                                                       | Doc deliverable (same PR)                               |
| -- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------ | ------------------------------------------------------- |
| C1 | `messaging.ts:1-4` lists five brokers ("RabbitMQ, NATS, Kafka, Redis Streams, in-memory"); seven ship | Source: Pub/Sub and Service Bus ship (M54)                                     | Module JSDoc names all seven                            |
| C2 | `ROADMAP.md` "Deferred reliability milestone" says ordering belongs to the outbox design              | This milestone owns the publish-side primitive; the outbox owns relay ordering | One sentence in that ROADMAP paragraph pointing at M106 |

## 3. Design decisions

### 3.1 The contract: one optional trailing parameter

- **Decision:** `publish<T>(topic: string, message: T, options?: PublishOptions): Promise<void>`.
  `PublishOptions` =
  `{ readonly orderingKey?: string; readonly deduplicationId?: string; readonly
  headers?: Readonly<Record<string, string>> }`.
- **Why:** optional and trailing, so every caller compiles unchanged, and an implementor declaring
  two parameters stays assignable (fewer parameters are assignable in TypeScript). No required
  member is added, which the `0.9.0` versioning policy forbids outside a minor.
- **Test home:** `packages/common/test/unit/publish-options.test.ts` (type-level: a two-parameter
  implementor still assigns to `IMessageBroker`).

### 3.2 An option a broker cannot honour natively is carried, never dropped and never refused

- **Decision:** every broker writes `orderingKey` to the transport header `x-setu-ordering-key` and
  `deduplicationId` to `x-setu-deduplication-id` (exported as `ORDERING_KEY_HEADER` and
  `DEDUPLICATION_ID_HEADER`), on top of any native mapping. No broker refuses an option for lacking
  the primitive.
- **Why:** refusing would make portable producer code broker-specific — an outbox relay passing an
  ordering key would throw on RabbitMQ. Silently ignoring is the dead-option defect class. Carrying
  makes the option observable on every broker (`MessageMetadata.headers`), which is what a consumer
  needs to check `aggregateVersion` or de-duplicate. The guarantee differs per broker, and §3.3's
  table is the documentation and the test data.
- **Prior art (surveyed 2026-10-07 from official docs and upstream source):** NestJS, Encore.ts,
  Moleculer, Dapr, CloudEvents, Spring Cloud Stream, MassTransit, NServiceBus and Watermill. None
  refuses an option the broker cannot honour. CloudEvents (the `partitionkey` extension) and
  Watermill (keys derived from metadata) carry it as a header with no effect, which is this design.
  Dapr and Moleculer drop it silently, and Dapr's docs do not say so; MassTransit mixes throwing
  setters with silent no-ops. A documented, tested per-broker table is stricter than all nine.
- **Test home:** `packages/messaging-plugin/test/integration/header-conformance.test.ts` (extended:
  one table over all seven brokers).

### 3.3 Per-broker mapping (this table is the test data)

| Broker          | `orderingKey`                                                                        | `deduplicationId`                                                                      |
| --------------- | ------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------- |
| Kafka           | message `key` → one partition, in order (measured)                                   | header only                                                                            |
| Pub/Sub         | native `orderingKey`; ordered delivery needs an ordering subscription (§3.5)         | header only                                                                            |
| NATS            | header only (one stream is totally ordered; a consumer group gives no per-key order) | `Nats-Msg-Id` → server de-duplicates within the stream's `duplicate_window` (measured) |
| Service Bus     | header only (`sessionId` needs a session receiver; measured ignored on a plain one)  | `messageId` → de-duplicated only on an entity with duplicate detection (measured)      |
| RabbitMQ        | header only                                                                          | header, and the `messageId` property (so `MessageMetadata.messageId` is stable)        |
| Redis Streams   | header only                                                                          | header only                                                                            |
| In-memory       | header only (dispatch already follows publish order)                                 | header only                                                                            |
| `WorkersBroker` | envelope field, surfaced as the header                                               | envelope field, surfaced as the header                                                 |

- **Decision:** exactly the table above.
- **Why:** each native row is backed by a 2026-10-07 measurement (§1). RabbitMQ's `messageId`
  mapping replaces a value it already sets from `runtime.uuid()`, so a consumer reading
  `metadata.messageId` gets the producer's stable ID instead of a random one.
- **Test home:** the conformance table; `kafka-real.test.ts` (partition affinity, CI);
  `nats-real.test.ts` (duplicate stored once, CI); guarded emulator tests for Pub/Sub and Service
  Bus (local, `docs/messaging-emulators.md`).

### 3.4 Validation

- **Decision:** `validatePublishOptions` (internal, `brokers/publish-options.ts`) runs on every
  PUBLIC publish entry — each broker's `publish`, `TracedBroker.publish`, `PipelinedBroker.publish`,
  `WorkersBroker.publish` and `publishIntegrationEvent` — and returns a frozen copy that is the only
  thing any later step reads. Every refusal is a `RangeError` delivered as a REJECTED promise, never
  a synchronous throw from a `Promise`-returning method (the M52b class).
  - **Copy once.** `options` must be a plain object or `undefined`. Each of its three members is
    read exactly once; `headers` must be a plain object whose OWN enumerable string keys are read
    once each, in one pass, into a fresh record built with `Object.fromEntries` (so a `__proto__`
    key defines an own property and never a prototype). Symbol keys are refused; inherited keys are
    not read. Validation runs on the copy and the copy is what reaches the wire — a getter or a
    `Proxy` cannot answer one value to the check and another to the broker (the M98e copy-once
    class). A getter or `Proxy` trap that throws rejects the publish.
  - **`orderingKey`, `deduplicationId`:** non-empty, well-formed (`isWellFormed()`) strings of at
    most 128 UTF-8 bytes, refused by `common`'s exported `hasForbiddenAliasCharacter` (Cc, Cf, Zl,
    Zp — the predicate M101f shares across diagnostics aliases) and carrying no leading or trailing
    whitespace.
  - **Header count:** at most 32 caller headers.
  - **Header names:** 1–256 bytes, every character in `0x21-0x7E` except `:` — exactly what nats.js
    accepts, the strictest of the seven transports.
  - **Header values:** well-formed strings of at most 1024 UTF-8 bytes, refused by the same
    predicate, with no leading or trailing whitespace.
  - **Reserved names, compared ASCII-case-insensitively:** `traceparent`, `tracestate`, `cc`, `bcc`,
    `payload`; the RabbitMQ server's own `x-death`, `x-delivery-count`, `x-delay`, and any name
    beginning `x-first-death-` or `x-last-death-`; and any name beginning `x-setu-`, `nats-` or
    `goog`. The list is ONE internal table (`RESERVED_HEADER_NAMES`, `RESERVED_HEADER_PREFIXES`, not
    barrel-exported) that the test iterates, not prose.
  - **Refusal text** names the field and the rule. It never quotes a value, and it quotes a header
    name only after that name has passed the character check (a reserved-name refusal), escaped with
    `JSON.stringify`; a name refused for its characters is identified by its position in the record
    instead.
  - **Inbound is not re-validated, with one exception.** Delivered headers keep passing through
    `normalizeTransportHeaders`, which drops values with no faithful string form and does not judge
    names. The exception is `WorkersBroker`, whose two fields are parsed from a JSON body rather
    than delivered by a header channel: a field that is not a string satisfying the id rule above is
    dropped, never surfaced, the same treatment the normaliser gives an unfaithful value.
- **Why:**
  - 128 bytes is Service Bus's `messageId` limit, the tightest native id; 32 × (256 + 1024) bytes
    stays under Service Bus's 64 KB for all properties together and leaves Pub/Sub's 100-attribute
    limit room for the framework's own; 256/1024 are Pub/Sub's key/value limits. One portable bound
    means a publish never fails on one broker and passes on another.
  - Whitespace is refused because nats.js `trim()`s a value, so the same header would be faithful on
    six brokers and altered on one. A lone surrogate is refused because every UTF-8 transport
    encodes it as U+FFFD, so the value on the wire would not be the value validated.
  - Each reserved name is one a broker or its server ACTS on (§1): `CC`/`BCC` route the message to
    other queues, `Nats-Rollup` can purge a stream, `Nats-Expected-*` rejects the publish,
    `x-setu-*` are read back by the framework (`x-setu-attempt` is the retry count a consumer
    trusts), `payload` is silently dropped by Redis Streams, `goog` keys are reportedly refused by
    Pub/Sub (measured during implementation, §10 obligation 1), RabbitMQ's server writes and reads
    the `x-death` family and `x-delivery-count`, and the delayed-message plugin acts on `x-delay`,
    and the trace headers are written by `TracedBroker`. Refusing them on every broker keeps the
    rule portable and keeps a caller-supplied header from steering a broker.
- **Test home:** `packages/messaging-plugin/test/unit/publish-options-validation.test.ts`.

### 3.5 Pub/Sub ordering

- **Decision:** the SDK adapter caches one `Topic` per name, created with `messageOrdering: true`.
  After a failed ordered publish it calls `topic.resumePublishing(orderingKey)` before rethrowing. A
  new arm option, `enableMessageOrdering` (default `false`), creates the transport's own
  subscriptions with ordering enabled.
- **Why:** the adapter currently builds `pubsub.topic(topic)` per publish (`pubsub-broker.ts:253`),
  and the SDK keeps its ordered queue per `Topic` object, so concurrent publishes for one key would
  race. The SDK pauses a key after a failed ordered publish until `resumePublishing`; without it one
  transient failure blocks that key for the life of the process. Subscription ordering is fixed at
  creation and costs throughput, so it is opt-in.
- **Test home:** `packages/messaging-plugin/test/unit/pubsub-adapter.test.ts` (cache, flag, resume);
  guarded emulator test (ordered delivery on an ordering subscription).

### 3.6 Decorators forward the options

- **Decision:** `TracedBroker` and `PipelinedBroker` pass `options` through, merging `traceparent`
  into `headers` after validation.
- **Why:** both sit in front of every first-party broker; a decorator that drops the argument
  type-checks and silently removes the feature.
- **Test home:** `packages/messaging-plugin/test/integration/messaging-telemetry.test.ts` (options
  reach the wire with tracing and behaviours both on).

### 3.7 `publishIntegrationEvent` and the opt-in ordering selector

- **Decision:**
  - `publishIntegrationEvent` gains a sixth parameter `options?: PublishOptions`. `deduplicationId`
    defaults to the envelope ID; a caller-supplied one wins.
  - `defineIntegrationEvent` accepts an optional
    `orderingKey?: (envelope: IntegrationEventEnvelope<T>) => string | undefined`, stored on the
    definition as `IntegrationEventDefinition.orderingKey`. A non-function is refused with a named
    `TypeError` at definition time, like the four existing fields.
  - Precedence for `orderingKey`: the caller's `options.orderingKey`, then the definition's
    selector, then none. A selector returning `undefined` means no key; a selector that throws, or
    returns a value §3.4 refuses, makes `publishIntegrationEvent` reject — never a synchronous
    throw.
- **Why:**
  - The envelope ID is the end-to-end de-duplication key (producer-assigned, fresh per envelope), so
    that default changes nothing observable beyond a header. This is mainstream: MassTransit and
    NServiceBus generate a message ID by default and MassTransit maps it to Service Bus's native
    de-duplication; Dapr sends the CloudEvent `id` as NATS `Nats-Msg-Id`; CloudEvents defines
    de-duplication by `id`.
  - Ordering derivation is configuration everywhere it exists (Encore `orderingAttribute`, Spring
    `partitionKeyExpression`, MassTransit `UsePartitionKeyFormatter`, Watermill partitioning
    marshalers), and a per-type selector is that, at the place an event type is defined. Opt-in
    changes no existing producer, so it ships in a patch. A function rather than a field name covers
    `aggregateId` and any payload field, as MassTransit's formatter does.
- **Test home:** `packages/messaging-plugin/test/unit/integration/definition.test.ts` (selector
  stored; non-function refused); `packages/messaging-plugin/test/unit/integration/publish.test.ts`
  (default `deduplicationId`, the three-step precedence, `undefined` means no key, a throwing or
  invalid selector rejects).

### 3.8 What `orderingKey` promises

- **Decision:** the README, `PublishOptions` JSDoc and `PUBLIC_API.md` state the guarantee as:
  `orderingKey` decides **placement** — the same key reaches the same partition, ordering queue or
  ordered subscription where the broker has one — not the order handlers **finish** in. What a
  handler failure does to order differs per broker, and the README table carries a column for it:
  - **Order kept by blocking:** Kafka (a throwing handler leaves the offset uncommitted and kafkajs
    redelivers from that record, `kafka-broker.ts:723`, so one failing message stalls its whole
    partition until it succeeds) and Pub/Sub on an ordering subscription.
  - **Order lost on retry:** RabbitMQ (retry queues since #421), Redis Streams (reclaim since #419),
    NATS and Service Bus redelivery — later messages for the key are handled while the failed one
    waits. The NATS and Service Bus cells are reasoned from each broker's redelivery model and are
    measured during implementation before the README states them; the RabbitMQ and Kafka cells are
    pinned by the tests below.

  Consumers that need order compare the envelope's `aggregateVersion` and drop or defer a stale
  event.
- **Why:** a placement guarantee read as a processing guarantee is the most likely misuse of this
  option. NServiceBus states the same limit outright ("processing failures and recoverability will
  result in out-of-order processing"), as do Watermill (NATS: "with the redelivery feature, order
  can't be guaranteed") and MassTransit (Kafka: delayed redelivery means "messages may be processed
  out of order").
- **Test home:** `packages/messaging-plugin/test/integration/consumer-retry-real.test.ts` (real
  RabbitMQ: two messages with one key, the first failing once — the second is handled before the
  first's retry, pinning the documented limit so a later change to it is deliberate);
  `packages/messaging-plugin/test/integration/kafka-real.test.ts` (real Kafka: same key, the first
  failing once — the second is not handled until the first succeeds).

### 3.9 What a consumer may trust, and what a producer must not derive

- **Decision:** the messaging README gains a "Publish options and trust" section, mirrored in the
  `PublishOptions` JSDoc and `PUBLIC_API.md`, stating three rules:
  - An `x-setu-ordering-key` or `x-setu-deduplication-id` header on a DELIVERED message is a hint
    written by whoever published it. Validation runs on the publish side only, so a foreign or
    compromised producer with write access to the topic can send any value under these names. A
    consumer may use them to order or de-duplicate its own work, never to authorize anything.
  - A `deduplicationId` derived from request input lets the caller who chooses it suppress another
    message with the same id for the broker's window (NATS `duplicate_window`, 120 s by default;
    Service Bus's configured detection window). Derive it from a producer-assigned id — the envelope
    id `publishIntegrationEvent` uses by default is one.
  - An `orderingKey` derived from request input lets a caller concentrate load on one Kafka
    partition or one Pub/Sub ordering key (1 MB/s per key on Pub/Sub). Derive it from an aggregate
    the application owns.
- **Why:** the framework can bound and sanitize what it writes, but cannot authenticate what another
  producer wrote, and cannot tell from a string where a caller got it. Both misuses type-check and
  work in every test, so the guidance is the control.
- **Test home:** the doc-fence gate compiles the README example; the rules are prose, checked in
  review (§10 obligation 7).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `options` is an optional trailing parameter, so a two-parameter
`publish` stays assignable; both exported transports gain an optional trailing parameter; and
`IntegrationEventDefinition` gains an optional member, so a hand-built definition still assigns.

| Exported symbol                           | Kind            | Consumer / real code path that READS it                                            |
| ----------------------------------------- | --------------- | ---------------------------------------------------------------------------------- |
| `PublishOptions` (`common`)               | type            | `IMessageBroker.publish`, every broker, both decorators, `publishIntegrationEvent` |
| `ORDERING_KEY_HEADER` (`common`)          | const           | every broker's header write; consumers reading `MessageMetadata.headers`           |
| `DEDUPLICATION_ID_HEADER` (`common`)      | const           | same                                                                               |
| `IntegrationEventDefinition.orderingKey`  | optional member | `publishIntegrationEvent` reads it when the caller passes no `orderingKey`         |
| `IPubSubTransport.publish` 4th parameter  | param           | `GcpPubSubBroker.publishWithHeaders` passes `orderingKey`                          |
| `IServiceBusTransport.send` 4th parameter | param           | `ServiceBusBroker.publishWithHeaders` passes `messageId`                           |

### 4.1 Options — every option names its consumer

| Option                                                                                                              | Consumer                      | Behavior (per implementation)                                   |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------- |
| `PublishOptions.orderingKey`                                                                                        | every broker                  | §3.3 table                                                      |
| `PublishOptions.deduplicationId`                                                                                    | every broker                  | §3.3 table                                                      |
| `defineIntegrationEvent({ orderingKey })`                                                                           | `publishIntegrationEvent`     | selector applied per publish; caller's key wins (§3.7)          |
| `PublishOptions.headers`                                                                                            | every broker's header channel | written beside framework headers; reserved names refused (§3.4) |
| `enableMessageOrdering` on both Pub/Sub arms (`PubSubMessagingOptionsInjected`, `PubSubMessagingOptionsProduction`) | the SDK adapter's `open()`    | creates the transport's subscriptions with ordering enabled     |

## 5. Implementation files

| File                                                                            | Purpose                                                |
| ------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `packages/common/src/services/messaging.ts`                                     | `PublishOptions`, the header constants, the parameter  |
| `packages/common/src/index.ts`                                                  | barrel exports                                         |
| `packages/messaging-plugin/src/brokers/publish-options.ts`                      | internal: validation and the shared header merge       |
| `packages/messaging-plugin/src/brokers/message-broker.ts`                       | `publishWithHeaders` gains the options                 |
| `packages/messaging-plugin/src/brokers/*-broker.ts` (seven)                     | native mapping and header carriage                     |
| `packages/messaging-plugin/src/tracing/traced-broker.ts`                        | forwards options                                       |
| `packages/messaging-plugin/src/pipeline/pipelined-broker.ts`                    | forwards options                                       |
| `packages/messaging-plugin/src/integration/definition.ts`                       | optional `orderingKey` selector, validated             |
| `packages/messaging-plugin/src/integration/publish.ts`                          | sixth parameter, default `deduplicationId`, precedence |
| `packages/messaging-plugin/src/interfaces/index.ts`                             | `enableMessageOrdering`                                |
| `packages/cloudflare-plugin/src/messaging/{workers-broker,message-envelope}.ts` | optional envelope fields                               |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                       | src covered                                    | Key assertions                                                                                                                                                                                                                                                                                                                                                                    |
| ------------------------------------------------------------------------------- | ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/publish-options.test.ts`                             | `messaging.ts`                                 | a two-parameter implementor assigns; barrel exports both constants                                                                                                                                                                                                                                                                                                                |
| `packages/messaging-plugin/test/unit/publish-options-validation.test.ts`        | `publish-options.ts`                           | each §3.4 refusal is a rejected promise naming the field; every byte/count bound at both sides; every reserved name and prefix from the table in three casings; a getter answering two values and a `Proxy` reach the wire with the value validated; `__proto__` stays an own key; refusal text never contains the refused value; a name refused for its characters is not quoted |
| `packages/messaging-plugin/test/integration/header-conformance.test.ts`         | all seven brokers                              | one row per broker × option, asserting the wire shape from §3.3; every public entry (each broker, both decorators) rejects a reserved name before the transport is called                                                                                                                                                                                                         |
| `packages/messaging-plugin/test/integration/kafka-real.test.ts`                 | `kafka-broker.ts`                              | same key → one partition, in order; no key → unchanged; a failing first message blocks the second until it succeeds                                                                                                                                                                                                                                                               |
| `packages/messaging-plugin/test/integration/nats-real.test.ts`                  | `nats-broker.ts`                               | repeated `deduplicationId` stored once; a caller `Nats-Rollup` header is refused before the server sees it                                                                                                                                                                                                                                                                        |
| `packages/messaging-plugin/test/unit/pubsub-adapter.test.ts`                    | `pubsub-broker.ts`                             | topic cached, `messageOrdering: true`, `resumePublishing` after a failure, subscription flag                                                                                                                                                                                                                                                                                      |
| `packages/messaging-plugin/test/integration/messaging-telemetry.test.ts`        | both decorators                                | options survive tracing + behaviours; `traceparent` still the framework's                                                                                                                                                                                                                                                                                                         |
| `packages/messaging-plugin/test/unit/integration/definition.test.ts`            | `integration/definition.ts`                    | selector stored; non-function refused with a named `TypeError`                                                                                                                                                                                                                                                                                                                    |
| `packages/messaging-plugin/test/unit/integration/publish.test.ts`               | `integration/publish.ts`                       | default `deduplicationId`; caller > selector > none; `undefined` = no key; throwing/invalid selector rejects                                                                                                                                                                                                                                                                      |
| `packages/messaging-plugin/test/integration/consumer-retry-real.test.ts`        | (documented limit, §3.8; `rabbitmq-broker.ts`) | one key, first message fails once: the second is handled before the first's retry                                                                                                                                                                                                                                                                                                 |
| `packages/cloudflare-plugin/test/unit/messaging/workers-broker-publish.test.ts` | Workers broker + envelope                      | fields round-trip; an envelope without them still decodes; a decoded envelope whose fields fail §3.4 surfaces no header (a foreign producer's value is not trusted into `MessageMetadata`)                                                                                                                                                                                        |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m106-publish-options
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test              # with NATS_URL and KAFKA_BROKERS set; Pub/Sub and Service Bus emulators locally
deno task test:coverage     # ANSI-stripped per-file table; ≥90% branch/function/line every changed src file
deno task check:docs
deno task publish:check
deno task release:verify <version>
```

Negative controls: drop the forwarding in `PipelinedBroker` (conformance fails); drop the Kafka
`key` (real partition test fails); drop `Nats-Msg-Id` (NATS dedup test fails); make
`publishIntegrationEvent` ignore the definition's selector (precedence test fails); remove `cc` from
the reserved table (validation and conformance fail); compare reserved names case-sensitively (the
mixed-case rows fail); read a header value twice instead of from the copy (the getter test fails);
quote the value in a refusal (the no-echo test fails).

## 8. Risks & mitigations

- **NATS publish acknowledgement (resolved).** Fixed by #425 before this milestone; this branch is
  rebased on it, so the NATS deduplication mapping reads a real PubAck.
- **The reserved-name table is incomplete.** A broker may act on a header name §1 did not find.
  Mitigation: the table is data the tests iterate, each entry cites its source, and §10 obligation 1
  makes completeness an audit question; a later addition is a patch-level refusal.
- **Pub/Sub ordering semantics on the real service may differ from the emulator.** Mitigation: the
  emulator-backed behaviour is recorded as such in the README table, unverified against a live
  project (the M30b/M52 standard).
- **A hot ordering key concentrates one Kafka partition.** Mitigation: documented; the key is
  caller-chosen.

## 9. Out of scope

- A default ordering key in `publishIntegrationEvent` — not planned for any release (§0, §3.7).
- The outbox relay and consumer inbox — later milestones.
- Service Bus sessions — needs a session receiver mode; no current consumer asks for it.

## 10. Design security review (recorded before implementation)

Recorded 2026-10-08, before any implementation, at the maintainer's request. Nothing below is
reverse-engineered from code.

**Flows reviewed.** A producer's `PublishOptions` (`orderingKey`, `deduplicationId`, `headers`)
entering through any public publish entry — a broker's `publish`, `TracedBroker`, `PipelinedBroker`,
`WorkersBroker`, `publishIntegrationEvent` and a definition's `orderingKey` selector — through
validation and the header merge, onto seven transports as native properties (Kafka `key`, Pub/Sub
`orderingKey`, NATS `Nats-Msg-Id`, Service Bus `messageId`, RabbitMQ `messageId`) and as headers or
envelope fields; then delivered to a consumer as `MessageMetadata.headers`, possibly from a producer
that is not this framework. Refusal messages and the logs that quote them.

**Assets.** Delivery isolation — a message reaches only the destinations its topic names; the
framework's own control headers (`x-setu-attempt` and the disposition id on RabbitMQ, the trace
headers) and the decisions they drive; stream contents on NATS (a rollup purges); de-duplication
integrity — one producer's message is not suppressed by another's choice of id; broker capacity per
partition and per ordering key; the integrity of error messages and log records; the stability of
the validated value between check and send.

**Attackers.** (A1) An end user whose request data an application copies into an option — the
realistic case, since the options are strings an application builds. (A2) A foreign or compromised
producer with write access to a shared topic, sending any header it likes; it bypasses publish-side
validation entirely. (A3) In-process code passing a hostile `options` object: a getter or `Proxy`
answering differently on each read, a throwing trap, a `__proto__` key, symbol keys. (A4) A reader
of logs and error bodies, against whom a quoted CR/LF forges a record.

**Approved budgets.** Validation is O(caller headers), bounded at 32 headers of at most 1280 bytes
each, on the publish path only. No added round trip. The delivery path is unchanged.

**Design-time findings.**

| #   | Finding                                                                                                                                                     | Disposition                                                                                    |
| --- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| D1  | A caller `CC`/`BCC` header makes RabbitMQ deliver a copy to every queue it names (A1): cross-topic injection                                                | Reserved (§3.4)                                                                                |
| D2  | A caller `Nats-Rollup` header can purge a stream that allows rollups; `Nats-Expected-*` makes the publish fail; `Nats-Msg-Id` overrides de-duplication (A1) | Reserved by the `nats-` prefix (§3.4)                                                          |
| D3  | A caller `x-setu-attempt` header sets the retry count a RabbitMQ consumer trusts, dead-lettering a message on its first failure (A1)                        | Reserved by the `x-setu-` prefix (§3.4)                                                        |
| D4  | A caller `traceparent`/`tracestate` forges the trace `TracedBroker` writes (A1)                                                                             | Reserved (§3.4)                                                                                |
| D5  | Broker header names are compared by exact bytes, so a reserved check by exact spelling is bypassed by `Cc` or `NATS-ROLLUP`                                 | Reserved names compared ASCII-case-insensitively (§3.4)                                        |
| D6  | CR/LF or other control characters in a header name or value reach a wire format or a log line (A1, A4)                                                      | Refused in names (`0x21-0x7E`) and values (Cc/Cf/Zl/Zp) (§3.4)                                 |
| D7  | A value altered by one transport (NATS trims whitespace; UTF-8 encoders turn a lone surrogate into U+FFFD) is not the value validated                       | Refused (§3.4)                                                                                 |
| D8  | Unbounded header count or size fails on one broker and passes on another, and grows memory per publish                                                      | Count and byte bounds (§3.4)                                                                   |
| D9  | A getter or `Proxy` answers the validator one value and the broker another (A3)                                                                             | Copy once; only the copy is read (§3.4)                                                        |
| D10 | A header record copied by assignment turns a `__proto__` key into a prototype change (A3)                                                                   | `Object.fromEntries` over own string keys; symbol keys refused (§3.4)                          |
| D11 | A refusal quoting the refused value forges a log record or leaks request data (A4)                                                                          | No value quoted; a name quoted only after its character check, JSON-escaped (§3.4)             |
| D12 | A `deduplicationId` from request input lets one caller suppress another's message within the window (A1)                                                    | Documented (§3.9); the integration-event default is a producer-assigned id                     |
| D13 | An `orderingKey` from request input concentrates load on one partition or ordering key (A1)                                                                 | Documented (§3.9)                                                                              |
| D14 | A delivered `x-setu-*` header may come from a foreign producer (A2)                                                                                         | Documented as a hint, never authorization (§3.9); nothing in this milestone reads it to decide |
| D15 | A `WorkersBroker` envelope is parsed from JSON a foreign producer may have written (A2)                                                                     | Fields failing the id rule are dropped, never surfaced (§3.4)                                  |
| D16 | Pre-existing: a producer with topic write access can already forge `x-setu-attempt` on RabbitMQ, which this milestone does not change                       | Out of scope: write access to the topic is the existing trust boundary; recorded, not fixed    |

**Obligations the implementation audit must meet.**

1. No public publish entry reaches a transport without §3.4 validation: for every entry, a reserved
   name is refused before the transport fake records a call. The reserved table is complete for
   every name §1 shows a broker or its server acting on, and the `goog` prefix is measured against
   the Pub/Sub emulator (refused by the service, or recorded as not refused) rather than assumed.
2. Every reserved name and prefix is refused in lower, upper and mixed case.
3. A header name outside `0x21-0x7E` or containing `:`, and a value or id containing a Cc, Cf, Zl or
   Zp character, a lone surrogate, or leading or trailing whitespace, is refused; every count and
   byte bound is refused at limit + 1 and accepted at the limit.
4. The value on the wire is the value validated: an options object with a two-faced getter, and a
   `Proxy`, put the first-read value on the wire or are refused; a throwing getter rejects; a
   `__proto__` header arrives as an own key on a real transport and changes no prototype.
5. No refusal message contains the refused value, and a header name refused for its characters is
   not quoted at all.
6. Every refusal is a rejected promise, never a synchronous throw, from every entry.
7. The README, `PublishOptions` JSDoc and `PUBLIC_API.md` carry the three §3.9 rules, and the
   integration-event default `deduplicationId` is the envelope id.
8. `WorkersBroker` surfaces no envelope field that fails the id rule.
9. On real RabbitMQ and real NATS (CI), a header the plan reserves never reaches the server, and a
   permitted header round-trips byte for byte.
