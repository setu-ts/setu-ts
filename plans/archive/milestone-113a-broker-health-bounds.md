# Milestone 113a — Brokers that report healthy while down, and publishes with no bound (`@setu-ts/messaging-plugin`)

> **Status:** Planning. Branch: `feat/m113a-broker-health-bounds`. `develop` and `main` are
> protected — all work (implementation + fixes) stays on this one branch until it merges via a
> single PR.

## 0. Objective & scope

The X70 outage matrix (`smoke/X67-X73-FINDINGS.md` §X70) found three brokers whose health indicator
does not describe the broker and whose publish has no bound — the M101a shape on the brokers M101a
did not reach — and the v0.9.0 regression run found Kafka's `subscribe()` resolving before the
consumer group can receive anything (V9-3). This milestone gives Kafka and Pub/Sub a real, bounded,
cached reachability round trip (the M95b RabbitMQ precedent) and a `publishTimeoutMs`, gives NATS a
reconnect policy that survives an outage of any length, and makes a message published after Kafka's
`subscribe()` resolves reach that subscription.

- **In scope:** V9-35 (Kafka probe + publish bound), V9-36 (NATS reconnect), V9-37 (Pub/Sub probe +
  publish bound), V9-3 (Kafka starting position for a new consumer group); the messaging README,
  PUBLIC_API.md, CHANGELOG and `docs/upgrading.md` entries for each; real-backend outage tests.
- **NOT this milestone:** whether a hung broker (`reachable: 'unknown'`) should fail `/ready` — that
  is the readiness-semantics decision V9-19 owns in **M113b**; this milestone only removes the
  `reachable: true` lie and keeps the existing rule (a round trip that does not answer inside its
  bound has told us nothing, `undefined`, reported `up`/`'unknown'`). Outbox/inbox signals
  (V9-20…22) are **M113j**. A NATS publish bound is not added: JetStream's publish already rejects
  at the client's own 5 s ack timeout (X70 table: "rejects at 5.0 s").

## 1. Contracts verified from SOURCE (not names)

| Reference                                                 | Source (file:line)                                                                    | Verified surface / fact                                                                                                                                                                                                                                                             |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `KafkaBroker.reachability()`                              | `packages/messaging-plugin/src/brokers/kafka-broker.ts:501`                           | Returns `false` only while the observe-mode supervisor is faulted (fed by `producer.disconnect`), `undefined` when the producer has no `on`, else **`true`** — no I/O. The V9-35 lie.                                                                                               |
| `KafkaBroker.publishWithHeaders`                          | `kafka-broker.ts:566-603`                                                             | `await producer.send(...)` with no bound.                                                                                                                                                                                                                                           |
| `KafkaBroker.subscribe`                                   | `kafka-broker.ts:607-781`                                                             | `consumer.connect()` → `#subscribeWithRetry` (`fromBeginning: false`, line 898) → `run()` unawaited; resolves before any group join.                                                                                                                                                |
| `resolveClient` (Kafka)                                   | `kafka-broker.ts:89-115`                                                              | Lazy arm builds ONE `new kafkajs.Kafka({ clientId, brokers, retry? })`; injected arm validates only `producer`/`consumer`.                                                                                                                                                          |
| `IKafkaFactory`                                           | `packages/messaging-plugin/src/interfaces/index.ts:173`                               | `producer(): unknown; consumer({ groupId }): unknown` — **no `admin`**.                                                                                                                                                                                                             |
| `KafkaMessagingOptions` / `KafkaOptions`                  | `interfaces/index.ts:516-525`, `:888-955`                                             | No publish bound, no logger `warn`.                                                                                                                                                                                                                                                 |
| `NatsBroker` connect                                      | `nats-broker.ts:117-136`                                                              | Lazy arm: `nats.connect({ servers: url })` — client defaults (`maxReconnectAttempts` 10, `reconnectTimeWait` 2000). Injected arm returns the caller's connection.                                                                                                                   |
| `NatsOptions` / `NatsMessagingOptions`                    | `interfaces/index.ts:529-568`, `:858-880`                                             | No reconnect member.                                                                                                                                                                                                                                                                |
| `IPubSubTransport.isHealthy?`                             | `pubsub-broker.ts:197-205`                                                            | Optional, `Promise<boolean>`; JSDoc claims "the real adapter calls the SDK's `topic.exists()`".                                                                                                                                                                                     |
| `adaptPubSubModule`                                       | `pubsub-broker.ts:268-…`                                                              | Builds the transport; **defines no `isHealthy`** (grep). `PubSubSdkModule` facade (`pubsub-broker.ts:~90-152`) declares no `getTopics`.                                                                                                                                             |
| `GcpPubSubBroker.reachability()`                          | `pubsub-broker.ts:584-602`                                                            | `undefined` when `transport.isHealthy` is absent, else awaits it unbounded and uncached.                                                                                                                                                                                            |
| `GcpPubSubBroker` publish                                 | `pubsub-broker.ts:~620-635`                                                           | `await this.#transport.publish(...)` with no bound.                                                                                                                                                                                                                                 |
| RabbitMQ bound + probe (precedent)                        | `rabbitmq-broker.ts:62-79`, `:356-359`, `:557-568`, `:658-700`, `:818-850`            | `DEFAULT_PUBLISH_TIMEOUT_MS = 15_000`, `resolvePublishTimeoutMs` (via `deadlineRangeError`), `withDeadline` around publish with an `onTimeout` error saying "it may still be accepted"; `createCachedProbe<boolean \| undefined>` with `fallback: undefined`, TTL 5000, bound 2000. |
| `resolvePublishTimeoutMs` call at plugin                  | `plugin/messaging-plugin.ts:166-175`                                                  | Refused at `MessagingPlugin(...)` for the rabbitmq arm only; `:374` forwards it.                                                                                                                                                                                                    |
| Indicator outer bound                                     | `plugin/messaging-plugin.ts:603-630`                                                  | Every arm's `reachability()` is wrapped in `createCachedProbe` (5 s / 2 s / `undefined`); `false` → `down`, `undefined` → `up` + `'unknown'`.                                                                                                                                       |
| Direct uncached caller                                    | `packages/realtime-backplane-plugin/src/transports/messaging-backplane.ts:95`         | Calls `broker.isHealthy()` directly and keeps no cache — why the cache must live IN the broker (M95b review).                                                                                                                                                                       |
| `withDeadline`, `createCachedProbe`, `deadlineRangeError` | `packages/common/src/health/deadline.ts:77,118`, `health/probe.ts:121-137`            | Signatures as used by RabbitMQ; `withDeadline` rejects with the `onTimeout` error and aborts the signal.                                                                                                                                                                            |
| Test partitioning                                         | `scripts/test-partition-rules.ts:63-88`, `scripts/codemods/node-test-config.ts:31-46` | A test naming a backend env var or spawning `docker` is `isolated`, run with `fileParallelism: false` — so an outage test stopping the shared CI Kafka cannot overlap another Kafka suite.                                                                                          |
| kafkajs 2.2.4 admin (installed)                           | measured, `.probe/kafka*.mjs` (scratch)                                               | `admin({ retry })` exists; `describeCluster()`, `fetchOffsets({ groupId, topics })` (`offset: '-1'` = none committed), `fetchTopicOffsets(topic)` (`{ partition, offset }` = high watermark), `setOffsets({ groupId, topic, partitions })`.                                         |
| nats 2.29.3 (installed)                                   | measured                                                                              | `connect({ maxReconnectAttempts: -1, reconnectTimeWait: 2000 })` recovers after a 26 s stop; an existing JetStream `consume()` iterator delivers again afterwards without re-subscribing.                                                                                           |
| @google-cloud/pubsub 6.2.0 (installed)                    | measured                                                                              | `pubsub.getTopics({ pageSize: 1, autoPaginate: false, gaxOpts: { timeout: 1500, retry: null } })`: healthy ok in 4–12 ms; paused → gRPC code 4 `DEADLINE_EXCEEDED` at 1.5 s; stopped → code 14 `UNAVAILABLE` in ~2 ms. Without `gaxOpts` both hang past 8 s.                        |

