# Milestone 75 — Broker Trace Propagation (`@setu-ts/messaging-plugin`, `@setu-ts/telemetry-plugin`, `@setu-ts/common`)

> **Status:** Planning. Branch: `feat/m75-broker-trace-propagation`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

A trace must survive a `publish`. Today it does not, and the gap is two independent breaks rather
than the one the ROADMAP describes: the broker carries no `traceparent` (so a consumer span has no
parent to claim), **and** `TelemetryService.withSpan` never makes its span the active OTel context
(so a span created anywhere inside a request handler — a broker producer span included — is a fresh
root, disconnected from the request's own server span). Fixing only the broker half would produce a
correctly-linked producer→consumer pair floating in its own trace, unreachable from the HTTP request
that caused it. This milestone closes both, adds the W3C codec to `common` so `messaging-plugin` can
read and write the header without importing `telemetry-plugin` (§2.2), and settles the
`MessageMetadata.headers` contract question the ROADMAP assigns here.

- **In scope:** span activation via a new optional `TracerHost` seam and a runtime-gated OTel
  context manager; the `traceparent`/`tracestate` codec promoted to `common` with `telemetry-plugin`
  delegating to it; `traceparent` injected on publish and extracted on delivery across all seven
  `messaging-plugin` brokers; one shared producer/consumer span decorator over the internal broker
  adapter; the `MessageMetadata.headers` contract decision; and four merged-code defects this work
  necessarily touches (D1–D4 in §3.9).
- **NOT this milestone:** trace propagation across `queue-plugin` (SQS/Redis/RabbitMQ jobs) and
  `cloudflare-plugin`'s `WorkersBroker`/`WorkersQueue` — the same mechanism applies but each is its
  own transport surface with its own real-backend gate; recommended as **M75b**. Baggage (`baggage`
  header) propagation, metrics/log correlation, and OTel semantic-convention coverage beyond the
  four attributes named in §3.7 are also out (§9).

## 1. Contracts verified from SOURCE (not names)

| Reference                                                                        | Source (file:line)                                                                                                                                                                                       | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MessageMetadata`                                                                | `packages/common/src/services/messaging.ts:14-23`                                                                                                                                                        | `{ topic; messageId?; timestamp?; headers?: Readonly<Record<string,string>> }` — `headers` is **optional**, so populating it is source-compatible and requiring it would break the `custom` arm.                                                                                                                                                                       |
| `IMessageBroker.publish`                                                         | `packages/common/src/services/messaging.ts:114`                                                                                                                                                          | `publish<T>(topic, message): Promise<void>` — **no options parameter**. A caller cannot pass trace context, so injection must be ambient inside the broker, never threaded through this signature.                                                                                                                                                                     |
| `IMessageBroker.request`/`respond`                                               | `packages/common/src/services/messaging.ts:149,163`                                                                                                                                                      | Present, and both route through the broker's own `publish`/`subscribe` (see `RequestReplyCore` below), so RPC inherits injection with no separate mechanism.                                                                                                                                                                                                           |
| `ITelemetryService`                                                              | `packages/common/src/services/telemetry.ts:166-193`                                                                                                                                                      | **One method**, `withSpan(name, fn, options?)`. There is no `currentSpan()`/`currentContext()`, so a producer cannot ask for the ambient context — it must create its own span and read `span.spanContext()`.                                                                                                                                                          |
| `SpanOptions.parentContext`                                                      | `packages/common/src/services/telemetry.ts:55`                                                                                                                                                           | `readonly parentContext?: TelemetryContext` — the consumer-side parenting input already exists; no widening needed to parent a consumer span.                                                                                                                                                                                                                          |
| `TelemetryContext`                                                               | `packages/common/src/services/telemetry.ts:78-89`                                                                                                                                                        | `{ _opaque; traceId?; spanId?; traceFlags?; tracestate? }` — exactly the W3C fields, so the promoted codec needs **no new type** in `common`.                                                                                                                                                                                                                          |
| `ISpan.spanContext`                                                              | `packages/common/src/services/telemetry.ts:141`                                                                                                                                                          | `spanContext(): SpanContext` with `{ traceId; spanId; traceFlags }` all required `string`. This is the producer's only route to its own ids, and it is reachable from inside a `withSpan` callback.                                                                                                                                                                    |
| `TelemetryService.withSpan`                                                      | `packages/telemetry-plugin/src/services/telemetry-service.ts:138-171`                                                                                                                                    | Calls `startSpan` then `await fn(...)` in a `try/finally`. **Never calls `context.with`** — the span is created but never activated, which is the second break named in §0.                                                                                                                                                                                            |
| `buildTracerHost.startSpan`                                                      | `packages/telemetry-plugin/src/tracing/tracer.ts:301-347`                                                                                                                                                | Passes an OTel parent context as the 3rd arg **only** when `parentContext.traceId && .spanId`; otherwise passes `undefined`, so OTel falls back to `context.active()` — which is why activation is the fix.                                                                                                                                                            |
| `OtelApi` facade                                                                 | `packages/telemetry-plugin/src/tracing/tracer.ts:25-35`                                                                                                                                                  | Declares `trace.wrapSpanContext`, `trace.setSpan`, `context.active()`. **No `context.with`** and no `setGlobalContextManager` — both must be added to the facade for activation.                                                                                                                                                                                       |
| `parseTraceparentToContext`, `contextToTraceparent`, `extractContextFromHeaders` | `packages/telemetry-plugin/src/tracing/tracer.ts:60,89,108`                                                                                                                                              | All three exist, are marked `@internal`, and are **absent from `src/index.ts`** — so `messaging-plugin` cannot reach them today by any legal route.                                                                                                                                                                                                                    |
| `telemetry-plugin` barrel                                                        | `packages/telemetry-plugin/src/index.ts:12-35`                                                                                                                                                           | Exports `TelemetryPlugin`, `TELEMETRY_SPAN_KEY`, `telemetryMiddleware`, `NoopTelemetryService`, `TracerHost` and option types. Confirms the codec is unreachable and that `TracerHost` is public.                                                                                                                                                                      |
| `RequestReplyCore`                                                               | `packages/messaging-plugin/src/brokers/request-reply-core.ts:1-19,68-88`                                                                                                                                 | Its module doc states it deliberately avoids transport headers "which not every broker populates"; `RequestReplyDeps.publish`/`subscribe` are **the broker's own**, so RPC rides the traced path for free.                                                                                                                                                             |
| `MessageBrokerAdapter`                                                           | `packages/messaging-plugin/src/brokers/message-broker.ts:33-49`                                                                                                                                          | Internal seam (`extends IMessageBroker` + `isReady()`, `reachability()`), **not barrel-exported** — so new required members here are not a public API change.                                                                                                                                                                                                          |
| `asBrokerAdapter`                                                                | `packages/messaging-plugin/src/brokers/custom-adapter.ts:27-40`                                                                                                                                          | Wraps a public `IMessageBroker` into the internal seam, filling absent members. This is where the `custom` arm's new internal members get their defaults.                                                                                                                                                                                                              |
| `MessagingPlugin.register`                                                       | `packages/messaging-plugin/src/plugin/messaging-plugin.ts:106-233`                                                                                                                                       | Resolves the optional logger via `ctx.services.has('logger')`, builds one of eight arms, `await broker.connect()`, then registers. `optionalDependencies: ['logger']` only — **no telemetry coupling exists**.                                                                                                                                                         |
| `messaging-plugin` telemetry coupling                                            | `grep -rn "TELEMETRY\|telemetry" packages/messaging-plugin/src`                                                                                                                                          | **Zero matches.** The claim that the packages are currently uncoupled is verified, not assumed.                                                                                                                                                                                                                                                                        |
| `TelemetryPlugin` metadata                                                       | `packages/telemetry-plugin/src/plugin/telemetry-plugin.ts:106-112`                                                                                                                                       | `provides: [CAPABILITIES.TELEMETRY]`, `optionalDependencies: [CAPABILITIES.LOGGER]`, `priority: MIDDLEWARE_PRIORITY.TELEMETRY` (30). Lower number than messaging's `PLUGIN_PRIORITY.NORMAL`, so it already orders first by priority — the `optionalDependencies` edge added in §3.8 is what covers a replacement provider at a higher number (M45b's measured lesson). |
| Instrumentation Node gate                                                        | `packages/telemetry-plugin/src/instrumentation/instrumentation-registry.ts:95-97,204-205`                                                                                                                | `isInstrumentationSupported` returns `platform === 'node'`; unsupported platforms record `'unsupported platform'`. Confirms the M24b route is unavailable on the CLI's default Deno target.                                                                                                                                                                            |
| `createCachedProbe` / `realtime-codec`                                           | `packages/common/src/health/probe.ts:97`, `packages/common/src/realtime-codec.ts`                                                                                                                        | Two committed precedents for a pure, zero-dependency helper living in `common` and being consumed by several plugins — the pattern §3.2 follows.                                                                                                                                                                                                                       |
| `IRedisStreamsClient.xadd`                                                       | `packages/messaging-plugin/src/interfaces/index.ts:16-23`                                                                                                                                                | `xadd(name, id, data: string \| Array<string>, ...args: string[])` — already variadic `string`, so two extra field/value arguments need **no facade change**.                                                                                                                                                                                                          |
| `IPubSubTransport.publish`                                                       | `packages/messaging-plugin/src/brokers/pubsub-broker.ts:68`                                                                                                                                              | `publish(topic, bytes): Promise<void>` — **no header channel**; its `open` callback yields `{ payload, ack, nack }` with no attributes. Both sides need the widening in §3.5.                                                                                                                                                                                          |
| `IServiceBusTransport.send`                                                      | `packages/messaging-plugin/src/brokers/service-bus-broker.ts:110`                                                                                                                                        | `send(topic, body): Promise<void>` — **no header channel**; `open`'s callback yields `{ payload, ack, nack }`. Both sides need the widening in §3.5.                                                                                                                                                                                                                   |
| Public port exports                                                              | `packages/messaging-plugin/src/index.ts:91-103`                                                                                                                                                          | `IPubSubTransport` and `IServiceBusTransport` **are** barrel-exported, so §3.5's widening is a public API change (§10.2) — it is additive and optional, and §3.5 states why that is source-compatible both ways.                                                                                                                                                       |
| Per-broker `headers` population                                                  | `in-memory-broker.ts:140`, `redis-streams-broker.ts:350`, `rabbitmq-broker.ts:501-508`, `nats-broker.ts:405-410`, `kafka-broker.ts:406-412`, `pubsub-broker.ts:420-422`, `service-bus-broker.ts:529-531` | Measured per broker: in-memory ✗, redis ✗, pubsub ✗, service-bus ✗ set no `headers`; rabbitmq ✓ and kafka ✓ do; nats appears to but does not (D2). This **refutes the ROADMAP's "no broker populates it"** — see C1.                                                                                                                                                   |
| OTel default context manager                                                     | Probe, `@opentelemetry/api@^1.9.0` on Deno 2.x                                                                                                                                                           | `_getContextManager()` is `NoopContextManager`; `context.with(...)` propagated **nothing at all**, not even synchronously (`sync inside with: undefined`). So activation is inert until a manager is registered.                                                                                                                                                       |
| `AsyncLocalStorageContextManager`                                                | Probe, `@opentelemetry/context-async-hooks@^2.0.0` on Deno 2.x                                                                                                                                           | `setGlobalContextManager` returned `true`; values propagated across `await`, nested `with` shadowed correctly (`A` → `B` → back to `A`), and the value was absent again after the outermost `with` returned. **Works on Deno.**                                                                                                                                        |
| `nats.headers()` / `MsgHdrs`                                                     | Probe, `npm:nats@2.x`                                                                                                                                                                                    | `typeof nats.headers === 'function'`; the returned `MsgHdrsImpl` answers `get`/`set`/`has`/`keys`. A plain-object cast yields `undefined` for a real key and `Object.keys` gives `['_code','_description','headers']` — the internals. Confirms D2.                                                                                                                    |
| kafkajs `IHeaders`                                                               | `kafkajs` `index.d.ts:148-150`, `Message` at `:109-115`                                                                                                                                                  | `IHeaders` values are `Buffer \| string \| (Buffer \| string)[] \| undefined`. Confirms D3 (the read facade declares `Record<string,Uint8Array>`) and that a non-string payload field is not a legal header value.                                                                                                                                                     |
| Pub/Sub attributes                                                               | `@google-cloud/pubsub@5.3.1` `topic.d.ts:357,396`, `subscriber.d.ts:130-132`                                                                                                                             | `publish(data, attributes?: Attributes)` documents `@throws {TypeError} If any value in attributes object is not a string`; received `Message.attributes: { [key: string]: string }`. A string-only header channel exists on both sides.                                                                                                                               |
| Service Bus application properties                                               | `@azure/service-bus@7.9.5` `service-bus.d.ts:2050-2052,2094`                                                                                                                                             | `ServiceBusMessage.applicationProperties?: { [key: string]: number \| boolean \| string \| Date \| null }`, and `ServiceBusReceivedMessage extends ServiceBusMessage`, so the channel exists on both sides.                                                                                                                                                            |
| npm-specifier gate                                                               | `scripts/npm-specifier-audit.ts:5-24`                                                                                                                                                                    | Refuses any `import()` whose first argument is not a string literal unless a `computed-specifier:` marker is present. §3.1's new loader must use a literal specifier.                                                                                                                                                                                                  |
| Plan linter                                                                      | `scripts/plan-lint.ts:52-74`                                                                                                                                                                             | Nine required sections; `<FILL:` is an error; `\bOR\b`, `either`, `TBD`, `TODO`/`FIXME`, `???` are warnings outside inline code.                                                                                                                                                                                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                       | Resolution (picked side)                                                                                                                                                                                                             | Doc deliverable (same PR)                                                                                                                                                                                                                                                   |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md:7509-7511` states `MessageMetadata.headers` "is declared and **no broker populates it**, so `headers` is `{}` on every delivered message". Source disagrees three ways: `rabbitmq-broker.ts:507` and `kafka-broker.ts:410` **do** populate it; four brokers omit it entirely, so the delivered value is `undefined`, never `{}`; and `nats-broker.ts:409` populates it with the wrong object (D2). | The source. The gap is the **write** side (no broker injects on publish) plus one broken read (nats) and four absent reads — not a uniformly empty map.                                                                              | Rewrite the M75 "The gap, verified from source" paragraph in `ROADMAP.md` with the per-broker table from §1, and record the correction in this plan's §3.9.                                                                                                                 |
| C2 | `ROADMAP.md:7512-7515` frames the OTel Node gate as "the one mechanism that could close this", implying the remedy must be an auto-instrumentation.                                                                                                                                                                                                                                                            | Neither the gap nor the fix is auto-instrumentation. The framework's own `ITelemetryService` runs on every runtime the telemetry plugin supports, and the missing piece is span **activation** (§3.1), which is a `TracerHost` seam. | Amend the same ROADMAP paragraph to name span activation as the seam, and keep the Node-gate sentence only as the reason the auto-instrumentation route is unavailable.                                                                                                     |
| C3 | `ARCHITECTURE.md:1839` lists middleware priority 30 as "TelemetryMiddleware — Propagate trace context", which reads as though trace context propagates through the application. It propagates into the server span and out on the response header only; nothing nests under it, because `withSpan` never activates.                                                                                            | The narrower reading, then made true by §3.1.                                                                                                                                                                                        | Add a paragraph to `ARCHITECTURE.md` §"Logging and Observability" stating that spans nest through the activation seam, that activation requires the context manager of §3.1, and that without it spans are siblings.                                                        |
| C4 | `PUBLIC_API.md:5150-5152` says the plugin exposes "manual span creation via `withSpan`" with no statement about nesting, and its options table (`:5162-5175`) has no row for context propagation.                                                                                                                                                                                                              | Document nesting and the new option.                                                                                                                                                                                                 | Add the `contextPropagation` row to the Telemetry options table, a "Span nesting and context propagation" subsection, and a "Trace context across the broker" subsection to the Messaging section covering the per-broker channel table and the `headers` contract of §3.6. |
| C5 | `packages/messaging-plugin/README.md` and the `MessageMetadata.headers` JSDoc (`common/src/services/messaging.ts:21`) both describe `headers` as "Transport headers" with no statement of which brokers supply them — the ambiguity that let D2 sit unnoticed.                                                                                                                                                 | State the contract explicitly per §3.6.                                                                                                                                                                                              | Update the `headers` JSDoc to the §3.6 wording, and add the per-broker propagation table to `packages/messaging-plugin/README.md` and `packages/telemetry-plugin/README.md`.                                                                                                |

## 3. Design decisions

### 3.1 Span activation — the seam that makes nesting real

- **Decision:** `TracerHost` gains one **optional** member,
  `activate?<T>(span: unknown, fn: () => Promise<T>): Promise<T>`. `TelemetryService.withSpan` calls
  it when present, running `fn` inside it; when absent it runs `fn` directly, which is today's
  behaviour byte-for-byte. `buildTracerHost` implements it as
  `api.context.with(api.trace.setSpan(api.context.active(), span), fn)`, and the `OtelApi` facade
  gains `context.with`. Because the probe in §1 shows the global manager is `NoopContextManager` and
  `context.with` then propagates nothing, the plugin also registers an
  `AsyncLocalStorageContextManager`, lazy-loaded through a **literal**
  `import('npm:@opentelemetry/context-async-hooks@^2.0.0')` behind a zero-argument importer seam
  (the M70e default-branch pattern), once per process, via `api.context.setGlobalContextManager`.
  Registration failure — an absent package, a runtime without `node:async_hooks`, a manager already
  installed by the host application — is reported through `ctx.logger` at `warn` and **degrades to
  no activation**; it never throws (the M24b instrumentation policy).
- **Why:** `ITelemetryService` has exactly one method and no ambient-context accessor (§1), so a
  producer span cannot ask what its parent is — the parent has to be ambient in OTel itself. The
  optional member keeps every existing `TracerHost` implementation, including an injected
  `tracerProviderFactory` host in a consumer's tests, assignable unchanged. A global context manager
  is the one exception to §11.4 taken here, and it is taken because OTel's context manager is
  process-global by construction: there is no per-provider form of it. M24b's per-instance
  `setTracerProvider` is not a counter-example — that avoided a global **tracer provider**, a
  different object with a per-instance API.
- **Test home:** `telemetry-plugin/test/unit/span-activation.test.ts` (seam present, seam absent,
  nested spans, `fn` throwing inside activation) and
  `telemetry-plugin/test/integration/context-manager-real.test.ts` (the real
  `AsyncLocalStorageContextManager`, asserting a nested span's `traceId` equals its parent's and its
  `spanId` differs).

### 3.2 The W3C codec moves to `common`, and the duplicate is deleted

- **Decision:** `parseTraceparentToContext`, `contextToTraceparent` and `extractContextFromHeaders`
  move verbatim to a new `packages/common/src/trace-context.ts`, are barrel-exported from `common`,
  and `telemetry-plugin/src/tracing/tracer.ts` **deletes its copies and imports them**. Two header
  names ship as constants beside them (`TRACEPARENT_HEADER`, `TRACESTATE_HEADER`, §11.2). No new
  type is introduced: `TelemetryContext` already carries exactly the W3C fields (§1).
- **Why:** §2.2 forbids `messaging-plugin` importing `telemetry-plugin`, and the functions are
  `@internal` and unexported anyway, so there is no legal route today. Promotion follows the M47
  `realtime-codec` and M55 content-type precedents, and — the point — it **deletes** a definition
  rather than adding one, so this is not the M30b `pemToDer` duplication case. The functions are
  pure and zero-dependency, which is what §2.1 permits in `common`.
- **Test home:** `common/test/unit/trace-context.test.ts` owns the codec's branches (valid header,
  malformed, version other than `00`, absent, `tracestate` carried, missing ids yielding `null`);
  `telemetry-plugin/test/unit/tracer-delegates-codec.test.ts` asserts the plugin re-exports nothing
  of its own and that `injectContext`/`extractContext` still round-trip.

