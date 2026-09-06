# Milestone 90d — The Two Brokers That Cannot Start (`@setu-ts/messaging-plugin`)

> **Status:** Planning. Branch: `feat/m90d-brokers-that-cannot-start`. `main` is protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.
>
> **Plan base.** Written against the tree at the tip of `feat/m90b-health-truth-bounded` (PR #249),
> not `origin/main`. M90b changed `service-bus-broker.ts` (X28-5 `isHealthy`, X28-6 retry options),
> and X28-4 below touches the same delivery path, so every `service-bus-broker.ts:NN` citation is
> post-M90b. Rebase on `main` once #249 merges and re-check the four citations in §1 marked
> **(post-M90b)**.

## 0. Objective & scope

Two of the seven shipped transports cannot start. `nats` and `kafka` shipped in M14b, were never
driven by any exercise, and both **fail during `register()` with an uncaught rejection**
(`plugin/messaging-plugin.ts:362` awaits `broker.connect()` inside the startup hook), so an
application configured with one of them never binds a socket. That is a broken capability rather
than a degraded one, which is why the ROADMAP puts this letter first among the five High-carrying
ones. The two causes are unrelated and both are one-line-shaped; what is not one-line-shaped is
**why no gate caught them**, and closing that is the larger half of this milestone: every existing
NATS and Kafka test injects a fake client, and both fakes accept what the real dependency rejects —
the contract-violating-double root cause the register already names three times (M37b ioredis, M53
`zrangebyscore`, M55 `read()` EOF). X28-3 (both NATS failures are bare platform errors) and X28-4
(both **cloud** brokers drop the `messageId`/`timestamp` their platforms supply) ride with them,
because all four are one question: does an adapter read what its transport actually says.

- **In scope:** X28-1 (Kafka producer event names), X28-2 (NATS catch-all stream refused), X28-3
  (named errors for both NATS prerequisite failures), X28-4 (`messageId`/`timestamp` on the Pub/Sub
  and Service Bus delivery paths), the two guarded real-backend suites that make X28-1 and X28-2
  regressions visible, the CI wiring those suites need, and the doc corrections C1–C4 below.
- **NOT this milestone:** X28-5 and X28-6 — **M90b** (shipped; see the plan base note). X28-7 (the
  Service Bus receiver's causeless `AggregateError`) — **M90j**, which owns operator diagnostics as
  one rule across three packages. X28-8 (the first publish after an outage is lost) — deliberately
  ungrouped in the ROADMAP register and not folded in here. Kafka RPC's own behaviour. It is
  implemented — `KafkaBroker.request` delegates to the shared `RequestReplyCore`
  (`kafka-broker.ts:479-481`) over M14d's `openInbox` seam — and this milestone only makes it
  reachable by fixing startup. **X28's note that Kafka's "documented `MessagingNotSupportedError`
  refusal could not be observed" is stale**: it reads the pre-M14d README, and M14d deprecated that
  error rather than leaving Kafka refusing. Pub/Sub RPC, recorded in X28 as **unrun** rather than
  broken.

## 1. Contracts verified from SOURCE (not names)

| Reference                                    | Source (file:line)                                                                          | Verified surface / fact                                                                                                                                                                                                                                                                    |
| -------------------------------------------- | ------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| the failure site                             | `messaging-plugin/src/plugin/messaging-plugin.ts:362`                                       | `await broker.connect();` inside the plugin's startup path. A rejection here is not caught anywhere in the plugin, so it surfaces as the kernel's uncaught startup rejection. Confirms "never binds a socket".                                                                             |
| Kafka's wrong event names                    | `messaging-plugin/src/brokers/kafka-broker.ts:146-147`                                      | `attachFaultListener: (onFault) => this.#attachProducerEvent('DISCONNECT', onFault)` and `…('CONNECT', …)` — the **keys** of kafkajs's `producer.events`, passed where the **values** are required.                                                                                        |
| what the string reaches                      | `messaging-plugin/src/brokers/kafka-broker.ts:287-297`                                      | `#attachProducerEvent(event: string, …)` guards `typeof producer.on !== 'function'` and returns a no-op disposer, then calls `producer.on(event, listener)` with the bare string. kafkajs validates the name and throws `KafkaJSNonRetriableError`.                                        |
| the facade the guard leans on                | `messaging-plugin/src/interfaces/index.ts:163-171`                                          | `IKafkaEventEmitter` declares only `on(event: string, listener)`. **`event` is an unconstrained `string`**, so no wrong name is a compile error, and the facade exposes no `events` map to read the correct value from.                                                                    |
| kafkajs's accepted names                     | `smoke/X28-FINDINGS.md` (X28-1), probed against real kafkajs 2.x                            | `producer.events = {"CONNECT":"producer.connect","DISCONNECT":"producer.disconnect", …}`; `on("CONNECT")` **threw**, `on("producer.connect")` was **accepted**. Probed, not read off the error text.                                                                                       |
| NATS stream creation                         | `messaging-plugin/src/brokers/nats-broker.ts:215-231`                                       | `streams.info(streamName)` inside a `try`; the `catch` creates only when `e.message.includes('stream not found')`, with `subjects: ['>']` and no other field. Any other failure is rethrown **bare**.                                                                                      |
| what NATS refuses                            | `smoke/X28-FINDINGS.md` (X28-2), probed against a real server                               | `subjects:['>']` → `REFUSED: capturing all subjects requires no-ack to be true`; `subjects:['>'] + no_ack` → `CREATED`. The remedy was confirmed in the same run, not inferred.                                                                                                            |
| the JetStream probe is outside the `try`     | `messaging-plugin/src/brokers/nats-broker.ts:206-207`                                       | `const jsm = await realConn.jetstreamManager();` sits **before** the `try`, so a server without JetStream rejects with NATS's raw `503` (`NO_RESPONDERS` for `$JS.API`) and nothing names the cause.                                                                                       |
| the publish is not awaited                   | `messaging-plugin/src/brokers/nats-broker.ts:368-382`                                       | `realJs` is typed `publish(subject, data, options?): void` and the call is **not awaited**; `publishWithHeaders` returns `Promise.resolve()`. The real `js.publish` returns `Promise<PubAck>`, so the broker discards a promise it never observes.                                         |
| **what `no_ack: true` does to that promise** | probed against a real `nats:2-alpine -js`, 2026-09-07                                       | `no_ack=true` → the message **is stored** and `js.publish()` **REJECTS with `TIMEOUT`**; `no_ack=false` → resolves, stored. Since the broker never awaits, `no_ack: true` makes **every publish an unhandled rejection** ~5 s later. This reverses §3.2's first design (see the decision). |
| topic → subject is verbatim                  | `messaging-plugin/src/brokers/nats-broker.ts:374,381,421`                                   | `realJs.publish(topic, …)` and `filter_subject: topic` — the caller's topic **is** the subject, with no prefix anywhere. So the stream's declared subjects and the topic namespace are coupled (§3.2).                                                                                     |
| `NatsOptions`                                | `messaging-plugin/src/interfaces/index.ts:628-641`                                          | `url`, `client`, `headersFactory`, `streamName`, `defaultQueue`, `logger`. **No subject option** — barrel-exported, so an addition is public API.                                                                                                                                          |
| Pub/Sub's delivered message shape            | `messaging-plugin/src/brokers/pubsub-broker.ts:88-98`                                       | `IPubSubTransport.open`'s `onMessage` receives `{ payload, ack, nack, attributes? }`. **No id, no timestamp** — so the broker could not read them even if it wanted to; the port is the constraint, not the broker.                                                                        |
| Pub/Sub metadata construction                | `messaging-plugin/src/brokers/pubsub-broker.ts:463-466`                                     | `const metadata: MessageMetadata = { topic, headers: msg.attributes ?? {} };` — exactly two members.                                                                                                                                                                                       |
| Service Bus delivered shape **(post-M90b)**  | `messaging-plugin/src/brokers/service-bus-broker.ts:145-157`                                | `IServiceBusTransport.open`'s `onMessage` receives `{ payload, ack, nack, applicationProperties? }`. Same gap as Pub/Sub, same cause.                                                                                                                                                      |
| Service Bus metadata **(post-M90b)**         | `messaging-plugin/src/brokers/service-bus-broker.ts:701-704`                                | `{ topic, headers: msg.applicationProperties ?? {} }`.                                                                                                                                                                                                                                     |
| both ports are public API                    | `messaging-plugin/src/index.ts:99,107`                                                      | `IPubSubTransport` and `IServiceBusTransport` are barrel-exported, so widening them needs `PUBLIC_API.md` in the same PR and the added members must be **optional** to stay source-compatible for an out-of-repo transport.                                                                |
| `MessageMetadata`                            | `common/src/services/messaging.ts:14-26`                                                    | `topic` required; `messageId?: string`, `timestamp?: Date`, `headers?` optional. **So X28-4 needs no `common` change** — the contract already carries both members and the adapters simply never populate them.                                                                            |
| the error family to extend                   | `messaging-plugin/src/errors.ts:15,29,55,73,90,116`                                         | `RequestTimeoutError`, `RemoteHandlerError`, `MessagingNotSupportedError`, `CloudBrokerUnavailableError`, `ReplyInboxUnavailableError`, `ChainGateTimeoutError` — all `extends Error`, all exported for consumer `instanceof`.                                                             |
| the guarded real-import precedent            | `messaging-plugin/test/unit/nats-real-import.test.ts:20-45`                                 | `try { await import('npm:nats@2.x') } catch { console.warn('SKIP: …'); return; }` then assertions against the real module. The shape a real-dependency check takes in this package.                                                                                                        |
| the package's net grant                      | `messaging-plugin/deno.json` `test.permissions.net`                                         | `6379`, `5672`, `5673`, `8085` only. **Neither 4222 nor 9092 is granted**, so a guarded NATS/Kafka suite cannot open a socket until this list grows (M53: a CLI `--allow-net` _replaces_ this block rather than unioning with it).                                                         |
| the guarded-suite env convention             | `messaging-plugin/test/integration/outage-real.test.ts:93,157,209`                          | `Deno.env.get('RABBITMQ_URL')` / `('REDIS_URL')` — the guard reads an endpoint variable and the CI job supplies it.                                                                                                                                                                        |
| the CI service-container precedent           | `.github/workflows/ci.yml:42-121`                                                           | `mongo`, `redis`, `elasticmq`, `rabbitmq`, `minio`, `mailpit` — each with an image pin and a `--health-cmd`. Several carry a comment recording that the naive probe could not work.                                                                                                        |
| a service block cannot set a command         | `.github/workflows/ci.yml` Bigtable step comment (M82) and `test/apps-gate.test.ts:180-182` | "the Google Cloud CLI image's default command is a shell and a service block has no way to set one, because `options` reaches `docker create` BEFORE the image while the command comes after it." This is why §3.5 uses **steps**.                                                         |
| the CI-wiring pin                            | `test/apps-gate.test.ts:247-320`                                                            | Image, port mapping, env var and scoped `net` grant are each asserted, so a later edit cannot turn a proof into a silent skip. The shape the new suites' pins must take.                                                                                                                   |
| §2.2 dependency direction                    | `AI_GUIDELINES.md` §2.2                                                                     | No plugin imports another. Everything here is inside `messaging-plugin`, so no cross-package channel is needed and no capability token changes.                                                                                                                                            |
| §10.2 / §16.1 approval                       | `AI_GUIDELINES.md` §10.2, §16.1                                                             | A published-surface addition (`NatsOptions.streamSubjects`, two error classes, two port widenings) requires a `PUBLIC_API.md` edit in the same PR.                                                                                                                                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                          | Resolution (picked side)                                                                                                                                                                                                                        | Doc deliverable (same PR)                                                                                                                                                            |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | `interfaces/index.ts:165-167` documents `IKafkaEventEmitter` as emitting "`CONNECT`, `DISCONNECT`, and `CRASH` (consumer) events", and `kafka-broker.ts:249-251` repeats it. Those are the **keys** of `producer.events`, and passing them is exactly the defect. | The JSDoc is wrong, not the accepted-name list. kafkajs accepts the **values** (`producer.connect`, `producer.disconnect`, `consumer.crash`), probed in X28-1. The doc is what made the defect read as correct to every reviewer.               | Both JSDoc blocks corrected to name the wire values and to say the keys are not accepted; `PUBLIC_API.md`'s `IKafkaEventEmitter` entry gains the same statement.                     |
| C2 | The README (`:132`) lists `'nats'` as "NATS JetStream client" and `PUBLIC_API.md:4060` documents `streamName` as a "JetStream stream name", so the **requirement** is stated — while nothing states the **failure**, which is a raw `NatsError: 503`.             | Keep the requirement where it is and add the failure beside it. X28-3 is explicit that the gap is the connection between the two, not the requirement's absence.                                                                                | README NATS section and `PUBLIC_API.md` NATS block gain: JetStream must be enabled (`-js`), what is thrown when it is not (`JetStreamUnavailableError`), and the `-js` flag by name. |
| C3 | The README broker table (`:132-133`) presents `'nats'` and `'kafka'` as supported transports with no caveat, while both are non-functional against a real backend on `0.4.0`.                                                                                     | The table becomes true by the code changing, not by the table changing — but the table must also say which transports are now covered by a real-backend suite, because "supported" meant "shipped" for these two and that is what let them rot. | README broker table gains a "driven against a real backend in CI" column, filled honestly for all seven rows.                                                                        |
| C4 | The README metadata paragraph (`:187`) describes header behaviour per broker and says nothing about `messageId`/`timestamp`, so a consumer reading `metadata.messageId` for de-duplication cannot learn which brokers supply it.                                  | State it per broker rather than leaving "absent means cannot" ambiguous — the same ambiguity X28-4 names and the same one M70k had to invent `IWorkerHost.reportsExit?` to resolve.                                                             | README gains a per-broker `messageId`/`timestamp` row; `PUBLIC_API.md` messaging section states that all seven first-party brokers populate both after this milestone.               |

## 3. Design decisions

### 3.1 Kafka: pass the wire values as named constants, and let a wrong name stay loud

- **Decision:** replace `'DISCONNECT'`/`'CONNECT'` with two module-level constants,
  `KAFKA_PRODUCER_DISCONNECT = 'producer.disconnect'` and
  `KAFKA_PRODUCER_CONNECT =
  'producer.connect'`, passed to `#attachProducerEvent`.
  `IKafkaEventEmitter` is **not** widened with an `events` map, and `#attachProducerEvent` gains
  **no** `try`/`catch`.
- **Why:** reading `producer.events.DISCONNECT` at runtime with a `?? 'producer.disconnect'`
  fallback is the tempting alternative and it is worse here — it adds a branch that every injected
  fake takes, which is the exact shape that hid this defect for four releases. A literal plus a
  guarded real-import assertion that `producer.events.DISCONNECT === 'producer.disconnect'` moves
  the check to a place a fake cannot satisfy. And no `catch`: kafkajs rejecting a name must keep
  failing loudly, since a swallowed rejection would convert this defect from "cannot start" into
  "starts and never reports a fault", which is strictly harder to find.
- **Test home:** `test/unit/kafka-broker.test.ts` (the constant reaches `on` — asserted with a fake
  that **records** the name rather than accepting any string) and
  `test/unit/kafka-real-import.test.ts` (the constant equals the real `producer.events` value).

### 3.2 NATS: create the stream only from an explicit `streamSubjects`, and never send `no_ack`

- **Decision:** `NatsOptions.streamSubjects?: readonly string[]` has **no default**. When it is
  supplied and `streams.info` reports the stream absent, `streams.add` sends `{ name, subjects }`
  verbatim and **never** `no_ack`. When it is absent and the stream does not exist, `connect()`
  throws `JetStreamStreamError` naming the stream and both remedies — create the stream out of band,
  or supply `streamSubjects`. An existing stream is untouched in both cases.
- **Why:** **the obvious fix is measured to be worse than the bug, which is why this decision
  reversed.** X28-2's own probe shows `subjects: ['>']` refused and `subjects: ['>'] + no_ack: true`
  accepted, and an earlier draft of this plan took that as the remedy on the reasoning that the
  broker discards the PubAck anyway. Probed against a real `nats:2-alpine -js`: with `no_ack: true`
  the message IS stored and `js.publish()` **rejects with `TIMEOUT`**, because the server is
  configured never to answer. `nats-broker.ts:374,381` does not await that promise, so every publish
  would raise an **unhandled rejection** about five seconds later — fatal on Deno and on Node since
  v15. So the catch-all is unusable in BOTH forms: refused without `no_ack`, and crash-producing
  with it. Requiring an explicit subject set is the only shape that both creates a stream and leaves
  publishing intact, and it costs no existing deployment anything, because creation has never
  succeeded (X28-2) — every working NATS installation already declares its stream out of band. It
  also drops the catch-all's real hazard, which X28-2 names: `'>'` ingests every subject on the
  server, including other applications'.
- **Test home:** `test/unit/nats-broker.test.ts` (a supplied `streamSubjects` sends exactly those
  subjects and no `no_ack` key; an absent one with an absent stream throws `JetStreamStreamError`
  naming both remedies; an absent one with an EXISTING stream connects normally) and
  `test/integration/nats-real.test.ts` (a real server accepts what is sent, and a publish through
  the created stream **resolves** rather than rejecting — the assertion that would have caught the
  reversed design).

### 3.3 NATS: two named errors, one per prerequisite failure

- **Decision:** export `JetStreamUnavailableError` and `JetStreamStreamError` from `src/errors.ts`.
  `connect()` wraps the `jetstreamManager()` call in a `try` and rethrows the first when it rejects;
  the stream branch rethrows the second when `streams.add` rejects, and when `streams.info` rejects
  with anything other than `stream not found`. Both carry the platform error as `cause`.
- **Why:** this is the guard-family shape the project has already fixed three times — M52c (D1),
  M52d (Durable Objects), M70k (queue bindings) — and
  `cloudflare-plugin/src/bindings/facades.ts:421-423` states the principle in as many words: fail
  with a name rather than at the first request with a bare platform error. Two classes rather than
  one with a `reason` discriminant, because a discriminant field would have no reader outside its
  own test (the dead-surface rule) while two classes each get read by an application's `catch`. The
  `cause` chain is what keeps the platform's own text — the `503`, the `no-ack` sentence — reachable
  rather than replaced.
- **Test home:** `test/unit/nats-broker.test.ts` — an injected connection whose `jetstreamManager`
  rejects, and one whose `streams.add` rejects, each asserted for the class, the named remedy, and
  `cause` identity.

### 3.4 Cloud metadata: widen the two transport ports, read in the real adapters, omit when absent

- **Decision:** `IPubSubTransport.open`'s and `IServiceBusTransport.open`'s `onMessage` message
  shape each gain `messageId?: string` and `timestamp?: Date`. The real adapters populate them from
  `message.id`/`message.publishTime` and `message.messageId`/`message.enqueuedTimeUtc`; the brokers
  copy each onto `MessageMetadata` **only when present**, never assigning `undefined`.
- **Why:** the broker is not the constraint — the port is (`pubsub-broker.ts:88-98`,
  `service-bus-broker.ts:145-157` carry neither field), so "read the field" is a port widening and
  has to be planned as one. Optional members keep an out-of-repo transport source-compatible (the
  M42 `signal?` / M44 `fs?` precedent), and the port normalises to `Date` so each SDK's own spelling
  stops at the adapter. Omitting rather than assigning `undefined` is required by
  `exactOptionalPropertyTypes` and is also the honest signal: after this milestone an absent
  `metadata.messageId` means the transport carried none, which is the ambiguity X28-4 exists to
  remove. Nothing is added on the **publish** side: both platforms assign the id themselves, so
  minting one here would be a second identity competing with the real one.
- **Test home:** `test/unit/pubsub-broker.test.ts` and `test/unit/service-bus-broker.test.ts` (a
  transport supplying both, and one supplying neither — the second asserting **absence** with
  `'messageId' in metadata`, which is the only check that separates absent from `undefined`);
  `test/unit/pubsub-adapter.test.ts` and `test/unit/service-bus-adapter.test.ts` (the real adapters
  map the SDK's own field names); `test/e2e/pubsub-emulator.test.ts` and
  `test/e2e/service-bus-emulator.test.ts` (the emulators supply real values).

### 3.5 Both real backends run as CI **steps**, not service containers

- **Decision:** `.github/workflows/ci.yml` starts NATS and Kafka with `docker run` steps in the
  backend job, exports `NATS_URL` and `KAFKA_BROKERS`, and waits for each to answer before the suite
  runs. Neither becomes a `services:` entry.
- **Why:** a service block cannot set a command — `options` reaches `docker create` before the image
  while the command comes after it, which is exactly why M82's Bigtable emulator is a step — and
  JetStream is enabled by the `-js` **flag** on `nats-server`, with no environment equivalent in the
  official image. Kafka's KRaft single-node mode needs both a controlled startup and a readiness
  check that means more than an open port, and a step is where that can be written. The image pins,
  the port mappings, the two environment variables and the two new `net` grants are all asserted in
  `test/apps-gate.test.ts`, per the M53 rule that a guarded suite with no assertion that it ran is a
  silent skip waiting to happen.
- **Test home:** `test/apps-gate.test.ts` — new cases pinning both images, both port mappings, both
  env vars, and the `4222`/`9092` entries in `messaging-plugin/deno.json`.

### 3.6 Neither guarded suite may pass by skipping

- **Decision:** `nats-real.test.ts` and `kafka-real.test.ts` guard with `ignore:` on the missing
  endpoint variable rather than an early `return`, and `test/apps-gate.test.ts` asserts that CI
  supplies both variables. Neither app nor suite is added to any skip allowlist.
- **Why:** M70c's own trap — a suite that early-`return`s reports **passed** while asserting
  nothing, so the run is green whether the fix is present or not. `ignore:` reports an ignored test,
  which is visible in the count, and the apps-gate pin is what makes dropping the variable from the
  workflow a failure rather than a quieter green.
- **Test home:** `test/apps-gate.test.ts`.

### 3.7 What each guarded suite must actually prove

- **Decision:** `kafka-real.test.ts` boots a `MessagingPlugin({ broker: 'kafka' })` application
  against a real broker through `createApplication` and asserts `start()` **resolves** — plus one
  publish/subscribe round trip. `nats-real.test.ts` does the same against a server whose stream does
  **not** yet exist, and asserts the stream is created; a second case points at a stream name that
  already exists and asserts the `info` path is taken.
- **Why:** the unit-level assertion (the right string reaches `on`) proves the constant and not the
  claim. The claim is "an application configured with this broker binds a socket", and only a real
  backend can answer it. The absent-stream precondition is load-bearing for NATS: X28-2 records that
  `streams.add` is reached **only** from the `catch`, so a suite reusing a warm server exercises
  nothing — which is precisely how this survived.
- **Test home:** the two new integration suites.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                | Kind      | Consumer / real code path that READS it                                                                                                                             |
| ---------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `JetStreamUnavailableError`                    | class     | Thrown by `NatsBroker.connect` when `jetstreamManager()` rejects; read by an application's `catch`/`instanceof` around `app.start()`, and by `nats-broker.test.ts`. |
| `JetStreamStreamError`                         | class     | Thrown by `NatsBroker.connect` when `streams.add` rejects, and when `streams.info` rejects for a reason other than absence; same consumers.                         |
| `IPubSubTransport` (widened)                   | interface | Read by `GcpPubSubBroker.subscribe` when building `MessageMetadata`; implemented by `adaptPubSubModule` and by any application-supplied transport.                  |
| `IServiceBusTransport` (widened)               | interface | Read by `ServiceBusBroker.subscribe` when building `MessageMetadata`; implemented by `adaptServiceBusModule` and by any application-supplied transport.             |
| `NatsOptions` (widened with `streamSubjects?`) | interface | Read by `NatsBroker.connect`'s stream-creation branch.                                                                                                              |

**No new capability token, no `common` change, and no other barrel change.** `MessageMetadata`
already declares `messageId?` and `timestamp?` (`common/src/services/messaging.ts:18,20`), so X28-4
is an implementation gap and not a contract gap. A `test/unit/barrel-exports.test.ts` case pins the
two added error classes and pins that nothing else joined the surface — the M56 defect class, where
dropping a barrel export left eighteen other tests green.

### 4.1 Options — every option names its consumer

| Option                       | Consumer                                    | Behavior (per implementation)                                                                                                                                                                                       |
| ---------------------------- | ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NatsOptions.streamSubjects` | `NatsBroker.connect` stream-creation branch | Supplied → `streams.add({ name, subjects })` verbatim, no `no_ack`. Absent + stream exists → connects, creates nothing. Absent + stream absent → `JetStreamStreamError` naming the stream and both remedies (§3.2). |
| `NATS_URL` (CI env)          | `test/integration/nats-real.test.ts` guard  | Absent → the suite is `ignore:`d and reported as ignored. Present → the suite runs against that server.                                                                                                             |
| `KAFKA_BROKERS` (CI env)     | `test/integration/kafka-real.test.ts` guard | Same shape.                                                                                                                                                                                                         |

## 5. Implementation files

| File                                         | Purpose                                                                                                                                                  |
| -------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/brokers/kafka-broker.ts`                | Two wire-value constants; `#attachProducerEvent` call sites use them; the reachability JSDoc corrected (C1).                                             |
| `src/brokers/nats-broker.ts`                 | `streamSubjects` resolution; the catch-all default removed; the JetStream probe moved inside a `try`; both named errors thrown with `cause`.             |
| `src/errors.ts`                              | `JetStreamUnavailableError`, `JetStreamStreamError`.                                                                                                     |
| `src/interfaces/index.ts`                    | `NatsOptions.streamSubjects?`; `IKafkaEventEmitter` JSDoc corrected (C1).                                                                                |
| `src/brokers/pubsub-broker.ts`               | `IPubSubTransport.open` message shape widened; adapter reads `message.id`/`message.publishTime`; broker copies both onto `MessageMetadata` when present. |
| `src/brokers/service-bus-broker.ts`          | Same for `messageId`/`enqueuedTimeUtc`.                                                                                                                  |
| `src/index.ts`                               | Exports the two error classes.                                                                                                                           |
| `deno.json`                                  | `test.permissions.net` gains `127.0.0.1:4222`, `localhost:4222`, `127.0.0.1:9092`, `localhost:9092`.                                                     |
| `.github/workflows/ci.yml`                   | NATS and Kafka startup steps, readiness waits, `NATS_URL` and `KAFKA_BROKERS` on the backend job.                                                        |
| `README.md`, `PUBLIC_API.md`, `CHANGELOG.md` | C1–C4, the option and error rows, and the entries for the two behaviour fixes.                                                                           |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                | src covered                     | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| -------------------------------------------------------- | ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/kafka-broker.test.ts` (extended)              | `brokers/kafka-broker.ts`       | The fake producer **records** every `on(event, …)` name; after `connect()` the recorded set is exactly `['producer.disconnect','producer.connect']`. Uses the existing `fake-kafkajs-client.ts`, corrected to record rather than accept-any.                                                                                                                                                                                                                                                                                           |
| `test/unit/kafka-real-import.test.ts` (new)              | `brokers/kafka-broker.ts`       | Guarded `await import('npm:kafkajs@2.x')`; asserts `producer.events.DISCONNECT === 'producer.disconnect'` and `.CONNECT === 'producer.connect'`, and that a real producer accepts both. The `nats-real-import.test.ts` shape.                                                                                                                                                                                                                                                                                                          |
| `test/unit/nats-broker.test.ts` (extended)               | `brokers/nats-broker.ts`        | A supplied `streamSubjects` sends exactly those subjects and **no `no_ack` key**; an absent one with an absent stream throws `JetStreamStreamError` naming both remedies; an absent one with an existing stream connects and creates nothing; a rejecting `jetstreamManager` throws `JetStreamUnavailableError` with `cause`; a rejecting `streams.add` throws `JetStreamStreamError`; a `streams.info` rejection that is not "stream not found" throws `JetStreamStreamError` rather than the bare platform error.                    |
| `test/integration/nats-real.test.ts` (new)               | `brokers/nats-broker.ts`        | Guarded on `NATS_URL`. Against a server where the stream is **absent**: `app.start()` resolves and the stream exists afterwards. Against a pre-existing stream: `start()` resolves and no `add` is issued. One publish/subscribe round trip.                                                                                                                                                                                                                                                                                           |
| `test/integration/kafka-real.test.ts` (new)              | `brokers/kafka-broker.ts`       | Guarded on `KAFKA_BROKERS`. `createApplication` + `MessagingPlugin({ broker: 'kafka' })`; `app.start()` **resolves** (the X28-1 regression guard); one publish/subscribe round trip; and — against a pre-created `messaging.replies` topic, which Kafka requires — one `request`/`respond` round trip, which M14d implemented and which no exercise has ever reached because the broker could not boot. It must NOT assert `MessagingNotSupportedError`: M14d deprecated that refusal and `request()` delegates to `RequestReplyCore`. |
| `test/unit/pubsub-broker.test.ts` (extended)             | `brokers/pubsub-broker.ts`      | A transport supplying `messageId`/`timestamp` yields both on `MessageMetadata`; one supplying neither yields a metadata object where `'messageId' in metadata` is `false`.                                                                                                                                                                                                                                                                                                                                                             |
| `test/unit/pubsub-adapter.test.ts` (extended)            | `brokers/pubsub-broker.ts`      | The real adapter maps `message.id` → `messageId` and `message.publishTime` → `timestamp` as a `Date`, against a fake SDK module carrying the SDK's own field names.                                                                                                                                                                                                                                                                                                                                                                    |
| `test/unit/service-bus-broker.test.ts` (extended)        | `brokers/service-bus-broker.ts` | Same two cases as the Pub/Sub broker.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `test/unit/service-bus-adapter.test.ts` (extended)       | `brokers/service-bus-broker.ts` | Maps `messageId` and `enqueuedTimeUtc`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `test/e2e/pubsub-emulator.test.ts` (extended)            | `brokers/pubsub-broker.ts`      | The real emulator supplies both, so `metaKeys` matches the four-member set the three working brokers report in X28.                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `test/e2e/service-bus-emulator.test.ts` (extended)       | `brokers/service-bus-broker.ts` | Same.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `test/unit/barrel-exports.test.ts` (extended)            | `src/index.ts`                  | The two error classes are exported; the surface gained nothing else.                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/integration/header-conformance.test.ts` (extended) | all seven brokers               | The existing one-table-over-seven-brokers suite gains `messageId`/`timestamp` columns, so a broker that stops populating them fails here rather than in one broker's own file.                                                                                                                                                                                                                                                                                                                                                         |
| `test/apps-gate.test.ts` (extended, repo root)           | CI wiring                       | Both image pins, both port mappings, `NATS_URL` and `KAFKA_BROKERS` present on the job, and the four new `net` entries in `messaging-plugin/deno.json`.                                                                                                                                                                                                                                                                                                                                                                                |

**Fixture corrections are deliverables, not incidental.** `fake-kafkajs-client.ts` accepts any
string for `on`, and `fake-nats-client.ts` accepts any stream config — those two doubles are the
reason both defects shipped. Each is corrected to reject what the real dependency rejects, and the
correction is verified to fail the pre-fix code.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m90d-brokers-that-cannot-start, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.4.0
```

Plus, run locally against real backends before hand-off, with the endpoints exported:

```bash
docker run -d --name he-nats -p 4222:4222 nats:2-alpine -js
docker run -d --name he-kafka -p 9092:9092 apache/kafka:4.0.0
NATS_URL=nats://127.0.0.1:4222 KAFKA_BROKERS=127.0.0.1:9092 deno task test
```

The ignored-test count is the proof the guards ran: a run with the variables unset and a run with
them set must report different counts, and both must be green.

## 8. Risks & mitigations

- **Kafka's KRaft single-node startup in CI is the least certain piece of this milestone.** The
  `apache/kafka` image needs a controlled listener/controller configuration and a readiness check
  that means more than an open port, and getting it wrong produces a hang rather than a failure.
  Mitigation: it is a step (§3.5), so the readiness wait is ours to write; the step gets an explicit
  timeout and prints the container log on expiry, following the ElasticMQ and DynamoDB comments in
  `ci.yml` that record what their naive probe could not do.
- **The stream-creation design was already reversed once by measurement**, so the remaining risk is
  a second unmeasured assumption. Mitigation: `nats-real.test.ts` publishes and consumes against a
  real server on a freshly created stream AND asserts the publish promise **resolves**, so a
  regression in delivery — not just in creation — is what the suite measures. That assertion exists
  because its absence is what let the `no_ack` design look correct: the stream was created, the
  message was stored, and only the discarded promise carried the failure.
- **Widening two barrel-exported ports is a source-compatible change for implementors only while the
  members stay optional.** Mitigation: a type-level case in `header-conformance.test.ts` constructs
  a transport that omits both and asserts it is still assignable, so a later change to required
  fails at `deno check` rather than in a consumer's project.
- **The two new suites raise CI time and add two more backends that can flake.** Mitigation: both
  are small (a boot plus one round trip), and neither is added to a skip allowlist, so a flake is
  visible rather than absorbed.
- **Correcting the two fakes may drop coverage on branches they used to reach vacuously.**
  Mitigation: read the per-file table after the fixture change, not only after the source change —
  the M55 lesson that a fixture edit can move an unrelated file below the bar.

## 9. Out of scope

- **X28-5 / X28-6** (Service Bus health and its 90-second publish) — **M90b**, shipped.
- **X28-7** (the receiver's causeless `AggregateError`) — **M90j**, which fixes the seven
  cause-dropping sites and the `SerializedError` allowlist as one rule.
- **X28-8** (the first publish after an outage is lost) — deliberately ungrouped in the ROADMAP
  register; correct behaviour sits one retry away and it is a single instance rather than a shape.
- **Pub/Sub RPC**, recorded in X28 as unrun rather than broken, and the bare `5 NOT_FOUND` that
  names no topic — worth a row when someone establishes whether the framework or the provisioning is
  at fault.
- **A `subjectPrefix` that scopes published subjects** as well as the stream — that is a wire change
  for every existing NATS deployment, and §3.2 takes the non-breaking half deliberately.
- **The `custom` broker arm**, at-least-once redelivery and dead-lettering per transport, and
  `SnsPublisher` fan-out into SQS — the X28 "Still to run" tail, which is exercise work rather than
  a defect.