**Measured facts the design rests on** (throwaway `m113a-kafka` :19092, `m113a-nats` :14222,
`m113a-pubsub` :18085; probes kept in the session scratchpad, not committed):

1. **Kafka probe client.** A `Kafka` built with
   `retry: { retries: 0 }, requestTimeout: 1500, connectionTimeout: 1000` answers
   `describeCluster()` in 2–5 ms healthy; **paused** → `KafkaJSRequestTimeoutError` at ~1.0 s on
   every attempt (8/8); **stopped** → `KafkaJSConnectionClosedError` /
   `KafkaJSNumberOfRetriesExceeded` (connection error) in 2–5 ms. The SAME call on a client with
   kafkajs's DEFAULT timeouts hangs past 4 s when stopped (the stale socket waits out the 30 s
   `requestTimeout`), which would read `'unknown'` rather than `down`. So the probe needs its own
   short-timeout client.
2. **Kafka producer events.** Across pause and stop the producer emitted only
   `producer.network.request_queue_size` — never `producer.disconnect` — confirming V9-35's
   mechanism.
3. **V9-3 window.** Waiting for `consumer.events.GROUP_JOIN` is **not sufficient**: a fresh group on
   a fresh topic, publishing 4 messages at the join event, delivered **0/4** (local, rebalance
   delay 0) and **2/4** (`he-kafka`, default 3 s delay) on the first trial — the latest offset is
   resolved after the join. **Committing the high watermarks for a group with no committed offsets
   BEFORE `run()`** (`fetchOffsets` → all `-1` → `fetchTopicOffsets` → `setOffsets`) delivered **4/4
   on 8/8 trials** on both brokers and did not replay a message published before `subscribe()`.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                                                       | Resolution (picked side)                                   | Doc deliverable (same PR)                                                                                                                |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| C1  | `IPubSubTransport.isHealthy` JSDoc (`pubsub-broker.ts:198-205`) and `GcpPubSubBroker.reachability` JSDoc (`:584-591`) say the real adapter calls `topic.exists()`; it defines no probe at all. | The code is wrong; it gains a real probe (§3.4).           | Rewrite both JSDoc blocks to describe the `getTopics` round trip and its code mapping.                                                   |
| C2  | `KafkaBroker.reachability` JSDoc (`kafka-broker.ts:485-499`) presents the event flag as a reachability signal.                                                                                 | The flag is kept only as the fast `false` short-circuit.   | Rewrite the JSDoc to describe the round trip (§3.1).                                                                                     |
| C3  | The messaging README "Health indicator" section says only `RabbitMqBroker` and `ServiceBusBroker` build their own cached, bounded probes, and is silent on Kafka/Pub/Sub.                      | After this milestone Kafka and Pub/Sub do too.             | Update that paragraph; add a per-broker probe table (broker → round trip → stopped / hung outcome), every cell from the §1 measurements. |
| C4  | README "Kafka consumer groups" (`README.md:441`) is silent on the start-position window V9-3 reports.                                                                                          | Window closed for groups this instance initialises (§3.3). | Add the start-position guarantee and its limits (injected factory without `admin`; a group already active elsewhere).                    |
| C5  | `PUBLIC_API.md` messaging section documents `publishTimeoutMs` only on the RabbitMQ arm (`:5644`, `:6842`).                                                                                    | It now exists on Kafka and Pub/Sub arms too.               | Add the option to both arms and the NATS `reconnect` option; correct the health-indicator paragraph (`:6386-6425`) as in C3.             |

