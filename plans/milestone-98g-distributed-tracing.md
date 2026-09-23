# Milestone 98g — Minimized Distributed Tracing and Correlation

> **Status:** Planning on `docs/m98-capability-diagnostics`. Implementation and fixes belong on
> `feat/m98g-distributed-tracing`; `main` remains protected.

## 0. Objective & scope

Add a bounded local projection of completed, sampled spans from the telemetry plugin so
independently paired devtool sessions can correlate approved operations by trace relationships.
Existing exporters, sampling, activation, propagation and shutdown remain authoritative.

- **In scope:** built-in OTel-provider completed spans, approved service/operation aliases,
  trace/span/parent/link identifiers, kind/outcome/duration/loss, typed source/token, `/v1/traces`,
  native `traces(after, limit)`, and design plus committed-tree security audits.
- **NOT this milestone:** raw OTLP, arbitrary attributes/events/resources/baggage/exceptions,
  unsampled spans, custom TracerHost internals, automatic service discovery/access, or a globally
  ordered distributed timeline.

Implementation starts from main containing M98d's fixed inspector-support manifest; HealthPlugin
itself remains optional and is not required for trace observations.

## 1. Contracts verified from SOURCE (not names)

| Reference                | Source (file:line)                                                                                     | Verified surface / fact                                                                                                                                     |
| ------------------------ | ------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ITelemetryService`      | `packages/common/src/services/telemetry.ts:166`                                                        | Creates spans and optionally reports only the currently active IDs; no completed-span feed.                                                                 |
| `SpanOptions`            | `packages/common/src/services/telemetry.ts:43`                                                         | Carries kind, arbitrary attributes and optional explicit parent context.                                                                                    |
| `TracerHost`             | `packages/telemetry-plugin/src/interfaces/index.ts:71`                                                 | Custom host exposes start/activate/context/shutdown only; no readable completed spans.                                                                      |
| `TelemetryService`       | `packages/telemetry-plugin/src/services/telemetry-service.ts:112`                                      | Ends framework spans in `finally`; exceptions and status go to the underlying span.                                                                         |
| OTel provider            | `packages/telemetry-plugin/src/tracing/tracer.ts:252`                                                  | Built-in provider receives a constructor-time `spanProcessors` array and current exporter processor.                                                        |
| OTel processor contract  | `npm:@opentelemetry/sdk-trace@2.11.0/build/src/SpanProcessor.d.ts:7` (resolved by `deno.lock:45,1126`) | `SpanProcessor` requires `onStart`, `onEnd`, `forceFlush`, `shutdown`; `onEnding` is optional.                                                              |
| OTel readable span input | `npm:@opentelemetry/sdk-trace@2.11.0/build/src/export/ReadableSpan.d.ts:4`                             | Exact readable fields include name/kind/context/parent/time/status/attributes/links/events/duration/resource; diagnostics approves only the subset in §3.3. |
| Middleware naming        | `packages/telemetry-plugin/src/middleware/telemetry-middleware.ts:44`                                  | Raw server span names and route attributes use request paths and may be dynamic/sensitive.                                                                  |
| Queue propagation        | `packages/queue-plugin/src/tracing/traced-queue.ts:90`                                                 | Producer/consumer spans propagate W3C context; queue names and message IDs enter raw spans.                                                                 |
| Kernel IDs               | `packages/common/src/services/diagnostics.ts:203`                                                      | M98a operation IDs are instance-local; optional trace/span IDs do not form a completed span tree.                                                           |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                               | Resolution (picked side)                                                                                                        | Doc deliverable (same PR)                                                                                                    |
| -- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| C1 | Existing docs describe OTel export and active correlation only; M98g adds a readable local projection. | Keep exporter API and behavior unchanged; document a second, minimized span processor available only for the built-in provider. | Update `PUBLIC_API.md`, `ARCHITECTURE.md`, diagnostics protocol, telemetry/diagnostics READMEs, changelog and tracking docs. |

## 3. Design decisions

### 3.1 Observe through an additional OTel span processor

- **Decision:** When `TelemetryPluginOptions.diagnostics` is enabled and the built-in provider is
  used, construct an internal `DiagnosticSpanProcessor` and append it after the configured exporter
  processor in the same `BasicTracerProvider` constructor. Against the locked 2.11.0 contract,
  `onStart` is a synchronous no-op, optional `onEnding` is omitted, `onEnd` synchronously minimizes
  and catches every failure, `forceFlush` returns an already-resolved promise without touching the
  exporter, and `shutdown` idempotently closes/clears the collector. It never exports. The existing
  processor remains unchanged and receives every span as before.
- **Why:** This observes framework, queue/messaging and supported auto-instrumentation spans that
  actually finish, without a competing tracer or exporter.
- **Test home:** tracer/provider tests with fake processors and real OTel guarded import/e2e tests.

### 3.2 Explicit availability and coverage

- **Decision:** Add eager `CAPABILITIES.TRACE_DIAGNOSTICS` (`trace-diagnostics`) and
  `ITraceDiagnosticsSource`. TelemetryPlugin always registers one. It reports `disabled` without the
  option, `unsupported` with fixed coverage `custom-provider` for `tracerProviderFactory`, and
  `unsupported` with coverage `noop-no-provider` in noop/no-exporter mode. `collection-failed` is
  reserved for a supported collector that actually fails. Built-in-provider records declare coverage
  `completed-sampled-spans` plus enabled instrumentation kinds. Node-only auto instrumentation is
  reported only when its registry outcome says enabled; Deno support is limited to spans created
  through the framework telemetry service.
- **Why:** A package registration must not be mistaken for complete tracing support.
- **Test home:** plugin mode/runtime matrix tests.

### 3.3 Approved fields and names

- **Decision:** `TraceDiagnosticsOptions` requires `enabled: true`, a 1–64-byte `serviceAlias`, and
  `operations` mapping exact raw span names to unique 1–64-byte aliases. Unapproved spans are
  counted and dropped before the ring. `TraceObservation` contains sequence, service/operation
  aliases, trace ID, span ID, optional parent span ID, at most eight link trace/span pairs, kind,
  outcome (`ok`, `error`, `unset`), durationMs, and `ageMs`. Arbitrary name, attributes, events,
  resource labels, tracestate, baggage and exceptions never enter collector state. Identifiers must
  match W3C lowercase-hex grammar and all-zero values are rejected. `onEnd` reads only `name`,
  `kind`, `spanContext()`, `parentSpanContext`, `links[].context`, `status.code`, and `duration`. It
  maps numeric OTel kind/status values through fixed exhaustive tables and drops invalid values; it
  never touches status messages, attributes, events, resources, instrumentation scope, baggage,
  exception data, or link attributes.
- **Why:** Trace relationships remain useful while dynamic paths and application data stay outside
  capture.
- **Test home:** diagnostic processor exact-projection and canary tests.

### 3.4 Sampling, loss, parents and time

- **Decision:** The batch reports configured sampler description (`always-on` or `traceidratio` plus
  ratio), ring `lost`, and per-span `parentVisibility` (`observed`, `remote-or-unobserved`, `root`,
  `unknown`). A parent/link is an identifier relationship only; no edge is fabricated when the
  referenced span is absent. Capture order and local monotonic `ageMs` describe arrival at this
  process, never global start order. Unsampled spans are absent because OTel never completes them
  through the processor; the UI must display this limitation.
- **Why:** Partial traces and clock uncertainty are normal and must remain visible.
- **Test home:** sampling, missing parent, link, out-of-order, and cross-process fixtures.

### 3.5 Bounds and failure isolation

- **Decision:** Retain 1,024 frozen records in a ring, accept 128/read, cap links at eight and
  saturate counters. Processor methods contain no awaits and catch every validation/collector error;
  they never throw into OTel. `shutdown` marks the source closed and clears retained records after
  the connector session is revoked/parent closes; `forceFlush` resolves without touching the
  exporter. Disabled mode adds no processor or ring.
- **Why:** Tracing must not make application/exporter behavior or shutdown less reliable.
- **Test home:** overflow, throwing collector, forceFlush/shutdown ordering and response equivalence
  tests.

### 3.6 Fixed transport and independent sessions

- **Decision:** DiagnosticsPlugin optionally consumes the source and adds only canonical
  `GET /v1/traces?after=N&limit=N`; absence returns typed `unsupported`. `TraceDiagnosticsBatch`
  includes version, authenticated application instance, state, coverage, sampler, records,
  next/lost/closed. The connector copies exact fields and the native client validates them via
  `traces(after, limit)`. It sets the fixed authenticated status manifest's `traces` key true; a
  false key returns a frozen typed unsupported batch without a trace request.
  `ITraceDiagnosticsSource` exposes exactly:

  ```typescript
  read(instanceId: string, after: number, limit?: number): TraceDiagnosticsBatch;
  ```

  The method is synchronous, requires a non-empty instance ID, accepts only a non-negative safe
  cursor and limit 1–128 (default 128), throws one fixed value-free `RangeError` otherwise, and
  returns a deeply frozen batch matching the supplied instance. Devtool correlation may join equal
  trace IDs from sessions the user independently paired; identifiers never discover endpoints or
  authorize reads.
- **Why:** Correlation does not weaken M98b's per-application authentication boundary.
- **Test home:** connector/client/e2e tests across two separately authenticated apps.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                | Kind                  | Consumer / real code path that READS it                     |
| ---------------------------------------------- | --------------------- | ----------------------------------------------------------- |
| Trace coverage/outcome/parent-visibility types | common types          | Source, validator/client and devtool trace graph.           |
| `TraceObservation`, `TraceDiagnosticsBatch`    | common interfaces     | Span collector, client and devtool.                         |
| `ITraceDiagnosticsSource`                      | common interface      | TelemetryPlugin provider, DiagnosticsPlugin consumer.       |
| `CAPABILITIES.TRACE_DIAGNOSTICS`               | common token          | Same provider/consumer path.                                |
| `TraceDiagnosticsOptions`                      | telemetry option type | Plugin/provider builder validates and configures collector. |
| `IDiagnosticsClient.traces`                    | interface method      | Native devtool reads completed span batches.                |

`ITraceDiagnosticsSource.read(instanceId, after, limit?)` has the exact synchronous contract in
§3.6. `IDiagnosticsClient.traces(after: number, limit?: number): Promise<TraceDiagnosticsBatch>`
applies the same cursor bounds and negotiates support before sending the operation.

The OTel diagnostic processor, raw-readable-span adapter, ring and projectors remain internal.

### 4.1 Options — every option names its consumer

| Option                      | Consumer          | Behavior (per implementation)                                  |
| --------------------------- | ----------------- | -------------------------------------------------------------- |
| `diagnostics.enabled: true` | TelemetryPlugin   | Installs collector only for built-in real provider.            |
| `diagnostics.serviceAlias`  | collector         | Safe service label; never copies OTel resource `service.name`. |
| `diagnostics.operations`    | `onEnd` projector | Exact raw-name allowlist; replaces names before buffering.     |

## 5. Implementation files

| File                                                                                                                                                 | Purpose                                                        |
| ---------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------- |
| `packages/common/src/services/diagnostics.ts`, `src/tokens.ts`, `src/index.ts`                                                                       | Trace DTO/source contracts, token and exports.                 |
| `packages/telemetry-plugin/src/interfaces/index.ts`, `src/diagnostics/span-observation-collector.ts`, `src/diagnostics/diagnostic-span-processor.ts` | Options, ring, OTel processor.                                 |
| `packages/telemetry-plugin/src/tracing/tracer.ts`, `src/plugin/telemetry-plugin.ts`, `src/index.ts`                                                  | Processor composition, availability, registration and exports. |
| `packages/diagnostics-plugin/src/interfaces/index.ts`, `src/plugin/diagnostics-plugin.ts`                                                            | Client method, support key and optional source resolution.     |
| `packages/diagnostics-plugin/src/protocol/protocol.ts`, `src/transport/connector-handler.ts`, `src/client/client.ts`                                 | Trace target, projection, authenticated dispatch and client.   |
| `PUBLIC_API.md`, `ARCHITECTURE.md`, `docs/diagnostics-protocol.md`, package READMEs, `CHANGELOG.md`, `ROADMAP.md`, `CLAUDE.md`                       | Coverage and security contract.                                |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                   | src covered                     | Key assertions (and the signature each call type-checks against)                                                                |
| --------------------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/diagnostics-contract.test.ts`, `test/unit/tokens.test.ts`, `test/unit/index.test.ts`             | common diagnostics/tokens/index | Source signature, DTOs, token and exports.                                                                                      |
| `packages/telemetry-plugin/test/unit/trace-diagnostics-options.test.ts`, `test/unit/span-observation-collector.test.ts`     | interfaces/collector            | Alias bounds, source read signature, exact fields, W3C validation, ring loss, no raw canaries.                                  |
| `packages/telemetry-plugin/test/unit/diagnostic-span-processor.test.ts`                                                     | processor                       | Every locked lifecycle method, onEnd minimization, links/parents/status/duration, no throw.                                     |
| `packages/telemetry-plugin/test/unit/tracer.test.ts`                                                                        | tracer                          | Exporter processor preserved, diagnostic processor appended once, sampling/config unchanged.                                    |
| `packages/telemetry-plugin/test/unit/telemetry-plugin.test.ts`, `test/unit/barrel-exports.test.ts`                          | plugin/index                    | Disabled/noop/custom/built-in states, eager token, lifecycle and exports.                                                       |
| `packages/telemetry-plugin/test/integration/diagnostic-span-processor-real-import.test.ts`                                  | tracer/processor                | Locked real OTel SDK exercises every required lifecycle method; exporter still receives the span.                               |
| `packages/diagnostics-plugin/test/unit/protocol.test.ts`, `test/unit/connector-handler.test.ts`, `test/unit/plugin.test.ts` | protocol/connector/plugin       | Support key, target grammar, auth-before-read, exact projection, unsupported/failure states.                                    |
| `packages/diagnostics-plugin/test/unit/client.test.ts`, `test/index.test.ts`                                                | client/interfaces               | False-key no-request, `traces()` args, signed verification, exact DTO/instance checks.                                          |
| `packages/diagnostics-plugin/test/e2e/distributed-tracing.test.ts`                                                          | all paths                       | Real HTTP plus enqueue/process hops, missing activation/sampling/loss/order, two independently paired apps, no fabricated edge. |

