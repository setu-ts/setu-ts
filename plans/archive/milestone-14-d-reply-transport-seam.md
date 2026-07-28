# Milestone 14d — Messaging Plugin (`@hono-enterprise/messaging-plugin`)

> **Status:** Planning. Branch: `feat/m14d-reply-transport-seam`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

M14c shipped brokered request-reply, but its implementation collapsed the seam its own plan
specified. The plan (§3.2 of `plans/archive/milestone-14-c-messaging-request-reply.md`) called for a
per-broker `IReplyTransport` with `openInbox(onReply)`, letting each broker choose its own inbox
primitive. What shipped is `RequestReplyDeps` — `publish`/`subscribe`/`uuid`/`setTimeout`/
`clearTimeout` — and all four reply-capable brokers pass a byte-identical delegation object. Nothing
named `IReplyTransport`, `openInbox`, `sendReply`, or `sendRequest` exists in `packages/`. The
generic path works only because in-memory, Redis Streams, RabbitMQ, and NATS all treat a topic as a
cheap, per-instance-addressable resource; Kafka does not, which is the real reason `KafkaBroker`
ships a throw. This milestone restores the seam, implements Kafka request-reply on it, and fixes two
defects the generic path caused.

- **In scope:** a `ReplyInbox` seam (`openInbox` on `RequestReplyDeps`) plus a shared
  `createTopicInbox` helper the four existing brokers use unchanged; `KafkaBroker.request`/`respond`
  implemented over a shared reply topic with a per-instance consumer group; **D1** — RPC traffic
  moved to a derived `rr.req.<topic>` channel so request envelopes stop leaking into plain
  `subscribe()` consumers and plain `publish()` stops being swallowed by responders; **D2** — the
  reply inbox subscribes with `{ queue: <inboxAddress> }` so brokers with competing-consumer
  semantics give it exclusive delivery; `MessagingNotSupportedError` deprecated (not removed) per
  AI_GUIDELINES §9.2; the `common` JSDoc / PUBLIC_API / README / CHANGELOG corrections in the same
  PR.
- **NOT this milestone:** rewriting `RabbitMqBroker` onto AMQP `replyTo`/`correlationId` properties
  or `NatsBroker` onto a JetStream reply subject — the M14c plan named both, both work correctly on
  the generic path today, and AI_GUIDELINES §16.4 forbids rewriting merged milestones without
  justification. A future **M14e** owns them if a measured reason appears (e.g. AMQP
  `direct-reply-to` latency). Direct point-to-point typed RPC over HTTP/2 (gRPC/Connect) remains the
  future **Connect plugin**. No change to the in-process `IEventBus` (M12) or the CQRS buses (M13).

## 1. Contracts verified from SOURCE (not names)

