# Milestone 90i — Observability That Joins Up (`@setu-ts/common`, `@setu-ts/queue-plugin`, `@setu-ts/logger-plugin`, `@setu-ts/telemetry-plugin`)

> **Status:** Planning. Branch: `feat/m90i-observability-that-joins-up`. `main` is protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Three findings, one question: **can an operator follow a single request through the system?** X34
answered the positive half — the broker hop carries the trace across a process boundary with an
unbroken parent chain, matched by trace id in a different process, and demonstrably via the header
rather than ambient context, which is what M75 could not prove in-repo. So the capability exists and
works. What is missing is a **channel** on one ingress and a **bridge** to one sink.

X34-1 and X29-3 are the same defect measured twice: a queue job carries no trace. The distinction
that shapes the fix is that this is a **designed capability gap**, not an adapter declining to read
something — `AddJobOptions` is `{ delayMs?, maxAttempts? }`, `IJob` is
`{ id, name, data, attempts }`, `grep -c headers` over `common/src/services/queue.ts` is **0**, and
M86's own `IngressContext.headers` says so outright ("populated on the `'messaging'` arm only …
absent means there was no channel"). Messaging got trace propagation in M75 _because_
`MessageMetadata.headers` existed to carry it. X34-2 is the other end:
`grep -rn
"traceId|trace_id|spanId|traceparent"` over `packages/logger-plugin/src` returns nothing,
so an operator holding a trace id cannot find the log lines and an operator holding a log line
cannot find the trace. Every signal the framework emits is individually good and mutually
unjoinable.

**One plan claim from the ROADMAP does not survive source-checking, and it changes the shape of the
X34-2 half.** The suggested fix — "enrich each record with the active span's `trace_id`/`span_id`,
read optionally exactly as M45b reads `CAPABILITIES.METRICS`" — describes the _resolution_ correctly
and is **not implementable through the committed contract**: `ITelemetryService` has exactly **one**
member, `withSpan<T>(name, fn, options?)` (`common/src/services/telemetry.ts`), and no way to read
the span that is currently active. So X34-2 needs a `common` widening of its own, not just an
optional capability read.

- **In scope:** X34-1 / X29-3 (`AddJobOptions.headers?` and `IJob.headers?` in `common`, a
  `TracedQueue` decorator on the `TracedBroker` shape, and the four in-repo queue adapters carrying
  the channel), X34-2 (an optional `ITelemetryService.activeSpanContext?`, implemented by
  `TelemetryService`, and a trace-enriching logger decorator), and the doc deliverables C1–C3.
- **NOT this milestone:** The **scheduler**. X34 records its fresh root as **correct** — a tick has
  no upstream request — so `common/src/services/scheduler.ts` gains no header channel, and §3.7
  states why rather than leaving the asymmetry unexplained. `cloudflare-plugin`'s `WorkersQueue`
  (§9). Audit entries and metrics exemplars, which are the other two joins X29 asked about and
  neither of which has a finding. Any change to the trace-context codec, which M75 promoted into
  `common` and which is reused here unchanged.

## 0.1 Plan corrections — four claims that did not survive source-checking

Written before implementation, per CLAUDE.md's "a plan that fails a checklist item gets fixed as a
plan first". Each was established by reading the code or by running a probe, not by argument.

| #  | Claim as written                                                                                                 | What the source says                                                                                                                                                                                                                                                                                                                                  | Correction                                                                                                                                                                                                                                                                                                                                                                                                                      |
| -- | ---------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| P1 | §5: "`logger-plugin.ts`: `optionalDependencies` gains `CAPABILITIES.TELEMETRY`".                                 | `TelemetryPlugin` ALREADY declares `optionalDependencies: [CAPABILITIES.LOGGER]` (`telemetry-plugin.ts:142`), and `plugin-resolver.ts:49-53` makes an optional dependency a REAL graph edge whose cycle THROWS (`:169`). **Probed**: the added edge yields `Circular plugin dependency detected: logger-plugin -> telemetry-plugin -> logger-plugin`. | **The edge is NOT added.** It would make every application registering both plugins fail at `start()` — the exact composition this milestone exists to serve. The call-time thunk (§3.5) is the whole mechanism, and the existing edge makes it MANDATORY rather than merely prudent: the resolver orders `logger-plugin` BEFORE `telemetry-plugin` (probed), so telemetry is definitively absent at the logger's `register()`. |
| P2 | §3.2: "`QueuePlugin` registers the wrapper under `CAPABILITIES.QUEUE`" — as if registration were the only reach. | Declared processors are registered on the raw service, not the registered capability: `queue-plugin.ts:239` and `:288` both call `service.process(...)`. A wrapper reachable only through the token would be bypassed by the entire `processors` option arm (M70d/M86) — the shape a CLI-scaffolded application uses.                                 | The plugin holds ONE `registrar: IQueue` (the wrapper when telemetry is present, the service otherwise) and routes **both** `process()` sites and `ctx.services.register` through it. Without this the queue hop stays orphaned for exactly the declarative applications.                                                                                                                                                       |
| P3 | §3.5: "wraps the resolved `ILogger`" — enumerating the six level methods.                                        | `ILogger` also declares `child(bindings)` (`common/src/services/logger.ts:80`), and the framework's OWN request logger calls it (`request-logger.ts:71`, `logger.child({ requestId: ctx.id })`).                                                                                                                                                      | The decorator MUST decorate `child()` too. Otherwise the framework's own request log lines — the ones X34-2 most wants joined — carry no `trace_id`, while every unit test on the decorator passes.                                                                                                                                                                                                                             |
| P4 | §3.4: "`rabbitmq-queue.ts` and `sqs-queue.ts` each carry it explicitly" — two adapters needing real work.        | `rabbitmq-queue.ts:320` is `Buffer.from(JSON.stringify(job))` — the WHOLE job, so it carries the map for free exactly as memory (`:99`, `{ ...job }`) and redis (`:192`) do. Only `sqs-queue.ts:336` builds an explicit `{ v, id, name, data, maxAttempts }` envelope and re-validates it on `reserve` (`:384`).                                      | **Three adapters are free; only SQS needs work**, on both the write and the validated read. Carrying is via the framework's own envelope in all four; the plan's extra suggestion of ALSO writing native AMQP/SQS message attributes is dropped as scope (§9).                                                                                                                                                                  |