## 3. Design decisions

### 3.1 Kafka reachability is a bounded metadata round trip

- **Decision:** `reachability()` keeps the zero-cost `false` short-circuit while the supervisor is
  faulted, then reads a `createCachedProbe<boolean | undefined>` (fallback `undefined`, TTL 5000,
  bound 2000 — the RabbitMQ constants) built in `connect()` and dropped in `disconnect()`. The probe
  calls `describeCluster()` on a **probe admin** and maps: resolved → `true`; an error whose `name`
  (or any `cause` within `MAX_CAUSE_DEPTH`) is `KafkaJSRequestTimeoutError` → `undefined` (hung —
  told us nothing); any other rejection → `false`. The probe admin is:
  - **lazy client:** an admin from a SECOND `kafkajs.Kafka` built in `resolveClient` from an
    internal pure helper `kafkaHealthClientConfig(brokers, clientId)` returning
    `{ brokers, clientId: \`${clientId}-health\`, retry: { retries: 0 }, requestTimeout: 1500,
    connectionTimeout: 1000 }` (measured fact 1 — the main client's 30 s request timeout makes a
    stopped broker look hung);
  - **injected factory:** `factory.admin({ retry: { retries: 0 } })` when the new optional
    `IKafkaFactory.admin` (§4) is a function; its timeouts are the application's, documented;
  - **neither:** no probe — `reachability()` returns `faulted ? false : undefined` (`'unknown'`),
    replacing today's unconditional `true`. The probe admin is `connect()`ed in
    `KafkaBroker.connect()` after the producer and `disconnect()`ed in `KafkaBroker.disconnect()`
    (errors swallowed, like the producer). Its `connect()` failure fails startup, exactly as the
    producer's does today.
- **Why:** M95b precedent; the cache must sit in the broker because `realtime-backplane-plugin`
  calls `isHealthy()` uncached. Stopped → `down`; hung → `'unknown'` per the V5-2 rule (M113b owns
  whether that should fail readiness).
- **Test home:** `test/unit/kafka-broker.test.ts` (mapping, cache, short-circuit, no-admin arm,
  lifecycle); `test/unit/kafka-real-import.test.ts` (`kafkaHealthClientConfig` pinned and a real
  admin built from it has the four methods); `test/integration/outage-real.test.ts` (real stop →
  `down`, real pause → `'unknown'`, restore → `up`).

### 3.2 Kafka and Pub/Sub get `publishTimeoutMs`

- **Decision:** `DEFAULT_PUBLISH_TIMEOUT_MS` and `resolvePublishTimeoutMs` move from
  `rabbitmq-broker.ts` to a new internal `brokers/publish-timeout.ts` (RabbitMQ imports them from
  there; nothing else changes for RabbitMQ). `KafkaMessagingOptions`, `KafkaOptions`, both
  `PubSubMessagingOptions` arms and `PubSubOptions` gain `publishTimeoutMs?: number` — default
  `15000`, `0` = unbounded, validated by `resolvePublishTimeoutMs` both in `MessagingPlugin(...)`
  (extend the existing rabbitmq-only check at `messaging-plugin.ts:166` to `kafka` and `pubsub`) and
  in each broker constructor. Each broker wraps its transport send (`producer.send` /
  `transport.publish`) in `withDeadline` with runtime timers; `onTimeout` produces a plain `Error`
  naming the broker, the topic and the bound, ending "it may still be delivered". The bound covers
  `publishWithHeaders`, so RPC requests/replies and outbox relay publishes are bounded too.
- **Why:** a hung broker held every publish for the whole outage (69.2 s Kafka, 24 s Pub/Sub). One
  rule, one resolver, same default as RabbitMQ.
- **Test home:** `test/unit/publish-timeout.test.ts` (resolver range, default, `0`, `NaN`);
  `kafka-broker.test.ts` / `pubsub-broker.test.ts` (a never-settling fake send rejects at the bound
  with a fake clock; `0` waits; a send that settles first is unaffected);
  `test/unit/messaging-plugin.test.ts` (`MessagingPlugin({ broker: 'kafka', publishTimeoutMs: -1 })`
  and the pubsub equivalent throw `RangeError` at construction); `outage-real.test.ts` (paused Kafka
  publish rejects at the configured bound, not at unpause).

### 3.3 Kafka starts a new consumer group at the watermark it saw at `subscribe()` (V9-3)

**Revised after implementation** (see §11, "V9-3 redesign"): the first design called kafkajs
`admin.setOffsets`, which starts a temporary consumer that joins the group and waits for a fetch
(`kafkajs/src/admin/index.js:514–566`), about 5 s per new group — on every startup with a new group
and on every reply inbox (`rr-inbox-<uuid>`). It is replaced by a seek at group join, measured
below.

