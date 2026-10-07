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
  - Validation, rejected by name.
  - `enableMessageOrdering` on both Pub/Sub arms (`PubSubMessagingOptionsInjected`,
    `PubSubMessagingOptionsProduction`) for subscriptions the transport creates.
  - `publishIntegrationEvent` passing the envelope ID as the deduplication ID, and accepting caller
    options.
- **NOT this milestone:**
  - Awaiting NATS's JetStream acknowledgement — a defect in merged code, fixed first on
    `fix/nats-publish-ack` (§8). This milestone depends on it.
  - Deriving `orderingKey` from the envelope's `aggregateId` by default: that changes Kafka
    partitioning for existing producers, a changed default the versioning policy holds for a minor.
    Recorded in CHANGELOG `Unreleased` as an entry marked for the next minor.
  - Options on `request()`/`respond()` (RPC is framework-internal correlation traffic).
  - The transactional outbox and the consumer inbox (later milestones, `ROADMAP.md` "Deferred
    reliability milestone").
  - Service Bus sessions: consuming a session-enabled subscription needs a session receiver, which
    this broker does not use (§3.3).
  - SNS/SQS in `queue-plugin`: a different contract (`IQueue`).

## 1. Contracts verified from SOURCE (not names)

| Reference                                   | Source (file:line)                                                                              | Verified surface / fact                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IMessageBroker.publish`                    | `packages/common/src/services/messaging.ts:117`                                                 | `publish<T>(topic: string, message: T): Promise<void>` — no third parameter                                                                                  |
| `MessageMetadata.headers`                   | `packages/common/src/services/messaging.ts:14-26`                                               | optional `Readonly<Record<string, string>>`; first-party brokers populate `{}` when no headers arrived                                                       |
| `MessageBrokerAdapter.publishWithHeaders`   | `packages/messaging-plugin/src/brokers/message-broker.ts:41`                                    | internal header channel every broker already implements; `publish` delegates to it with `{}`                                                                 |
| `TracedBroker.publish`                      | `packages/messaging-plugin/src/tracing/traced-broker.ts:45-69`                                  | adds `traceparent` and calls the inner `publishWithHeaders`                                                                                                  |
| `PipelinedBroker.publish`                   | `packages/messaging-plugin/src/pipeline/pipelined-broker.ts:144`                                | decorator; must forward a new argument or drop it (the M70i dropped-argument class)                                                                          |
| Kafka publish                               | `packages/messaging-plugin/src/brokers/kafka-broker.ts:558-584`                                 | `send({ topic, messages: [{ value, headers }] })` — no `key`                                                                                                 |
| NATS publish                                | `packages/messaging-plugin/src/brokers/nats-broker.ts:478-506`                                  | `js.publish(subject, data, { headers })`, typed `void` and NOT awaited (defect, §8)                                                                          |
| `IPubSubTransport.publish` (exported)       | `packages/messaging-plugin/src/brokers/pubsub-broker.ts:146`, `index.ts:117`                    | `(topic, bytes, attributes?)`; the SDK adapter builds `pubsub.topic(topic)` per call (`:253`)                                                                |
| `IServiceBusTransport.send` (exported)      | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:137`, `index.ts:125`               | `(topic, body, applicationProperties?)`; the adapter calls `sendMessages(message)` (`:474`)                                                                  |
| RabbitMQ publish                            | `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts:669-700`                              | sets `messageId` from `runtime.uuid()` (`:689`), headers via properties                                                                                      |
| Redis Streams publish                       | `packages/messaging-plugin/src/brokers/redis-streams-broker.ts:335`                             | header fields on the stream entry                                                                                                                            |
| In-memory publish                           | `packages/messaging-plugin/src/brokers/in-memory-broker.ts:145`                                 | resolves on dispatch hand-off (M89c); headers delivered as given                                                                                             |
| `WorkersBroker.publish`                     | `packages/cloudflare-plugin/src/messaging/workers-broker.ts:254`                                | `encodePublishEnvelope(topic, id, payload)` (`message-envelope.ts:107`) — no header field                                                                    |
| `publishIntegrationEvent`                   | `packages/messaging-plugin/src/integration/publish.ts:63`                                       | `(runtime, broker, definition, payload, metadata?)` → `broker.publish(topic, envelope)`                                                                      |
| Envelope ID                                 | `packages/messaging-plugin/src/integration/envelope.ts:38`                                      | `readonly id: string`, producer-assigned, fresh per envelope; `aggregateId` optional (`:52`)                                                                 |
| `TRACEPARENT_HEADER`                        | `packages/common/src/trace-context.ts:11`                                                       | `'traceparent'` — the framework-owned header a caller must not overwrite                                                                                     |
| Kafka key → partition (measured 2026-10-07) | real `apache/kafka:4.0.0`, kafkajs 2.2.4, 3 partitions                                          | 12 unkeyed messages spread over partitions 0,1,2; 3 keys × 10 messages each landed on ONE partition per key, in publish order                                |
| NATS `msgID` (measured)                     | real `nats:2-alpine -js`, nats.js 2.29.3                                                        | second publish with the same `msgID` (and with a `Nats-Msg-Id` header) answered `duplicate: true`; stream held 1 copy each; `duplicate_window` default 120 s |
| NATS unmatched subject (measured)           | same                                                                                            | `js.publish` returns a promise that REJECTS (`503`); through the real `NatsBroker` the publish resolved and the rejection was unhandled                      |
| Pub/Sub `orderingKey` (measured)            | `google-cloud-cli:emulators`, `@google-cloud/pubsub@^6`                                         | publish with `orderingKey` accepted with and without `messageOrdering: true`; a non-ordering subscription received all messages                              |
| Service Bus (measured)                      | `servicebus-emulator`, `@azure/service-bus@^7`, `docs/fixtures/servicebus-emulator-config.json` | `sessionId` on a non-session subscription delivered to a plain receiver; a repeated `messageId` delivered twice (no duplicate detection configured)          |

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

- **Decision:** `orderingKey` and `deduplicationId`, when present, must be non-empty strings of at
  most 128 UTF-8 bytes with no control or format character. Header names must be non-empty and free
  of control characters, and values must be strings. `traceparent`, `tracestate` and any `x-setu-`
  name are reserved and refused. Every refusal is a `RangeError` naming the field, delivered as a
  REJECTED promise — never a synchronous throw from a `Promise`-returning method (the M52b class).
- **Why:** 128 is Service Bus's `messageId` limit, the tightest of the four natives, so one portable
  bound never fails on one broker and passes on another. Control characters are refused because NATS
  and RabbitMQ write headers to the wire. A caller-supplied `traceparent` would forge the trace
  `TracedBroker` writes.
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

### 3.7 `publishIntegrationEvent`

- **Decision:** gains a sixth parameter `options?: PublishOptions`. Its `deduplicationId` defaults
  to the envelope ID; a caller-supplied one wins. It does not derive `orderingKey`.
- **Why:** the envelope ID is the end-to-end de-duplication key (producer-assigned, fresh per
  envelope), so this default changes nothing observable except a header and NATS/Service Bus
  de-duplicating a re-send — which cannot occur through this API today. Deriving `orderingKey` from
  `aggregateId` would re-partition existing Kafka producers: a changed default, held for a minor
  (§0).
- **Test home:** `packages/messaging-plugin/test/unit/integration/publish.test.ts`.

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `options` is an optional trailing parameter, so a two-parameter
`publish` stays assignable, and both exported transports gain an optional trailing parameter.

| Exported symbol                           | Kind  | Consumer / real code path that READS it                                            |
| ----------------------------------------- | ----- | ---------------------------------------------------------------------------------- |
| `PublishOptions` (`common`)               | type  | `IMessageBroker.publish`, every broker, both decorators, `publishIntegrationEvent` |
| `ORDERING_KEY_HEADER` (`common`)          | const | every broker's header write; consumers reading `MessageMetadata.headers`           |
| `DEDUPLICATION_ID_HEADER` (`common`)      | const | same                                                                               |
| `IPubSubTransport.publish` 4th parameter  | param | `GcpPubSubBroker.publishWithHeaders` passes `orderingKey`                          |
| `IServiceBusTransport.send` 4th parameter | param | `ServiceBusBroker.publishWithHeaders` passes `messageId`                           |

### 4.1 Options — every option names its consumer

| Option                                                                                                              | Consumer                      | Behavior (per implementation)                                   |
| ------------------------------------------------------------------------------------------------------------------- | ----------------------------- | --------------------------------------------------------------- |
| `PublishOptions.orderingKey`                                                                                        | every broker                  | §3.3 table                                                      |
| `PublishOptions.deduplicationId`                                                                                    | every broker                  | §3.3 table                                                      |
| `PublishOptions.headers`                                                                                            | every broker's header channel | written beside framework headers; reserved names refused (§3.4) |
| `enableMessageOrdering` on both Pub/Sub arms (`PubSubMessagingOptionsInjected`, `PubSubMessagingOptionsProduction`) | the SDK adapter's `open()`    | creates the transport's subscriptions with ordering enabled     |

## 5. Implementation files

| File                                                                            | Purpose                                               |
| ------------------------------------------------------------------------------- | ----------------------------------------------------- |
| `packages/common/src/services/messaging.ts`                                     | `PublishOptions`, the header constants, the parameter |
| `packages/common/src/index.ts`                                                  | barrel exports                                        |
| `packages/messaging-plugin/src/brokers/publish-options.ts`                      | internal: validation and the shared header merge      |
| `packages/messaging-plugin/src/brokers/message-broker.ts`                       | `publishWithHeaders` gains the options                |
| `packages/messaging-plugin/src/brokers/*-broker.ts` (seven)                     | native mapping and header carriage                    |
| `packages/messaging-plugin/src/tracing/traced-broker.ts`                        | forwards options                                      |
| `packages/messaging-plugin/src/pipeline/pipelined-broker.ts`                    | forwards options                                      |
| `packages/messaging-plugin/src/integration/publish.ts`                          | sixth parameter, default `deduplicationId`            |
| `packages/messaging-plugin/src/interfaces/index.ts`                             | `enableMessageOrdering`                               |
| `packages/cloudflare-plugin/src/messaging/{workers-broker,message-envelope}.ts` | optional envelope fields                              |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                       | src covered               | Key assertions                                                                               |
| ------------------------------------------------------------------------------- | ------------------------- | -------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/publish-options.test.ts`                             | `messaging.ts`            | a two-parameter implementor assigns; barrel exports both constants                           |
| `packages/messaging-plugin/test/unit/publish-options-validation.test.ts`        | `publish-options.ts`      | each §3.4 refusal is a rejected promise naming the field; 128-byte boundary both sides       |
| `packages/messaging-plugin/test/integration/header-conformance.test.ts`         | all seven brokers         | one row per broker × option, asserting the wire shape from §3.3                              |
| `packages/messaging-plugin/test/integration/kafka-real.test.ts`                 | `kafka-broker.ts`         | same key → one partition, in order; no key → unchanged                                       |
| `packages/messaging-plugin/test/integration/nats-real.test.ts`                  | `nats-broker.ts`          | repeated `deduplicationId` stored once                                                       |
| `packages/messaging-plugin/test/unit/pubsub-adapter.test.ts`                    | `pubsub-broker.ts`        | topic cached, `messageOrdering: true`, `resumePublishing` after a failure, subscription flag |
| `packages/messaging-plugin/test/integration/messaging-telemetry.test.ts`        | both decorators           | options survive tracing + behaviours; `traceparent` still the framework's                    |
| `packages/messaging-plugin/test/unit/integration/publish.test.ts`               | `integration/publish.ts`  | default `deduplicationId` = envelope ID; caller wins; no `orderingKey` derived               |
| `packages/cloudflare-plugin/test/unit/messaging/workers-broker-publish.test.ts` | Workers broker + envelope | fields round-trip; an envelope without them still decodes                                    |

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
`key` (real partition test fails); drop `Nats-Msg-Id` (NATS dedup test fails).

## 8. Risks & mitigations

- **NATS publish acknowledgement is not awaited (pre-existing defect).** Without it, the NATS
  deduplication mapping cannot report anything and a refused publish kills the process. Mitigation:
  `fix/nats-publish-ack` lands first; this branch rebases on it.
- **Pub/Sub ordering semantics on the real service may differ from the emulator.** Mitigation: the
  emulator-backed behaviour is recorded as such in the README table, unverified against a live
  project (the M30b/M52 standard).
- **A hot ordering key concentrates one Kafka partition.** Mitigation: documented; the key is
  caller-chosen.

## 9. Out of scope

- Ordering by default in `publishIntegrationEvent` — the next minor (§0).
- The outbox relay and consumer inbox — later milestones.
- Service Bus sessions — needs a session receiver mode; no current consumer asks for it.