| Reference                            | Source (file:line)                                                                                      | Verified surface / fact                                                                                                                                                                                                                                                                                |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IMessageBroker.request`/`respond`   | `packages/common/src/services/messaging.ts:146,161`                                                     | Committed and published in `0.1.0-alpha.1`/`alpha.2`. Signatures are UNCHANGED by this milestone. The `request` JSDoc (:137) asserts "brokers that cannot (e.g. Kafka's consumer-group model)" — becomes false, so it is a doc deliverable.                                                            |
| `SubscribeOptions`                   | `packages/common/src/services/messaging.ts:43`                                                          | `{ queue?: string }` only. D2's fix therefore needs **no `common` change** — the core can pass a per-inbox queue name through the existing field.                                                                                                                                                      |
| `RequestOptions`                     | `packages/common/src/services/messaging.ts:53`                                                          | `{ timeoutMs?: number }`. Unchanged.                                                                                                                                                                                                                                                                   |
| `MessageMetadata`                    | `packages/common/src/services/messaging.ts:14`                                                          | `headers` OPTIONAL and unpopulated by in-memory/redis. Confirms the envelope-in-payload decision stays; this milestone does not move correlation to headers.                                                                                                                                           |
| `RequestReplyCore` (as shipped)      | `packages/messaging-plugin/src/brokers/request-reply-core.ts:88`                                        | `#inboxTopic` minted in the ctor as `rr.inbox.${deps.uuid()}` (:98). `#ensureInbox()` (:206) calls `deps.subscribe(inboxTopic, …)` with **no options**. `request()` awaits `#ensureInbox()` BEFORE arming the timer (:117-124), so subscribe latency delays the call but does not consume `timeoutMs`. |
| `RequestReplyDeps` (as shipped)      | `packages/messaging-plugin/src/brokers/request-reply-core.ts:47`                                        | Five members: `publish`, `subscribe`, `uuid`, `setTimeout`, `clearTimeout`. No inbox hook.                                                                                                                                                                                                             |
| Planned-but-absent `IReplyTransport` | `plans/archive/milestone-14-c-messaging-request-reply.md:78-81`                                         | Specified `openInbox(onReply): inboxAddress`, `sendReply`, `sendRequest`. `grep -rn "IReplyTransport\|openInbox\|sendReply\|sendRequest" packages/` returns **nothing** — the seam was never built.                                                                                                    |
| All four broker deps objects         | `in-memory-broker.ts:50`, `nats-broker.ts:115`, `rabbitmq-broker.ts:127`, `redis-streams-broker.ts:127` | Byte-identical five-line delegation to the broker's own `publish`/`subscribe` + `runtime` timers. No broker contributes a native reply primitive today.                                                                                                                                                |
| `RequestReplyCore.respond`           | `packages/messaging-plugin/src/brokers/request-reply-core.ts:165`                                       | Subscribes to the RAW topic and `return`s silently on a non-request envelope (:170-172) — this is D1: a plain `publish()` to a responded topic is dropped, and a plain `subscribe()` on it receives the raw envelope.                                                                                  |
| `KafkaBroker.subscribe`              | `packages/messaging-plugin/src/brokers/kafka-broker.ts:212`                                             | `groupId = options?.queue ?? this.#defaultQueue` (default `'messaging-consumers'`). A no-options inbox subscribe therefore joins the SHARED group — this is D2, and on Kafka it misroutes replies outright.                                                                                            |
| `KafkaBroker.request`/`respond`      | `packages/messaging-plugin/src/brokers/kafka-broker.ts:321,335`                                         | Both `return Promise.reject(new MessagingNotSupportedError())`. Replaced by real implementations.                                                                                                                                                                                                      |
| `IKafkaFactory`                      | `packages/messaging-plugin/src/interfaces/index.ts:76-81`                                               | **Only `producer()` and `consumer({groupId})` — NO `admin()`.** Per-instance reply-TOPIC creation is therefore unreachable without widening an option-referenced facade. This is what forces §3.2's shared-reply-topic design.                                                                         |
| `KafkaOptions`                       | `packages/messaging-plugin/src/interfaces/index.ts:245-256`                                             | `brokers`, `client`, `clientId`, `defaultQueue`, `logger`. Gains `replyTopic` (§4.1).                                                                                                                                                                                                                  |
| `InMemoryBroker.subscribe`           | `packages/messaging-plugin/src/brokers/in-memory-broker.ts:178-207`                                     | Stores `queue` on the subscriber only when truthy (:187); competing consumers share a queue name. A unique per-inbox queue is a group of one → exclusive delivery. Confirms D2's fix is safe (a no-op) on this broker.                                                                                 |
| `MessagingPlugin` kafka wiring       | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:135-142`                                      | Builds `KafkaOptions` field-by-field under `exactOptionalPropertyTypes`. `replyTopic` must be threaded the same way.                                                                                                                                                                                   |
| `MessageBrokerAdapter`               | `packages/messaging-plugin/src/brokers/message-broker.ts:11`                                            | `extends IMessageBroker` + `isReady()`. Unchanged — the seam is internal to the brokers, not on this interface.                                                                                                                                                                                        |
| `FakeKafkaFactory`                   | `packages/messaging-plugin/test/fixtures/fake-kafkajs-client.ts`                                        | Keys consumers by `groupId`; `FakeKafkaProducer.send` only RECORDS and does not feed consumers. A round-trip test therefore requires extending the fixture (§6) — it cannot be written against the fixture as-is.                                                                                      |
| Guarded real-import test             | `packages/messaging-plugin/test/unit/kafka-broker.test.ts:215-230`                                      | Existing precedent: construct with no injected client against `localhost:9999`, assert `connect()` rejects, which enters the real `loadKafkajs()` import. Reused unchanged.                                                                                                                            |
| ARCHITECTURE.md                      | `grep -in "request-reply\|kafka" ARCHITECTURE.md`                                                       | Single hit at :1329 — a telemetry auto-instrumentation row naming `kafkajs`. **No request-reply claim to correct.** ARCHITECTURE is NOT a doc deliverable here.                                                                                                                                        |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                           | Resolution (picked side)                                                                                                                                                                                                                                                                       | Doc deliverable (same PR)                                                                                                         |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `common`'s `IMessageBroker.request` JSDoc (`messaging.ts:137`) and `respond` JSDoc (:152) state that Kafka cannot support request-reply. After this milestone it can.                              | Kafka support wins. The JSDoc drops the Kafka example and describes `MessagingNotSupportedError` as reserved for future transports that cannot comply.                                                                                                                                         | Edit `packages/common/src/services/messaging.ts` JSDoc at :129-165. Contract signatures untouched.                                |
| C2 | `PUBLIC_API.md:2331-2334` carries a "Broker support" blockquote naming Kafka unsupported, and :2329 an error-table row saying the same.                                                            | Same as C1. Rewrite the blockquote to list all five brokers as reply-capable and document the Kafka reply-topic prerequisite.                                                                                                                                                                  | Edit `PUBLIC_API.md` §Request-Reply (:2322-2334), add the `replyTopic` option to §Plugin Options.                                 |
| C3 | `packages/messaging-plugin/README.md:41` marks `'kafka'` request-reply as **no**; :49 repeats the prose.                                                                                           | Same as C1.                                                                                                                                                                                                                                                                                    | Edit the broker table row and the §Request-reply prose.                                                                           |
| C4 | AI_GUIDELINES §9.4 forbids removing a public export without deprecation, but after this change `MessagingNotSupportedError` has no thrower — which the CLAUDE.md dead-surface rule calls a defect. | **§9.2 wins.** The dead-surface rule governs NEW surface being invented; §9.2 governs surface already published (this class shipped in `0.1.0-alpha.1`). Keep the export, mark `@deprecated`, remove in the next major. Recorded as a design decision in §3.5 so it is deliberate, not silent. | JSDoc `@deprecated` on the class; PUBLIC_API error-table row annotated; CHANGELOG "Deprecated" entry.                             |
| C5 | The on-the-wire RPC format changes (D1 moves requests to `rr.req.<topic>`), but `0.1.0-alpha.2` is published.                                                                                      | **Break it, document it.** Pre-1.0 alpha; the envelope was never a documented stability promise. Maintainer decision recorded here.                                                                                                                                                            | CHANGELOG `### Changed` **BREAKING** entry stating an alpha.2 responder and an alpha.3 requester do not interoperate mid-rollout. |