### 3.3 One tracing decorator over the internal adapter, not seven copies

- **Decision:** a single internal `TracedBroker` decorator wraps the resolved
  `MessageBrokerAdapter`, is applied in `MessagingPlugin.register` when `CAPABILITIES.TELEMETRY`
  resolves, and owns **all** span work: it wraps `publish` in a `producer` span, reads
  `span.spanContext()`, formats a `traceparent` with the §3.2 codec, hands it to the transport
  through the §3.4 seam, and wraps each delivery in a `consumer` span parented by the extracted
  context. Absent the telemetry capability the adapter is registered unwrapped and behaviour is
  byte-identical to alpha.9.
- **Why:** §11.1 — span creation, attribute naming and error mapping are identical for all seven
  brokers, and seven copies is exactly the shape M70h's `renderList` and M70m's `renderSignature`
  findings punish. It also means the RPC path needs no separate mechanism:
  `RequestReplyDeps.publish` and `.subscribe` are the broker's own members (§1), so a wrapped broker
  traces `request`/`respond` through the same code.
- **Test home:** `messaging-plugin/test/unit/traced-broker.test.ts` (span kinds, attributes, header
  handed to the seam, consumer parented from a delivered header, span ended on a throwing handler,
  untraced passthrough when the capability is absent).

### 3.4 The internal adapter carries headers; the public contract does not change