**One design consequence recorded rather than left implicit.** With `TracedQueue` as the outermost
`IQueue`, a declared M86 ingress behaviour runs OUTSIDE the consumer span, because the behaviour
chain is applied by a `QueueService` SUBCLASS (`BehaviorChainQueueService`) and a subclass is
necessarily inner-at-registration, hence outer-at-dispatch. Messaging composes the other way round
(`PipelinedBroker(TracedBroker(broker))`, `messaging-plugin.ts:367,385`), so there a behaviour runs
INSIDE the span. The asymmetry is accepted for this milestone and is stated in the decorator's JSDoc
and in §9: X34's own "Still to run" defers the behaviour chain as an observation point, the
processor's own span — which is what X34-1 measured — IS correctly parented in both orders, and with
no behaviours declared (the default, and the only case the plain `QueueService` is constructed for)
the question does not arise. Closing it means converting M86's subclass into a wrapper, which is a
rewrite of a shipped milestone (§16.4) and belongs to whoever measures the behaviour hop.

## 1. Contracts verified from SOURCE (not names)

| Reference                                     | Source (file:line)                                                        | Verified surface / fact                                                                                                                                                                                                                                                    |
| --------------------------------------------- | ------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| the queue contract's whole surface            | `common/src/services/queue.ts:14-23,39-44`                                | `IJob<T> = { id, name, data, attempts }` and `AddJobOptions = { delayMs?, maxAttempts? }`. **Neither type declares a header member** — the channel does not exist rather than being unread.                                                                                |
| the model to mirror                           | `common/src/services/messaging.ts:14-26`                                  | `MessageMetadata.headers?: Readonly<Record<string, string>>` with the documented "`{}` means the channel was read and was empty". The exact shape and the exact semantics X34-1 asks for.                                                                                  |
| the telemetry service's whole surface         | `common/src/services/telemetry.ts` (`ITelemetryService`)                  | **One member**: `withSpan<T>(name, fn: (span: ISpan) => Promise<T>, options?)`. There is **no active-span accessor**, so a logger cannot ask what span is running. This is the ROADMAP correction in §0.                                                                   |
| what a span can report                        | `common/src/services/telemetry.ts:141`                                    | `ISpan.spanContext(): SpanContext` — so the identifiers exist and are already a `common` type; only the _reachability_ of the active one is missing.                                                                                                                       |
| the codec is already shared                   | `common/src/trace-context.ts:11,14,30,51,71`                              | `TRACEPARENT_HEADER`, `TRACESTATE_HEADER`, `parseTraceparentToContext`, `contextToTraceparent`, `extractContextFromHeaders` — promoted in M75 "precisely so more than one package could carry a `traceparent`".                                                            |
| the decorator shape to copy                   | `messaging-plugin/src/tracing/traced-broker.ts:18-70`                     | `TracedBroker implements MessageBrokerAdapter`, holds the wrapped adapter plus an `ITelemetryService`, and injects `traceparent` inside `withSpan` on publish. Applied at `messaging-plugin.ts:365`.                                                                       |
| the four in-repo queue adapters               | `queue-plugin/src/adapters/`                                              | `memory-queue.ts`, `redis-queue.ts`, `rabbitmq-queue.ts`, `sqs-queue.ts`, behind the internal `queue-adapter.ts` seam.                                                                                                                                                     |
| **what the adapter seam does NOT carry**      | `queue-plugin/src/adapters/queue-adapter.ts:41-193`                       | `connect`/`disconnect`/`isReady`/`enqueue`/`reserve`/`ack`/`requeue`/`deadLetter`/`storeRecurring`/`fetchRecurringDue`/`advanceRecurring`. **No `AddJobOptions` and no processor invocation** — so a decorator here could neither inject nor start a consumer span (§3.2). |
| who owns `add` and dispatch                   | `queue-plugin/src/services/queue-service.ts:75,175,181,400`               | `QueueService implements IQueue`; `add<T>(name, data, options?)` builds the `StoredJob`, and `#dispatchJob` invokes the registered processor. This is the layer §3.2 wraps.                                                                                                |
| where the service is constructed              | `queue-plugin/src/plugin/queue-plugin.ts:218`                             | `new QueueService(adapter, runtime, serviceOptions)` — the one site the wrapper is applied at.                                                                                                                                                                             |
| the internal persisted envelope               | `queue-plugin/src/interfaces/index.ts:132-155`                            | `StoredJob<T> = { id, name, data, attempts, maxAttempts, availableAtMs, claimToken?, … }`. Plugin-internal, so adding `headers?` needs no `common` change beyond `IJob`.                                                                                                   |
| one adapter carries it for free               | `queue-plugin/src/adapters/redis-queue.ts:192`                            | `await this.#client.hset(jobsKey, job.id, JSON.stringify(job));` — the **whole job** is serialized, so a new optional member on `IJob` round-trips with no adapter change. Named because it makes the work uneven, not uniform.                                            |
| the optional-capability precedent             | `worker-pool-plugin/src/plugin/…:52,57`                                   | `optionalDependencies: ['logger', CAPABILITIES.METRICS]` then `ctx.services.has(CAPABILITIES.METRICS) ? … : …`. M45b's shape, and the one the logger decorator follows.                                                                                                    |
| the read-at-call-time lesson                  | M52b (`WorkersQueueOptions.logger`) and M45b                              | A capability captured at `register()` silences everything registered afterwards; it must be read through a thunk at call time.                                                                                                                                             |
| the guard-every-call lesson                   | M45b code review                                                          | Every call into a replaceable capability is guarded, because an instrument or a service that throws turns the reporting path into the fault. The logger decorator inherits this rule verbatim.                                                                             |
| activation is what makes an active span exist | M75 (`TracedBroker`, `TelemetryService.withSpan`, `TracerHost.activate?`) | M75 registered an `AsyncLocalStorageContextManager` and made `withSpan` call `context.with`. Without that there is no active span to read, so X34-2's fix is only possible **after** M75 — recorded rather than assumed.                                                   |
| the two service implementations               | `telemetry-plugin/src/services/telemetry-service.ts:131,221`              | `TelemetryService` and `NoopTelemetryService`, both `implements ITelemetryService`. An optional member is implemented by the first and omitted by the second.                                                                                                              |
| the logger implementations                    | `logger-plugin/src/loggers/`                                              | `console-logger.ts`, `pino-logger.ts`, `noop-logger.ts`, plus `normalize-metadata.ts`. Both real loggers use `#` private fields, so a **detached method** breaks them (M52c) — which constrains §3.5's decorator.                                                          |
| the measured asymmetry                        | `smoke/X34-FINDINGS.md` (X34-1)                                           | In one run: `receive x34.orders` and `x34.broker.handle` join the request trace; `x34.queue.handle` is orphaned with `parent=-`; `x34.scheduler.handle` has its own trace **correctly**. The run is its own control.                                                       |
| the cross-process proof                       | `smoke/X29-FINDINGS.md` (X29-3)                                           | 3 spans on trace `b4509aaa…` in the producer, the same id received in a different process — the hop carries _the request's_ trace, which is the assertion M75's own review found missing in-repo.                                                                          |
| §2.2 dependency direction                     | `AI_GUIDELINES.md` §2.2                                                   | `logger-plugin` may not import `telemetry-plugin`. The bridge is `CAPABILITIES.TELEMETRY` plus a `common` contract member — the channel, exactly as M75's codec is.                                                                                                        |
| §10.2 / §16.1 approval                        | `AI_GUIDELINES.md` §10.2, §16.1                                           | Three `common` additions, each needing a `PUBLIC_API.md` row in the same PR.                                                                                                                                                                                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                | Resolution (picked side)                                                                                                                                                           | Doc deliverable (same PR)                                                                                                                              |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | The ROADMAP's M90i section says X34-2 is fixed by reading the active span "exactly as M45b reads `CAPABILITIES.METRICS`". `ITelemetryService` has one member and no active-span accessor, so it is not. | The resolution pattern is right and the read is unavailable. Add the accessor as an **optional** contract member and keep the M45b resolution shape for the capability itself.     | ROADMAP M90i bullet corrected to name the `common` widening; `PUBLIC_API.md` telemetry section documents `activeSpanContext?`.                         |
| C2 | `M86`'s `IngressContext.headers` JSDoc states headers are "populated on the `'messaging'` arm only … absent means there was no channel" — accurate today and false the moment the queue carries one.    | The JSDoc is a statement about current capability, and this milestone changes the capability. Update it in the same PR rather than leaving a contract comment that has gone stale. | `common` `IngressContext.headers` JSDoc updated to name both arms and to keep the scheduler's absence explicit (§3.7).                                 |
| C3 | Neither `queue-plugin`'s README nor `PUBLIC_API.md` says the queue is a trace boundary, so a reader who has seen M75's messaging work reasonably assumes the queue behaves the same way. X29-3 says so. | The behaviour changes, so the assumption becomes correct — and the docs state what is propagated, by which adapters, and what a missing header means.                              | `queue-plugin` README and `PUBLIC_API.md` gain a propagation section; `logger-plugin`'s gain the enrichment fields and the absent-telemetry behaviour. |