## 3. Design decisions

### 3.1 `openInbox` restored on `RequestReplyDeps`; four brokers share one helper

- **Decision:** `RequestReplyDeps` gains a sixth member,
  `openInbox(onReply: (message: unknown) => void): Promise<ReplyInbox>`, where
  `ReplyInbox = { readonly address: string; close(): Promise<void> }`. `RequestReplyCore` stops
  minting `rr.inbox.<uuid>` in its constructor and stops calling `deps.subscribe` for its own inbox;
  `#ensureInbox()` calls `deps.openInbox(...)` instead and stores the returned `address` as the
  `replyTo` it stamps on each request envelope. A new internal module `src/brokers/inbox.ts` exports
  `createTopicInbox(deps)`, which reproduces today's behavior exactly (mint `rr.inbox.<uuid>`,
  `subscribe` to it, `unsubscribe` on close) — the four existing brokers pass
  `openInbox: createTopicInbox({ subscribe, uuid })` and are behavior-identical apart from D2.
  `KafkaBroker` passes its own (§3.2). The failed-init memo-clearing already in `#ensureInbox()`
  (`request-reply-core.ts:206-217`) is preserved verbatim.
- **Why:** This is the seam M14c's own plan specified and the implementation dropped. It is the
  minimum change that lets a broker define what an inbox _is_ rather than having a topic string
  imposed on it, and `createTopicInbox` keeps the four working brokers on one shared code path
  (AI_GUIDELINES §11.1) instead of duplicating inbox logic five times.
- **Test home:** `test/unit/inbox.test.ts` covers `createTopicInbox` (address shape, subscribe
  delegation, close→unsubscribe). `test/unit/request-reply-core.test.ts` asserts the core calls
  `openInbox` exactly once across concurrent requests, uses the returned `address` as `replyTo`, and
  clears the memo when `openInbox` rejects so a later call retries.

