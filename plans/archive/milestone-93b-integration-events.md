# Milestone 93b — Messaging (`@setu-ts/messaging-plugin`)

> **Status:** Planning. Branch: `feat/m93b-integration-events`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A cross-service event is currently an untyped topic string plus an ad-hoc payload:
`broker.publish('orders.created', payload)` cannot state the event's schema version, its identity,
its causal chain, or its aggregate version, and the consumer receives `unknown` and narrows it by
hand at every boundary. This milestone adds the semantic layer that sits **on top of** the transport
the plugin already ships — a declarable integration-event contract, a wire envelope that carries the
identity and causality fields, a publisher, and a subscription helper that structurally validates
and parses before the application handler ever runs. It changes no `IMessageBroker` method, adds no
capability token, and requires no broker adapter to be rewritten; every one of the eight broker arms
gets it for free because the envelope is **payload data**, not transport headers.

- **In scope:** `defineIntegrationEvent`, the `IntegrationEventEnvelope` wire shape,
  `publishIntegrationEvent`, `onIntegrationEvent` (producing the existing `SubscriptionDefinition`),
  `causedBy` for correlation propagation, one exported rejection error, the versioned-topic rollout
  policy made mechanical, and the doc deliverables in §2.
- **NOT this milestone:**
  - Aggregate-local domain-event recording — **M93a** (`@setu-ts/events-plugin`). **M93a merged
    first (PR #285) and this milestone still imports nothing from it** (verified:
    `grep -rn events-plugin
    packages/messaging-plugin/` finds it only in an existing README
    fence, never in `src/`; `IDomainEvents`/`createDomainEvents` do not exist in `packages/` yet;
    and even the existing `EventsMessagingBridge` takes `IDomainEvent`/`IEventBus` from
    `@setu-ts/common`, not from that package — `events-messaging-bridge.ts:3`). The one file this
    milestone touches in `events-plugin` is a comment (C1); see the merge-order risk in §8.
  - Transactional outbox, consumer inbox, de-duplication by event ID, replay, retention — the
    **deferred reliability milestone** named at the end of the ROADMAP's M93 section.
  - Any change to `EventsMessagingBridge`, which is kept exactly as it is.
  - Any dependency on `@setu-ts/events-plugin` (§2.2 forbids it and nothing here needs it).

## 1. Contracts verified from SOURCE (not names)