## 3. Design decisions

### 3.1 The queue channel mirrors `MessageMetadata.headers` exactly

- **Decision:** `AddJobOptions.headers?: Readonly<Record<string, string>>` and
  `IJob.headers?: Readonly<Record<string, string>>`, both optional, with `MessageMetadata.headers`'s
  documented semantics copied verbatim: `{}` means the channel was read and carried nothing;
  **absent** means there was no channel.
- **Why:** the M75 injection path then applies unchanged, and the two ingresses cannot drift on
  meaning — which is the whole reason X34-1 asks for a mirror rather than a new shape. Optional
  keeps every out-of-repo `IQueue` implementor source-compatible (the M42 `signal?` / M44 `fs?`
  precedent), and it makes the honest three-state distinction available: an adapter that cannot
  carry headers omits the member rather than reporting `{}`, which is the same ambiguity M70k had to
  invent `IWorkerHost.reportsExit?` to resolve.
- **Test home:** `common/test/unit/queue-contract.test.ts` (type-level: an implementor omitting both
  still satisfies the contract) and `queue-plugin/test/integration/header-conformance.test.ts`.

### 3.2 One `TracedQueue` decorator, wrapping `IQueue` — **not** the adapter

- **Decision:** `queue-plugin/src/tracing/traced-queue.ts` implements `IQueue` and wraps the
  constructed `QueueService` (`queue-plugin.ts:218`); `QueuePlugin` holds it as the single
  `registrar: IQueue` when `CAPABILITIES.TELEMETRY` is present and routes BOTH
  `ctx.services.register` AND every `process()` registration site through it (§0.1 P2 — registering
  it under the token alone would leave the entire declarative `processors` arm untraced).
  `add(name, data, options)` injects `traceparent` into `options.headers` inside a producer span,
  and `process(name, processor,
  options)` wraps the caller's processor so each job starts a
  consumer span parented from `job.headers`. **No adapter contains any tracing code**, and
  `StoredJob` gains an internal `headers?` so the map survives persistence.
