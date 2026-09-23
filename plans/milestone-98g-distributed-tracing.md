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

## 1. Contracts verified from SOURCE (not names)

| Reference           | Source (file:line)                                                    | Verified surface / fact                                                                              |
| ------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `ITelemetryService` | `packages/common/src/services/telemetry.ts:166`                       | Creates spans and optionally reports only the currently active IDs; no completed-span feed.          |
| `SpanOptions`       | `packages/common/src/services/telemetry.ts:43`                        | Carries kind, arbitrary attributes and optional explicit parent context.                             |
| `TracerHost`        | `packages/telemetry-plugin/src/interfaces/index.ts:71`                | Custom host exposes start/activate/context/shutdown only; no readable completed spans.               |
| `TelemetryService`  | `packages/telemetry-plugin/src/services/telemetry-service.ts:112`     | Ends framework spans in `finally`; exceptions and status go to the underlying span.                  |
| OTel provider       | `packages/telemetry-plugin/src/tracing/tracer.ts:252`                 | Built-in provider receives a constructor-time `spanProcessors` array and current exporter processor. |
| Middleware naming   | `packages/telemetry-plugin/src/middleware/telemetry-middleware.ts:44` | Raw server span names and route attributes use request paths and may be dynamic/sensitive.           |
| Queue propagation   | `packages/queue-plugin/src/tracing/traced-queue.ts:90`                | Producer/consumer spans propagate W3C context; queue names and message IDs enter raw spans.          |
| Kernel IDs          | `packages/common/src/services/diagnostics.ts:203`                     | M98a operation IDs are instance-local; optional trace/span IDs do not form a completed span tree.    |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                               | Resolution (picked side)                                                                                                        | Doc deliverable (same PR)                                                                                                    |
| -- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| C1 | Existing docs describe OTel export and active correlation only; M98g adds a readable local projection. | Keep exporter API and behavior unchanged; document a second, minimized span processor available only for the built-in provider. | Update `PUBLIC_API.md`, `ARCHITECTURE.md`, diagnostics protocol, telemetry/diagnostics READMEs, changelog and tracking docs. |

## 3. Design decisions

### 3.1 Observe through an additional OTel span processor

- **Decision:** When `TelemetryPluginOptions.diagnostics` is enabled and the built-in provider is
  used, construct an internal `DiagnosticSpanProcessor` and append it after the configured exporter
  processor in the same `BasicTracerProvider` constructor. It implements OTel processor lifecycle,
  never exports, and minimizes on `onEnd` before writing its ring. The existing processor remains
  unchanged and receives every span as before.
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
  match W3C lowercase-hex grammar and all-zero values are rejected.
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
  `traces(after, limit)`. Devtool correlation may join equal trace IDs from sessions the user
  independently paired; identifiers never discover endpoints or authorize reads.
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
| common diagnostics/tokens/index source                                                                                                               | Trace DTO/source contracts, token and exports.                 |
| `packages/telemetry-plugin/src/interfaces/index.ts`, `src/diagnostics/span-observation-collector.ts`, `src/diagnostics/diagnostic-span-processor.ts` | Options, ring, OTel processor.                                 |
| `packages/telemetry-plugin/src/tracing/tracer.ts`, `src/plugin/telemetry-plugin.ts`, `src/index.ts`                                                  | Processor composition, availability, registration and exports. |
| diagnostics interfaces/plugin/protocol/connector/client source                                                                                       | Fixed trace operation and native method.                       |
| Public, architecture, protocol, package, release and tracking docs                                                                                   | Coverage and security contract.                                |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                  | src covered               | Key assertions (and the signature each call type-checks against)                                                                |
| ---------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| common diagnostics/token/index tests                       | common changed files      | Types, token and exports.                                                                                                       |
| telemetry options/collector tests                          | interfaces/collector      | Alias bounds, exact fields, W3C validation, ring loss, no raw canaries.                                                         |
| telemetry `test/unit/diagnostic-span-processor.test.ts`    | processor                 | onEnd minimization, links/parents/status/duration, no throw, flush/shutdown.                                                    |
| telemetry `test/unit/tracer.test.ts`                       | tracer                    | exporter processor preserved, diagnostic processor appended once, sampling/config unchanged.                                    |
| telemetry `test/unit/plugin.test.ts`, `test/index.test.ts` | plugin/index              | disabled/noop/custom/built-in states, eager token, lifecycle and exports.                                                       |
| telemetry guarded real-import integration test             | tracer/processor          | Real pinned OTel SDK ends an approved span and exporter still receives it.                                                      |
| diagnostics protocol/connector/plugin tests                | protocol/connector/plugin | target grammar, auth-before-read, exact projection, unsupported/failure states.                                                 |
| diagnostics client/index tests                             | client/interfaces         | `traces()` args, signed verification, exact DTO/instance checks.                                                                |
| diagnostics `test/e2e/distributed-tracing.test.ts`         | all paths                 | Real HTTP plus enqueue/process hops, missing activation/sampling/loss/order, two independently paired apps, no fabricated edge. |

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