| Reference                             | Source (file:line)                                                   | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IMessageBroker`                      | `packages/common/src/services/messaging.ts:101-185`                  | `connect`, `disconnect`, `publish<T>(topic, message)`, `subscribe<T>(topic, handler, options?)`, `request`, `respond`, optional `isHealthy?`. `publish` takes a free `T`; nothing constrains the payload shape. **Unchanged by this milestone.**                                                                                                                                                                                                                                                                                                                                                                               |
| `MessageHandler<T = unknown>`         | `packages/common/src/services/messaging.ts:36-39`                    | `(message: T, metadata: MessageMetadata) => void \| Promise<void>`. Default `T` is `unknown`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `MessageMetadata`                     | `packages/common/src/services/messaging.ts:14-26`                    | `topic`, optional `messageId`, optional `timestamp: Date`, optional `headers`. No application-level identity field of any kind — which is the gap this milestone fills in the payload.                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `SubscribeOptions`                    | `packages/common/src/services/messaging.ts:46-49`                    | `{ queue?: string }` only.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `SubscriptionDefinition`              | `packages/messaging-plugin/src/interfaces/index.ts:329-336`          | `{ topic: string; handler: MessageHandler; options?: SubscribeOptions }`. `handler` is **non-generic** — `MessageHandler<unknown>` — so the helper's wrapper `(raw: unknown, metadata) => …` is assignable with no cast.                                                                                                                                                                                                                                                                                                                                                                                                       |
| `SubscriptionEntry`                   | `packages/messaging-plugin/src/interfaces/index.ts:345-347`          | `SubscriptionDefinition \| RegistryFactory<SubscriptionDefinition>`. The factory arm already exists, so a handler needing a resolved capability needs no new surface here (see §3.7).                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Declarative subscription registration | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:507-512`   | `subscribeDefinition` calls `broker.subscribe(definition.topic, definition.handler, definition.options)` on the **already-wrapped** broker. A definition produced by `onIntegrationEvent` therefore plugs straight in.                                                                                                                                                                                                                                                                                                                                                                                                         |
| `IRuntimeServices.uuid` / `.now`      | `packages/common/src/runtime.ts:328` / `:344`                        | `uuid(): string`, `now(): number`. These are the only runtime services the publisher needs — no timers, no crypto.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `InMemoryBroker` publish semantics    | `packages/messaging-plugin/src/brokers/in-memory-broker.ts:145-241`  | `publish` **resolves on dispatch hand-off, not handler completion**, and serializes then deserializes through `ISerializer` before delivery. A handler rejection is routed to `InMemoryBrokerOptions.onDispatchError` and **never rejects `publish`**. Load-bearing for §6: a parser-failure test cannot assert `await publish()` rejects.                                                                                                                                                                                                                                                                                     |
| `JsonSerializer`                      | `packages/messaging-plugin/src/serializers/json-serializer.ts:20,32` | `JSON.stringify` / `JSON.parse`. A `Date` does not survive the round trip as a `Date`, which is why the envelope timestamp is an ISO-8601 **string** (§3.3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `PipelinedBroker` ingress payload     | `packages/messaging-plugin/src/pipeline/pipelined-broker.ts:189`     | `payload: message as T` — the **delivered** message. For an integration-event subscription that is the raw envelope, not the parsed payload (§3.8).                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `EventsMessagingBridge` forwarding    | `packages/messaging-plugin/src/bridge/events-messaging-bridge.ts:94` | `await broker.publish(topic, event.data)` — it forwards `event.data`, confirming the ROADMAP's claim that it is a convenience bridge carrying no portable envelope. Untouched here.                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `IntegrationEvent` (events-plugin)    | `packages/events-plugin/src/events/domain-event.ts:74-81`            | An abstract class that already owns the name "integration event" in a different package. It adds **no fields** to `DomainEvent`. See C1 and §3.9.                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| README fence gate                     | `test/package-readme-fence-compiler.test.ts:57`                      | `'packages/messaging-plugin/README.md': 6` — the README is gated at **6** compilable fences. New fences compile and the count moves (§2, C3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| README exports table                  | `packages/messaging-plugin/README.md:296`                            | Generated by `deno task docs:exports`; `deno task check:docs` fails on drift.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| Barrel assertion                      | `packages/messaging-plugin/test/unit/barrel-exports.test.ts:19-`     | Asserts each value export is defined and a function. Extended, not replaced.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Plugin-owned dispatch reporter        | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:228-242`   | **`MessagingPlugin` always supplies its own `onDispatchError`**, so `InMemoryBrokerOptions.onDispatchError` is NOT reachable through `MessagingPluginOptions` (the option's own JSDoc says so at `interfaces/index.ts:313-314`). Its reporter reads the logger at call time and flattens the error to `error.message` in one string: `In-memory broker handler rejected for topic "<topic>" (messageId: <id>): <detail>`. Load-bearing for §3.5 and §6.                                                                                                                                                                        |
| `CustomMessagingOptions`              | `packages/messaging-plugin/src/interfaces/index.ts:591-594`          | `{ broker: 'custom'; instance: IMessageBroker }`. `MessageBrokerAdapter extends IMessageBroker` (`brokers/message-broker.ts:39`), so an application-constructed `InMemoryBroker` carrying its own `onDispatchError` is assignable here — the one route to a bespoke rejection sink.                                                                                                                                                                                                                                                                                                                                            |
| `IDomainEvent<T>`                     | `packages/common/src/services/events.ts:17-30`                       | `type`, `id`, `occurredOn: Date`, `data`, optional `aggregateId`, optional `version`. Read by the README's domain-to-integration example (§3.11) — from `common`, never from `events-plugin`.                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `createDomainEvents` (M93a, merged)   | `packages/events-plugin/src/events/domain-events.ts:70-93`           | `createDomainEvents(): IDomainEvents` with `record`/`pending`/`remove`/`clear`. Merged in PR #285. Used **only** in a README fence (§3.11); no `src` file in this package imports it, and `packages/messaging-plugin/README.md:269` already imports `@setu-ts/events-plugin` in a fence, so the gate resolves it.                                                                                                                                                                                                                                                                                                              |
| `createMockPlugin`                    | `packages/testing/src/mock-plugin.ts:64-72`                          | `createMockPlugin({ name, service })` registers `service` under `provides ?? name` and declares it in `provides`. `CAPABILITIES.LOGGER` is the literal `'logger'` (`common/src/tokens.ts:43`), which is what the plugin's reporter reads — so `{ name: 'logger', service: recordingLogger }` is the §6 case-(c) seam. No collision: that suite registers no `LoggerPlugin`, and §6.4 reserves `createMockPlugin` for exactly this (providing a capability the application does not register). Eight packages already import `@setu-ts/testing` in tests, `view-plugin` most recently, so this is precedented and publish-safe. |
| `@since` convention                   | `packages/kernel/src/application/application.ts:140,160`             | M91 (unreleased, ships in `0.6.0`) tags new members `@since 0.6.0` while the manifests read `0.5.0`. This milestone follows M91: **`@since 0.6.0`**.                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                 | Doc deliverable (same PR)                                                                                                                                                                                                                                                                           |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `packages/events-plugin/src/events/domain-event.ts:62` claims `IntegrationEvent`'s type identity "discriminates cross-service events for M14's messaging bridge (`instanceof IntegrationEvent`)". `grep -rn "instanceof IntegrationEvent" packages/` finds that phrase **only in this comment and in a test comment** — the bridge matches by the `eventTypes` string list (`events-messaging-bridge.ts:90-97`) and performs no `instanceof` anywhere. The claimed consumer does not exist. | The bridge's behaviour is correct; the JSDoc is wrong. Correct the comment to describe what the bridge actually does. This is a docs-must-match-behavior fix on a claim **about the messaging bridge**, which this milestone owns; it is a comment-only edit in `events-plugin` with no `src` behaviour change and no import between the packages.                       | Rewrite the `IntegrationEvent` JSDoc paragraph in `packages/events-plugin/src/events/domain-event.ts` to state that the bridge selects by configured `eventTypes` and that the class is a semantic marker with no framework reader, and point a cross-service contract at `defineIntegrationEvent`. |
| C2 | The ROADMAP's M93b signature is `defineIntegrationEvent<T>({ type, version, topic, parse })`, and its rollout policy says each version "owns a distinct topic whose name ends in `.v<version>`" — but a supplied `topic` and a supplied `version` can disagree (`topic: 'orders.placed.v1', version: 2`), leaving the policy as prose a producer can silently violate.                                                                                                                      | Keep the ROADMAP's four-field signature (a `type` is the semantic name that travels in the envelope, a `topic` is the transport destination, and collapsing them would force the wire name to equal the event name). Make the policy **mechanical** instead: `defineIntegrationEvent` refuses at definition time a `topic` that does not end with `.v${version}` (§3.2). | ROADMAP M93b "versioned-topic rollout policy" bullet gains one sentence recording that the suffix is enforced by the factory rather than documented, and names the escape (the raw `broker.publish`/`subscribe` surface is unchanged for a pre-existing unversioned topic).                         |
| C3 | `test/package-readme-fence-compiler.test.ts:57` pins the messaging README at 6 compilable fences; this milestone adds a documented producer/consumer/migration example set to that README.                                                                                                                                                                                                                                                                                                  | Add the fences, make every one of them compile, and move the pinned count to match.                                                                                                                                                                                                                                                                                      | Update the count in `test/package-readme-fence-compiler.test.ts` in the same PR (a stale count is a gate that stops discriminating).                                                                                                                                                                |
| C4 | `PUBLIC_API.md:4188` "Messaging" section documents the broker, the bridge, and the options, and has no integration-event surface at all — but §10.5 requires every `index.ts` export to appear there.                                                                                                                                                                                                                                                                                       | Add a new `### Integration event contracts` subsection under the Messaging section.                                                                                                                                                                                                                                                                                      | `PUBLIC_API.md` subsection covering all ten new exports, the envelope field table, the rejection-reason table, and the rollout policy. Plus the regenerated README exports table (`deno task docs:exports`).                                                                                        |