## 7. Verification gates

```bash
git branch --show-current   # feat/m98g-distributed-tracing during implementation
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage
```

Inspect per-file coverage for 90% branch/function/line. On the committed tree run
`deno task publish:check` and `deno task release:verify <version>`. Record real
runtime/instrumentation coverage, reviewed revision, findings and dispositions in the implementation
PR; untested instrumentation is removed from supported claims.

## 8. Risks & mitigations

- Sensitive names/attributes enter memory: exact name allowlist and a processor API that emits only
  fixed fields.
- Extra processor disrupts export: append independently, never wrap exporter, never throw, and
  compare export calls.
- Partial data looks complete: report sampler, coverage, loss and parent visibility.
- Trace IDs become authority: connector still requires each session's MAC and instance binding.
- Local timestamps imply global order: expose age/arrival only and document no global clock
  alignment.

## 9. Out of scope

- Custom TracerHost completed-span support and raw exporter feeds.
- Full auto-instrumentation coverage on Deno/Bun and unsampled span recovery.
- Remote discovery, cross-service authentication, baggage/attribute browsing, and global timing
  reconstruction.

## 10. Design security review — completed before implementation

**Reviewed flow:** OTel sampled span end → dedicated processor → exact raw-name approval → primitive
ID/status/time validation → bounded ring → typed source → authenticated fixed connector → signed
frame → validating client. Minimization precedes retention; exporter and its raw span path remain
separate.

**Approved budgets:** 128 operation aliases, 64-byte aliases, eight links/span, 1,024 records,
128/read, bounded primitive fields, and 256 KiB/frame. Disabled/noop/custom-provider modes create no
diagnostic span processor.

| Finding                                                | Resolution in this plan                                                                     |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------- |
| HTTP names/attributes can include sensitive paths.     | Only exact configured names become aliases; attributes are structurally unreachable.        |
| A second tracing system could alter parenting.         | Observe the existing provider's completion processor only.                                  |
| Cross-app trace match could imply access or causality. | Sessions pair independently; missing hops remain explicit and no endpoint discovery occurs. |
| Custom hosts cannot supply completed spans.            | Fixed unsupported coverage state, no fabricated wrapper feed.                               |

The implementation audit plants canaries in paths, query values, attributes, baggage, resources and
exceptions; checks processor inputs, retained records, frames, errors and logs; proves approved
aliases/relationships remain; compares exporter output and application effects with diagnostics
absent/enabled/throwing/full; and repeats every M98b credential, replay, origin, authority, expiry,
revocation, instance, version and mutation-refusal case.