- **Why:** the decorator SHAPE is `TracedBroker`'s; the LAYER is not, and getting that wrong is the
  trap. `QueueAdapter` (`adapters/queue-adapter.ts:41-193`) is
  `connect`/`disconnect`/`isReady`/`enqueue`/`reserve`/`ack`/`requeue`/`deadLetter`/`storeRecurring`
  — storage operations. It never sees `AddJobOptions` (`QueueService.add` at `:175` builds the
  `StoredJob` at `:181`) and it never invokes a processor (`#dispatchJob` at `:400` does), so a
  decorator at that seam could inject nothing and could not create the consumer span at all.
  Wrapping the service is the only layer where both halves of the trace are reachable, and it still
  keeps extraction in ONE place rather than four — the split that produced X31-1 in `static-plugin`
  and the duplicate-conditional defect in M90e. The health indicator and M70k's depth reads go
  through the adapter and are untouched.
- **Test home:** `queue-plugin/test/unit/traced-queue.test.ts` and
  `queue-plugin/test/integration/trace-continuity-real.test.ts`.

### 3.3 The queue ingress envelope carries the header too

- **Decision:** `withIngressBehaviors` (`queue-plugin/src/processors/job-processor.ts:203`) adds the
  header map to the `IngressContext` it builds **through a conditional spread**
  (`...(job.headers === undefined ? {} : { headers: job.headers })`), never `headers: job.headers`,
  so an M86 queue behaviour reads the channel the same way the `'messaging'` arm's does. The map
  must be carried end to end for that to mean anything: `QueueService.add` copies `options.headers`
  onto the `StoredJob` (`queue-service.ts:181`) and `runJob` copies `storedJob.headers` onto the
  `IJob` it hands the processor — without both hops `job.headers` is always `undefined` and this
  section is decorative.