## 3. Design decisions

### 3.1 The layer sits beside the broker, not inside it

- **Decision:** The three helpers are **free functions** over an `IMessageBroker` reference. No
  method is added to `IMessageBroker`, no broker adapter changes, no wrapper class is introduced,
  and the plugin's `register()` is untouched.
- **Why:** `IMessageBroker` is a committed `common` contract with eight in-repo implementations and
  a documented `'custom'` arm for out-of-repo ones; adding a member would be breaking for every
  implementor to buy a convenience that composes perfectly well as a function. A decorator class
  (the `TracedBroker`/`PipelinedBroker` shape) is also wrong here: those exist because they must
  intercept _every_ message; this layer applies per event contract, chosen by the caller.
- **Test home:** `test/unit/integration/publish.test.ts` drives `publishIntegrationEvent` against a
  recording `IMessageBroker` stand-in and asserts the exact `(topic, message)` pair reaching
  `publish`; `test/integration/integration-events.test.ts` proves the same call works through the
  real `MessagingPlugin`-registered broker with no plugin option set.

### 3.2 A definition's topic must carry its own version suffix

- **Decision:** `defineIntegrationEvent({ type, version, topic, parse })` validates at call time and
  throws a plain `TypeError` when: `type` is empty, `topic` is empty, `version` is not a positive
  safe integer, `parse` is absent, or `topic` does not end with the exact string `.v${version}`. The
  refusal names the offending field and the expected suffix.
- **Why:** The rollout policy is only a policy if a producer cannot quietly violate it. A `version`
  bump with an unchanged topic is precisely the change that breaks every deployed v1 consumer, and
  it is invisible to the type checker because both fields are independently well-typed. Enforcing
  the suffix makes the two fields one fact. `version` is guarded as a positive safe integer because
  `NaN`, `0`, `1.5` and `Number.MAX_VALUE` all produce a suffix string and all compare wrongly
  afterwards — the M90a `NaN`-disables-the-check class.
- **Test home:** `test/unit/integration/definition.test.ts` — one case per refused field plus the
  accepted case, with the accepted definition's fields asserted individually.

### 3.3 The envelope is payload data with an ISO-8601 string timestamp

- **Decision:** The wire shape is
  `{ id, type, version, occurredAt, data, correlationId?, causationId?, aggregateId?, aggregateVersion? }`.
  `occurredAt` is an ISO-8601 **string** produced by `new Date(runtime.now()).toISOString()`, and
  `id` is `runtime.uuid()`. The envelope is the `message` argument to `broker.publish`; nothing is
  written to transport headers.
- **Why:** Verified from source — `JsonSerializer` (`json-serializer.ts:20,32`) round-trips through
  `JSON.parse`, so a `Date` arrives at the consumer as a string regardless of what the producer put
  in. Declaring the field a string is the honest type; a `Date`-typed field would be a lie on every
  transport. It is named `occurredAt` rather than `occurredOn` deliberately: `events-plugin`'s
  `DomainEvent.occurredOn` is a `Date` (`domain-event.ts:46`), and reusing that name for a
  differently-typed field is how a reader gets it wrong. Headers are rejected as the carrier because
  `MessageMetadata.headers` is optional on the committed contract and populated only by the brokers
  whose transport has a header channel — payload is the one channel all eight arms carry.
- **Test home:** `test/unit/integration/envelope.test.ts` asserts the exact field set and that
  `occurredAt` parses as a valid ISO-8601 instant; `test/integration/integration-events.test.ts`
  asserts the envelope observed by a plain `broker.subscribe` consumer is byte-comparable to the
  produced one after the broker's serializer round trip.

### 3.4 The publisher does not run `parse` on the outgoing payload

- **Decision:** `publishIntegrationEvent` builds the envelope from the caller's already-typed `T`
  and publishes it. `definition.parse` runs on the consumer side only.