- **Decision:** `MessageBrokerAdapter` gains two **required** internal members —
  `publishWithHeaders(topic, message, headers: Readonly<Record<string,string>>): Promise<void>` and
  a `subscribeWithHeaders` variant whose handler receives the transport headers the broker actually
  read. Every first-party broker implements them; `asBrokerAdapter` implements them for the `custom`
  arm by delegating to the wrapped instance's plain `publish`/`subscribe` and **dropping** the
  headers, so a custom broker keeps working and its non-propagation is a stated fact rather than a
  silent one. `IMessageBroker.publish` is untouched.
- **Why:** the public `publish` has no options parameter and adding one would be a `common` widening
  that every call site would then be expected to thread (§1). The internal seam is not
  barrel-exported (§1), so required members there cost no public API change and no deprecation.
  Making them required rather than optional is deliberate: an optional member returning nothing
  cannot be told apart from "this broker chose not to propagate", the ambiguity M70k had to invent
  `IWorkerHost.reportsExit?` to escape.
- **Test home:** `messaging-plugin/test/unit/custom-adapter.test.ts` gains cases proving the custom
  arm accepts and drops headers without throwing; each broker's own unit test asserts its transport
  call carries the header.

### 3.5 Per-broker header channel — seven transports, one table

- **Decision:** each broker uses the channel its transport actually has, verified in §1:

  | Broker          | Channel                                                      | Facade change                                                                                                                         |
  | --------------- | ------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------- |
  | `memory`        | metadata passed in-process; no wire exists                   | none                                                                                                                                  |
  | `redis-streams` | two extra `XADD` field/value pairs beside `payload`          | none — `xadd` is already variadic `string` (§1)                                                                                       |
  | `rabbitmq`      | `properties.headers` on publish; already read on delivery    | none                                                                                                                                  |
  | `nats`          | `MsgHdrs` built by the module's retained `headers()` factory | `NatsOptions.headersFactory?` for the injected-client path (§3.5a)                                                                    |
  | `kafka`         | `Message.headers`, string values only                        | none — the facade is local to the broker                                                                                              |
  | `pubsub`        | `attributes`, string values only                             | `IPubSubTransport.publish(topic, bytes, attributes?)` and an `attributes` member on the `open` callback message                       |
  | `service-bus`   | `applicationProperties`                                      | `IServiceBusTransport.send(topic, body, applicationProperties?)` and an `applicationProperties` member on the `open` callback message |

  Both cloud facade widenings are **optional additions**: an existing injected transport whose
  `publish(topic, bytes)` takes two parameters stays assignable to a three-parameter signature, and
  an `open` callback that ignores a new message member stays assignable too. Such a transport
  silently drops the header, and §3.6's table records it as non-propagating rather than leaving a
  reader to discover it.