### 3.2 Kafka inbox: one shared reply topic, one consumer group per broker instance

- **Decision:** `KafkaBroker` supplies an `openInbox` that subscribes to a single configurable reply
  topic (`KafkaOptions.replyTopic`, default `'messaging.replies'`) using a **unique per-instance
  consumer group**, `rr-inbox-${runtime.uuid()}`, passed through the existing
  `SubscribeOptions.queue`. `ReplyInbox.address` is the reply topic itself. Every instance therefore
  receives every reply and discards those whose `correlationId` is not in its own pending map —
  which `#onReply` already does (`request-reply-core.ts:225-232`), so **no envelope change is
  needed**: correlation ids are `runtime.uuid()` values and never collide across instances. The
  reply topic must exist (or Kafka auto-create must be enabled); this is documented as an ops
  prerequisite rather than created by the broker.
- **Why:** `IKafkaFactory` exposes no `admin()` (`interfaces/index.ts:76-81`), so creating a
  per-instance reply topic is unreachable without widening a facade that `KafkaOptions.client`
  exposes to consumers — a public-API change with no other consumer. A shared topic needs no admin
  API and no topic lifecycle, so it also answers the "abandoning an inbox must be free" problem:
  only the consumer group is left behind, and Kafka expires idle groups on
  `offsets.retention.minutes`. The unique group is what makes delivery exclusive to the requesting
  instance, which the shared `defaultQueue` (`kafka-broker.ts:212`) actively prevents today.
- **Trade-off (documented, not hidden):** reply delivery is O(instances) — each of N broker
  instances reads every reply and drops ~(N−1)/N of them. Acceptable for RPC-scale traffic and
  stated in the README and PUBLIC_API; an application needing better fan-out isolation configures a
  distinct `replyTopic` per service.
- **Test home:** `test/unit/kafka-broker.test.ts` — round-trip resolve; the inbox consumer is
  created with a groupId matching `/^rr-inbox-/` and NOT `'messaging-consumers'`; two broker
  instances on one reply topic each resolve only their own correlation id; `replyTopic` default and
  override.

### 3.3 D1 — RPC moves to a derived `rr.req.<topic>` channel

- **Decision:** `RequestReplyCore.request(topic, …)` publishes to `` `rr.req.${topic}` `` and
  `respond(topic, …)` subscribes to `` `rr.req.${topic}` ``. The `isRequestEnvelope` guard stays as
  a defensive check but is no longer the routing mechanism. Plain `publish`/`subscribe` on `topic`
  are untouched. The prefix is a module-level constant, not a literal (AI_GUIDELINES §11.2).
- **Why:** Today `respond()` shares the raw topic with pub/sub, so (a) a plain `subscribe()` handler
  on that topic receives `{ kind: 'rr-request', correlationId, replyTo, payload }` instead of the
  payload, and (b) a plain `publish()` to it is silently dropped by the responder's guard
  (`request-reply-core.ts:170-172`). Separating the channel fixes both at the routing layer rather
  than filtering defensively, which would still mis-handle a user payload that happened to carry a
  `kind` field. C5 records the maintainer decision that the resulting wire break is acceptable.
- **Test home:** `test/unit/request-reply-core.test.ts` asserts the published topic is
  `rr.req.<topic>` and the subscribed topic matches. `test/unit/in-memory-broker.test.ts` adds the
  D1 regression pair: with a responder active on `'t'`, a plain `subscribe('t')` handler receives
  the raw payload (never an envelope), and a plain `publish('t', …)` reaches that handler rather
  than being swallowed.

### 3.4 D2 — the inbox subscribes under its own queue name

- **Decision:** every `openInbox` implementation passes `{ queue: <unique per-instance name> }` to
  `subscribe`. For `createTopicInbox` the name is the inbox topic itself (already unique per
  instance); for Kafka it is `rr-inbox-<uuid>` (§3.2).
- **Why:** `KafkaBroker.subscribe` falls back to the shared `defaultQueue` when no queue is given
  (`kafka-broker.ts:212`), which routes replies to whichever group member owns the partition — not
  necessarily the caller. On the other four brokers each inbox topic already has exactly one
  subscriber, so a unique queue name is a correctness no-op there (verified for in-memory at
  `in-memory-broker.ts:187`); the change is therefore safe everywhere and load-bearing on Kafka. No
  `common` change: `SubscribeOptions.queue` already exists (`messaging.ts:43`).