- **Why:** `parse` is a narrowing function `unknown → T`, and a realistic implementation (a Zod
  schema with defaults, coercion, or stripping) **returns a different object** than it was given.
  Running it on publish would silently change what the producer asked to send. It also would not buy
  the guarantee it appears to: what the consumer parses is the value after a JSON round trip, which
  the producer-side call has not seen. The honest consequence — a producer can publish a payload its
  own consumers reject, and that surfaces at the consumer — is stated in the README and
  `PUBLIC_API.md` rather than left to be discovered.
- **Test home:** `test/unit/integration/publish.test.ts` publishes through a definition whose
  `parse` throws unconditionally and asserts the publish succeeds and the recorded payload is the
  caller's object unchanged.

### 3.5 One rejection class, discriminated by reason, with the parser's error as `cause`

- **Decision:** `IntegrationEventRejectedError extends Error` carries
  `reason: 'malformed' | 'type-mismatch' | 'version-mismatch' | 'parse'`, plus `topic`, the
  `expectedType` and `expectedVersion` from the definition, and — when `reason` is `'parse'` — the
  thrown parser error as `cause`. The wrapper **throws** it; it does not swallow, and it does not
  call the application handler.
- **Why:** An operator triaging a dead-letter needs to tell "the producer sent a shape we do not
  understand" from "our own handler has a bug", and the four reasons are the four distinct
  producer-side faults. One class rather than four keeps the `instanceof` branch a consumer writes
  to a single import while still discriminating. Preserving the parser's own error as `cause` is
  what keeps a Zod error's field paths — the most useful diagnostic in the whole path — reachable;
  M90f's driver-error wrapping is the precedent. Throwing rather than reporting is the ROADMAP's
  stated contract: the rejection follows the broker's native failure path, which is
  nack-and-redeliver on a real broker and `onDispatchError` on the in-memory one. **The `message`
  string carries the whole diagnostic on its own**, naming the reason, the topic, and the expected
  against the observed `type`/`version`. That is not belt-and-braces: verified from source,
  `MessagingPlugin`'s own reporter (`messaging-plugin.ts:233-241`) formats a rejection as
  `error.message` into a single log string, so on the **default** in-memory composition the
  structured fields never reach an operator and the message is all that survives. The fields serve
  an application's `instanceof` branch on a path that surfaces the error object itself — a real
  broker's nack handler, or the `'custom'` arm (§1) with an application-supplied sink.
- **Test home:** `test/unit/integration/subscribe.test.ts` — one case per reason, each asserting the
  application handler was never invoked and the thrown value's `reason`, `topic` and (for `'parse'`)
  `cause` identity, plus one case per reason asserting `message` names the reason and the topic
  without reading any structured field.

### 3.6 The handler receives the parsed payload, the envelope, and the transport metadata

- **Decision:** `IntegrationEventHandler<T>` is
  `(payload: T, envelope: IntegrationEventEnvelope<T>, metadata: MessageMetadata) => void | Promise<void>`,
  and the envelope handed over is rebuilt with its `data` field set to the **parsed** value, so
  `envelope.data === payload` holds for every delivery.
- **Why:** The payload is what the handler almost always wants, and hoisting it to the first
  parameter keeps the common case free of destructuring. The envelope is what makes correlation
  propagation possible at all, and the raw `MessageMetadata` is what the existing imperative
  `subscribe` handler already receives, so a reader moving between the two forms is not surprised.
  Rebuilding `data` from the parsed value removes the one way the two can disagree: with the raw
  value left in place, a coercing parser would make `envelope.data` and `payload` two different
  objects with no indication which is authoritative.
- **Test home:** `test/unit/integration/subscribe.test.ts` asserts `envelope.data === payload` by
  reference through a coercing parser that returns a new object.

### 3.7 Correlation propagation is a pure `causedBy(envelope)` helper, and there is no factory variant

- **Decision:** `causedBy(envelope)` returns
  `{ correlationId: envelope.correlationId ?? envelope.id, causationId: envelope.id }`, shaped to be
  spread straight into `publishIntegrationEvent`'s optional metadata argument. No factory-producing
  variant of `onIntegrationEvent` is added.
- **Why:** The `?? envelope.id` fallback is the whole of the chain-root rule, and it is exactly the
  line every consumer would otherwise copy into every handler — §11.1's case for extracting it. The
  factory variant is unnecessary because it already exists: `SubscriptionEntry`
  (`interfaces/index.ts:345-347`) accepts `RegistryFactory<SubscriptionDefinition>`, so a handler
  needing a resolved capability is written
  `(services) => onIntegrationEvent(def, handlerFor(services))` with no new surface. Adding a second
  spelling would be two mechanisms for one seam.
- **Test home:** `test/unit/integration/publish.test.ts` covers both `causedBy` branches (a root
  envelope with no `correlationId`, and a descendant that inherits one);
  `test/integration/integration-events.test.ts` proves the `RegistryFactory` form registers and
  delivers through `MessagingPlugin({ subscriptions })`.

### 3.8 Ingress behaviours observe the raw envelope, and that is documented rather than changed

- **Decision:** When `MessagingPlugin({ behaviors })` is configured, the chain runs **before** the
  helper's wrapper, so `IngressContext.payload` is the raw envelope and never the parsed `T`. The
  chain is not reordered and `PipelinedBroker` is not modified.