- **Why:** enveloping the payload instead would have given one uniform mechanism, and it is refused:
  `publish`/`subscribe` is the cross-service integration surface, so a foreign consumer reading the
  topic would break — the M14d `rr.req.<topic>` wire change was acceptable precisely because RPC
  traffic is framework-internal, and plain pub/sub is not.
- **Test home:** one case per broker in its existing unit test, plus
  `messaging-plugin/test/integration/header-conformance.test.ts` driving all seven through the same
  publish-then-deliver assertion.

### 3.5a NATS needs its header factory retained

- **Decision:** `NatsBroker` keeps the `headers()` function off the module it already loads in
  `resolveClient`, and `NatsOptions` gains an optional `headersFactory?: () => INatsHeaders` for the
  injected-client path, where no module is loaded at all. With neither available the broker
  propagates nothing and reports that once at `warn`. On the read side the `MsgHdrs` object is
  converted through its `keys()`/`get()` members, never cast (D2).
- **Why:** §1's probe shows `MsgHdrs` is constructible only through `nats.headers()` and that a
  plain-object cast yields the object's private internals. An injected client is the test path and
  the bring-your-own-connection path; it carries no module, so the factory has to be a separate
  option rather than something derived.
- **Test home:** `messaging-plugin/test/unit/nats-broker.test.ts` (factory supplied, factory absent
  with the single warning, `MsgHdrs` read through `keys()`/`get()`) and the guarded
  `nats-real-import.test.ts` asserting the real `nats.headers()` reaches the broker.

