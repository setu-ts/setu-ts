# Milestone 119a — Messaging (`@setu-ts/messaging-plugin`)

> **Status:** Planning. Branch: `feat/m119a-message-delivery-bounds`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR into `develop`.

## 0. Objective & scope

A consumer must not see a message again because its process restarted or its group is new, and every
publish must have a bound that fails with a named error. Five register rows from the `v0.10.0` run,
all in `messaging-plugin`: V10-13 (High, NATS replay), V10-2 (Kafka first-join duplicate), V10-21
(Redis Streams publish with no bound), V10-30 (publish timeouts are a bare `Error`), V10-5 (outbox
`markSent` pause reads as a store failure).

- **In scope:** the meaning of a queue-less NATS subscription (maintainer decision 2026-10-24: a
  shared group named from `defaultQueue`) and the reply inbox's consumer shape; a reaping threshold
  for the consumers earlier releases leaked; the Kafka first-join seek rule; one exported
  `PublishTimeoutError` thrown by every bounded arm; a `publishTimeoutMs` bound on the Redis Streams
  and NATS arms; the V10-5 decision and its README correction; the ROADMAP's incorrect cross-broker
  claim.
- **NOT this milestone:** readiness of the mail, backplane, queue and migration indicators (M119b);
  the RabbitMQ _queue_ indicator (V10-22, M119b); a fan-out (every-replica) subscription mode on
  NATS, and aligning RabbitMQ's queue-less fan-out with the other arms — both are new behaviour with
  no register row and need their own milestone if wanted; the Service Bus publish bound — the Azure
  SDK bounds each send through its own `retryOptions`, so no row and no change; the Redis Streams
  dead-letter `XADD` on the consumer path (`redis-streams-broker.ts:609`), which is no publish.

## 1. Contracts verified from SOURCE (not names)