- **Why:** Verified from source: `pipelined-broker.ts:189` sets `payload` from the message the
  broker delivered, and `subscribeDefinition` (`messaging-plugin.ts:507-512`) hands the helper's
  wrapper to the already-wrapped broker — so the wrapper is inside the chain by construction. That
  ordering is also the correct one: a behaviour that short-circuits (a tenant guard, an auth check)
  must be able to refuse a message _without_ the framework having parsed it first, and a behaviour
  reading `envelope.correlationId` off the raw object is doing something useful. The cost is that a
  behaviour cannot depend on `payload` being `T`, which is a documentation obligation, not a defect.
- **Test home:** `test/integration/integration-events.test.ts` registers a behaviour alongside an
  integration-event subscription and asserts the observed `payload` carries the envelope's `type`
  and `id` fields, and that a short-circuiting behaviour prevents both the parse and the handler.

### 3.9 The new surface is named for the contract, not for the class in `events-plugin`

- **Decision:** No exported symbol is named `IntegrationEvent`. The definition type is
  `IntegrationEventDefinition<T>` and the wire type is `IntegrationEventEnvelope<T>`.
- **Why:** `events-plugin` already exports an abstract class called `IntegrationEvent`
  (`domain-event.ts:74`). Two packages exporting that bare name would collide in any application
  importing both, and the two concepts are genuinely different: that class is an in-process
  `DomainEvent` subclass with no added fields, while this is a cross-service wire contract. The
  suffixed names make the distinction visible at the import site, and C1's JSDoc correction points a
  reader from one to the other.
- **Test home:** `test/unit/barrel-exports.test.ts` asserts the exported names.

### 3.10 The envelope's structural check accepts unknown extra fields

- **Decision:** `validateEnvelope` requires the mandatory fields to be present and of the right
  primitive type, checks `type` and `version` for exact equality with the definition, and
  **ignores** any additional top-level field it does not recognise.
- **Why:** A producer on a later framework version may add an envelope field this consumer's build
  does not know about; refusing the message for that would make every additive envelope change a
  breaking, coordinated deployment — the opposite of what a versioned contract is for. Payload
  strictness is the parser's job, where the application owns the policy and can be as strict as it
  likes.
- **Test home:** `test/unit/integration/envelope.test.ts` validates an envelope carrying an unknown
  extra field and asserts it passes, and that the extra field survives onto the handler's envelope.

### 3.11 The domain-to-integration mapping is an explicit README example, not a framework path

- **Decision:** The README shows an application mapping one `IDomainEvent` — recorded by M93a's
  `createDomainEvents()` — onto a published integration event, building the payload explicitly from
  `event.data` and passing the causal fields as
  `{ causationId: event.id, aggregateId: event.aggregateId, aggregateVersion: event.version }`. It
  lives in a README fence as application code; no `src` file in this package imports
  `@setu-ts/events-plugin`, and nothing in the framework performs this mapping automatically.
- **Why:** The ROADMAP names this example as a deliverable, and now that M93a is merged it can
  reference a real API rather than a sketch. Writing it out is also the only place two traps get
  named. First, `event.type` is the **domain** fact's name and is deliberately not the integration
  `type`: the contract owns its own `type`/`version` pair, and deriving the wire name from an
  internal class name would couple a published contract to a refactor. Second, `event.occurredOn` is
  when the fact happened and the envelope's `occurredAt` is when it was published — different
  instants, and conflating them would silently misreport end-to-end latency for every consumer.
  Forwarding `event.data` whole is what `EventsMessagingBridge` already does
  (`events-messaging-bridge.ts:94`) and is precisely the unversioned shape this milestone exists to
  replace, so the example transforms rather than forwards.
- **Test home:** the README fence gate (C3) compiles it. There is deliberately no runtime assertion:
  the mapping is application policy, not framework behaviour, and a test asserting one particular
  mapping would be asserting a decision the application owns.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                   | Kind      | Consumer / real code path that READS it                                                                                                                                                                                          |
| --------------------------------- | --------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `defineIntegrationEvent`          | function  | Called by the application to produce the definition that `publishIntegrationEvent` and `onIntegrationEvent` both read; its refusals are the §3.2 guard. Read in `src/integration/publish.ts` and `src/integration/subscribe.ts`. |
| `publishIntegrationEvent`         | function  | Application producer path. Reads `IRuntimeServices.uuid`/`now` and calls `IMessageBroker.publish`. Exercised through the real plugin in `test/integration/integration-events.test.ts`.                                           |
| `onIntegrationEvent`              | function  | Produces a `SubscriptionDefinition` consumed by `messaging-plugin.ts:507-512` (`subscribeDefinition`) when passed through `MessagingPlugin({ subscriptions })`, and by an imperative `broker.subscribe` when spread by hand.     |
| `causedBy`                        | function  | Read by the application handler and spread into `publishIntegrationEvent`'s metadata argument; the README and `PUBLIC_API.md` correlation-propagation example is its documented path.                                            |
| `IntegrationEventRejectedError`   | class     | Constructed and thrown on the real delivery path in `src/integration/subscribe.ts`; read by the application's `instanceof` branch in a broker failure handler (`InMemoryBrokerOptions.onDispatchError`, a dead-letter consumer). |
| `IntegrationEventDefinition<T>`   | interface | The parameter type of `publishIntegrationEvent` and `onIntegrationEvent`; the return type of `defineIntegrationEvent`.                                                                                                           |
| `IntegrationEventEnvelope<T>`     | interface | The `message` type published by `publishIntegrationEvent`, the value validated in `src/integration/envelope.ts`, and the second parameter of every `IntegrationEventHandler`.                                                    |
| `IntegrationEventMetadata`        | interface | The optional fifth argument of `publishIntegrationEvent`; the return type of `causedBy` is assignable to it.                                                                                                                     |
| `IntegrationEventHandler<T>`      | type      | The second parameter of `onIntegrationEvent`; the application writes one per subscription.                                                                                                                                       |
| `IntegrationEventRejectionReason` | type      | The `reason` field of `IntegrationEventRejectedError`; read by an application's `switch` in a dead-letter branch and asserted per-case in `test/unit/integration/subscribe.test.ts`.                                             |