- **Decision:**
  1. **Capture.** In `subscribe()`, after `#subscribeWithRetry` succeeds and **before** `run()`, the
     broker calls `fetchOffsets({ groupId, topics: [topic] })` on a group admin (`admin` from the
     main factory: lazy → `kafka.admin()`; injected → `factory.admin?.()`). If every partition
     reports `offset === '-1'` the group is new: it calls `fetchTopicOffsets(topic)` and keeps the
     per-partition high watermarks as this member's **start offsets**. A group with any committed
     offset captures nothing and behaves exactly as today.
  2. **Advertise.** The consumer is created with `partitionAssigners: [startAwareRoundRobin]`, an
     internal wrapper over kafkajs's `PartitionAssigners.roundRobin` that delegates `assign()`
     unchanged and keeps its `name`/`version` (so members on older versions interoperate), and whose
     `protocol()` encodes `AssignerProtocol.MemberMetadata` with `userData` = this member's start
     offsets as JSON (empty when none were captured). Partition assignment is unchanged.
  3. **Seek on the first join only.** On the consumer's first `GROUP_JOIN` (later rebalances do
     nothing), when start offsets were captured: re-read `fetchOffsets`; for each ASSIGNED partition
     still uncommitted, read every current member's start offsets through `describeGroups` →
     `MemberMetadata.decode(member.memberMetadata).userData`, and `seek` to the **minimum** across
     members and this member's own (BigInt comparison of the string offsets). kafkajs commits the
     seek offset (measured: committed within 500 ms), so a member joining later finds committed
     offsets and seeks nothing.
  4. **Failure handling.** Any failure in steps 1 or 3 (an admin error, an undecodable member
     `userData`, which is skipped per member) does **not** fail the subscription — it is reported
     once through `logger.warn` (new optional member, §4.1; falls back to `logger.error`) naming
     topic and group. A skipped member does not discard other usable snapshots; an admin or seek
     failure leaves affected partitions with kafkajs's latest-offset behaviour.
  5. **Injected factory.** The assigner and protocol codec come from the kafkajs module: the lazy
     path already has it; with an injected `client` the broker tries `import('kafkajs')` once at
     `connect()`; if that fails it still seeks to its OWN start offsets (step 3 without the
     cross-member minimum) and documents that concurrent first starts of one new group can then miss
     messages. Without a group admin (`factory.admin` absent) the whole step is skipped
     (documented).
  6. The group admin is connected lazily through ONE memoized connect promise and disconnected in
     `disconnect()`. `subscribe()` still resolves right after `run()`; it does not wait for the
     join.
- **Guarantee (documented in README "Kafka consumer groups"):** a message published after
  `subscribe()` resolves on any member of a new group is delivered to the group, including when
  several members of the new group start at once; nothing published before the first member's
  `subscribe()` is replayed. Limits: an injected factory without `admin`, or without a loadable
  kafkajs module (step 5); a member that crashes between `subscribe()` and the join takes its start
  offsets with it.
- **Why — measured** (throwaway Kafka 4.0 with rebalance delay 0, and `he-kafka` with the default 3
  s; 4 messages published the instant `subscribe()` resolves, 3 older ones before it): no handling →
  **0/4 in 7/7 trials**; seek on join → **4/4 in 12/12, nothing replayed, `subscribe()` resolves in
  ~5 ms, first delivery ~20 ms after the join**. Second member of a still-new group starting 50 ms
  later, 6 messages published between the two `subscribe()` calls: seeking each member's own
  watermark lost **3/6 in 4/4 trials** (the partitions assigned to the later member); the
  cross-member minimum delivered **6/6 in 4/4**; a second member starting after the first had joined
  found committed offsets and seeked nothing (3/3). This matches Spring Kafka's documented pattern
  (seek in `onPartitionsAssigned`); `fromBeginning: true` (Spring Cloud Stream's named-group
  default) was rejected because a new group on an existing topic would replay its whole history.
- **Test home:** `kafka-broker.test.ts` (new group → watermarks captured before `run`; first
  `GROUP_JOIN` seeks each uncommitted assigned partition to the minimum of the members' decoded
  start offsets; committed partitions and later joins not seeked; committed group captures nothing
  and advertises empty `userData`; an undecodable member skipped; admin failure warned once,
  subscription active; no admin → skipped; no kafkajs module with an injected client → own-offset
  seek); the assigner wrapper's `assign` output equals round robin's for the same input and its
  `protocol` round-trips through the real `AssignerProtocol` (`kafka-real-import.test.ts`);
  `test/integration/kafka-real.test.ts` (new group, publish immediately after `subscribe()` →
  delivered; pre-subscribe message not delivered; first RPC after boot succeeds; TWO consumers of
  one new group started 50 ms apart with messages published between them → all delivered, the
  concurrent-start reproduction).

### 3.4 Pub/Sub reachability is a bounded `getTopics` round trip

- **Decision:** `IPubSubTransport.isHealthy?` widens to `Promise<boolean | undefined>` and
  `adaptPubSubModule` implements it:
  `pubsub.getTopics({ pageSize: 1, autoPaginate: false, gaxOpts: { timeout: 1500, retry: null } })`
  (the `PubSubSdkModule` facade gains the member). Mapping: resolved → `true`; numeric gRPC `code`
  14 (`UNAVAILABLE`) → `false`; code 4 (`DEADLINE_EXCEEDED`) → `undefined`; any other numeric gRPC
  code (including 7 `PERMISSION_DENIED` and 16 `UNAUTHENTICATED` — a publisher-only service account
  lacks `pubsub.topics.list`, and the server answering proves reachability, the M90b Service Bus
  401/403 rule) → `true`; an error with no numeric code → `false`. `GcpPubSubBroker.reachability()`
  wraps `transport.isHealthy()` in a broker-owned `createCachedProbe<boolean | undefined>` (5000 /
  2000 / fallback `undefined`), built in `connect()` and dropped in `disconnect()`; absent
  `isHealthy` stays `undefined`.
- **Why:** V9-37; measured — `gaxOpts` is what turns a stop into a fast `UNAVAILABLE` instead of a
  hang. A list call needs no topic name the broker might not know.
- **Test home:** `test/unit/pubsub-adapter.test.ts` (each code mapping against a fake SDK; the exact
  `getTopics` options); `pubsub-broker.test.ts` (cache, bound, absent member);
  `test/e2e/pubsub-emulator.test.ts` (guarded on `PUBSUB_EMULATOR_HOST`: healthy → `true`; a real
  `docker pause` of the emulator → `undefined` within the bound and publish rejects at
  `publishTimeoutMs`; `docker stop` → `false`; restore → `true`).

### 3.5 NATS reconnects without a budget by default