- **Test home:** `test/unit/inbox.test.ts` asserts the queue name is passed and equals the address;
  `test/unit/kafka-broker.test.ts` asserts the inbox groupId is unique and not the default.

### 3.5 `MessagingNotSupportedError` is deprecated, not deleted

- **Decision:** the class stays exported from `src/index.ts` with an `@deprecated` JSDoc block
  naming its removal in the next major and stating that no broker in this version throws it. It
  keeps its `PUBLIC_API.md` row, annotated as deprecated. No code throws it after this milestone.
- **Why:** it shipped in `0.1.0-alpha.1`, so AI_GUIDELINES §9.2's deprecation process applies;
  deleting it would be a silent breaking change to a published export (§9.4). This is the C4
  resolution made explicit so a reviewer does not read the now-unthrown class as an oversight.
- **Test home:** `test/unit/messaging-errors.test.ts` keeps its existing construction/`instanceof`
  assertions (the class must remain constructible and catchable for consumers holding `instanceof`
  checks); `test/unit/barrel-exports.test.ts` keeps asserting it is exported.

## 4. Exported surface — every symbol names its consumer

No symbol is ADDED to `packages/messaging-plugin/src/index.ts` by this milestone. `ReplyInbox` and
`createTopicInbox` are internal (`src/brokers/inbox.ts`), consumed by the five brokers, and
deliberately NOT barrel-exported — same posture as `RequestReplyCore`, which M14c also kept
internal.

| Exported symbol              | Kind                     | Consumer / real code path that READS it                                                                                                          |
| ---------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KafkaBroker`                | class (already exported) | `MessagingPlugin` (`messaging-plugin.ts:142`); now additionally reached via `request`/`respond` by application RPC code.                         |
| `MessagingNotSupportedError` | class (already exported) | **Deprecated (§3.5).** Retained for consumers holding `instanceof` checks written against `0.1.0-alpha.1`/`alpha.2`. No thrower in this version. |
| `KafkaOptions`               | type (already exported)  | `MessagingPlugin` kafka arm; gains `replyTopic`, read by `KafkaBroker`'s `openInbox` (§4.1).                                                     |
| `RequestOptions`             | type (re-exported)       | Unchanged — `RequestReplyCore` reads `timeoutMs`.                                                                                                |
| `RequestHandler`             | type (re-exported)       | Unchanged — `respond()` signature on all five brokers.                                                                                           |

Internal (not exported from `index.ts`):

| Internal symbol     | Kind      | Consumer                                                                                                         |
| ------------------- | --------- | ---------------------------------------------------------------------------------------------------------------- |
| `ReplyInbox`        | interface | Return type of `openInbox`; read by `RequestReplyCore.#ensureInbox` for `address` and by `close()` for teardown. |
| `createTopicInbox`  | function  | Called by `InMemoryBroker`, `RedisStreamsBroker`, `RabbitMqBroker`, `NatsBroker` when building their deps.       |
| `RR_REQUEST_PREFIX` | constant  | Read by `RequestReplyCore.request` and `.respond` to derive the RPC channel (§3.3).                              |

### 4.1 Options — every option names its consumer

| Option                    | Consumer                 | Behavior (per implementation)                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------- | ------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `KafkaOptions.replyTopic` | `KafkaBroker.#openInbox` | The Kafka topic every reply is published to and every instance's inbox consumer reads. Defaults to `'messaging.replies'`. Threaded from `MessagingPluginOptions` through the kafka arm at `messaging-plugin.ts:135-142` in the same field-by-field style. **Kafka only** — the other four brokers mint a per-instance inbox topic and ignore the concept, so the option is not added to their option types (dead-option rule). |

## 5. Implementation files

