# Milestone 101b — message transports that fail against the real broker

> **Status:** Planning. Branch: `feat/m101b-real-broker-arms`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR. **Sequence:**
> lands AFTER M101a (same package; this branch is cut from `main` once M101a has merged and reuses
> the kernel-app outage-suite shape M101a §3.8 establishes). It does not depend on M101c–M101h.

## 0. Objective & scope

Three broker arms pass every fake-backed test and fail on first contact with the real server, each
on a broker-specific naming or startup rule that a permissive fake accepts: Pub/Sub's default
subscription name is project-global, so a second topic attaches to the first topic's subscription
(V8-2, High); NATS uses the reply inbox's dotted queue name verbatim as a JetStream durable name,
which the client itself refuses (V8-6); a Kafka subscription to a topic that does not exist yet dies
at boot with a raw `KafkaJSProtocolError` naming no topic (V8-26). All three share one deliverable:
a real-backend case per arm that exercises RPC and a SECOND topic, not one topic at a time.

- **In scope:** a per-topic default subscription name and a topic-binding check for Pub/Sub; an
  injective encoding of a `SubscribeOptions.queue` into a legal JetStream consumer name; a named
  error for a Kafka topic that cannot be subscribed, a reader for the consumer's `run()` rejection,
  and a forwarded `KafkaOptions.retry`; the real-NATS RPC case, the real-Kafka fresh-topic case, and
  a two-topic + RPC emulator case for Pub/Sub; the documentation of what each arm needs to
  pre-exist.
- **NOT this milestone:** the Service Bus health race and every bounded-call row (M101a); an
  `admin()` surface on `IKafkaFactory` so the broker could create topics (named in §9); Pub/Sub
  topic creation (the broker deliberately creates none — `pubsub-emulator.test.ts:56`).

## 1. Contracts verified from SOURCE (not names)