### 3.6 `MessageMetadata.headers` stays optional and becomes a populated contract

- **Decision:** the member keeps its `headers?: Readonly<Record<string,string>>` shape — no `common`
  widening — and its JSDoc becomes a contract: **every first-party broker populates it on
  delivery**, with `{}` when the transport carried no headers, and it is absent only for a broker
  that has no header channel to read. A conformance test pins this for all seven, and the `custom`
  arm is documented as the one case where the value reflects whatever the application's broker
  supplies.
- **Why:** making it required would break any out-of-repo `IMessageBroker` implementor for no gain —
  the framework's own brokers are the only ones the milestone can fix, and a required member does
  not make a third-party broker populate it. Distinguishing `{}` from `undefined` is the part that
  carries information: `{}` means "read the channel, it was empty", `undefined` means "this
  transport has no channel", and the four brokers that currently omit the member conflate those.
- **Test home:** `messaging-plugin/test/integration/header-conformance.test.ts`.

### 3.7 Span names and attributes

- **Decision:** producer spans are named `publish <topic>` with kind `producer`; consumer spans are
  `receive <topic>` with kind `consumer`. Four attributes are set on both: `messaging.system` (the
  broker type string), `messaging.destination.name` (the topic), `messaging.operation` (`'publish'`
  / `'receive'`), and `messaging.message.id` when the metadata carries one. A handler throw sets
  `error` status and records the exception, which `withSpan` already owns.
- **Why:** these four are the OTel messaging attributes the framework can supply honestly from what
  it holds; anything further (batch sizes, partition ids, consumer group) is per-broker and belongs
  with the broader semantic-convention work deferred in §9.
- **Test home:** `messaging-plugin/test/unit/traced-broker.test.ts`.

### 3.8 Capability resolution and ordering

- **Decision:** `MessagingPlugin` resolves `CAPABILITIES.TELEMETRY` with `ctx.services.has` and adds
  it to `optionalDependencies` alongside `'logger'`. The resolved service is captured at
  `register()` time, but the **logger** used for the §3.5a and §3.1 warnings is read at call time
  through a thunk.
- **Why:** the `optionalDependencies` edge is what orders a replacement telemetry provider
  registered at a higher priority number ahead of messaging — M45b measured that priority alone is
  sufficient for the shipped plugin (30 against 500) and load-bearing only for that replacement
  case, so the edge is added for correctness and the plan does not overstate what it buys. The
  logger thunk is the M52b `waitUntil` lesson, restated by M52b's own `WorkersQueueOptions.logger`
  defect.
- **Test home:** `messaging-plugin/test/integration/messaging-telemetry.test.ts`, including a
  replacement provider registered at a higher priority number.

### 3.9 Four merged-code defects this work necessarily touches