- **Decision:** `NatsMessagingOptions` and `NatsOptions` gain
  `reconnect?: { maxAttempts?: number; waitMs?: number }`, forwarded to `nats.connect` as
  `maxReconnectAttempts` / `reconnectTimeWait`. Defaults: `maxAttempts: -1` (unbounded),
  `waitMs: 2000` (nats.js's own wait). Validation at `MessagingPlugin(...)` and in the broker
  constructor: `maxAttempts` an integer ≥ `-1`, `waitMs` an integer in `1`–`2147483647` (`0` would
  spin the reconnect loop), else `RangeError` naming the field. Supplying `reconnect` together with
  an injected `client` throws `TypeError` at construction (the application built that connection;
  the option would otherwise be silently dead — the `enableMessageOrdering` precedent). A finite
  `maxAttempts` that is exhausted closes the connection and the indicator keeps reporting `down`
  (unchanged reporting; documented).
- **Why:** V9-36 — a 25 s outage exhausted the silent 10 × 2 s budget. Measured: `-1` recovers after
  26 s and the existing consumer delivers again.
- **Test home:** `nats-broker.test.ts` (defaults forwarded to the lazy `connect`, overrides
  forwarded, validation, client+reconnect refused) via the existing lazy-load seam;
  `outage-real.test.ts` (guarded on `NATS_URL`: stop the server for 26 s, restore → indicator back
  to `up`, a publish succeeds, and a pre-outage subscription receives a post-outage message).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none. `IKafkaFactory.admin` is optional; `IPubSubTransport.isHealthy`
widens its RETURN type, which an implementor returning `boolean` still satisfies (the only reader is
`GcpPubSubBroker`). Behaviour changes (CHANGELOG `Changed`, `docs/upgrading.md`): Kafka and Pub/Sub
publishes are now bounded at 15 s by default; an injected Kafka factory without `admin` reports
`reachable: 'unknown'` instead of `true`; a lazily built NATS connection reconnects forever; a new
Kafka consumer group starts at the high watermark at `subscribe()` time. Ships in minor `0.10.0`.

`src/index.ts` exports no new symbol (the options are members of already-exported interfaces).

| Exported symbol                         | Kind             | Consumer / real code path that READS it                    |
| --------------------------------------- | ---------------- | ---------------------------------------------------------- |
| `IKafkaFactory.admin?` (new member)     | interface member | `KafkaBroker` probe (§3.1) and group initialisation (§3.3) |
| `IPubSubTransport.isHealthy?` (widened) | interface member | `GcpPubSubBroker.reachability()` cached probe (§3.4)       |

### 4.1 Options — every option names its consumer

| Option                                                                               | Consumer                                        | Behavior (per implementation)                                                                      |
| ------------------------------------------------------------------------------------ | ----------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| `KafkaMessagingOptions.publishTimeoutMs` / `KafkaOptions.publishTimeoutMs`           | `KafkaBroker.publishWithHeaders` `withDeadline` | §3.2; validated at plugin construction and in the constructor                                      |
| `PubSubMessagingOptions*.publishTimeoutMs` / `PubSubOptions.publishTimeoutMs`        | `GcpPubSubBroker` publish `withDeadline`        | §3.2; both arms, injected transport included                                                       |
| `NatsMessagingOptions.reconnect` / `NatsOptions.reconnect`                           | `resolveClient` lazy `nats.connect` options     | §3.5; refused with an injected `client`                                                            |
| `KafkaOptions.logger.warn?` (new optional member; type widens to `{ error; warn? }`) | §3.3 group-initialisation failure report        | Falls back to `logger.error`; the plugin's Kafka arm already passes `ctx` logger, which has `warn` |

The plugin's Kafka/Pub/Sub/NATS arm builders in `messaging-plugin.ts` must FORWARD each new option
to the broker (the M70i dropped-argument class) — each forward is asserted by a plugin-level test
under a non-default value.

## 5. Implementation files

| File                                                                                            | Purpose                                                                                                                                                                             |
| ----------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/brokers/publish-timeout.ts` (new)                                                          | `DEFAULT_PUBLISH_TIMEOUT_MS`, `resolvePublishTimeoutMs` (moved, internal)                                                                                                           |
| `src/brokers/rabbitmq-broker.ts`                                                                | import the moved resolver; no behaviour change                                                                                                                                      |
| `src/brokers/kafka-start-offsets.ts` (new)                                                      | Internal start-aware round robin, per-member decoding/BigInt minimum and optional-module fallback (§3.3)                                                                            |
| `src/brokers/kafka-broker.ts`                                                                   | health client + probe (§3.1), publish bound (§3.2), group initialisation (§3.3)                                                                                                     |
| `src/brokers/pubsub-broker.ts`                                                                  | adapter `isHealthy` (§3.4), broker cached probe, publish bound (§3.2), JSDoc C1                                                                                                     |
| `src/brokers/nats-broker.ts`                                                                    | reconnect options + validation (§3.5)                                                                                                                                               |
| `src/interfaces/index.ts`                                                                       | new options and members (§4)                                                                                                                                                        |
| `src/plugin/messaging-plugin.ts`                                                                | construction-time validation and forwarding for the three arms                                                                                                                      |
| `src/index.ts`                                                                                  | unchanged (asserted by `barrel-exports.test.ts`)                                                                                                                                    |
| `test/fixtures/fake-kafkajs-client.ts`                                                          | gains `admin()` modelling the four methods with the REAL return shapes (string offsets, `'-1'` for none committed) — a fixture that returned numbers would hide a `=== '-1'` defect |
| `README.md`, `PUBLIC_API.md`, `CHANGELOG.md` (`Unreleased`), `docs/upgrading.md` (`Unreleased`) | C1–C5 and the §4 behaviour changes                                                                                                                                                  |
| `ROADMAP.md`, `CLAUDE.md`                                                                       | M113a Progress row ✅ and "Current status" entry, in this PR; plan archived to `plans/archive/`                                                                                     |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                       | src covered                                | Key assertions                                                                                                                                                                                                                                                                                                                                |
| ----------------------------------------------- | ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/publish-timeout.test.ts` (new)       | `publish-timeout.ts`                       | default 15000; `0` accepted; negative, `NaN`, `Infinity`, `> 2147483647` refused with `RangeError` naming `publishTimeoutMs`                                                                                                                                                                                                                  |
| `test/unit/kafka-start-offsets.test.ts` (new)   | `kafka-start-offsets.ts`                   | Real-codec round trip; identical round-robin assignment/name/version; BigInt minima; independently skipped malformed/legacy metadata; optional import success/failure                                                                                                                                                                         |
| `test/unit/brokers/kafka-broker-health.test.ts` | `kafka-broker.ts`                          | Existing lifecycle and observer health assertions through the new admin-backed probe                                                                                                                                                                                                                                                          |
| `test/unit/rabbitmq-durability.test.ts`         | `rabbitmq-broker.ts`, `publish-timeout.ts` | Existing default, validation, bounded publish and unbounded opt-out assertions against the moved resolver                                                                                                                                                                                                                                     |
| `test/unit/kafka-broker.test.ts`                | `kafka-broker.ts`                          | §3.1 mapping incl. a `RequestTimeout` nested in `cause`; cache (two reads in TTL → one `describeCluster`); faulted short-circuit; no-admin → `undefined`; §3.2 bound with fake timers; §3.3 capture-before-`run`, advertised offsets, first-join assignment/commit filtering, minimum versus own fallback, warn-once errors and release races |
| `test/unit/kafka-real-import.test.ts`           | `kafka-broker.ts` lazy arm                 | `kafkaHealthClientConfig` output pinned; a real `kafkajs.Kafka` built from it exposes `admin()` whose instance has `describeCluster`, `fetchOffsets`, `fetchTopicOffsets`, `describeGroups`                                                                                                                                                   |
| `test/unit/pubsub-adapter.test.ts`              | `pubsub-broker.ts` adapter                 | `getTopics` called with the exact options; codes 14 → `false`, 4 → `undefined`, 7/16/5 → `true`, no code → `false`                                                                                                                                                                                                                            |
| `test/unit/pubsub-broker.test.ts`               | `pubsub-broker.ts` broker                  | cached + bounded probe; a never-settling `isHealthy` → `undefined` at 2 s; publish bound; probe dropped on `disconnect()`                                                                                                                                                                                                                     |
| `test/unit/nats-broker.test.ts`                 | `nats-broker.ts`                           | defaults and overrides reach the lazy `connect`; validation; `client` + `reconnect` refused                                                                                                                                                                                                                                                   |
| `test/unit/rabbitmq-broker.test.ts`             | `rabbitmq-broker.ts`                       | existing publish-bound tests still pass against the moved resolver (no edit expected)                                                                                                                                                                                                                                                         |
| `test/unit/messaging-plugin.test.ts`            | `messaging-plugin.ts`                      | construction-time `RangeError`/`TypeError` per arm; each new option forwarded to its broker under a non-default value                                                                                                                                                                                                                         |
| `test/unit/barrel-exports.test.ts`              | `index.ts`                                 | no new runtime export                                                                                                                                                                                                                                                                                                                         |
| `test/integration/kafka-real.test.ts`           | §3.3 real                                  | guarded on `KAFKA_BROKERS`: immediate publish after `subscribe()` delivered; pre-subscribe message not delivered; first RPC succeeds; two new members 50 ms apart with six partition-explicit messages between subscribe calls deliver all six                                                                                                |
| `test/integration/outage-real.test.ts`          | §3.1, §3.2, §3.5 real                      | guarded on `KAFKA_BROKERS` / `NATS_URL`: Kafka stop → `false` (indicator `down`) within the 2 s bound, pause → `undefined`, paused publish rejects at its bound, restore → `true`; NATS 26 s stop → recovers and delivers                                                                                                                     |
| `test/e2e/pubsub-emulator.test.ts`              | §3.4, §3.2 real                            | guarded on `PUBSUB_EMULATOR_HOST` (local only — not in CI, `docs/messaging-emulators.md`): pause/stop/restore outcomes, bounded publish                                                                                                                                                                                                       |

**Negative controls (each run once, observed failing, reverted):** (3b) seek each member's OWN start
offsets instead of the cross-member minimum → the two-consumer concurrent-start case misses
messages; (1) restore Kafka's `return Promise.resolve(true)` → the real stop case fails; (2) build
the Kafka probe from the main client → the real stop case reads `undefined`, not `false`; (3) remove
the first-join seek step → the real immediate-publish case fails on a fresh topic; (4) drop
`gaxOpts` → the emulator stop case reads `undefined`; (5) default NATS `maxAttempts` back to 10 →
the 26 s outage case never recovers; (6) drop the plugin's `publishTimeoutMs` forward on the Kafka
arm → the plugin forwarding test fails.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m113a-broker-health-bounds
pnpm run check:plan
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm test
pnpm test:coverage          # ANSI-stripped per-file table; ≥90% branch/function/line every changed src file
pnpm run test:tooling       # apps-gate pins stay green
pnpm run check:docs
pnpm run release:publish --dry-run
```

Real-backend runs need `KAFKA_BROKERS`, `NATS_URL` and (local) `PUBSUB_EMULATOR_HOST`; the ignored
count proves the guarded suites ran.

## 8. Risks & mitigations

- **The outage tests stop the shared CI Kafka/NATS.** → They name the backend env vars, so the
  partition classifier runs them in the serial `isolated` project before the parallel one; each test
  restores the container in a `finally` and waits for the broker before returning.
- **The health client opens a second connection to Kafka per broker instance.** → One admin
  connection, used once per 5 s at most (cache); documented.
- **A member crashes before joining a fresh group.** → Its advertised start offsets are lost; this
  limit and the no-module/no-admin fallbacks are documented.
- **A Kafka publish rejected at the bound may still be delivered** (kafkajs keeps retrying
  internally). → Error text and docs say so, as RabbitMQ's does.
- **Container restart time in CI** (Kafka KRaft ~10 s, the NATS case needs 26 s down). → Accepted;
  the cases are bounded by explicit waits with generous test timeouts.

## 9. Out of scope

- Failing `/ready` for `reachable: 'unknown'` — M113b (V9-19).
- A bound on NATS publish beyond the client's 5 s ack timeout — not needed (X70).
- A probe or bound for Redis Streams, RabbitMQ or Service Bus — already shipped (M95b, M101a).
- Running the Pub/Sub emulator in CI — the emulator suites stay local
  (`docs/messaging-emulators.md`).

## 10. Design security review (recorded after implementation, at the maintainer's direction)

The committed-tree security audit of `582573a3` failed because this plan had no design review while
the diff crosses a trust boundary (F1 below). This section is recorded after implementation — the
M101a §11 / M101b §10 precedent — and is not presented as having guided the design.

**Flows reviewed.** (a) Kafka consumer-group join metadata: each member's `userData`, written by
whatever client joined the group, decoded by every other member through `describeGroups` and used to
choose the offset a new group's member seeks to. (b) The Kafka and Pub/Sub reachability probes: a
dedicated short-timeout admin round trip and a `getTopics` call whose errors are classified into
`true` / `false` / `undefined`. (c) `publishTimeoutMs` and NATS `reconnect`, commonly fed from
environment variables. (d) Error messages and warnings quoting topic, group and transport errors.
(e) The optional `import('kafkajs')` for an injected client and the module-shape check.

**Assets.** Delivery semantics of a new consumer group (no replay of history, no skipped messages);
availability — a probe or publish against a hung broker settles, a failed `start()` exits, the event
loop is not blocked; and the integrity of log records and error messages.

**Attackers.** A Kafka client able to join the consumer group (an authorised peer service, a
misconfigured deployment sharing a group id, or a holder of the group's credentials). A hostile or
buggy broker or SDK answer. An operator value that is not a finite number. A reader of logs.

**Approved budgets.** One `describeGroups` and one extra `fetchOffsets` per consumer, only on the
first join of a group with no committed offsets. One admin connection per broker for probes, one
probe round trip per 5 s at most (cached).

**Obligations.**

1. A foreign member can move a new group's start offset EARLIER only, never later, so it can cause
   replay but never a skipped message; this is accepted because the same principal can already
   commit the group's offsets, and the docs state that group members are trusted.
2. One topic's advertised offsets never reach another topic's partitions: `userData` is keyed by
   topic and only the consumer's own topic is read.
3. Remote `userData` cannot impose unbounded synchronous work: member metadata above
   `MAX_MEMBER_METADATA_BYTES` (64 KiB) is skipped before decode, offsets are refused above 19
   digits and partition ids above 10 before `BigInt`, and keys are own-property reads (no prototype
   pollution).
4. Malformed metadata from one member is skipped with a warning and never discards the others.
5. Probe and publish bounds settle every call (`withDeadline`), the probe is cached and bounded
   inside the broker (direct callers such as the realtime backplane included), and every bound
   refuses a non-finite or out-of-range value at construction without echoing it.
6. Every quoted string goes through `JSON.stringify` / `describeError`, so CR, LF and the Unicode
   line separators cannot forge a log record.
7. Every failure path releases what it connected (the producer when the probe admin fails; a failed
   group-admin connect is forgotten rather than memoized).

**Findings.**

| #   | Finding                                                                                                                                                | Disposition                                                                                                                                                                                                                                                                                                                                                               |
| --- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | Audit: no design security review                                                                                                                       | Fixed: this section                                                                                                                                                                                                                                                                                                                                                       |
| F2  | Audit: a foreign member advertising `0` makes a new group replay history silently; docs claimed no replay unconditionally; `userData` carried no topic | Fixed: obligations 1–2 — topic-keyed `userData`; trust stated in README, PUBLIC_API, CHANGELOG and the upgrade guide. **Declined:** a warning when an advertised offset is below this member's own, because the legitimate concurrent-start path (§3.3) lowers the later member's offsets on every concurrent first start, so the warning would fire on correct behaviour |
| F3  | Audit: remote `userData` parsed with no size bound (12.9 MB blob 231 ms; 10M-digit `BigInt` 1.2 s)                                                     | Fixed: obligation 3                                                                                                                                                                                                                                                                                                                                                       |
| V1  | Verification: first publish to an auto-created topic after a broker restart exceeded a 2 s `publishTimeoutMs`                                          | Documented in the README; default unaffected                                                                                                                                                                                                                                                                                                                              |
| O1  | Audit observation: with sends in flight during a pause, `app.stop()` takes ~26 s and the process does not exit — identical on `develop`                | Pre-existing; out of scope, flagged for a `fix/…` branch                                                                                                                                                                                                                                                                                                                  |

## 11. Implementation notes

- The implementation request overrides §5/§7 closeout steps: leave ROADMAP.md and CLAUDE.md status
  unchanged, keep this plan at its current path, and leave all changes uncommitted. Committed-tree
  publication verification therefore remains a maintainer closeout step.
- Moving the internal publish resolver also requires updating the existing
  `rabbitmq-durability.test.ts` imports (it imported both moved symbols); RabbitMQ behavior is
  unchanged. This is an additional test-file edit, not a design change.
- The Pub/Sub SDK doubles gain `getTopics`; NATS lazy-connect forwarding is tested through Vitest
  module mocks while the real-backend suites retain real imports.
- `docs/health-indicators.md` registration line references are refreshed after plugin edits because
  the tooling audit checks their exact source locations.
- The first real run passed the new first-message/first-RPC, Kafka stop/pause, Pub/Sub outage and
  NATS 26-second outage assertions. The older multi-topic Kafka case exceeded its 30-second runner
  budget: kafkajs `admin.setOffsets` internally runs a temporary consumer and waits for FETCH/stop
  (`node_modules/kafkajs/src/admin/index.js:514–566`), measured about 5 seconds per group locally.
  Its obsolete join sleeps/publish retries are replaced with single-publish assertions; the two boot
  tests receive explicit 60/90-second budgets for multiple groups.

- Negative-control iteration exposed a test-restoration gap: `docker start` alone can return before
  Kafka answers metadata, so a following run failed during startup rather than exercising the
  intended mutation. Kafka outage tests now wait for real metadata readiness before startup and in
  `finally`. The invalid startup failures are not counted as control evidence; the valid main-client
  control observed `undefined` instead of `false` at the stopped-broker assertion.

- The first combined coverage command passed the messaging package and every per-file threshold, but
  its automatic tooling phase caught the upgrade-guide attribution convention: a migration heading
  must name backticked subjects also present in the corresponding CHANGELOG section
  (`test/docs-gate.test.ts:2265–2278`). The new heading now names `publishTimeoutMs` and
  `reconnect`; no gate assertion is changed.

### V9-3 redesign and plan-review gaps (added by the maintainer's reviewer after the first pass)

- **V9-3 redesign.** The first implementation's `setOffsets` cost ~5 s per new group (Codex's note
  above). §3.3 is rewritten to the seek-on-join design with cross-member start offsets; the probes
  are in the session scratchpad (`seek.mjs`, `seek-control.mjs`, `replica.mjs`, `coord.mjs`). The
  60/90-second Kafka test budgets added for `setOffsets` must be reverted to what the redesign
  needs.
- **Gaps in the reviewed plan the first pass did not report:** the realtime-backplane citation was
  unverified (now `transports/messaging-backplane.ts:95`); §6 omitted `rabbitmq-durability.test.ts`
  and `kafka-broker-health.test.ts`, both of which the change touches; and the plan did not decide
  whether a committed-tree security audit is needed. **Decision: an audit IS required** (corrected
  during verification — an earlier revision said none). The first-join seek reads every group
  member's join metadata, which other Kafka clients write, and seeks to the lowest offset any member
  advertises; anything able to join the group can steer where a new group starts, and the JSON is
  parsed with no size bound. The audit decides whether that is acceptable given that group
  membership is already privileged.
- **Verification finding (doc):** the first publish to an auto-created topic right after a broker
  restart took over 2 s (leader election inside kafkajs's send), so a small `publishTimeoutMs` can
  reject it; the default 15 s does not. The README now says the bound covers that wait.

- **Implementation correction for the redesign:** the §6 test matrix and §8 risk still described
  offset writes after §3.3 was rewritten. They now name capture-before-run, first-join seeks,
  `describeGroups`, and the lost-start-offset crash limit. Negative control 3 disables first-join
  seeks; 3b substitutes own offsets for the cross-member minimum. The round-robin wrapper and
  independent member decoding/BigInt minimum live in internal `brokers/kafka-start-offsets.ts`,
  covered by `test/unit/kafka-start-offsets.test.ts`; neither is exported from `src/index.ts`. The
  fixture now supplies real encoded member metadata, seek recording and assigned partitions in
  GROUP_JOIN payloads. `rabbitmq-durability.test.ts` and `kafka-broker-health.test.ts` remain in the
  verification scope. The 60/90-second Kafka boot-test budgets are removed.
- **Codec port correction:** kafkajs 2.2.4 `MemberMetadata.encode` delegates `userData` to
  `Encoder.writeBytes`, which accepts a UTF-8 string as well as Buffer. The internal structural
  codec port uses that measured string path to avoid a runtime-specific Buffer API in plugin code;
  the real-codec round-trip test pins the resulting bytes and unchanged assignment output.

- **Concurrent-start test correction:** on the zero-rebalance-delay throwaway broker, an
  uncoordinated 50 ms stagger let member A complete its first join before B subscribed, so it did
  not exercise the still-new-group race. The real test now gates only entry to both real kafkajs
  `run()` calls until both `subscribe()` snapshots are captured (A, 50 ms, six partition-explicit
  publishes, B). Admin calls, encoded metadata, assignment, seeks and delivery all remain real.
  Negative control 3b must fail this reproduction before it counts as evidence.

- **Redesign negative controls (2026-10-16):** control 3, deleting the first-join seek, exited 1
  with `timeout waiting for Kafka immediate delivery` on a fresh topic. Control 3b, using each
  member’s own watermark, exited 1 with only `message-0`, `message-2`, `message-4` received out of
  six (the later member’s partition lost all three). Both mutations were restored immediately;
  `.tmp/m113a-negative-3.log` and `.tmp/m113a-negative-3b.log` retain the failure evidence.

- **Failure-wording clarification:** skipping one member’s undecodable metadata keeps the minimum
  from the own snapshot and other usable members; it does not disable all seeking. §3.3 and the
  README/PUBLIC_API now distinguish that path from an admin or seek failure, which leaves affected
  partitions with kafkajs latest-offset behavior. The malformed-member unit case exercises this.

- **Plan matrix closure and measured result:** §5/§6 now explicitly map the new internal seam and
  the previously omitted durability/health tests. Full messaging coverage passed (1579 tests, 83
  guarded skips); every changed source file exceeds 90% branch/function/line. The real Kafka suite
  passed all six cases. New-group `subscribe()` returned in 58.36 ms; concurrent members returned in
  65.02 ms and 58.20 ms (the group join remains asynchronous). The automatic tooling coverage target
  and explicit `test:tooling` each passed 1304 tests. Both negative controls above remain reverted,
  and the throwaway backends were restored running and unpaused.