| Reference                                      | Source (file:line)                                                                                                                            | Verified surface / fact                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Pub/Sub default subscription name              | `packages/messaging-plugin/src/brokers/pubsub-broker.ts:37,297,478`                                                                           | `DEFAULT_QUEUE = 'messaging-consumers'`; `subscribe()` uses `options?.queue ?? this.#defaultQueue` for EVERY topic — one project-global name                                                                                                                                                                                                 |
| `ALREADY_EXISTS` swallowed, binding never read | `packages/messaging-plugin/src/brokers/pubsub-broker.ts:207-218,220`                                                                          | the real adapter's `open()` calls `topic(topic).createSubscription(subscription)`, rethrows every gRPC code but `6`, then attaches `pubsub.subscription(subscription)` — whichever topic that subscription is bound to                                                                                                                       |
| `PubSubSdkModule` facade                       | `packages/messaging-plugin/src/brokers/pubsub-broker.ts:44-60`                                                                                | names only `topic().publishMessage/createSubscription` and `subscription().on/close/delete`; no `getMetadata`, so the binding check needs a facade widening                                                                                                                                                                                  |
| `IPubSubTransport.open` / `createSubscription` | `packages/messaging-plugin/src/brokers/pubsub-broker.ts:99-116`                                                                               | the domain port the broker calls; the binding check belongs INSIDE the real adapter's `open`, behind this port, so the broker and the fake transport are untouched                                                                                                                                                                           |
| RPC channel and reply inbox                    | `packages/messaging-plugin/src/brokers/request-reply-core.ts:37-40`; `pubsub-broker.ts:319-330`                                               | responders subscribe to `rr.req.<topic>` through the broker's PUBLIC `subscribe()` — hence with the DEFAULT queue; the reply inbox already uses a per-instance `rr-inbox-<uuid>` subscription on `replyTopic`                                                                                                                                |
| Pub/Sub `Subscription.getMetadata`             | `~/.cache/deno/npm/registry.npmjs.org/@google-cloud/pubsub/6.1.0/build/src/subscription.d.ts:536`                                             | `getMetadata(gaxOpts?): Promise<GetSubscriptionMetadataResponse>` — a one-element tuple whose metadata is `google.pubsub.v1.ISubscription`, carrying `topic?: string \| null` as the fully-qualified `projects/<p>/topics/<t>` (`build/protos/protos.d.ts:1315`). The lock resolves `npm:@google-cloud/pubsub@6` to `6.1.0` (`deno.lock:31`) |
| No client-side name validation in the SDK      | `grep -rn "goog\|must start with\|255" …/pubsub/6.1.0/build/src/{pubsub,util,subscription,topic}.js` is empty                                 | the subscription-ID grammar is enforced by the SERVICE: 3–255 characters, starting with a letter, from `[A-Za-z0-9-_.~+%]`, not starting with `goog` (Pub/Sub resource-naming docs). Topic IDs share the grammar, so `messaging-consumers.<topic>` is legal whenever `<topic>` is, up to the length cap                                      |
| Existing emulator suite                        | `packages/messaging-plugin/test/e2e/pubsub-emulator.test.ts:35-40,49-62,74,159-165`                                                           | one topic per case, each in its own app; the RPC case runs with NO prior ordinary subscription in that app — which is why V8-2 was invisible. Topics are pre-created by an `admin` client                                                                                                                                                    |
| The doc that masks V8-2                        | `docs/messaging-emulators.md:39-42`                                                                                                           | "a second consecutive run … fails with `RequestTimeoutError`; `docker restart he-pubsub` before each run" — the second run's `rr.req.<topic>` attached to the first run's `messaging-consumers`                                                                                                                                              |
| NATS consumer name from the queue              | `packages/messaging-plugin/src/brokers/nats-broker.ts:498,517-523`                                                                            | `consumerName = options?.queue ?? \`messaging-${uuid}\``; passed as BOTH`name`and`durable_name`to`jsm.consumers.add`                                                                                                                                                                                                                         |
| The inbox queue is dotted                      | `packages/messaging-plugin/src/brokers/inbox.ts:20,117-121`                                                                                   | `TOPIC_INBOX_PREFIX = 'rr.inbox.'`; `createTopicInbox` subscribes with `{ queue: address }` where `address = 'rr.inbox.<uuid>'` — so every NATS `request()` reaches `subscribe` with a dotted queue                                                                                                                                          |
| nats grammar — client-side, before the wire    | `~/.cache/deno/npm/registry.npmjs.org/nats/2.29.3/lib/jetstream/jsutil.js:34-66`; `jsmconsumer_api.js:50-72`                                  | `minValidation` refuses a name containing any of `.`, `*`, `>`, `/`, `\`, space, tab, LF, CR with `invalid durable name - durable name cannot contain '<c>'`; applied to `durable_name` (`:51`) and, with a `consumer 'name'` prefix, to `name` (`:61`). Both fields need the same encoding. Lock: `npm:nats@2` → `2.29.3` (`deno.lock:59`)  |
| Existing real-NATS suite                       | `packages/messaging-plugin/test/integration/nats-real.test.ts:55-120,122,171`                                                                 | kernel app with `streamSubjects: ['<scope>.>']`; three cases, none calls `request()`; CI supplies `NATS_URL` (`ci.yml:81,272-274`)                                                                                                                                                                                                           |
| Kafka subscribe path                           | `packages/messaging-plugin/src/brokers/kafka-broker.ts:420-443,460`                                                                           | `groupId = options?.queue ?? deriveDefaultGroupId(defaultQueue, topic)` (`<defaultQueue>:<topic>`, `:140-142`); `await consumer.connect()`; `await consumer.subscribe({ topic, fromBeginning: false })` — the throw site; `consumer.run({...})` is NOT awaited and has no `.catch` (`grep "\.catch(" kafka-broker.ts` finds none on it)      |
| `resolveClient` builds the `Kafka`             | `packages/messaging-plugin/src/brokers/kafka-broker.ts:84-99`                                                                                 | `new kafkajs.Kafka({ clientId, brokers })` — no `retry`; `KafkaOptions` (`interfaces/index.ts:707-730`) and the `KafkaMessagingOptions` arm (`:444-452`) carry no `retry`                                                                                                                                                                    |
| `KafkaOptions.logger` is dead surface          | `packages/messaging-plugin/src/interfaces/index.ts:729`; M75 entry in `CLAUDE.md`                                                             | set by the plugin, read by nothing ("`KafkaOptions.logger` is still dead; noted, not fixed"). §3.4 gives it its first reader                                                                                                                                                                                                                 |
| kafkajs: where the error comes from            | `~/.cache/deno/npm/registry.npmjs.org/kafkajs/2.2.4/src/consumer/index.js:134,185`; `src/cluster/index.js:216-246`                            | `consumer.subscribe` → `cluster.addMultipleTargetTopics` → `refreshMetadata`; an `UNKNOWN_TOPIC_OR_PARTITION` is rethrown after restoring the target set (`:232-240`) — it escapes `subscribe` with the error `type` on it                                                                                                                   |
| kafkajs already retries metadata               | `…/kafkajs/2.2.4/src/cluster/brokerPool.js:152-156`; `src/retry/defaults.js`; `src/retry/index.js:17-18,46-47`; `src/protocol/error.js:25-27` | `refreshMetadata` runs inside `this.retrier`; defaults `retries: 5`, `initialRetryTime: 300`, `multiplier: 2`, `maxRetryTime: 30000` (≈ 9 s of attempts); `UNKNOWN_TOPIC_OR_PARTITION` is `retriable: true`, so it IS retried. What escapes is the budget's exhaustion — a topic that is not auto-created, not a leader election             |
| kafkajs `retry` option                         | `…/kafkajs/2.2.4/types/index.d.ts:60,228-235`                                                                                                 | `KafkaConfig.retry?: RetryOptions` (`maxRetryTime`, `initialRetryTime`, `factor`, `multiplier`, `retries`, `restartOnFailure`); consumers merge it as their default (`src/index.js:68,124,169`)                                                                                                                                              |
| kafkajs `run()` crash path                     | `…/kafkajs/2.2.4/src/consumer/index.js:189-304`                                                                                               | `run` awaits `start(onCrash)`; a crash with a retriable cause is restarted internally; a non-restartable one REJECTS the `run()` promise — un-awaited in this broker, i.e. an unhandled rejection that terminates the process                                                                                                                |
| Existing real-Kafka suite                      | `packages/messaging-plugin/test/integration/kafka-real.test.ts:49-82`                                                                         | pre-creates all four wire topics through `admin.createTopics` ("Kafka auto-creation is not assumed"), so no case ever subscribes a fresh topic; CI runs `apache/kafka:4.0.0` with no broker config override (`ci.yml:294`), whose `auto.create.topics.enable` is Kafka's default `true`                                                      |
| `JetStreamStreamError` (named-error precedent) | `packages/messaging-plugin/src/errors.ts:260-283`                                                                                             | `(stream, cause?)`, message names the resource and BOTH remedies, `name` set, `cause` forwarded; exported from the barrel (`src/index.ts:63-73`)                                                                                                                                                                                             |
| Kafka group-id precedent (M90d)                | `packages/messaging-plugin/README.md:183-196`                                                                                                 | documents `<defaultQueue>:<topic>` and why the separator is a character topic names cannot contain                                                                                                                                                                                                                                           |
| Package test net grant                         | `packages/messaging-plugin/deno.json:9-21`                                                                                                    | `127.0.0.1:8085`, `127.0.0.1:4222`, `127.0.0.1:9092` already granted; no manifest change                                                                                                                                                                                                                                                     |
| CI backend inventory                           | `.github/workflows/ci.yml:78-82,264-300`; `test/apps-gate.test.ts:498-534`; `docs/messaging-emulators.md:162-170`                             | NATS and Kafka run in CI (pinned); the Pub/Sub emulator is local-only by decision ("Why not CI")                                                                                                                                                                                                                                             |
| M101a dependency                               | `plans/milestone-101a-bounded-health.md` §3.2, §3.8                                                                                           | the kernel-app `/health`+`/ready` outage-suite shape and the `service-bus-broker.ts` change this branch rebases over; nothing in this plan touches that file                                                                                                                                                                                 |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                  | Resolution (picked side)                                                                                        | Doc deliverable (same PR)                                                                                                                                                                      |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `docs/messaging-emulators.md:39-42` tells the reader to `docker restart he-pubsub` between runs because the RPC case times out — that timeout IS V8-2, not emulator statefulness                                                          | The advice masks the defect. Strike it once §3.1 ships; the suite must pass twice against one emulator instance | Paragraph replaced by one stating the per-topic default and that repeated runs share an instance                                                                                               |
| C2 | `PUBLIC_API.md:4975,4992,5020` and the messaging README document `defaultQueue` for Pub/Sub as "default consumer-group subscription name" with no per-topic derivation, while Kafka's row (`:5034`) documents `<defaultQueue>:<topic>`    | Pub/Sub gets the same shape with its own separator (§3.1); the doc rows say so                                  | `PUBLIC_API.md` Pub/Sub `defaultQueue` row + a "Pub/Sub subscriptions" README subsection beside "Kafka consumer groups"                                                                        |
| C3 | `packages/messaging-plugin/README.md:155-182` "NATS prerequisites" names `streamSubjects` and the stream, and nothing about the subjects RPC needs (`rr.req.<topic>`, `rr.inbox.>`) nor that a queue name becomes a consumer name         | Document the subject set an RPC-capable NATS stream must cover and the consumer-name encoding (§3.2)            | README NATS subsection + `PUBLIC_API.md` `NatsOptions.streamSubjects` note                                                                                                                     |
| C4 | `KafkaOptions.replyTopic` JSDoc (`interfaces/index.ts:716-726`) says a topic "must already exist (or `auto.create.topics.enable` must be on)" for the REPLY topic only; nothing says it of a subscribed topic, and the failure is unnamed | State the rule for every subscribed topic and name the error (§3.3)                                             | README "Kafka consumer groups" gains a "Kafka topics" paragraph; `PUBLIC_API.md` Kafka rows gain `retry` and the error; `KafkaOptions` JSDoc                                                   |
| C5 | `CHANGELOG.md` `Unreleased` has no messaging entry; §3.1 changes a default subscription NAME in a released arm                                                                                                                            | Breaking — recorded with migration text                                                                         | `CHANGELOG.md` `Unreleased` → `Changed` (Pub/Sub default name, Kafka named error + crash containment) and `Fixed` (NATS RPC); `docs/upgrading.md` `## Unreleased` entry for the Pub/Sub rename |