| Reference                                       | Source (file:line)                                                                                                                                                                           | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| NATS queue-less subscribe                       | `packages/messaging-plugin/src/brokers/nats-broker.ts:628`, `:656-662`                                                                                                                       | The queue falls back to the literal `messaging-` plus a fresh `runtime.uuid()`; `jsm.consumers.add` is sent `name`, `filter_subject`, `durable_name` (= name), `ack_policy: 'explicit'`, `metadata` — durable, no `deliver_policy` (server default `all`). V10-13's mechanism, confirmed.                                                                                                                                                                                                                                                                                                                           |
| NATS `defaultQueue` is dead                     | `interfaces/index.ts:578` (`NatsMessagingOptions`), `:886` (`NatsOptions`); `plugin/messaging-plugin.ts:403`                                                                                 | Declared on both interfaces and copied by the plugin; `nats-broker.ts` never reads it (grep: 0 hits).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Queue-less meaning on the other arms            | `redis-streams-broker.ts:183,382`; `kafka-broker.ts:460,821`; `pubsub-broker.ts:503,698`; `service-bus-broker.ts:682,998`; `rabbitmq-broker.ts:492,881,904-905`; `in-memory-broker.ts:30-31` | Redis Streams and Service Bus: the shared group `defaultQueue` (default `messaging-consumers`). Kafka and Pub/Sub: a shared group derived per topic from `defaultQueue`. RabbitMQ: `<defaultQueue>-<uuid>`, exclusive + auto-delete (fan-out). In-memory: fan-out. The ROADMAP's "the fan-out meaning every other broker gives a queue-less subscriber" is false for four of six arms.                                                                                                                                                                                                                              |
| External frameworks (2026-10-24)                | Spring Cloud Stream, NestJS, Dapr, Moleculer, MassTransit docs (sources in the PR)                                                                                                           | Fan-out camp: Spring Cloud Stream (no group → anonymous, non-durable, auto-deleted, starts at latest); NestJS NATS transport (no `queue` → every instance). Shared-group camp: Dapr (group = app id), Moleculer (balanced by service name), MassTransit (endpoint named from the service). The maintainer chose the shared group.                                                                                                                                                                                                                                                                                   |
| NATS consumer collision check                   | `nats-broker.ts:630-633`, `:664-679`; `errors.ts` `NatsConsumerNameCollisionError`                                                                                                           | A consumer that exists with a different config is attached only if its recorded `setu.queue` and `filter_subject` both match; else `NatsConsumerNameCollisionError`.                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Consumer-name encoding                          | `brokers/nats-consumer-name.ts:51-58`                                                                                                                                                        | `toJetStreamConsumerName` escapes `.`, `*`, `>`, `/`, `\`, whitespace as `_` + two hex digits; legal names pass unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| NATS unsubscribe / disconnect                   | `nats-broker.ts:785-797`, `:430-450`                                                                                                                                                         | Both only `stop()` the `ConsumerMessages` handle; neither deletes a consumer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Reply inbox on NATS                             | `brokers/inbox.ts:118-124`, `nats-broker.ts:251`                                                                                                                                             | `createTopicInbox` subscribes `rr.inbox.<uuid>` with `queue` set to that address and `[REPLY_INBOX_TRANSIENT]: true`. NATS ignores the marker (only `rabbitmq-broker.ts:861,903` read it), so every process leaves a durable `rr_2einbox_2e<uuid>` consumer behind.                                                                                                                                                                                                                                                                                                                                                 |
| RPC responder                                   | `brokers/request-reply-core.ts:224`                                                                                                                                                          | `respond()` subscribes `rr.req.<topic>` with the caller's options; with no `queue` it takes the queue-less path — why V10-13 re-executes RPC requests.                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| RPC request publish                             | `request-reply-core.ts:195`; `nats-broker.ts:246`                                                                                                                                            | The request goes out through `deps.publish`, which is the broker's `publishWithHeaders`; a publish bound therefore bounds the request's send.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| nats.js consumer API                            | `nats@2.29.3 lib/jetstream/jsmconsumer_api.d.ts:5-20`; `jsapi_types.d.ts:363,916`                                                                                                            | `add`, `update(stream, durable, Partial<ConsumerUpdateConfig>)`, `delete`, `list`, `info`. `inactive_threshold` is in `ConsumerUpdateConfig`; `DeliverPolicy.New = "new"`.                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| nats.js consume status events                   | `nats@2.29.3 lib/jetstream/consumer.d.ts:127,137`                                                                                                                                            | `ConsumerNotFound = "consumer_not_found"`, `ConsumerDeleted = "consumer_deleted"`, read through `ConsumerMessages.status()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| nats.js publish timeout                         | `lib/jetstream/types.d.ts` (`JetStreamPublishOptions.timeout`); `nats-base-client/core.d.ts:51`                                                                                              | `timeout: number` per publish; expiry rejects with `code === 'TIMEOUT'`. Today the refusal is wrapped in a bare `Error` by `describePublishRefusal` (`nats-broker.ts:186`, `:598`).                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Reconnect wait                                  | `nats-broker.ts:157-166`                                                                                                                                                                     | `reconnect.waitMs`, default 2000, validated integer 1–2147483647.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| **Probed on nats-server (he-nats), 2026-10-24** | scratch probes, not committed                                                                                                                                                                | (1) `consumers.add` with `name`, no `durable_name`, `deliver_policy: 'new'`, `inactive_threshold` makes an ephemeral consumer that receives only later messages; `delete` removes it. (2) `update` sets `inactive_threshold` on an existing durable: idle → reaped after the threshold; actively consuming → survives 6 s at a 2 s threshold, reaped once it stops. (3) Deleting a consumer under a running `consume()` emits `consumer_deleted`; re-adding the same name does not revive that `consume()` (nothing delivered in 35 s). Stopping it and calling `consumers.get` + `consume` again resumes delivery. |
| Kafka first-join seek                           | `brokers/kafka-broker.ts:1004-1037`                                                                                                                                                          | On the first `GROUP_JOIN`: `fetchOffsets` + `describeGroups` (two admin round trips), then `seek(minimum[p])` for each assigned partition whose committed offset is `'-1'`. `eachMessage` (`:928-976`) runs concurrently and records nothing, so a partition delivered from but not yet auto-committed is rewound — V10-2's mechanism.                                                                                                                                                                                                                                                                              |
| `minimumStartOffsets`, `KafkaStartOffsets`      | `brokers/kafka-start-offsets.ts:4,101-150`                                                                                                                                                   | Decimal-string offsets per partition; pure, unit-tested — the new seek rule sits beside it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| **V10-2 re-measured on develop `8534d248`**     | scratch probe against he-kafka (Kafka 4.0), not committed                                                                                                                                    | After #493: 0 duplicates in 20 fresh groups (10 pre-created topics, publishes 2.4–4.65 s after subscribe; 10 auto-created topics, publishes 0–2.7 s after). The race in the code stays — nothing orders `eachMessage` before the seek — so it is fixed by rule and pinned by a deterministic unit test; the real test is a regression guard.                                                                                                                                                                                                                                                                        |
| Publish bound helpers                           | `brokers/publish-timeout.ts:4,16-22`; `packages/common/src/health/deadline.ts:77,118`                                                                                                        | `DEFAULT_PUBLISH_TIMEOUT_MS = 15_000`; `resolvePublishTimeoutMs` (0 = unbounded, RangeError outside 0–2147483647); `withDeadline(run, { timeoutMs, onTimeout, timing })`, where `timeoutMs: 0` returns the call unbounded.                                                                                                                                                                                                                                                                                                                                                                                          |
| Bare-`Error` timeout sites                      | `kafka-broker.ts:789-792`, `pubsub-broker.ts:681-684`, `rabbitmq-broker.ts:829-833`                                                                                                          | Each `onTimeout` returns a plain `Error` whose message ends "within N ms (publishTimeoutMs); it may still be delivered". V10-30 confirmed.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Construction-time bound validation              | `plugin/messaging-plugin.ts:167-169`                                                                                                                                                         | `resolvePublishTimeoutMs` runs at `MessagingPlugin(...)` for `kafka`, `pubsub`, `rabbitmq` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Redis Streams publish                           | `redis-streams-broker.ts:63-69`, `:341-361`                                                                                                                                                  | Client built with `lazyConnect: true` only; `publishWithHeaders` awaits `client.xadd(...)` with no bound — V10-21. ioredis `commandTimeout` is not usable: it applies to every command, including the broker's blocking `XREADGROUP BLOCK` reads.                                                                                                                                                                                                                                                                                                                                                                   |
| Redis/NATS option shapes                        | `interfaces/index.ts:436`, `:527`, `:786`, `:857`; `plugin/messaging-plugin.ts:331-406`                                                                                                      | Neither arm's two interfaces carry `publishTimeoutMs`; the plugin copies options field by field.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Outbox `markSent` timeout                       | `outbox/relay.ts:9-26`, `:468-492`                                                                                                                                                           | A `markSent` that outlives `storeTimeoutMs` blocks the key, returns `'store-failure'`, and observes the late answer with `late: true`. Deliberate and stated in the module header.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Health reason source                            | `outbox/outbox-service.ts:175`, `outbox/outbox-health.ts:154`                                                                                                                                | `storeWriteFailing` is `lastSweep.endedBy === 'store-failure'` → reason `store-write-failing`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Existing pin of V10-5's behaviour               | `test/unit/outbox/relay-late-settlement.test.ts:130-156`                                                                                                                                     | "a pause inside markSent: the answer after the bound still reports a duplicate" asserts `endedBy === 'store-failure'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| README claims                                   | `packages/messaging-plugin/README.md:1275-1277`, `:1351`                                                                                                                                     | "a relay paused inside its publish may also report the `store-write-failing` health reason"; table: "last sweep ended on a rejected store call". Both disagree with `relay.ts:468-492`.                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Existing error classes                          | `src/errors.ts`; barrel `src/index.ts:64,75`                                                                                                                                                 | `RequestTimeoutError` and `ChainGateTimeoutError` (with `timeoutMs`) are the precedents. No `PublishTimeoutError` anywhere in the repo (grep).                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                   | Resolution (picked side)                                          | Doc deliverable (same PR)                                                                                         |
| --- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| C1  | README `:1277` and `:1351` say only a publish pause / a _rejected_ store call reports `store-write-failing`; `relay.ts` also books a `markSent` that outlived its bound    | The code is right (§3.6); the README is corrected                 | README outbox paragraph and health table rewritten (§3.6 wording)                                                 |
| C2  | README "Kafka and Pub/Sub publish bounds" (`:454`) and each arm's JSDoc describe the timeout by message text only                                                          | The error becomes `PublishTimeoutError`                           | README section retitled "Publish bounds", covering all five arms; JSDoc on each `publishTimeoutMs`; PUBLIC_API.md |
| C3  | README "NATS prerequisites" (`:371`) and the `subscribe` JSDoc do not say what a queue-less subscription is; `defaultQueue` is documented on the NATS arm but not honoured | Queue-less = shared durable group `<defaultQueue>.<topic>` (§3.1) | README NATS section, `subscribe` and `defaultQueue` JSDoc, `docs/upgrading.md` 0.11.0 entry                       |
| C4  | ROADMAP M119a "Decisions" says every other broker gives a queue-less subscriber fan-out                                                                                    | False for Redis Streams, Kafka, Pub/Sub and Service Bus (§1)      | ROADMAP M119a paragraph corrected in the status-flip commit                                                       |

## 3. Design decisions

### 3.1 A queue-less NATS subscription is a shared durable group per topic (V10-13)

- **Decision:** `NatsBroker` reads `options.defaultQueue` (default `'messaging-consumers'`, the
  other arms' default). With no `queue`, `subscribe` uses the derived queue `<defaultQueue>.<topic>`
  and takes the existing durable path unchanged in every other respect: the consumer name is
  `toJetStreamConsumerName` of the derived queue, `durable_name` equals it, the raw derived queue is
  recorded as `setu.queue`, and the collision check applies. The one addition on this path is
  `deliver_policy: 'new'` in the config sent to `consumers.add`, so a group created for the first
  time starts at messages published after it, as a new Kafka group does (`fromBeginning: false`).
  Once the consumer exists, every later start of any replica re-attaches to it and resumes from its
  acknowledgement floor. An explicit `queue` keeps today's config exactly (no `deliver_policy`).
- **Why:** the maintainer's choice (2026-10-24), matching Redis Streams, Kafka, Pub/Sub and Service
  Bus here and Dapr, Moleculer and MassTransit outside. A queue-less RPC responder is then answered
  by one replica, never by all of them, and is not re-run on restart. The stable name ends the
  per-process leak. The `.` separator matches Pub/Sub's derived form. Two (defaultQueue, topic)
  pairs that concatenate to the same string (`a` + `b.c`, `a.b` + `c`) differ in `filter_subject`,
  so the existing collision check refuses the second with `NatsConsumerNameCollisionError`.
- **Test home:** `test/unit/nats-broker.test.ts` (config sent for a queue-less subscribe under the
  default and a custom `defaultQueue`; explicit queue config unchanged; the concatenation collision
  refused); `test/integration/nats-real.test.ts` (restart does not replay; one consumer per topic
  however many boots; two replicas split, not duplicate, deliveries).

### 3.2 The NATS reply inbox is an ephemeral consumer that recovers

- **Decision:** when `subscribe` receives `[REPLY_INBOX_TRANSIENT]: true` (read through
  `InternalSubscribeOptions`, as RabbitMQ reads it), it creates an **ephemeral** consumer: `name` =
  `toJetStreamConsumerName(queue)` (`rr_2einbox_2e<uuid>`), `filter_subject` = topic,
  `ack_policy: 'explicit'`, `deliver_policy: 'new'`, `inactive_threshold` =
  `INBOX_INACTIVE_THRESHOLD_NS` (300 000 000 000, 5 min; an internal constant, not an option), no
  `durable_name`, no metadata, no collision bookkeeping. Closing the inbox (`unsubscribe`) and
  `disconnect()` stop the handle and then delete the consumer; each delete is bounded at 2 000 ms by
  `withDeadline` and a failure is logged, never thrown. The broker reads the handle's `status()`. On
  `consumer_not_found` or `consumer_deleted` while the inbox is open, it stops the old handle,
  re-adds the same config, calls `consumers.get` + `consume` with the same callback, and swaps the
  new handle into the `ActiveConsumer` entry. A failed re-create is logged and retried after
  `reconnect.waitMs` until it succeeds or the inbox closes. Closing marks the entry inactive first,
  so the broker's own delete does not trigger a re-create. The `inbox.ts` JSDoc that names RabbitMQ
  as the marker's only reader is corrected.
- **Why:** the inbox subject is unique per process, so a durable consumer replays nothing but is
  left behind on every restart — the other half of V10-13's "16 durable consumers after four boots".
  An ephemeral consumer can be reaped during an outage longer than the threshold. Probe (3) showed a
  running `consume()` never resumes on its own, and that stop + get + consume does. Without
  recovery, RPC replies would stop arriving after such an outage.
- **Test home:** `test/unit/nats-reply-inbox.test.ts` (new: config with the marker; a public
  `queue: 'rr.inbox.x'` without the marker takes the §3.1 durable path; delete on close and
  disconnect, bounded and logged on failure or hang; status event → re-create and handle swap; retry
  after a failed re-create; no re-create after close); `test/integration/nats-real.test.ts` (inbox
  consumer deleted by `jsm` mid-run → the next `request()` still gets its reply; no `rr_2einbox_2e*`
  consumer left after `app.stop()`).

### 3.3 Consumers earlier releases leaked: a reaping threshold, applied at connect

- **Decision:** after `connect()` has ensured the stream, the broker starts a sweep and does not
  await it, so boot time is unaffected. The sweep lists the stream's consumers and calls
  `consumers.update(stream, name, { inactive_threshold: INBOX_INACTIVE_THRESHOLD_NS })` on each one
  that matches all of: `config.durable_name` set; name matches `messaging-` + a lowercase RFC 4122
  uuid, or `rr_2einbox_2e` + one (the exact shapes earlier releases created); recorded
  `metadata['setu.queue']` absent or equal to the decoded name (`messaging-<uuid>`,
  `rr.inbox.<uuid>`); `inactive_threshold` unset or `0`. The predicate and the sweep live in a new
  internal module `src/brokers/nats-leaked-consumers.ts` (not exported from `src/index.ts`). A
  failed `list` or `update` is logged once per sweep and never fails `connect()`. The sweep stops
  when the broker disconnects.
- **Why:** deleting these consumers would break an older replica still running during a rolling
  deploy. A threshold leaves a consumer that is still pulling alone and lets the server reap it once
  its process is gone (probe 2). A user queue literally spelled `messaging-<uuid>` would also get
  the threshold, and would be reaped only after 5 min with no client attached. The README names this
  reserved shape.
- **Test home:** `test/unit/nats-leaked-consumers.test.ts` (new: the predicate as a data table —
  each matching and non-matching shape; the sweep updates only matches; a rejected `list` or
  `update` is reported once); `test/unit/nats-broker.test.ts` (connect starts the sweep and resolves
  even when it rejects); `test/integration/nats-real.test.ts` (a pre-created `messaging-<uuid>`
  durable carries `inactive_threshold` after connect).

### 3.4 Kafka first-join seek: skip a partition already delivered from its start (V10-2)

- **Decision:** `eachMessage` records, synchronously on entry and before the handler runs, the first
  offset it saw for each partition (`firstDelivered: Map<number, string>`, per subscription). The
  first-join handler chooses the seeks through a new pure function in `kafka-start-offsets.ts`:
  `partitionsToSeek(assigned, uncommitted, minimum, firstDelivered): Array<{ partition: number; offset: string }>`.
  For each assigned, uncommitted partition with a `minimum` entry: no first delivery → seek to the
  minimum; first delivered offset ≤ minimum → no seek (it started at or before the start point, so
  nothing was missed and a seek would repeat it); first delivered offset > minimum → seek to the
  minimum (messages between the two were skipped: re-delivering is the at-least-once choice over
  losing them). The call and the seeks run in one synchronous block, so no `eachMessage` entry can
  fall between the decision and the seek.
- **Why:** this tells "never delivered" from "delivered but not yet auto-committed" without a commit
  round trip. The rule never loses a message the current code delivers, and never repeats one when
  the consumer happened to start at the right offset — V10-2's `0:0` twice.
- **Test home:** `test/unit/kafka-start-offsets.test.ts` (the function: a table of the three cases
  plus "not assigned", "committed" and "no minimum"); `test/unit/kafka-broker.test.ts` (fake
  consumer: `0:0` delivered while the join's `fetchOffsets` is pending → no `seek`, the handler ran
  once; no delivery → `seek`; a first delivery past the minimum → `seek`);
  `test/integration/kafka-real.test.ts` (regression guard: 10 fresh groups, a publish around the
  join, each delivered exactly once).

### 3.5 One `PublishTimeoutError` for every bounded arm (V10-30)

- **Decision:** `src/errors.ts` gains
  `class PublishTimeoutError extends Error { readonly topic: string; readonly timeoutMs: number }`,
  `name = 'PublishTimeoutError'`, constructor
  `(message: string, details: { topic: string; timeoutMs: number })`. The Kafka, Pub/Sub and
  RabbitMQ `onTimeout` callbacks construct it with their existing message text unchanged, so a
  caller matching on the text keeps working. Redis Streams and NATS throw it per §3.7. Exported from
  `src/index.ts`; documented in PUBLIC_API.md and the README.
- **Why:** a caller must tell "may still be delivered" apart from a refusal without parsing text.
  `RequestTimeoutError` is the RPC precedent and `ChainGateTimeoutError.timeoutMs` the field
  precedent.
- **Test home:** `test/unit/publish-timeout.test.ts` (one table over the five arms, fake clients
  whose send never settles: `instanceof PublishTimeoutError`, `topic`, `timeoutMs`, message);
  `test/unit/messaging-errors.test.ts` (class shape); `test/unit/barrel-exports.test.ts`.

### 3.6 Outbox `markSent` past its bound stays `store-failure` (V10-5)

- **Decision:** behaviour unchanged. A `markSent` that does not answer within `storeTimeoutMs` ends
  the sweep `store-failure`, so `store-write-failing` is reported. The late answer is still observed
  (M113j). The README is corrected. The health row reads "this instance's last sweep ended on a
  store call that was rejected or did not answer within `storeTimeoutMs`". The paragraph at
  `:1275-1277` says a relay paused inside its publish or at a settlement write reports it, and that
  the late answer is recorded anyway.
- **Why:** the sweep's end is decided when the bound fires, before any answer exists. A store taking
  longer than its configured bound is the condition `store-write-failing` exists to show; calling it
  anything else would hide it.
- **Test home:** `test/unit/outbox/relay-late-settlement.test.ts:130` — add
  `instanceSignals().storeWriteFailing === true` to the existing case.

### 3.7 Redis Streams and NATS publish bounds (V10-21)

- **Decision:** `publishTimeoutMs?: number` is added to `RedisStreamsMessagingOptions`,
  `RedisStreamsOptions`, `NatsMessagingOptions` and `NatsOptions`. Default 15 000, `0` unbounded. It
  is validated by `resolvePublishTimeoutMs` in the broker constructor and at `MessagingPlugin(...)`
  (the arm list at `:167` gains `'redis-streams'` and `'nats'`), and copied field by field in
  `messaging-plugin.ts` like RabbitMQ's. **Redis Streams:** only the `xadd` in `publishWithHeaders`
  is wrapped in `withDeadline`, whose `onTimeout` builds a `PublishTimeoutError` reading "Redis did
  not acknowledge the message published to "<topic>" within N ms (publishTimeoutMs); it may still be
  delivered". No ioredis `commandTimeout`. **NATS:** `js.publish` is passed `timeout` =
  `publishTimeoutMs` (or 2147483647 when the bound is `0`) and wrapped in `withDeadline` with the
  same bound. A rejection with `code === 'TIMEOUT'` becomes a `PublishTimeoutError` in the same
  message form ("NATS did not acknowledge…"); every other rejection keeps `describePublishRefusal`.
  The NATS bound moves from the client's 5 s default to 15 s, recorded in the CHANGELOG.
- **Why:** X79 measured a paused Redis holding publishes 14–21 s while every other arm failed at its
  bound. NATS was bounded by its client, but at a fixed 5 s and with a bare error.
- **Test home:** `test/unit/publish-timeout.test.ts` (the five-arm table; `0` unbounded on both new
  arms; a bad value refused at `MessagingPlugin(...)` for both; the configured value reaches the
  broker); `test/unit/nats-broker.test.ts` (`timeout` forwarded, including the `0` case; `TIMEOUT` →
  `PublishTimeoutError`; another code → the existing refusal);
  `test/integration/outage-real.test.ts` (paused Redis with `publishTimeoutMs: 2000` →
  `PublishTimeoutError` in 2 000–3 000 ms).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — no type changes. These behaviours change in minor `0.11.0`,
recorded in CHANGELOG and `docs/upgrading.md`: a queue-less NATS subscriber now shares
`<defaultQueue>.<topic>` with the other replicas instead of receiving every message on a per-process
consumer (and no longer replays history on restart); a Redis Streams publish gains a 15 s default
bound; the NATS publish bound moves from 5 s to 15 s.

| Exported symbol       | Kind  | Consumer / real code path that READS it                                                                                   |
| --------------------- | ----- | ------------------------------------------------------------------------------------------------------------------------- |
| `PublishTimeoutError` | class | Thrown by the Kafka, Pub/Sub, RabbitMQ, Redis Streams and NATS publish paths; applications branch on it with `instanceof` |

### 4.1 Options — every option names its consumer

| Option                                                   | Consumer                                                                               | Behavior (per implementation)                                                                                       |
| -------------------------------------------------------- | -------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------- |
| `NatsMessagingOptions.defaultQueue` (existing, now read) | `MessagingPlugin` → `NatsOptions.defaultQueue` → `NatsBroker.subscribe` derived queue  | Default `'messaging-consumers'`; the queue-less group is `<defaultQueue>.<topic>` (§3.1)                            |
| `RedisStreamsMessagingOptions.publishTimeoutMs` (new)    | `MessagingPlugin` → `RedisStreamsOptions.publishTimeoutMs` → the `xadd` deadline       | 15 000 default; `0` unbounded; RangeError at `MessagingPlugin(...)` outside 0–2147483647; consumer reads unaffected |
| `NatsMessagingOptions.publishTimeoutMs` (new)            | `MessagingPlugin` → `NatsOptions.publishTimeoutMs` → `js.publish` `timeout` + deadline | Same range and default; bounds `publish()`, the request send of `request()`, and responder reply publishes          |

## 5. Implementation files

| File                                                                                         | Purpose                                                                                                                                             |
| -------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                                                                               | export `PublishTimeoutError`                                                                                                                        |
| `src/errors.ts`                                                                              | `PublishTimeoutError` (§3.5)                                                                                                                        |
| `src/brokers/nats-broker.ts`                                                                 | read `defaultQueue`; derived durable group (§3.1); ephemeral inbox + recovery + delete (§3.2); connect-time sweep call (§3.3); publish bound (§3.7) |
| `src/brokers/nats-leaked-consumers.ts` (new)                                                 | internal: leaked-name predicate and the sweep over `consumers.list` / `update` (§3.3)                                                               |
| `src/brokers/inbox.ts`                                                                       | JSDoc only: NATS also reads `REPLY_INBOX_TRANSIENT`                                                                                                 |
| `src/brokers/kafka-start-offsets.ts`                                                         | `partitionsToSeek` (§3.4)                                                                                                                           |
| `src/brokers/kafka-broker.ts`                                                                | `firstDelivered`; the join handler uses `partitionsToSeek`; `onTimeout` → `PublishTimeoutError`                                                     |
| `src/brokers/pubsub-broker.ts`                                                               | `onTimeout` → `PublishTimeoutError`                                                                                                                 |
| `src/brokers/rabbitmq-broker.ts`                                                             | `onTimeout` → `PublishTimeoutError`                                                                                                                 |
| `src/brokers/redis-streams-broker.ts`                                                        | `publishTimeoutMs` + `xadd` deadline (§3.7)                                                                                                         |
| `src/interfaces/index.ts`                                                                    | `publishTimeoutMs` on the four Redis/NATS option interfaces; `defaultQueue` JSDoc on the NATS arm                                                   |
| `src/plugin/messaging-plugin.ts`                                                             | validate and forward `publishTimeoutMs` for `redis-streams` and `nats`                                                                              |
| `README.md`, `PUBLIC_API.md`, `CHANGELOG.md`, `docs/upgrading.md`, `ROADMAP.md`, `CLAUDE.md` | C1–C4; the 0.11.0 behaviour changes; status flip with PR number; plan archived to `plans/archive/`                                                  |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                         | src covered                                                   | Key assertions                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/nats-broker.test.ts` (extend)                                          | `nats-broker.ts`                                              | §3.1 config under default and custom `defaultQueue`, explicit queue unchanged, concatenation collision refused; §3.3 sweep started, `connect()` resolves when it rejects; §3.7 `timeout` forwarded, `TIMEOUT` mapping; the NATS fake gains `update`, `delete`, `list` and `status()`                                                                                |
| `test/unit/nats-reply-inbox.test.ts` (new)                                        | `nats-broker.ts`                                              | §3.2 in full                                                                                                                                                                                                                                                                                                                                                        |
| `test/unit/nats-leaked-consumers.test.ts` (new)                                   | `nats-leaked-consumers.ts`                                    | predicate table (matching durables; an ephemeral consumer; threshold already set; user queue with different metadata; uppercase or malformed uuid; `rr_2einbox_2e<uuid>`); only matches updated; failures reported once                                                                                                                                             |
| `test/unit/kafka-start-offsets.test.ts` (extend)                                  | `kafka-start-offsets.ts`                                      | `partitionsToSeek` table (§3.4)                                                                                                                                                                                                                                                                                                                                     |
| `test/unit/kafka-broker.test.ts` (extend)                                         | `kafka-broker.ts`                                             | the three join orderings (§3.4)                                                                                                                                                                                                                                                                                                                                     |
| `test/unit/publish-timeout.test.ts` (extend)                                      | the five brokers, `messaging-plugin.ts`, `publish-timeout.ts` | five-arm table (§3.5); `0` unbounded and refusals for Redis and NATS; forwarded value observed (§3.7)                                                                                                                                                                                                                                                               |
| `test/unit/messaging-errors.test.ts`, `test/unit/barrel-exports.test.ts` (extend) | `errors.ts`, `index.ts`                                       | class name, fields, `instanceof Error`; barrel export                                                                                                                                                                                                                                                                                                               |
| `test/unit/outbox/relay-late-settlement.test.ts` (extend)                         | `relay.ts` (unchanged)                                        | §3.6 signal assertion                                                                                                                                                                                                                                                                                                                                               |
| `test/integration/nats-real.test.ts` (extend, guarded `NATS_URL`)                 | real nats-server                                              | V10-13 scenario: a queue-less `respond` across three boots runs each request once and leaves one `rr.req` consumer; two replicas split queue-less deliveries; an inbox consumer deleted mid-run recovers; no inbox consumer after `app.stop()`; a pre-created leaked durable gains `inactive_threshold`; a paused server rejects publish with `PublishTimeoutError` |
| `test/integration/kafka-real.test.ts` (extend, guarded `KAFKA_BROKERS`)           | real Kafka                                                    | 10 fresh groups, one message each near the join → exactly once each                                                                                                                                                                                                                                                                                                 |
| `test/integration/outage-real.test.ts` (extend, guarded `REDIS_URL`)              | real Redis                                                    | paused Redis → `PublishTimeoutError` at the configured bound                                                                                                                                                                                                                                                                                                        |