- **Decision:** all four are fixed on this branch, each with a test that fails without the fix, and
  each recorded in `CHANGELOG.md`.
  - **D1 — Kafka publish leaks the whole payload into transport headers.** `kafka-broker.ts:329-333`
    passes `message as Record<string,string>` as `headers`, so every field of the payload is
    duplicated into Kafka headers, and a non-string field is not a legal `IHeaders` value (§1).
    Fixed to carry only the framework's own headers.
  - **D2 — NATS `metadata.headers` is the `MsgHdrs` internals.** `nats-broker.ts:409` casts
    `MsgHdrs` to `Record<string,string>`; the probe shows a real key reads `undefined` and
    `Object.keys` gives `['_code','_description','headers']`. Fixed by reading through
    `keys()`/`get()` per §3.5a.
  - **D3 — the Kafka read facade understates `IHeaders`.** `kafka-broker.ts:397` declares
    `headers: Record<string, Uint8Array>` while the real type admits `string`, arrays and
    `undefined` (§1), so `TextDecoder().decode(v)` on a string value is wrong. Fixed to the real
    union with per-value normalization.
  - **D4 — RabbitMQ promotes a payload field to transport metadata.** `rabbitmq-broker.ts:301-308`
    scans the payload for a `messageId` field and uses it as the AMQP `messageId`. Left **as
    behaviour** but documented, because changing it would alter the `messageId` an existing consumer
    observes; the fix is limited to no longer letting the payload reach the `headers` channel.
- **Why:** the milestone takes ownership of the header channel on exactly these brokers, so shipping
  a `traceparent` alongside a payload-derived header set would bake the defect in. D1 and D2 also
  mean the ROADMAP's premise needed correcting (C1).
- **Test home:** each broker's existing unit test file, plus the §3.5 conformance test.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                      | Kind             | Consumer / real code path that READS it                                                                                                                 |
| ------------------------------------------------------------------------------------ | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parseTraceparentToContext`                                                          | function         | `messaging-plugin`'s `TracedBroker` (consumer-side parenting) and `telemetry-plugin`'s `extractContextFromHeaders`, which now imports it from `common`. |
| `contextToTraceparent`                                                               | function         | `TracedBroker` (producer-side injection) and `telemetry-plugin`'s `buildTracerHost.injectContext` plus `telemetryMiddleware`'s response header.         |
| `extractContextFromHeaders`                                                          | function         | `telemetry-plugin`'s `buildTracerHost.extractContext`; also the read path for any transport that exposes a `Headers` object.                            |
| `TRACEPARENT_HEADER`                                                                 | const            | `TracedBroker` (both directions), `telemetryMiddleware`, and the §3.5 per-broker transport wiring — the one spelling of the name (§11.2).               |
| `TRACESTATE_HEADER`                                                                  | const            | `extractContextFromHeaders` and the §3.5 transport wiring where the channel carries it.                                                                 |
| `TracerHost` (`activate?`)                                                           | interface member | `TelemetryService.withSpan` calls it; `buildTracerHost` implements it. Both are real, non-test call paths.                                              |
| `IPubSubTransport` (3rd param, `attributes` on the delivered message)                | interface member | `GcpPubSubBroker.publish`/`subscribe`; the real `adaptPubSubModule` transport supplies it.                                                              |
| `IServiceBusTransport` (3rd param, `applicationProperties` on the delivered message) | interface member | `ServiceBusBroker.publish`/`subscribe`; the real `adaptServiceBusModule` transport supplies it.                                                         |
| `NatsOptions.headersFactory`                                                         | option           | `NatsBroker`'s publish path on the injected-client route (§3.5a).                                                                                       |
| `INatsHeaders`                                                                       | interface        | The type of `headersFactory`'s return and of the read-side conversion in `NatsBroker`; named because §5.2 forbids `any` at that boundary.               |

No symbol is added to `messaging-plugin`'s `src/index.ts`: `TracedBroker`, `publishWithHeaders` and
`subscribeWithHeaders` are internal (§3.3, §3.4), pinned by the existing
`messaging-plugin/test/unit/barrel-exports.test.ts` (the M56 defect class).

### 4.1 Options — every option names its consumer

| Option                                          | Consumer                                       | Behavior (per implementation)                                                                                                                                                         |
| ----------------------------------------------- | ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TelemetryPluginOptions.contextPropagation?`    | `TelemetryPlugin.register` → `buildTracerHost` | Default `true`: attempt the §3.1 context-manager registration and expose `activate`. `false`: skip both, so `withSpan` behaves exactly as it does in alpha.9. Read on both branches.  |
| `TelemetryPluginOptions.contextManagerFactory?` | `TelemetryPlugin.register`                     | Injectable seam returning a pre-built context manager, so the registration branch is unit-testable without the npm package — the `tracerProviderFactory` precedent.                   |
| `MessagingCommonOptions.tracing?`               | `MessagingPlugin.register`                     | Default `true`: wrap the adapter in `TracedBroker` when the telemetry capability resolves. `false`: register unwrapped even when telemetry is present. Read on both branches.         |
| `NatsOptions.headersFactory?`                   | `NatsBroker.publish`                           | Supplied: build `MsgHdrs` with it. Absent with an injected client: propagate nothing and warn once (§3.5a). Absent with a lazily-loaded module: the module's own `headers()` is used. |

## 5. Implementation files