## 3. Design decisions

### 3.1 V8-2 — a per-topic default subscription, and a refused foreign binding

- **Decision:** `GcpPubSubBroker.subscribe` derives the default as
  `deriveDefaultSubscription(defaultQueue, topic) = \`
  ${defaultQueue}.${topic}\``(`'.'`joins, the
  package's own`rr.req.`convention; the Kafka`':'`is illegal in a Pub/Sub ID and no character is
  reserved there, so recoverability by splitting is not claimed and the README says so). A derived or
  caller-supplied name longer than 255 characters is refused at`subscribe()`with a plain`Error`naming the limit and`SubscribeOptions.queue`. Inside the real adapter's`open()`, an`ALREADY_EXISTS`(gRPC code`6`) is followed by`pubsub.subscription(name).getMetadata()`; when the
  metadata's`topic`does not end in`/topics/<requested topic>`,`open()`throws a new exported`PubSubSubscriptionBoundElsewhereError(subscription,
  boundTopic,
  requestedTopic)`naming all
  three and the two remedies (pass a distinct`SubscribeOptions.queue`, or delete the subscription).`PubSubSdkModule.subscription(...)`gains`getMetadata():
  Promise<[{ topic?: string | null },
  ...unknown[]]>`;`IPubSubTransport`is unchanged, so every injected transport and every existing test compiles. A
  caller-supplied`queue`
  keeps today's behaviour — the binding check applies to it too, because the silent attach is wrong
  for any name.
- **Why:** the M90d Kafka reasoning transfers whole: a shared default means one topic's subscription
  is the next topic's, and messages are consumed by the wrong handler with no log (4 of 6 lost in
  the run). The binding check is the second half, because a per-topic default only moves the
  collision to a caller who reuses one `queue` across topics. `getMetadata` is the SDK's documented
  read of a subscription's topic and exists in the pinned `6.1.0`; the emulator serves it.
- **Breaking:** a deployment whose existing `messaging-consumers` subscription carries a backlog
  keeps that subscription with no consumer after upgrade; the upgrade note says to pass
  `SubscribeOptions.queue: 'messaging-consumers'` on the ONE topic that owns it until drained, then
  delete it.
- **Test home:** `test/unit/pubsub-broker.test.ts` (two topics with no `queue` open two distinct
  subscriptions; `defaultQueue` honoured as the prefix; the 255 refusal).
  `test/unit/pubsub-adapter.test.ts` (fake SDK: `ALREADY_EXISTS` + metadata on the same topic →
  attaches; on a different topic → `PubSubSubscriptionBoundElsewhereError` naming both; a non-`6`
  code still rethrows). `test/e2e/pubsub-emulator.test.ts` gains the case V8-2 reproduces — ONE app
  subscribing topic A and topic B with defaults and then `respond`/`request` on a third: both topics
  deliver only their own messages (a counter per topic, the control that a shared subscription
  fails), the admin client lists `messaging-consumers.<A>` and `messaging-consumers.<B>`, and the
  RPC round-trips; plus a pre-created `messaging-consumers.<B>` bound to topic A → the named error
  from `start()`. The suite is then run TWICE against one emulator instance (C1). **Local-only,
  `ignore:` on `PUBSUB_EMULATOR_HOST`** (no emulator in CI). Negative control: revert the derivation
  → the second topic's counter receives the first topic's messages and the RPC times out — the run's
  own signature.

### 3.2 V8-6 — an injective, grammar-aware JetStream consumer name

- **Decision:** `toJetStreamConsumerName(queue)` in a new `brokers/nats-consumer-name.ts` encodes
  each byte the client refuses — the nine-character table from `jsutil.js:45`, held as data — as
  `_` + two lowercase hex digits (`.` → `_2e`), and returns a name containing none of them
  UNCHANGED. `NatsBroker.subscribe` passes the encoded value as both `name` and `durable_name` and
  keeps `filter_subject: topic` verbatim (the SUBJECT may contain dots). The default
  `messaging-<uuid>` and every legal user queue are therefore byte-identical to today, so no
  existing durable consumer is renamed. A legal queue that literally contains `_2e` can collide with
  a dotted one; that is documented rather than removed by escaping `_` too, which would rename every
  underscore queue in every running deployment.
- **Why:** the refusal is client-side (`jsmconsumer_api.js:51`), before the wire, on the exact name
  the inbox mints — so NATS `request()` has never worked against a real server, and any dotted user
  queue fails identically. A hash was rejected because it hides the queue name from an operator's
  `nats consumer ls`; the hex escape keeps it readable.
- **Test home:** `test/unit/nats-consumer-name.test.ts` (the nine-character table as data; identity
  for a legal name; injectivity over a corpus of dotted and wildcard names; the real `nats`
  `validateDurableName` from the pinned package accepts every encoded output — a guarded real-import
  assertion beside `nats-real-import.test.ts`). `test/unit/nats-broker.test.ts` (the encoded name
  reaches `jsm.consumers.add` as `name` and `durable_name`; `filter_subject` keeps the dotted
  topic). `test/integration/nats-real.test.ts` gains two cases: a `respond`/`request` round-trip
  through a kernel app whose `streamSubjects` cover `<scope>.>` and `rr.inbox.>` (the subject set C3
  documents), and a user subscription with `queue: 'orders.eu'` that delivers. **In CI**
  (`NATS_URL`). Negative control: revert the encoding → the RPC case fails with the run's verbatim
  `invalid durable name - durable name cannot contain '.'`.

### 3.3 V8-26 — a Kafka topic that cannot be subscribed is named, and the consumer never crashes the process

- **Decision:** in `KafkaBroker.subscribe`, the `await consumer.subscribe(...)` is wrapped: an error
  whose `type === 'UNKNOWN_TOPIC_OR_PARTITION'` disconnects that consumer and throws a new exported
  `KafkaTopicUnavailableError(topic, groupId, cause)` whose message names the topic, the group, and
  the two remedies (pre-create the topic; enable `auto.create.topics.enable`) — the
  `JetStreamStreamError` shape. No broker-owned retry loop is added: kafkajs's
  `brokerPool.
  refreshMetadata` already retries this retriable error inside its own retrier, so a
  second loop would double the budget silently; instead `KafkaOptions.retry` (and the
  `KafkaMessagingOptions` arm) is forwarded verbatim to `new Kafka({ clientId, brokers, retry })`,
  so an operator whose leader election outlasts ≈ 9 s lengthens the budget where kafkajs reads it.
  The un-awaited `consumer.run(...)` promise gains a `.catch` that reports through
  `KafkaOptions.logger` (its first reader) and marks the `ActiveConsumer` not running, so a consumer
  crash kafkajs declines to restart is a logged, observable failure rather than an unhandled
  rejection.
- **Why:** "retry metadata" is already what kafkajs does, measured from its source; what the run saw
  was the budget running out on a topic the broker would not create, surfacing as an error with no
  topic in it. Naming the topic is the fix a developer can act on, and the `retry` pass-through is
  the configurable half without inventing a second retry policy. The `run()` rejection is the same
  class M52b fixed on `createQueueHandler`: a promise nothing holds.
- **Test home:** `test/unit/kafka-broker.test.ts` (fake factory whose `consumer.subscribe` rejects
  with `{ name: 'KafkaJSProtocolError', type: 'UNKNOWN_TOPIC_OR_PARTITION', retriable: true }` →
  `KafkaTopicUnavailableError` with the topic and group in the message and the original as `cause`,
  consumer disconnected; a different `type` rethrows unchanged; `retry` reaches the `Kafka`
  constructor; a `run()` rejection reaches `logger.error` and the broker stays `isReady()`).
  `test/integration/kafka-real.test.ts` gains a case that subscribes a NEVER-created topic through a
  kernel app and asserts `start()` resolves and a publish after the join is delivered — the real
  proof that kafkajs's own metadata retry covers auto-creation on the CI broker — and a second case
  that injects a factory producing the protocol error against the otherwise-real app to prove the
  named error reaches `start()`'s rejection (the CI broker auto-creates, so the real path cannot
  produce the exhausted budget; §8). **In CI** (`KAFKA_BROKERS`). Negative control: revert the wrap
  → the injected case rejects with the raw `KafkaJSProtocolError` naming no topic.

### 3.4 One real-backend case per arm exercises RPC and a second topic

- **Decision:** each arm's real suite drives a kernel application with the real `MessagingPlugin`
  and asserts through the resolved `CAPABILITIES.MESSAGING`: two ordinary subscriptions on two
  topics in ONE app, then `respond` + `request`. Guards are `ignore:` on the env var; each file
  states whether CI runs it (NATS, Kafka: yes; Pub/Sub: local-only).
- **Why:** every existing arm suite subscribes one topic per app, which is precisely the shape under
  which all three defects are invisible.
- **Test home:** the three suites in §3.1–§3.3; `test/apps-gate.test.ts` keeps its NATS/Kafka pins
  and gains none, since no CI wiring changes.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                      | Kind   | Consumer / real code path that READS it                                                                           |
| ---------------------------------------------------- | ------ | ----------------------------------------------------------------------------------------------------------------- |
| `PubSubSubscriptionBoundElsewhereError`              | class  | thrown by the real Pub/Sub adapter's `open()`; rejects `subscribe()`/`start()`; `instanceof` for an application   |
| `KafkaTopicUnavailableError`                         | class  | thrown by `KafkaBroker.subscribe`; rejects `start()` for a declared subscription; `instanceof` for an application |
| `KafkaOptions.retry` / `KafkaMessagingOptions.retry` | option | `resolveClient` → `new Kafka({ retry })`                                                                          |

`toJetStreamConsumerName` and `deriveDefaultSubscription` stay internal (pinned by the existing
`barrel-exports.test.ts`). No `common` change and no new capability token.

### 4.1 Options — every option names its consumer

| Option                                       | Consumer                    | Behavior (per implementation)                                                                                             |
| -------------------------------------------- | --------------------------- | ------------------------------------------------------------------------------------------------------------------------- |
| `PubSubOptions.defaultQueue` (existing)      | `GcpPubSubBroker.subscribe` | now the PREFIX of `<defaultQueue>.<topic>`; default `'messaging-consumers'` unchanged                                     |
| `SubscribeOptions.queue` (existing, Pub/Sub) | the real adapter's `open()` | used verbatim, and ALSO binding-checked on `ALREADY_EXISTS`                                                               |
| `SubscribeOptions.queue` (existing, NATS)    | `NatsBroker.subscribe`      | encoded through `toJetStreamConsumerName` before reaching `jsm.consumers.add`                                             |
| `KafkaOptions.retry` (new)                   | `resolveClient`             | forwarded to kafkajs; absent → kafkajs defaults; ignored for an injected `client`, documented                             |
| `KafkaOptions.logger` (existing)             | the `run()` `.catch`        | first reader; absent → the rejection is swallowed after marking the consumer stopped (no console fallback — `no-console`) |

## 5. Implementation files

| File                                                          | Purpose                                                                                                     |
| ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `packages/messaging-plugin/src/brokers/pubsub-broker.ts`      | `deriveDefaultSubscription`, length refusal, facade `getMetadata`, binding check in the real adapter (§3.1) |
| `packages/messaging-plugin/src/brokers/nats-consumer-name.ts` | `toJetStreamConsumerName` + the forbidden-character table (§3.2)                                            |
| `packages/messaging-plugin/src/brokers/nats-broker.ts`        | encode `name`/`durable_name` (§3.2)                                                                         |
| `packages/messaging-plugin/src/brokers/kafka-broker.ts`       | named error, `run()` rejection reader, `retry` forwarding (§3.3)                                            |
| `packages/messaging-plugin/src/interfaces/index.ts`           | `KafkaOptions.retry`, `KafkaMessagingOptions.retry`; JSDoc for C4                                           |
| `packages/messaging-plugin/src/errors.ts`                     | the two error classes                                                                                       |
| `packages/messaging-plugin/src/index.ts`                      | exports the two classes                                                                                     |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                      | src covered                                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                     |
| ---------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/pubsub-broker.test.ts` (extend)     | `brokers/pubsub-broker.ts`                   | `subscribe(topicA, h)` and `subscribe(topicB, h)` call `transport.open` with `messaging-consumers.<topic>` each; `defaultQueue: 'x'` → `x.<topic>`; 256-char name → `Error` naming the limit; `{ queue }` passes verbatim                            |
| `test/unit/pubsub-adapter.test.ts` (extend)    | `brokers/pubsub-broker.ts` (real adapter)    | fake SDK with `createSubscription` rejecting `{ code: 6 }` and `subscription().getMetadata()` → same topic attaches; other topic → `PubSubSubscriptionBoundElsewhereError` with `subscription`/`boundTopic`/`requestedTopic`; `{ code: 5 }` rethrows |
| `test/e2e/pubsub-emulator.test.ts` (extend)    | `brokers/pubsub-broker.ts`                   | §3.1 two-topic + RPC case, foreign-binding case, double run. **Local-only**, `ignore:` on `PUBSUB_EMULATOR_HOST`                                                                                                                                     |
| `test/unit/nats-consumer-name.test.ts` (new)   | `brokers/nats-consumer-name.ts`              | table-driven grammar; identity; injectivity; guarded real `validateDurableName` acceptance                                                                                                                                                           |
| `test/unit/nats-broker.test.ts` (extend)       | `brokers/nats-broker.ts`                     | `subscribe(topic, h, { queue: 'rr.inbox.abc' })` → `jsm.consumers.add(stream, { name: 'rr_2einbox_2eabc', durable_name: same, filter_subject: topic })`                                                                                              |
| `test/integration/nats-real.test.ts` (extend)  | `brokers/nats-broker.ts`, `brokers/inbox.ts` | RPC round-trip and a dotted user queue against real JetStream. **CI**, `ignore:` on `NATS_URL`                                                                                                                                                       |
| `test/unit/kafka-broker.test.ts` (extend)      | `brokers/kafka-broker.ts`, `errors.ts`       | §3.3 unit cases against `new KafkaBroker(runtime, serializer, { client, retry, logger })`; `cause` identity                                                                                                                                          |
| `test/unit/messaging-plugin.test.ts` (extend)  | `interfaces/index.ts`                        | the `kafka` arm forwards `retry`                                                                                                                                                                                                                     |
| `test/integration/kafka-real.test.ts` (extend) | `brokers/kafka-broker.ts`                    | fresh-topic boot + delivery; injected-protocol-error boot rejects with the named error. **CI**, `ignore:` on `KAFKA_BROKERS`                                                                                                                         |
| `test/unit/barrel-exports.test.ts` (extend)    | `index.ts`                                   | two classes added; the two helpers absent                                                                                                                                                                                                            |