| File                                                            | Purpose                                                                                                                                                                                  |
| --------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/messaging-plugin/src/brokers/inbox.ts`                | **NEW.** `ReplyInbox` interface + `createTopicInbox(deps)` shared helper (§3.1, §3.4). Not barrel-exported.                                                                              |
| `packages/messaging-plugin/src/brokers/request-reply-core.ts`   | `openInbox` added to `RequestReplyDeps`; ctor stops minting the inbox topic; `#ensureInbox` uses the seam; `request`/`respond` derive `rr.req.<topic>`; `close()` calls `inbox.close()`. |
| `packages/messaging-plugin/src/brokers/kafka-broker.ts`         | Replace both `MessagingNotSupportedError` rejections with real delegation to a `RequestReplyCore` built on a Kafka `openInbox` (§3.2); `replyTopic` field; `disconnect` closes the core. |
| `packages/messaging-plugin/src/brokers/in-memory-broker.ts`     | Pass `openInbox: createTopicInbox(...)` in its deps object.                                                                                                                              |
| `packages/messaging-plugin/src/brokers/redis-streams-broker.ts` | Same.                                                                                                                                                                                    |
| `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts`      | Same.                                                                                                                                                                                    |
| `packages/messaging-plugin/src/brokers/nats-broker.ts`          | Same.                                                                                                                                                                                    |
| `packages/messaging-plugin/src/interfaces/index.ts`             | `KafkaOptions.replyTopic?: string`; `MessagingPluginOptions.replyTopic?: string`.                                                                                                        |
| `packages/messaging-plugin/src/plugin/messaging-plugin.ts`      | Thread `replyTopic` into the kafka arm (`exactOptionalPropertyTypes`-safe conditional assignment).                                                                                       |
| `packages/messaging-plugin/src/errors.ts`                       | `@deprecated` JSDoc on `MessagingNotSupportedError` (§3.5). No behavior change.                                                                                                          |
| `packages/common/src/services/messaging.ts`                     | JSDoc only (C1) — no signature or contract change.                                                                                                                                       |

Doc deliverables (same PR, no code): `PUBLIC_API.md` (C2 + `replyTopic`),
`packages/messaging-plugin/README.md` (C3), `CHANGELOG.md` (C4 Deprecated + C5 BREAKING),
`ROADMAP.md` (new M14d section + `14d` progress row), `CLAUDE.md` (Current status).

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                      | src covered                           | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| -------------------------------------------------------------- | ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/inbox.test.ts` **(NEW)**                            | `src/brokers/inbox.ts`                | `createTopicInbox({subscribe, uuid})` returns `address` matching `/^rr\.inbox\./`; delegates to `subscribe(address, handler, { queue: address })` (D2, §3.4); `close()` calls `unsubscribe()` exactly once; a rejecting `subscribe` propagates. Calls type-check against `ReplyInbox`.                                                                                                                                                                                                                         |
| `test/unit/request-reply-core.test.ts` **(updated)**           | `src/brokers/request-reply-core.ts`   | Existing M14c assertions retained (correlation match, timeout reject + pending cleanup, late-reply drop, failed-init memo clear, `close()` rejects in-flight). NEW: `openInbox` called exactly once across two concurrent `request()` calls; `replyTo` equals the returned `address`; `request` publishes to `rr.req.<topic>` and `respond` subscribes to `rr.req.<topic>` (§3.3); `close()` calls `inbox.close()`. Fake deps implement the 6-member `RequestReplyDeps`.                                       |
| `test/unit/kafka-broker.test.ts` **(updated)**                 | `src/brokers/kafka-broker.ts`         | Round-trip `request`/`respond` resolves through the extended fake (below); inbox consumer groupId matches `/^rr-inbox-/` and is NOT `'messaging-consumers'` (§3.2/D2); two instances sharing one `replyTopic` each resolve only their own correlation id; `replyTopic` defaults to `'messaging.replies'` and honors an override; `RequestTimeoutError` on no responder; `RemoteHandlerError` when the responder throws; existing guarded real-import test (`kafka-broker.test.ts:215-230`) retained unchanged. |
| `test/fixtures/fake-kafkajs-client.ts` **(extended)**          | — (fixture)                           | `FakeKafkaProducer.send` currently only records (§1). Extend so a `send` routes the message into every consumer subscribed to that topic, honoring the existing per-`groupId` consumer map and auto-commit modelling. Required for any round-trip assertion; fixture stays faithful to kafkajs semantics (CLAUDE.md test-double rule).                                                                                                                                                                         |
| `test/unit/in-memory-broker.test.ts` **(updated)**             | `src/brokers/in-memory-broker.ts`     | D1 regression pair (§3.3): with `respond('t', …)` active, a plain `subscribe('t')` handler receives the raw payload and never a `kind: 'rr-request'` object; a plain `publish('t', …)` reaches that handler. Plus existing round-trip retained.                                                                                                                                                                                                                                                                |
| `test/unit/nats-broker.test.ts` **(updated)**                  | `src/brokers/nats-broker.ts`          | Round-trip still resolves through `createTopicInbox`; subscribed request topic is `rr.req.<topic>`.                                                                                                                                                                                                                                                                                                                                                                                                            |
| `test/unit/rabbitmq-broker.test.ts` **(updated)**              | `src/brokers/rabbitmq-broker.ts`      | Same as NATS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `test/unit/redis-streams-broker.test.ts` **(updated)**         | `src/brokers/redis-streams-broker.ts` | Same as NATS.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `test/unit/messaging-errors.test.ts` **(updated)**             | `src/errors.ts`                       | `MessagingNotSupportedError` remains constructible, `instanceof Error`, and carries its message (§3.5) — it is deprecated, not removed.                                                                                                                                                                                                                                                                                                                                                                        |
| `test/unit/messaging-plugin.test.ts` **(updated)**             | `src/plugin/messaging-plugin.ts`      | `replyTopic` is threaded into the kafka arm and omitted (not `undefined`) when unset, per `exactOptionalPropertyTypes`.                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/unit/barrel-exports.test.ts` **(unchanged)**             | `src/index.ts`                        | Export set is unchanged by this milestone — asserts no accidental addition or removal.                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `test/integration/messaging-integration.test.ts` **(updated)** | plugin + brokers                      | Through a real kernel app: `MessagingPlugin({ broker: 'kafka', client: fakeFactory })` resolves `CAPABILITIES.MESSAGING` and completes an RPC round-trip; a memory-broker responder and a plain subscriber coexist on one topic (D1 at the public surface).                                                                                                                                                                                                                                                    |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m14d-reply-transport-seam, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