| File                                                            | Purpose                                                                                                                                          |
| --------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/common/src/trace-context.ts`                          | The pure W3C codec and the two header-name constants (§3.2).                                                                                     |
| `packages/common/src/index.ts`                                  | Barrel: the five new symbols in §4.                                                                                                              |
| `packages/telemetry-plugin/src/tracing/tracer.ts`               | Delete the local codec and import from `common`; add `context.with` and `setGlobalContextManager` to the `OtelApi` facade; implement `activate`. |
| `packages/telemetry-plugin/src/tracing/context-manager.ts`      | The literal lazy `import()` of `@opentelemetry/context-async-hooks`, the registration branch, and its injectable seam (§3.1).                    |
| `packages/telemetry-plugin/src/services/telemetry-service.ts`   | `withSpan` runs `fn` inside `activate` when the host offers it.                                                                                  |
| `packages/telemetry-plugin/src/interfaces/index.ts`             | `TracerHost.activate?`; `contextPropagation` and `contextManagerFactory` options.                                                                |
| `packages/telemetry-plugin/src/plugin/telemetry-plugin.ts`      | Wire the two new options and report the registration outcome through the logger.                                                                 |
| `packages/messaging-plugin/src/tracing/traced-broker.ts`        | The single producer/consumer span decorator (§3.3).                                                                                              |
| `packages/messaging-plugin/src/brokers/message-broker.ts`       | The two new required internal members (§3.4).                                                                                                    |
| `packages/messaging-plugin/src/brokers/custom-adapter.ts`       | Implement them for the `custom` arm by dropping headers (§3.4).                                                                                  |
| `packages/messaging-plugin/src/brokers/in-memory-broker.ts`     | Carry headers in-process into `MessageMetadata` (§3.5, §3.6).                                                                                    |
| `packages/messaging-plugin/src/brokers/redis-streams-broker.ts` | Two extra `XADD` fields; read them back into `MessageMetadata`.                                                                                  |
| `packages/messaging-plugin/src/brokers/rabbitmq-broker.ts`      | Inject into `properties.headers`; stop letting the payload reach it (D4).                                                                        |
| `packages/messaging-plugin/src/brokers/nats-broker.ts`          | Retain `headers()`, add `headersFactory`, read `MsgHdrs` through `keys()`/`get()` (§3.5a, D2).                                                   |
| `packages/messaging-plugin/src/brokers/kafka-broker.ts`         | Carry only framework headers (D1); widen the read facade to the real `IHeaders` union (D3).                                                      |
| `packages/messaging-plugin/src/brokers/pubsub-broker.ts`        | `attributes` on both sides plus the facade widening (§3.5).                                                                                      |
| `packages/messaging-plugin/src/brokers/service-bus-broker.ts`   | `applicationProperties` on both sides plus the facade widening (§3.5).                                                                           |
| `packages/messaging-plugin/src/interfaces/index.ts`             | `MessagingCommonOptions.tracing`, `NatsOptions.headersFactory`, `INatsHeaders`.                                                                  |
| `packages/messaging-plugin/src/plugin/messaging-plugin.ts`      | Optional telemetry resolution, the `optionalDependencies` edge, and the wrap (§3.8).                                                             |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                               | src covered                                                 | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/trace-context.test.ts`                                                                                | `common/src/trace-context.ts`                               | Round-trip against `parseTraceparentToContext(header: string \| null): TelemetryContext` and `contextToTraceparent(context: TelemetryContext): string \| null`: valid header; malformed; version `01` rejected; `null` input; `tracestate` carried by `extractContextFromHeaders(headers: Headers)`; a context missing `spanId` formatting to `null`.         |
| `telemetry-plugin/test/unit/span-activation.test.ts`                                                                    | `services/telemetry-service.ts`, `interfaces/index.ts`      | A host with `activate` runs `fn` inside it; a host without one still runs `fn` (byte-identical alpha.9 path); a throw inside activation still reaches `setStatus('error')` + `recordException` + `end()` exactly once. Calls type-check against `activate?<T>(span: unknown, fn: () => Promise<T>): Promise<T>`.                                              |
| `telemetry-plugin/test/unit/context-manager.test.ts`                                                                    | `tracing/context-manager.ts`                                | The injectable seam covers all four branches: registration succeeds; the package is absent; `setGlobalContextManager` returns `false`; `contextPropagation: false` skips the attempt. Each non-success branch warns once and does not throw.                                                                                                                  |
| `telemetry-plugin/test/integration/context-manager-real.test.ts`                                                        | `tracing/context-manager.ts`, `tracing/tracer.ts`           | **Real-import test** (§12.2): the literal `import('npm:@opentelemetry/context-async-hooks@^2.0.0')` loads, registers, and a span created inside another `withSpan` shares its `traceId` and differs in `spanId`. Guarded so an absent package skips rather than fails.                                                                                        |
| `telemetry-plugin/test/unit/tracer-delegates-codec.test.ts`                                                             | `tracing/tracer.ts`                                         | `injectContext`/`extractContext` still round-trip after the codec moved, and the plugin declares no codec of its own — a compile-time assertion against the `common` import (the M70m barrel lesson).                                                                                                                                                         |
| `messaging-plugin/test/unit/traced-broker.test.ts`                                                                      | `tracing/traced-broker.ts`                                  | Producer span named `publish <topic>` with kind `producer` and the four §3.7 attributes; the formatted `traceparent` reaches `publishWithHeaders(topic, message, headers)`; a delivered header parents the consumer span through `SpanOptions.parentContext`; a throwing handler records the exception; no telemetry capability means no wrap and no span.    |
| `messaging-plugin/test/unit/custom-adapter.test.ts` (extended)                                                          | `brokers/custom-adapter.ts`                                 | The `custom` arm satisfies `publishWithHeaders`/`subscribeWithHeaders`, drops the headers, and does not throw; an instance already carrying the full internal seam is returned unchanged.                                                                                                                                                                     |
| `messaging-plugin/test/unit/{in-memory,redis-streams,rabbitmq,nats,kafka,pubsub,service-bus}-broker.test.ts` (extended) | the seven broker files                                      | Per broker: the transport call carries `traceparent` in that broker's channel; a delivered message surfaces it in `metadata.headers`. Plus the D1–D3 regression cases — Kafka headers contain no payload field, the Kafka read normalizes a `string` header value, and NATS reads through `keys()`/`get()` rather than a cast.                                |
| `messaging-plugin/test/integration/header-conformance.test.ts`                                                          | all seven brokers, `brokers/message-broker.ts`              | One publish-then-deliver assertion run across all seven: `metadata.headers` is present and carries the `traceparent`; a message published with no trace context yields `{}` and never `undefined` (§3.6).                                                                                                                                                     |
| `messaging-plugin/test/integration/messaging-telemetry.test.ts`                                                         | `plugin/messaging-plugin.ts`, `tracing/traced-broker.ts`    | Through a **real kernel application** with the real `TelemetryPlugin` and `LoggerPlugin`: a handler's `publish` produces a producer span whose `traceId` equals the request server span's, and the subscriber's consumer span shares it. Also `tracing: false`, a replacement telemetry provider at a higher priority number, and the absent-capability path. |
| `messaging-plugin/test/integration/rabbitmq-trace-real.test.ts`                                                         | `brokers/rabbitmq-broker.ts`                                | **Real backend** (RabbitMQ 4 in CI, guarded on `RABBITMQ_URL`): a `traceparent` published on one connection is read back from `properties.headers` on another. Not in `ALLOW_SKIP`, so a dropped service fails CI (the M70c precedent).                                                                                                                       |
| `messaging-plugin/test/integration/redis-trace-real.test.ts`                                                            | `brokers/redis-streams-broker.ts`                           | **Real backend** (Redis 7 in CI, guarded on `REDIS_URL`): the extra `XADD` fields survive a real round trip and do not disturb the `payload` field.                                                                                                                                                                                                           |
| `messaging-plugin/test/e2e/{pubsub,service-bus}-emulator.test.ts` (extended)                                            | `brokers/pubsub-broker.ts`, `brokers/service-bus-broker.ts` | Guarded emulator suites gain one assertion each: `attributes` / `applicationProperties` carry the header through the real emulator. Run locally per `docs/messaging-emulators.md`; CI does not host these.                                                                                                                                                    |
| `messaging-plugin/test/unit/nats-real-import.test.ts`                                                                   | `brokers/nats-broker.ts`                                    | **Real-import test**: the real `nats.headers()` builds a `MsgHdrs` the broker's publish path accepts, and the read conversion returns the value that was set.                                                                                                                                                                                                 |
| `messaging-plugin/test/unit/barrel-exports.test.ts` (extended)                                                          | `src/index.ts`                                              | The barrel gains nothing: `TracedBroker`, `publishWithHeaders` and `subscribeWithHeaders` are absent from the public surface.                                                                                                                                                                                                                                 |