The two new seams (`partitionsToSeek`, the leaked-consumer predicate) are pure and tested directly.
Each real-backend case is guarded and also covered by the fake-client unit tests.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m119a-message-delivery-bounds
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test
pnpm test:coverage          # ANSI-stripped per-file table; ≥90% branch/function/line every src file
pnpm run test:deno-lane
# with the local backend containers (full-backend env block): nats-real, kafka-real, outage-real
pnpm run release:publish --dry-run
pnpm run release:verify <version>
```

Behaviour proofs before the PR: re-run the V10-13 scenario (queue-less responder, three boots, count
handler calls and consumers) against `he-nats` on develop and on the branch, and show both; confirm
each new unit test fails with its fix reverted. Security audit: not required — the diff changes
consumer lifecycle and error types and crosses no trust boundary (no new input parsing, credential
or tenant path).

## 8. Risks & mitigations

- An application that relied on every NATS replica receiving every queue-less message now gets
  shared delivery → CHANGELOG and `docs/upgrading.md` say so, and give the way back: pass a `queue`
  that is stable and unique per replica (for example the pod name). A per-replica queue made from a
  random value would leak a durable consumer per start, and the upgrade guide says that too.
- A first-time group starts at new messages, so messages published before any replica of a new
  queue-less group subscribed are not delivered → the same rule as a new Kafka group; README states
  it.
- The connect-time sweep sets a threshold on a user's own queue spelled `messaging-<uuid>` → the
  predicate also requires matching or absent metadata, the README names the reserved shape, and such
  a consumer is reaped only after 5 min with no client.
- The V10-2 fix cannot be shown failing on real Kafka (0/20 on develop) → the deterministic unit
  test with the fake consumer is the fail-without-fix proof.
- A Redis `xadd` abandoned at its bound can still land later (ioredis offline queue) → message and
  README say "may still be delivered", as for the other arms.

## 9. Out of scope

- Readiness of `mail`, backplane, RabbitMQ `queue` and migration indicators — M119b.
- A fan-out subscription mode on NATS, and making RabbitMQ's queue-less meaning match the other arms
  — new behaviour with no register row; a separate milestone if wanted.
- `deliver_policy` for an explicit, caller-named NATS queue — unchanged (a new named queue still
  starts at the stream's first message, as it does today).
- Service Bus publish bound — the SDK's own retry bound applies; revisit only if a run measures a
  hang.