Additionally, per CLAUDE.md "Before reporting a task done":

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/messaging-plugin/src
grep -rn "IReplyTransport\|openInbox" packages/messaging-plugin/src   # the seam must actually exist this time
```

## 8. Risks & mitigations

- **Rewriting a merged milestone (AI_GUIDELINES §16.4).** → Justified in §0 and requested by the
  maintainer; public signatures are unchanged, the four working brokers keep their behavior via
  `createTopicInbox`, and every behavior change is enumerated in §2 with a doc deliverable.
- **The wire break (C5) bites a rolling deploy.** → CHANGELOG entry states plainly that an alpha.2
  responder and an alpha.3 requester do not interoperate, and that RPC responders should be drained
  or restarted together rather than rolled.
- **Kafka reply topic must pre-exist.** → Documented as an ops prerequisite in README + PUBLIC_API
  with the default name; a missing topic surfaces as the producer's own error rather than a silent
  hang, because `request()` awaits `publish` and rejects on its failure
  (`request-reply-core.ts:139-148`).
- **Fixture extension could enshrine wrong Kafka semantics** (CLAUDE.md test-double rule). → The
  extended `FakeKafkaProducer.send` must preserve the existing per-`groupId` consumer map and
  commit-on-resolve modelling; the guarded real-import test stays as the one path touching real
  kafkajs.
- **Coverage regression in the four untouched brokers** when their deps object changes shape. → §6
  names an updated test for each; per-file table re-read after the refactor, not just after
  additions.
- **O(instances) reply fan-out on Kafka** (§3.2). → Documented trade-off with the per-service
  `replyTopic` escape hatch; not hidden.

## 9. Out of scope

- **AMQP `replyTo`/`correlationId` and NATS JetStream reply subjects** — the native primitives
  M14c's plan named. Deferred to a future **M14e**; the restored seam is what makes them
  implementable without touching `RequestReplyCore` again.
- **gRPC / Connect typed RPC over HTTP/2** — the future **Connect plugin**. Note that native gRPC
  additionally needs HTTP/2 trailers, which the `fetch`-shaped `IHttpAdapter`
  (`packages/common/src/runtime.ts:292-322`) cannot express; that plugin owns the escape hatch.
- **Widening `IKafkaFactory` with `admin()`** — would enable per-instance reply topics, but §3.2
  reaches the same guarantee without a public-API change. Revisit only if the shared-topic fan-out
  proves costly.
- **Moving correlation onto `MessageMetadata.headers`** — still blocked by in-memory and Redis not
  populating headers (`messaging.ts:22`, verified in M14c).