Per-file numbers are read from the ANSI-stripped `deno task test:coverage:pkg messaging-plugin`
table on the rebased branch before the first edit and after each change; `nats-consumer-name.ts` and
`errors.ts` land at 100%, and the three broker files must not regress.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m101b-real-broker-arms, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs
deno task publish:check     # on the committed tree
deno task release:verify 0.8.0
```

Plus the negative controls, each observed failing and reverted: §3.1 (the emulator two-topic case
with the derivation reverted), §3.2 (the real-NATS RPC case with the encoding reverted — the run's
verbatim message), §3.3 (the injected case with the wrap reverted — the raw error). The emulator
suite is run twice against one instance to prove C1's advice is no longer needed.

## 8. Risks & mitigations

- **Sequence.** Cut from `main` after M101a merges; the only shared file is none — M101a touches
  `service-bus-broker.ts` and `messaging-plugin.ts`, this plan does not — so the rebase is trivial,
  but the branch still waits so the CHANGELOG `Unreleased` section is edited in one order.
- **The real Kafka path cannot exhaust the budget.** The CI broker auto-creates, so the named error
  is proven with an injected factory; the raw escape the run saw came from a broker that did not
  auto-create (its image is not recorded in `smoke/ENVIRONMENT.md`). Before merging, the error path
  is probed once locally against `apache/kafka:4.0.0` started with
  `KAFKA_AUTO_CREATE_TOPICS_ENABLE=false`, and the probe's outcome is written into the PR — if
  kafkajs's exhausted-retry error arrives with a different `type`, the match widens to
  `retriable === true` on a `KafkaJSProtocolError` as well, and the unit table gains that row.
- **Pub/Sub emulator fidelity.** The binding check relies on the emulator honouring `getMetadata`
  with a `topic`; the existing suite already lists subscriptions through the admin client, so the
  surface exists there — asserted by the new case rather than assumed.
- **The `_2e` collision.** Documented; a legal queue containing a literal `_` + two hex digits that
  also appears as the encoding of a dotted sibling is the only case, and the README names it.
- **Pub/Sub rename blast radius.** Every deployment on the Pub/Sub arm gets a new subscription per
  topic on upgrade — orphaned backlogs are the risk → the upgrade note's two steps, and the
  CHANGELOG entry is `Changed` with a breaking marker.
- **Second-topic cases lengthen the real suites.** Each new case uses its own run-suffixed topics
  and tears them down; the NATS stream and the Kafka group ids are suffixed too.

## 9. Out of scope

- An `admin()` member on `IKafkaFactory` so the broker could create topics itself — a facade
  widening every injected factory would have to satisfy; the named error and the documented
  pre-creation are the row's fix.
- Pub/Sub topic creation; the broker creates none by design and the e2e pre-creates them.
- Renaming existing NATS durable consumers for legal queue names (none change) and escaping `_`
  (rejected in §3.2).
- The Service Bus arm (RPC refused by name on the emulator — a documented limitation, not a row).
- Every health and bounded-call row: M101a.