- **Why:** the spread rather than the plain assignment is the care that matters here:
  `headers:
  job.headers` on an absent map creates an **own property whose value is `undefined`**,
  so a behaviour testing presence (`'headers' in ctx`) sees a channel that does not exist — the
  precise inversion of the contract, and the `exactOptionalPropertyTypes` trap this repository
  documents. The envelope is `{ kind: 'queue', name, payload: job, attempt }` today — no `headers` —
  and M86's own contract says `IngressContext.headers` **absent means there was no channel**. After
  §3.1 the queue HAS one, so leaving the member absent would state something false about the
  capability, which is the ambiguity §3.1 exists to remove. A behaviour could reach
  `ctx.payload.headers` regardless, but then the two ingress arms would be read differently for one
  concept, which is the drift a shared envelope exists to prevent.
- **Test home:** `queue-plugin/test/integration/queue-behaviors.test.ts` (extended) — a behaviour
  observes the value when a job carries headers, and observes the member **absent** when it does
  not.

### 3.4 Every adapter carries the map, and the two that need real work are named

- **Decision:** `memory-queue.ts` and `redis-queue.ts` carry it with no change to their envelopes —
  Redis serializes the whole job (`redis-queue.ts:192`) and memory holds the object.
  `rabbitmq-queue.ts` is free for the same reason (`:320` serializes the whole job). **Only
  `sqs-queue.ts` needs work**, on both sides: it builds an explicit
  `{ v, id, name, data, maxAttempts }` envelope (`:336`) and re-validates it on `reserve` (`:384`),
  so the member is added to the envelope, the validator and the post-validation cast (§0.1 P4).
- **Why:** stating which adapters are free and which are not is what keeps a plan honest — the work
  is uneven, and the first draft of this section got the split WRONG (§0.1 P4), which is exactly the
  mistake a table claiming four equal changes would have hidden. Carrying the map inside the
  framework's own envelope is what every adapter already does for `data` and `maxAttempts`, so it
  needs no new transport concept; writing native AMQP properties or SQS message attributes IN
  ADDITION would make the `traceparent` visible to the broker's own tooling, which is real value and
  is deliberately deferred as scope (§9).
- **Test home:** `queue-plugin/test/integration/outage-real.test.ts`'s neighbours — a guarded
  RabbitMQ case and a guarded ElasticMQ case asserting the header on the wire, plus unit cases for
  memory and Redis.

### 3.5 `activeSpanContext?` is an optional `common` member, read through a guarded decorator

- **Decision:** `ITelemetryService` gains `activeSpanContext?(): SpanContext | undefined`.
  `TelemetryService` implements it over the OTel context manager M75 registers;
  `NoopTelemetryService` omits it. `logger-plugin` gains an internal `TraceEnrichedLogger` decorator
  that wraps the resolved `ILogger` — **all six level methods AND `child()`** (§0.1 P3) — resolves
  `CAPABILITIES.TELEMETRY` through a **thunk at call time**, guards every call, and merges
  `trace_id`/`span_id` into each record's metadata.