Coverage: every `src` file in §5 is named above. Files whose new branches sit behind an external
import (`tracing/context-manager.ts`, the NATS header factory) keep their decidable logic in an
internal seam that the unit tests drive directly, with the real `import()` exercised once behind a
guard — the CLAUDE.md rule for external-dependency code.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m75-broker-trace-propagation, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task publish:check     # committed tree; catches slow types on the new common exports
deno task release:verify 0.1.0-alpha.9
```

Additional, because this milestone changes a published contract's behaviour and adds a dependency:

```bash
deno task check:apps                                   # apps/microservices exercises the broker
deno run --allow-read scripts/npm-specifier-audit.ts    # the new import() must be a literal
grep -rn "new Function\|eval(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" \
  packages/{common,messaging-plugin,telemetry-plugin}/src
```

The full suite must be run **twice** — once with the real backends up and once with them stopped —
per the M53 lesson that a guarded suite can pass for the wrong reason.

## 8. Risks & mitigations

- **The global context manager is a process-wide side effect.** A host application that has already
  registered its own manager will make `setGlobalContextManager` return `false`. Mitigation: treat
  that as a success for the host's purposes, warn once naming the situation, and expose `activate`
  anyway — the host's manager will carry the context. A test covers the `false` branch.
- **`AsyncLocalStorage` availability off Deno and Node is unverified here.** The probe covered Deno
  only. Mitigation: probe Bun and real workerd (`apps/cloudflare` + `wrangler dev` already exists in
  this repository) during implementation, and where it is unavailable **omit** `activate` rather
  than shipping a silent no-op — the M70k `reportsExit?` rule. Record the per-runtime answer in
  `PUBLIC_API.md`.
- **Span activation is a behaviour change to a released API.** Spans that were roots become
  children. Mitigation: `contextPropagation` defaults to `true` because a tracer that does not nest
  is the defect, but the CHANGELOG entry states the change with migration text, and existing tests
  that assert flat parentage are expected to need updating — a re-run of the full suite after §3.1
  is a required step, not an optional one.
- **A one-milestone scope across seven brokers plus two packages is large.** Mitigation: the
  per-broker work is only transport plumbing because §3.3 puts all span logic in one decorator, and
  §3.5's table fixes the shape of each broker's change before implementation starts. If the two
  cloud brokers' emulator verification proves unreachable, they ship the plumbing with the guarded
  suites and the fact is stated, never implied.
- **A contract-violating test double could hide the whole thing.** This repository's most repeated
  root cause, and it is acute here: a fake transport that accepts a third argument it ignores would
  pass every unit test while the real SDK dropped the header. Mitigation: the real-backend and
  real-import tests in §6 are deliverables, not notes, and each new assertion is verified to fail
  when its `src` change is reverted.
- **`deno doc --lint` debt.** New exports in `common` add JSDoc surface; the M38 ratchet fails a run
  that drifts. Mitigation: full JSDoc with `@param`/`@returns`/`@since` on all five new `common`
  exports, and re-read `DOC_LINT_BASELINE` after the change.

## 9. Out of scope

- **`queue-plugin` and `cloudflare-plugin` trace propagation** — the same mechanism applies to
  `RedisQueue`, `RabbitMqQueue`, `SqsQueue`, `WorkersQueue` and `WorkersBroker`, but each is a
  distinct transport with its own real-backend gate. Recommended as **M75b**.
- **`baggage` propagation** — the W3C `baggage` header carries application-defined key/values
  alongside `traceparent`. `TelemetryContext` has no member for it and adding one is a `common`
  widening with no reader in this milestone (the dead-surface rule). Belongs with M75b.
- **Full OTel messaging semantic conventions** — batch attributes, partition and offset,
  consumer-group identity, and the `messaging.batch.message_count` family. §3.7 ships the four
  attributes the framework can supply honestly; the rest are per-broker and want their own
  milestone.
- **Metrics and log correlation** — emitting `trace_id`/`span_id` into `ILogger` output and
  exemplars into `IMetricsService`. Both are separate capabilities with their own contracts.
- **Retiring `experimentalDecorators`** — **M76** owns it.