### 4.1 Options — every option names its consumer

No plugin option is added: `MessagingPluginOptions` and every arm of its union are untouched. The
new surface is configured entirely by the arguments to the three functions.

| Option (argument field)            | Consumer                                                                                                   | Behavior (per implementation)                                                                                                                                                        |
| ---------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `defineIntegrationEvent.type`      | `createEnvelope` (written to the wire), `validateEnvelope` (exact-match check)                             | Identical on every broker — it is a payload field.                                                                                                                                   |
| `defineIntegrationEvent.version`   | `createEnvelope`, `validateEnvelope`, and the §3.2 topic-suffix guard                                      | Identical on every broker.                                                                                                                                                           |
| `defineIntegrationEvent.topic`     | `publishIntegrationEvent` (the `publish` topic), `onIntegrationEvent` (the `SubscriptionDefinition.topic`) | Passed through verbatim to the broker; each arm applies its own topic-name rules, which this layer does not restate.                                                                 |
| `defineIntegrationEvent.parse`     | `onIntegrationEvent`'s wrapper only (§3.4 — never the publisher)                                           | Identical on every broker; a throw becomes `reason: 'parse'`.                                                                                                                        |
| `publishIntegrationEvent` metadata | `createEnvelope`                                                                                           | Each of `correlationId`, `causationId`, `aggregateId`, `aggregateVersion` is **omitted** from the envelope when absent, never written as `undefined` (`exactOptionalPropertyTypes`). |
| `onIntegrationEvent` options       | `SubscriptionDefinition.options`                                                                           | Forwarded unchanged to `broker.subscribe`; consumer-group semantics remain each arm's own, exactly as the imperative call.                                                           |

## 5. Implementation files