- **Why:** an optional member keeps every implementor source-compatible while making the absent case
  meaningful — a service that cannot report an active span omits the method, and the logger then
  enriches nothing rather than emitting empty strings. A **decorator** rather than an edit to
  `console-logger.ts` and `pino-logger.ts`: both use `#` private fields, so the enrichment must call
  through the instance (M52c's detached-method defect), and a decorator also covers a custom
  `ILogger` an application registers. Reading through a thunk is M52b's lesson — a capability
  captured at `register()` silences everything registered afterwards — and guarding every call is
  M45b's, because a telemetry service that throws must never turn the logging path into the fault.
- **Test home:** `telemetry-plugin/test/unit/active-span-context.test.ts`,
  `logger-plugin/test/unit/trace-enriched-logger.test.ts` (including a throwing telemetry service
  and a service omitting the member), and `logger-plugin/test/integration/log-trace-join.test.ts`.

### 3.6 The record fields are `trace_id` and `span_id`, in snake case, deliberately

- **Decision:** the two enrichment fields are named `trace_id` and `span_id`, departing from the
  framework's own camelCase metadata convention (`requestId`).
- **Why:** these fields exist to be consumed by a log backend, and the OpenTelemetry log-correlation
  convention — the one Loki, Elastic and the OTel collector's own processors key on — is snake case.
  A camelCase spelling would be internally consistent and would not join up in any of the tools the
  join exists for, which is the whole finding. The departure is documented where the fields are, so
  it reads as a decision rather than an inconsistency.
- **Test home:** `logger-plugin/test/unit/trace-enriched-logger.test.ts` asserts the exact keys.

### 3.7 The scheduler gets no header channel, and the asymmetry is documented

- **Decision:** `common/src/services/scheduler.ts` is unchanged. `IngressContext.headers` stays
  **absent** on the `'scheduler'` arm, and the JSDoc says why.
- **Why:** X34 measured the scheduler's fresh root and recorded it as **correct** — a tick has no
  upstream request, so a parent would be a fabrication. Adding the member "for symmetry" would
  create exactly the ambiguity §3.1 exists to remove: an operator could no longer tell "this work
  had no cause" from "the cause was lost", which X34-1 names as the thing an orphaned trace cannot
  signal. Leaving it out is the decision; documenting it is what stops the next reader filing it as
  an oversight.
- **Test home:** `common/test/unit/ingress-contract.test.ts` (extended) pins that the scheduler arm
  carries no headers.

### 3.8 Absent telemetry changes nothing, and that is pinned

- **Decision:** with no `CAPABILITIES.TELEMETRY` registered, nothing is **injected** — a job carries
  no framework-written `traceparent` and a log record carries no `trace_id`/`span_id`, which is
  byte-identical to today on both paths. A `headers` map the **caller** passed in `AddJobOptions` is
  still carried end to end: `headers` is a public option on a public contract, so its delivery
  cannot depend on which capabilities happen to be registered. Absent telemetry the member is absent
  only when the caller supplied none.
- **Why:** this is the M45b contract and the reason both reads are optional. It also keeps the
  three-state semantics honest: absent means no channel, and an application without telemetry has
  none.
- **Test home:** `queue-plugin/test/integration/no-options-unchanged.test.ts` (extended) and
  `logger-plugin/test/integration/no-telemetry-unchanged.test.ts`.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                      | Kind   | Consumer / real code path that READS it                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------- | ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `AddJobOptions.headers?` (`common`)                  | member | Written by `TracedQueue.add`; read by every queue adapter's enqueue path.                                                                                                                                                                                                                                                                                                                                                   |
| `IJob.headers?` (`common`)                           | member | Written by every adapter's dispatch path; read by `TracedQueue`'s consumer span and by an application's processor.                                                                                                                                                                                                                                                                                                          |
| `ITelemetryService.activeSpanContext?` (`common`)    | member | Implemented by `TelemetryService`; **read by `logger-plugin`'s `TraceEnrichedLogger`**, which is the consumer that makes it more than a getter.                                                                                                                                                                                                                                                                             |
| `TracerHost.activeSpanContext?` (`telemetry-plugin`) | member | `TracerHost` IS barrel-exported (`telemetry-plugin/src/index.ts:21`), so this is a public widening and needs its own `PUBLIC_API.md` row. Read by `TelemetryService.activeSpanContext`; it is the only place the OTel context is reachable, since `ITelemetryService` cannot see one. Optional, so a custom `tracerProviderFactory` host omitting it still satisfies the interface and correctly reports "cannot tell you". |

`queue-plugin`, `logger-plugin` and `telemetry-plugin` export **nothing new** — `TracedQueue` and
`TraceEnrichedLogger` are internal, exactly as `TracedBroker` is (`messaging-plugin/src/index.ts`
does not export it). A `barrel-exports.test.ts` case in each pins that (the M56 defect class).

### 4.1 Options — every option names its consumer

| Option     | Consumer | Behavior (per implementation)                                                                                                                                                                                               |
| ---------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| None added | —        | Both behaviours are gated on `CAPABILITIES.TELEMETRY` being registered, which is already an explicit application choice. A second opt-in would be an option whose only honest value is "yes" whenever telemetry is present. |

## 5. Implementation files

| File                                                             | Purpose                                                                                                                                                         |
| ---------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/src/services/queue.ts`                                   | `AddJobOptions.headers?`, `IJob.headers?`, with `MessageMetadata.headers`'s semantics.                                                                          |
| `common/src/services/telemetry.ts`                               | `ITelemetryService.activeSpanContext?`.                                                                                                                         |
| `common/src/services/ingress.ts` (JSDoc only)                    | C2 — the `IngressContext.headers` statement, and the scheduler's deliberate absence.                                                                            |
| `queue-plugin/src/tracing/traced-queue.ts`                       | The decorator over `IQueue` (§3.2).                                                                                                                             |
| `queue-plugin/src/plugin/queue-plugin.ts`                        | `optionalDependencies` gains `CAPABILITIES.TELEMETRY`; the constructed service is wrapped into the single `registrar` used by both `process()` sites (§0.1 P2). |
| `queue-plugin/src/processors/job-processor.ts`                   | `withIngressBehaviors` adds `headers` to the `IngressContext` by conditional spread; `runJob` copies `storedJob.headers` onto the delivered `IJob` (§3.3).      |
| `queue-plugin/src/services/queue-service.ts`                     | `add` copies `AddJobOptions.headers` onto the `StoredJob` (§3.3).                                                                                               |
| `queue-plugin/src/adapters/{memory,redis,rabbitmq,sqs}-queue.ts` | Carry the map (§3.4).                                                                                                                                           |
| `queue-plugin/src/interfaces/index.ts`                           | `StoredJob.headers?`, so the map survives persistence (§3.2).                                                                                                   |
| `telemetry-plugin/src/services/telemetry-service.ts`             | `activeSpanContext` on `TelemetryService`; `NoopTelemetryService` omits it.                                                                                     |
| `logger-plugin/src/loggers/trace-enriched-logger.ts`             | The decorator.                                                                                                                                                  |
| `logger-plugin/src/plugin/logger-plugin.ts`                      | Wraps the resolved logger. **No `optionalDependencies` change** — that edge is a startup-breaking cycle (§0.1 P1).                                              |
| `README.md` × 2, `PUBLIC_API.md`, `ROADMAP.md`, `CHANGELOG.md`   | C1–C3 and the two feature entries.                                                                                                                              |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                     | src covered                        | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------------- | ---------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/queue-contract.test.ts` (new)                               | `services/queue.ts`                | Type-level: an `IQueue` implementation omitting `headers` on both types still satisfies the contract (the M55 `runtime-contracts` precedent).                                                                                                                                                                                                                                                                          |
| `common/test/unit/ingress-contract.test.ts` (extended)                        | `services/ingress.ts`              | The scheduler arm carries no headers; the queue arm now may (§3.7).                                                                                                                                                                                                                                                                                                                                                    |
| `queue-plugin/test/unit/traced-queue.test.ts` (new)                           | `tracing/traced-queue.ts`          | `add` injects a well-formed `traceparent` into `AddJobOptions.headers` under a producer span; a processor registered through the wrapper is invoked with its span parented to the context extracted from `job.headers`; a job with **no** headers starts a root span and does not throw; a telemetry service that throws leaves both `add` and dispatch working.                                                       |
| `queue-plugin/test/unit/{memory,redis,rabbitmq,sqs}-queue.test.ts` (extended) | each adapter                       | Headers survive enqueue → reserve → dispatch; an adapter given no headers omits the member rather than reporting `{}`.                                                                                                                                                                                                                                                                                                 |
| `queue-plugin/test/integration/queue-behaviors.test.ts` (extended)            | `processors/job-processor.ts`      | An ingress behaviour reads `ctx.headers` for a job that carries them, and for one that does not the member is **absent** rather than present-and-`undefined` — asserted with `'headers' in ctx`, the only check that separates the two (§3.3).                                                                                                                                                                         |
| `queue-plugin/test/unit/queue-service.test.ts` (extended)                     | `services/queue-service.ts`        | `add({ headers })` with no telemetry registered delivers that exact map to the processor through `StoredJob` → `IJob`, and `add()` with none leaves the member absent at both hops.                                                                                                                                                                                                                                    |
| `queue-plugin/test/integration/header-conformance.test.ts` (new)              | all four adapters                  | One table over four adapters, so an adapter that stops carrying the map fails here rather than in its own file — the `messaging-plugin` precedent.                                                                                                                                                                                                                                                                     |
| `queue-plugin/test/integration/trace-continuity-real.test.ts` (new)           | `tracing/traced-queue.ts`          | Guarded on `REDIS_URL` and `RABBITMQ_URL`, with the real OTel API and SDK: `POST /order` → `add` → `handle` is **one trace** with an unbroken parent chain. The X29-3 shape, asserted by matching the id rather than `toBeDefined()` (M75's own review lesson).                                                                                                                                                        |
| `queue-plugin/test/integration/no-options-unchanged.test.ts` (extended)       | `plugin/queue-plugin.ts`           | Without telemetry, a job enqueued with no `headers` is byte-identical to today, **and** a job enqueued WITH caller-supplied `headers` delivers them unchanged (§3.8) — the two cases together are what stop delivery depending on capability registration.                                                                                                                                                             |
| `telemetry-plugin/test/unit/active-span-context.test.ts` (new)                | `services/telemetry-service.ts`    | Inside `withSpan`, `activeSpanContext()` reports the running span's ids; outside any span it reports `undefined`; `NoopTelemetryService` does not declare the member.                                                                                                                                                                                                                                                  |
| `logger-plugin/test/unit/trace-enriched-logger.test.ts` (new)                 | `loggers/trace-enriched-logger.ts` | The exact keys `trace_id`/`span_id` (§3.6); a telemetry service **omitting** the member enriches nothing; one that **throws** is caught and the record still logs; the wrapped logger keeps its receiver, driven against the REAL `ConsoleLogger` with its `#` fields (M52c). **`child()` returns a DECORATED child** (§0.1 P3), so `logger.child({ requestId })` — what `request-logger.ts:71` does — still enriches. |
| `logger-plugin/test/integration/log-trace-join.test.ts` (new)                 | `plugin/logger-plugin.ts`          | Through a real application with the real `TelemetryPlugin` and `LoggerPlugin`: a log line emitted inside a request span carries the same `trace_id` the exported span reports. The join, end to end.                                                                                                                                                                                                                   |
| `logger-plugin/test/integration/no-telemetry-unchanged.test.ts` (new)         | `plugin/logger-plugin.ts`          | Without telemetry the record is byte-identical to today.                                                                                                                                                                                                                                                                                                                                                               |
| `*/test/unit/barrel-exports.test.ts` (extended, three packages)               | each `src/index.ts`                | Neither decorator leaked into a public surface, and `common`'s three additions are exported.                                                                                                                                                                                                                                                                                                                           |

**Negative controls to run and revert before hand-off**, each observed failing:

1. Drop the header injection in `TracedQueue.add` → the real-backend continuity case reports two
   traces instead of one, which is X34-1 reproduced.
2. Make `TracedQueue` read a _different_ header name on the consumer side → the continuity case
   fails while every adapter's own header test still passes, which is §3.2's argument for one
   decorator.
3. Return `undefined` from `activeSpanContext` unconditionally → the log-trace-join case fails while
   every logger unit test passes, so the join is what is measured and not the plumbing.
4. Enrich with `traceId`/`spanId` in camelCase → the key assertion fails; §3.6's departure is
   deliberate and pinned.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m90i-observability-that-joins-up, never main
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task check:docs
deno task publish:check     # on a COMMITTED tree
deno task release:verify 0.4.0
```

Plus, with Redis, RabbitMQ and ElasticMQ up, so the guarded continuity and wire-header cases run:

```bash
REDIS_URL=… RABBITMQ_URL=… SQS_ENDPOINT_URL=… deno task test
```

The ignored-test count is the proof they ran.

## 8. Risks & mitigations

- **A `common` contract member added to `ITelemetryService` is a widening of a service any
  application may implement.** Mitigation: it is optional, so nothing breaks; a type-level case pins
  that a one-member implementation still satisfies the interface; and §10.2 approval plus the
  `PUBLIC_API.md` row are listed deliverables.
- **The logger decorator sits on the hottest path in the framework.** Mitigation: the telemetry
  capability is resolved once per call through a memoised thunk that caches the _absence_ as well as
  the service, so a no-telemetry application pays one boolean per record; and
  `no-telemetry-unchanged` pins the record byte-identical.
- **A throwing or slow telemetry service could break logging**, which would make the observability
  fix an availability defect. Mitigation: every call is guarded (M45b's lesson, which found exactly
  this in `worker-pool-plugin` — an unguarded instrument write stranded a caller forever), and a
  throwing service has its own test.
- **Four adapters carrying a map is four chances to drop it.** Mitigation: `header-conformance` is
  one table over all four, which is the mechanism that caught six of seven brokers agreeing in M75.
- **`TracedQueue` and `TracedBroker` could drift.** Mitigation: both are decorators over an internal
  adapter seam with the same constructor shape, and the queue's continuity test asserts the same
  property the messaging one does, so a divergence in header name or span naming fails a test rather
  than being noticed in review.

## 9. Out of scope

- **The scheduler's header channel** — §3.7: X34 records its fresh root as correct, and adding one
  would remove the distinction between "no cause" and "cause lost".
- **`cloudflare-plugin`'s `WorkersQueue`** — it satisfies `IQueue` from another package, and its
  `{ v, name, id, data, maxAttempts? }` envelope is a **wire format** shared with a deployed
  Worker's `queue` handler (M52b), so widening it is a deployment-coupled change belonging with that
  package's own milestone. Until then it omits `headers`, which under §3.1's semantics correctly
  reports "no channel".
- **Audit entries and metrics exemplars** — the other two joins X29 asked about; neither has a
  finding, and an exemplar needs a metrics-contract change of its own.
- **A log-to-trace link in the other direction** (a span attribute naming a log stream) — the join
  X34-2 asks for is one-directional and sufficient: an operator holding one identifier can find the
  other through the log backend's own index.
- **Native AMQP message properties / SQS message attributes** — §0.1 P4. The map is carried in the
  framework's own envelope, which is what makes the round trip work; ALSO writing it to the
  transport's own header surface would make the `traceparent` visible to the broker's tooling and to
  a non-framework consumer. Real value, no finding, and a second write path per adapter.
- **A behaviour running inside the consumer span** — §0.1's design-consequence note. Closing it
  means converting M86's `BehaviorChainQueueService` subclass into a wrapper (§16.4), and X34's own
  "Still to run" defers the behaviour chain as an observation point.
- **Changing the trace-context codec** — M75 promoted it into `common` and this milestone reuses it
  unchanged, which is the point.