| File                                                                           | Purpose                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/integration/definition.ts`                                                | `IntegrationEventDefinition<T>`, `defineIntegrationEvent`, and the §3.2 field/suffix guard.                                                                                                                                                  |
| `src/integration/envelope.ts`                                                  | `IntegrationEventEnvelope<T>` plus the internal `createEnvelope` and `validateEnvelope`. Both directions of the wire shape live in one file so the producer and the consumer cannot drift about what a field is called or how it is checked. |
| `src/integration/publish.ts`                                                   | `IntegrationEventMetadata`, `publishIntegrationEvent`, `causedBy`.                                                                                                                                                                           |
| `src/integration/subscribe.ts`                                                 | `IntegrationEventHandler<T>`, `onIntegrationEvent`, and the wrapper that validates, parses, rebuilds the envelope, and calls the handler.                                                                                                    |
| `src/errors.ts` _(modified)_                                                   | Adds `IntegrationEventRejectionReason` and `IntegrationEventRejectedError` beside the package's existing error classes — one home for the package's errors.                                                                                  |
| `src/index.ts` _(modified)_                                                    | Barrel: the ten symbols in §4.                                                                                                                                                                                                               |
| `packages/messaging-plugin/README.md` _(modified)_                             | New section documenting the contract, the envelope table, correlation propagation, the rollout policy, the §3.4 producer-side caveat, and the §3.8 behaviour-ordering note. Exports table regenerated by `deno task docs:exports`.           |
| `PUBLIC_API.md` _(modified)_                                                   | New `### Integration event contracts` subsection under `## Messaging` (C4).                                                                                                                                                                  |
| `ROADMAP.md` _(modified)_                                                      | C2 sentence; the `93b` Progress Tracking row flipped to ✅ with its PR number.                                                                                                                                                               |
| `CHANGELOG.md` _(modified)_                                                    | One `### Added` entry under `Unreleased`. No `docs/upgrading.md` entry: this is a pure addition with no reader action.                                                                                                                       |
| `packages/events-plugin/src/events/domain-event.ts` _(modified, comment only)_ | C1 JSDoc correction. No behaviour change, no export change, no import added.                                                                                                                                                                 |
| `test/package-readme-fence-compiler.test.ts` _(modified)_                      | C3 fence count.                                                                                                                                                                                                                              |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                           | src covered                                             | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/integration/definition.test.ts`                          | `src/integration/definition.ts`                         | Accepted definition exposes `type`/`version`/`topic`/`parse` unchanged. One refusal case each for: empty `type`, empty `topic`, `version` of `0`, `-1`, `1.5`, `NaN`, a non-integer safe-bound value, and a `topic` whose suffix is absent (`'orders.placed'`), wrong (`'orders.placed.v2'` with `version: 1`), and a near-miss (`'orders.placed.v10'` with `version: 1` — a `endsWith('v1')` implementation passes this and must fail). Each call type-checks against `defineIntegrationEvent<T>(options: { type: string; version: number; topic: string; parse: (value: unknown) => T }): IntegrationEventDefinition<T>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `test/unit/integration/envelope.test.ts`                            | `src/integration/envelope.ts`                           | `createEnvelope` writes exactly the nine documented fields, omits each optional one when its metadata field is absent, sets `id` from `runtime.uuid()` and `occurredAt` from `runtime.now()` as a parseable ISO-8601 string (asserted against `createFakeRuntime` from `test/fixtures/fake-runtime.ts`, passing an explicit `startTimestamp` — its default is `Date.now()`, which would make the ISO assertion non-deterministic, the clock-mixing pitfall in a second guise). `validateEnvelope` accepts a valid envelope, accepts one with an unknown extra field (§3.10), and refuses: `null`, a primitive, an array, each missing mandatory field, each mandatory field of the wrong primitive type, a mismatched `type`, and a mismatched `version`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/unit/integration/publish.test.ts`                             | `src/integration/publish.ts`                            | Against a recording stand-in typed as `IMessageBroker`: `publishIntegrationEvent` calls `publish` exactly once with `definition.topic` and an envelope matching §3.3; causal metadata reaches the envelope; absent metadata fields are omitted rather than `undefined`; a definition whose `parse` throws still publishes and the payload is unchanged (§3.4); a rejecting `publish` rejects the call unchanged. `causedBy` returns `causationId === envelope.id` and `correlationId === envelope.id` for a root and `=== envelope.correlationId` for a descendant. Calls type-check against `publishIntegrationEvent<T>(runtime: IRuntimeServices, broker: IMessageBroker, definition: IntegrationEventDefinition<T>, payload: T, metadata?: IntegrationEventMetadata): Promise<void>`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `test/unit/integration/subscribe.test.ts`                           | `src/integration/subscribe.ts`                          | The returned value has `topic === definition.topic` and forwards `options`. Driving the returned `handler` directly: a valid envelope invokes the application handler once with the parsed payload, an envelope whose `data` differs after a coercing parser gives `envelope.data === payload` by reference (§3.6), and each of the four rejection reasons throws `IntegrationEventRejectedError` with that `reason`, the right `topic`, and — for `'parse'` — the thrown parser error as `cause`, with the application handler never invoked in any of them. Type-checks against `onIntegrationEvent<T>(definition: IntegrationEventDefinition<T>, handler: IntegrationEventHandler<T>, options?: SubscribeOptions): SubscriptionDefinition` — note `SubscriptionDefinition.handler` is non-generic `MessageHandler`, so the wrapper is assignable with no cast (§1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/messaging-errors.test.ts` _(extended)_                   | `src/errors.ts`                                         | `IntegrationEventRejectedError` sets `name`, carries `reason`/`topic`/`expectedType`/`expectedVersion`, and is an `instanceof Error`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `test/unit/barrel-exports.test.ts` _(extended)_                     | `src/index.ts`                                          | Each of the four new value exports is defined and a function, the error class is a function, and the five type exports are imported by name so `deno check` pins them (the M56 defect class: a type export dropped from a barrel leaves every runtime assertion green).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `test/integration/integration-events.test.ts` _(new)_               | all four `src/integration/*.ts` through the real plugin | Through a real `createApplication` with `RuntimePlugin` + `MessagingPlugin({ subscriptions })` and the default in-memory broker: (a) one producer, **two independent consumer groups** each receiving the event once (the ROADMAP's named example); (b) correlation propagation — a handler publishes a second event with `causedBy(envelope)` and the second envelope's `correlationId`/`causationId` are asserted; (c) a parser rejection observed through a **recording `ILogger` provided by `createMockPlugin({ name: 'logger', service })`** (§1) — not through `onDispatchError`, which `MessagingPlugin` owns and does not expose (§1) — asserting the logged string names the topic and the parse failure, and that `publish` itself resolved rather than rejecting (the §1 verified in-memory semantics). This is deliberately the default composition, so it proves the diagnostic reaches an operator through the path an application actually gets; the structured fields are asserted at unit level in `subscribe.test.ts`, where the wrapper is driven directly; (d) a v1 consumer receives nothing when only the v2 definition is published, and a **dual-publish** window delivers to both; (e) the `RegistryFactory<SubscriptionDefinition>` form (§3.7); (f) a registered ingress behaviour observes the raw envelope and a short-circuiting one prevents both parse and handler (§3.8). |
| `test/integration/integration-events-rabbitmq-real.test.ts` _(new)_ | the envelope across a real transport                    | Guarded on `RABBITMQ_URL` with `ignore:` on the `it`, **not** an early `return` — an early-return suite reports _passed_ while asserting nothing (M70c). Publishes through `publishIntegrationEvent` and consumes through `onIntegrationEvent` against a real RabbitMQ 4 broker, asserting every envelope field survives the real serializer and transport. This is the only thing that proves the wire shape is transport-independent rather than an artefact of the in-memory double's own `JsonSerializer` round trip.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `test/package-readme-fence-compiler.test.ts` _(modified)_           | the README fences                                       | Every new README fence compiles, and the pinned count moves to the new total (C3).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

**Guarded real-import test:** None (checked). This milestone adds no npm dependency, no dynamic
`import()`, and no external SDK — every line is pure TypeScript over the already-committed broker
contract, so §12.2's inject-or-lazy pattern has nothing to apply to.
`scripts/npm-specifier-audit.ts` (M70e) has no new specifier to see.

**Negative controls to run and revert (each observed failing before hand-off):**

1. Remove the §3.2 topic-suffix guard → the `orders.placed.v2` / `version: 1` and near-miss `.v10`
   cases in `definition.test.ts` must fail.
2. Replace the suffix check with `topic.endsWith('v' + version)` → the `.v10` near-miss must fail
   while every other definition case still passes, proving the case discriminates.
3. Skip the exact `version` check in `validateEnvelope` → case (d) of the integration suite (a v1
   consumer receiving a v2 envelope) must fail.
4. Hand the raw envelope to the handler instead of rebuilding `data` from the parsed value → the
   coercing-parser reference assertion in `subscribe.test.ts` must fail.
5. Call `definition.parse` inside `publishIntegrationEvent` → the §3.4 publish case must fail.
6. Report the parse failure instead of throwing it → integration case (c) must fail, and the
   application handler must be observed running on an unparsed value.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m93b-integration-events, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task docs:exports      # regenerate the README exports table before check:docs
deno task check:docs
deno task publish:check     # on a COMMITTED tree — new barrel exports need written-out return types
deno task release:verify 0.5.0
```

The two publish gates are mandatory here because the milestone changes `src/index.ts`: an inferred
return type on an exported function is a JSR slow type that `deno task check` does not see and
`publish:check` does (the M51 defect). Every new exported function gets a written-out return type.

## 8. Risks & mitigations

- **The suffix guard locks out a pre-existing unversioned topic.** A team adopting this layer over a
  live `orders.created` topic cannot express it. Mitigation: the raw `broker.publish`/`subscribe`
  surface is entirely unchanged and remains the documented route for an existing topic; the refusal
  fires at definition time — at module load, loudly, with the expected suffix named — never at
  runtime on a message. Recorded in the README beside the policy.
- **A parser that throws a non-`Error` value.** `cause` would then carry a primitive. Mitigation:
  `cause` is typed `unknown` and set verbatim; the rejection's own `message` names the topic and
  reason so the diagnostic stands without it, and a test covers a thrown string.
- **Rejection diagnostics are flattened to a string on the default composition.** `MessagingPlugin`
  supplies its own `onDispatchError` (`messaging-plugin.ts:228-242`) which logs `error.message` and
  discards the error object, so an application registering no logger capability sees a rejected
  envelope observed and dropped at the broker's terminus (`in-memory-broker.ts:260`). Mitigation:
  §3.5 makes `message` self-sufficient so the flattening loses nothing an operator needs; the
  README's consumer example registers `LoggerPlugin` rather than reaching for an `onDispatchError`
  the plugin does not expose, and names the `'custom'` arm as the route to a bespoke sink.
- **A reader conflates `correlationId` with the W3C trace id.** `TracedBroker` already propagates
  `traceparent` in transport headers (M75), and the two are different things with overlapping names.
  Mitigation: one paragraph in the README's new section stating that the trace context is transport
  metadata owned by the telemetry layer while correlation is an application-level causal chain in
  the payload, and that neither replaces the other.
- **C1's file overlap with M93a — settled, not open.** M93a (PR #285) merged first and created a
  **new** file, `packages/events-plugin/src/events/domain-events.ts`; it never touched
  `domain-event.ts`, so C1's target is clean. This branch is rebased on the merge and every citation
  above was re-verified against the merged tree, which caught one drift: M93a's `PUBLIC_API.md`
  insertion moved the Messaging section from line 4143 to 4188. The remaining overlap is
  adjacent-line only — the `93b` ROADMAP row beside M93a's `93a` row, and a sibling CHANGELOG bullet
  under the same `Unreleased` heading.
- **The integration suite passes vacuously if no message is ever delivered.** A subscription that
  silently fails to register would leave every "handler not called" assertion true. Mitigation:
  every case that asserts an absence is paired in the same suite with a positive case on the same
  definition proving delivery works, and case (a) counts deliveries rather than asserting a boolean.

## 9. Out of scope

- **Aggregate-local domain-event recording** (`IDomainEvents`, `createDomainEvents`) — **M93a**,
  `@setu-ts/events-plugin`. Nothing here imports it and nothing here bridges to it automatically;
  the mapping from a local domain event to an integration event is shown in the README as
  application code, exactly as the ROADMAP specifies.
- **Transactional outbox, consumer inbox, de-duplication by event ID, ordering, retention, replay,
  and failure observability across the database and messaging contracts** — the **deferred
  reliability milestone** at the end of the ROADMAP's M93 section. In particular, a transport
  accepting a publish still says nothing about every consumer finishing successfully; the messaging
  README's existing publish-timing section stays true and is linked from the new one.
- **Decorator or assembly scanning for event handlers, a saga DSL, an event store, and a portable
  retry/dead-letter policy** — all named non-deliverables in the ROADMAP section; a broker's own
  retry and dead-letter configuration remains that arm's concern.
- **Any change to `EventsMessagingBridge`.** It keeps forwarding `event.data`
  (`events-messaging-bridge.ts:94`) and remains the compatibility path.
- **Mis-stamped `@since` tags in `@setu-ts/view-plugin` and `@setu-ts/events-plugin`.** While
  verifying the convention (§1) it was observed that M92 and M93a both tag new surface
  `@since 0.5.0`, while M91 tags its own `@since 0.6.0`. M91 is correct and the other two are false,
  proved against the tag rather than argued: `v0.5.0` is published, and
  `git show v0.5.0:packages/events-plugin/src/events/domain-events.ts` finds nothing, so the symbol
  was not available in the release it claims. The mechanism explains both and will keep producing
  them — a release branch bumps every manifest **to the shipping version**, so after v0.5.0 ships
  the manifest reads `0.5.0`, and an author filling in `@since` from the manifest gets the
  **previous** release every time. Nothing gates it. This milestone follows M91 and uses
  `@since 0.6.0`; correcting the two merged packages is a defect in already-merged `main` and
  belongs on a `fix/…` branch, not here.
