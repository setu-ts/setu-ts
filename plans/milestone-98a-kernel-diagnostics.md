# Milestone 98a — Kernel Diagnostics (`@setu-ts/kernel`)

> **Status:** Planning; no implementation or security acceptance is claimed. Authored on
> `docs/m98-secure-devtool-diagnostics`. Implementation branch: `feat/m98a-kernel-diagnostics`;
> implementation and fixes remain there until merge.

## 0. Objective & scope

Expose an optional, read-only view of application composition and kernel execution for the separate
devtool. Capture selected metadata at its owning registration/execution boundary, rather than
serializing application objects. The kernel owns collection; an external reader pulls immutable,
bounded snapshots and event batches. No diagnostic network listener is part of this milestone.

- **In scope:** kernel collection, minimal shared DTO/read contracts, explicit activation,
  privacy-preserving labels, bounded polling, real consumer example, and behavioral security tests.
- **NOT this milestone:** M98b owns the authenticated connector. Data/payload inspection, non-HTTP
  handler instrumentation, source navigation, configuration/authorization explanations, replay and
  persistence remain the separately reviewed follow-ons listed under M98 in ROADMAP.md; no milestone
  number or implementation approval is implied for those follow-ons.

## 1. Contracts verified from SOURCE (not names)

Line references below describe base commit `c9cd53d7`; recheck them against the implementation base.

| Reference                        | Source (file:line)                                              | Verified surface / fact                                                                                                                                           |
| -------------------------------- | --------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IApplication`, `IPluginContext` | `packages/common/src/plugin.ts:433`, `:477`                     | Application exposes router, middleware, services and lifecycle operations; plugin context carries `app`. Neither exposes diagnostics.                             |
| `IPlugin`                        | `packages/common/src/plugin.ts:538`                             | Names, version, declared dependencies/provides/consumes and registration function. Declared edges are not observed calls.                                         |
| `RouteInfo`, `IRouterApi`        | `packages/common/src/plugin.ts:57`, `:81`                       | `listRoutes()` returns a definition with executable handlers, middleware and schema objects; copying the whole result would violate the proposed boundary.        |
| `IMiddlewareApi`                 | `packages/common/src/plugin.ts:42`                              | Registration only; no public list or execution observer.                                                                                                          |
| Application options and startup  | `packages/kernel/src/application/application.ts:59`, `:322`     | Options currently only pre-register plugins. Runtime is available after its provider registers, not at application construction or initial dependency resolution. |
| Request dispatch                 | `packages/kernel/src/application/application.ts:857`, `:990`    | Empty chains preserve synchronous dispatch. Route matching currently returns definition and params, not the selected template identity.                           |
| Middleware executor              | `packages/kernel/src/pipeline/execute-chain.ts:45`              | Global and route chains share short-circuit and double-next behavior. Timing must instrument this same mechanism.                                                 |
| Registry                         | `packages/kernel/src/registry/service-registry.ts:32`, `:54`    | Private registration maps; existing observer reports overrides/unregisters only. `get()` and `getAll()` resolve factories and are unsuitable for inspection.      |
| Router registration metadata     | `packages/kernel/src/router/router.ts:22`, `:354`               | Entries retain pattern, owner and insertion index; `listRoutes()` projects those plus the live definition.                                                        |
| Lifecycle                        | `packages/kernel/src/lifecycle/lifecycle-manager.ts:76`, `:141` | Register hooks drain per plugin; close runs every hook and aggregates failures. Observation must not change those semantics.                                      |
| Runtime clock and randomness     | `packages/common/src/runtime.ts:303`                            | `uuid`, `hrtime`, `now`, timers and Web Crypto are available through `IRuntimeServices`. No ambient clock is needed.                                              |
| Redaction                        | `packages/common/src/redaction/redaction-service.ts:24`         | Unclassified values pass through; field redaction cannot certify arbitrary diagnostic objects.                                                                    |
| Trace identifier read            | `packages/common/src/services/telemetry.ts:166`                 | Optional `activeSpanContext()` returns identifiers; it is not a span/log export feed.                                                                             |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                        | Resolution (picked side)                                                                                                                                            | Doc deliverable (same PR)                                                                   |
| -- | ----------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| C1 | M98 describes observers and a bounded handoff but does not choose a callback or pull interface. | Choose pull-only public reads. Internal event collection remains synchronous and bounded; application execution never calls a devtool callback.                     | Clarify M98 wording in ROADMAP.md; document polling in PUBLIC_API.md and the kernel README. |
| C2 | A route listing exists, but includes executable definitions.                                    | The new DTO contract is a separate projection; retain existing `listRoutes()` semantics.                                                                            | Explain both surfaces in PUBLIC_API.md and ARCHITECTURE.md.                                 |
| C3 | Runtime is unavailable for the earliest startup failures.                                       | Early observations have `atMs: null` and `durationMs: null`; assign the process-instance UUID only after runtime registration. Never invent epoch/monotonic values. | Document startup availability in PUBLIC_API.md.                                             |

No correction of unrelated historical API claims is included. Source governs all three decisions.

## 3. Design decisions

### 3.1 Activation and ownership

- **Decision:** Add `diagnostics?: KernelDiagnosticsOptions` to `ApplicationOptions`, and an
  optional readonly `diagnostics?: IDiagnosticsSource` member to `IApplication`. An omitted option
  leaves the property absent and creates no diagnostics collector, metadata mirror, ring or timers.
  `{ diagnostics: {} }` explicitly enables collection. `IPluginContext.app.diagnostics` is M98b's
  access path; no capability token is invented, no service is resolved to discover the reader, and
  third-party `IApplication` implementations remain compatible because the member is optional.
- Only kernel implementation owns the writer. The public reader offers `snapshot()` and `read()`;
  neither can register a callback, invoke application code or mutate state. No new field is added to
  the plugin contract. No telemetry plugin dependency or import is introduced.
- **Test home:** `packages/kernel/test/integration/diagnostics-activation.test.ts` and common's
  type-contract test. Assert an old structural application still type-checks.

### 3.2 Exact proposed public contracts

The following is the proposed new surface, not an assertion about current exports. Every field is
readonly; nested arrays/records are readonly and returned graphs are deeply frozen.

```typescript
interface IDiagnosticsSource {
  snapshot(): DiagnosticsSnapshot;
  read(after: number, limit?: number): DiagnosticsBatch;
}

interface KernelDiagnosticsOptions {
  labels?: {
    plugins?: readonly string[];
    capabilities?: readonly string[];
    routes?: readonly string[];
    middleware?: readonly string[];
  };
}
```

The four DTO types below live in `common/src/services/diagnostics.ts`. The options type lives in
kernel. Use named exports and JSDoc; there is no public collector class.

| Type                  | Exact fields and semantics                                                                                                                                                                                                                                                                                                                                                                                                               |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `DiagnosticsSnapshot` | `version: 1`; `instanceId: string` or `null`; `state: 'created'` / `'starting'` / `'running'` / `'failed'` / `'stopping'` / `'closed'`; `failureCode: 'startup-failed'` / `'shutdown-failed'` or `null`; `nodes: readonly DiagnosticsNode[]`; `edges: readonly { from: string; to: string; kind: 'provides' / 'requires' / 'optional' / 'consumes' / 'owns' }[]`; `truncated: boolean`; `droppedEvents: number`.                         |
| `DiagnosticsNode`     | `id: string`; `kind: 'plugin'` / `'capability'` / `'route'` / `'middleware'`; optional `label: string`, `version: string`, `method: HttpMethod`, `priority: number`, `position: number`, `registered: boolean`. Fields are emitted only for the relevant kind; no arbitrary properties or values. A capability's `registered` describes a registration, never readiness or lazy-instantiation state.                                     |
| `DiagnosticsEvent`    | `sequence: number`; `operationId: string`; `parentOperationId: string` or `null`; `kind: 'lifecycle'` / `'request'` / `'middleware'` / `'handler'`; `stage: string` from the fixed vocabulary below; `nodeId: string` or `null`; `outcome: 'ok'` / `'error'` / `'short-circuit'` / `'downstream-skipped'`; `atMs: number` or `null`; `durationMs: number` or `null`; optional `statusCode: number`, `traceId: string`, `spanId: string`. |
| `DiagnosticsBatch`    | `version: 1`; `instanceId: string` or `null`; `events: readonly DiagnosticsEvent[]`; `next: number`; `lost: number`; `closed: boolean`.                                                                                                                                                                                                                                                                                                  |

`stage` is typed as an inline string-literal union, not an arbitrary application string: `resolve`,
`register`, `register-hook`, `init`, `bootstrap`, `listen`, `stopping`, `shutdown`, `close`,
`request`, `request-hook`, `response-hook`, `error-hook`, `global`, `route`, `handler`,
`websocket-upgrade`, `grpc-dispatch`. It labels the measured kernel boundary, not downstream work.

IDs are opaque per-instance sequential IDs generated by the collector (`p1`, `c1`, `r1`, `m1`,
`op1`); they contain no names, tenant IDs or user input. The instance UUID is generated once through
the registered runtime. Plugin version is omitted unless it passes a bounded semver grammar. HTTP
methods are projected to the existing `HttpMethod` vocabulary; unsupported input is omitted.

The reader validates `after` as a non-negative safe integer and `limit` as an integer from 1 to 128
(default 128). Invalid reads throw a fixed `RangeError` without the supplied value. `after=0` starts
at the oldest retained record. `lost` is the count of missing sequence numbers before the first
returned record; `next` is the last returned sequence, or `after` if none. A cursor beyond the
current sequence is refused. Polling is non-destructive: readers do not steal each other's events.

**Test home:** new unit tests `diagnostics-contract.test.ts`, `diagnostics-buffer.test.ts` and the
integration consumer test; compile a consumer against every proposed signature.

### 3.3 Projection and label policy

- **Decision:** Omit labels by default. Each label option is an exact allowlist of registration
  strings, not a glob or regular expression. The developer must explicitly approve names/templates
  that may leave the process. Reject malformed option lists at construction with value-free errors:
  at most 256 entries per list, each at most 160 UTF-8 bytes, no control characters. Unknown names
  authorize no output. Names exceeding the bound are omitted rather than truncated into a new name.
- Never derive a label from a concrete request URL, function source, stack, `Error.message`,
  configuration value or instance property. Route labels are the complete registered pattern,
  including group prefix. Route middleware without an explicit approved name gets only its ID and
  position; do not consult function names. An allowlisted label may intentionally be sensitive;
  document that approving it is a disclosure decision, not a secret-detection guarantee.
- Capture the necessary primitive registration fields once at their owning mutation boundary. Use
  descriptor data values for optional diagnostic metadata and omit accessor-backed values; snapshot
  reads operate only on collector-owned data and cannot cause a new application read. Normal
  application registration can still execute trusted plugin code. Proxy traps and malicious
  same-process code are outside the sandbox claim, which this API does not make.
- The structural allowlist is the security boundary. M96's redactor is not called on raw request
  objects, and no new redaction policy option is exported. This v1 excludes all arbitrary values,
  rather than retaining unclassified ones. A projection exception drops the record and increments an
  integer counter; it does not log the offending object or exception.
- **Test home:** `diagnostics-projection.test.ts`, `diagnostics-canaries.test.ts`.

### 3.4 Registration and lifecycle integration

- **Decision:** Add internal, diagnostic-only mutation hooks to the root service registry, router
  and pipeline. Preserve the registry's existing logging observer instead of replacing it. Report
  successful instance/factory/multi registration and removal using token metadata alone; never call
  `get`/`getAll` and never observe request-child service values. Duplicate-registration failures do
  not produce a successful registration event.
- Keep bounded plugin/capability/route/middleware nodes and declared dependency edges. For a token
  registered by application code, owner is absent; do not attribute it to an unrelated plugin.
  Registration position and execution position are distinct; global middleware positions use the
  existing stable priority sort, route positions follow the route's array.
- Extend the internal router match result with its selected entry identity so application dispatch
  can name the actual route node. Cover the direct-match fast path and ranked fallback. Do not
  re-match or scan all routes per request, and do not widen `IRouterApi.listRoutes()`.
- The lifecycle manager observes each existing hook invocation with fixed phase plus ordinal; never
  infer hook ownership where it was not recorded. Application startup observes resolver, plugin
  registration and listener outcomes. Before runtime registration only null timings are possible.
  Runtime initialization starts the monotonic origin and creates the instance UUID.
- On startup failure and at final shutdown, clear retained node/edge/event buffers in a `finally`
  path while preserving the original application error. A reader then sees the coarse failed/closed
  state, failure code and counters; it cannot recover discarded sensitive metadata. This diagnostics
  cleanup does not change which application lifecycle hooks run or their failure semantics.
- **Test home:** `diagnostics-registration.test.ts`, `diagnostics-lifecycle.test.ts`, and existing
  registry/router/lifecycle unit suites with observation enabled and absent.

### 3.5 Execution semantics and trace correlation

- **Decision:** Emit completion records in actual completion order. An operation ID is allocated at
  entry and links the record to its parent even when the parent's completion record appears later.
  Duration is inclusive monotonic elapsed time, including downstream `next()` work; the UI must not
  sum parent and child durations as exclusive CPU time. No CPU profiling claim is made.
- The same chain executor records global and route middleware. Returning without `next()` is
  `short-circuit`; calling `next()` after ending the response records `downstream-skipped`. A throw
  records `error` and preserves its identity/propagation. Skipped stages emit no executed record.
  Fixed handler records cover HTTP handlers and protocol dispatch boundaries only. Hooks likewise
  preserve existing ordering and aggregation. No request/response stream is read or cloned.
- Preserve synchronous request/handler paths: instrumentation executes inline primitive work and
  branches on the existing promise-like result rather than wrapping all handlers in `async`. Stream
  timing ends when the response is produced, not when the client consumes the stream.
- Use a private WeakMap for diagnostic request-operation context; do not put it in application state
  or reuse a caller-supplied request ID. Optional trace/span identifiers are read only from an
  already resolved telemetry service on the execution path, validated as non-zero 32/16-character
  lowercase hex. Catch telemetry-read failures, omit identifiers, and never retain tracing baggage,
  caller headers or span attributes. Add the internal method
  `ServiceRegistry.peekResolved<T extends object>(token: CapabilityToken): T | undefined` in
  `registry/service-registry.ts`, using the existing single-registration lookup precedence and
  returning only its cached instance. It never executes a factory, enumerates multi-providers or
  falls past an unresolved local registration to a parent. The class remains absent from the public
  barrel; this method is not part of `IServiceRegistry` or the diagnostic reader. Unresolved
  telemetry is treated as absent. No inferred relationship crosses a queue/broker boundary.
- **Test home:** `diagnostics-execution.test.ts`, `diagnostics-protocol-boundaries.test.ts`, and
  existing synchronous-fast-path and streaming tests. A fake telemetry service exercises absence,
  valid identifiers, invalid identifiers and throws; a lazy telemetry factory remains uncalled.

### 3.6 Bounds, readers and performance

- **Decision:** Fixed v1 limits: 1,024 event slots, 1,024 encoded bytes per event, 256 KiB per
  snapshot, 1,024 nodes and 4,096 edges. Drop oversized events whole; evict oldest events when the
  ring fills. Stop adding topology entries at its limits, set `truncated`, and omit edges whose
  endpoints are absent. Bound strings and counts before serialization/allocation, not afterwards.
  Maintain counters with saturation at `Number.MAX_SAFE_INTEGER`; stop collection with a coarse
  failure state before sequence IDs can wrap. These are internal constants, not unused options.
- No public push subscription, timers, consumer queues or background promises. Request work never
  awaits a reader. A reader can be slow, stop polling or throw after reading without affecting the
  application. Deliberately blocking synchronous code in the same JS process remains out of scope.
- Snapshot DTOs are built/cached at registration changes; requests append fixed-shape events. Reads
  return frozen safe data, not handles into mutable collector storage. Teardown clears all caches
  and weak context bookkeeping. An inspection failure must not change a response.
- Performance acceptance: same machine/runtime, five paired 10-second runs after warm-up for an
  empty synchronous route and an async route with five middleware stages. Disabled median throughput
  must be at least 98% of baseline; enabled at least 90%, with p95 latency at most 110% of baseline.
  Archive command, revision and distributions in `.tmp/`; a miss is work to resolve, not permission
  to silently weaken the budget. Deterministic tests additionally pin the synchronous return path.
- **Test home:** `diagnostics-buffer.test.ts`, `diagnostics-equivalence.test.ts`, and the bounded
  100,000-operation stress exercise. No benchmark harness exists on the inspected base. Add
  `scripts/benchmark-kernel-diagnostics.ts` with disabled/enabled modes, the fixed warm-up/window
  above, throughput and per-request p95 output. Run
  `deno run -A scripts/benchmark-kernel-diagnostics.ts --mode=disabled` and the same command with
  `--mode=enabled`; run the identical disabled harness against the pre-change kernel in a baseline
  worktree, storing its copied harness under `.tmp/`. Record all commands and revisions as evidence.

### 3.7 Consumer and threat boundary

- **Decision:** Add `scripts/inspect-kernel.ts`, a runnable example that creates a small application
  with explicit diagnostic label allowlists, starts it without a port, injects a request, reads the
  public snapshot/batch and emits only those DTOs. It is a script, not a privileged production CLI.
  The script is the real consumer before M98b exists and is exercised as a subprocess in a script
  test. It must not depend on private kernel imports or user application configuration.
- Assets are application secrets, user data and availability. Inputs include hostile request data,
  metadata getters, errors and overloaded capture. The source is an explicitly authorized in-process
  reader, not a tenant-scoped user endpoint. Network authentication belongs to M98b.
- **Test home:** `test/inspect-kernel.test.ts` and kernel canary/equivalence tests.

## 4. Exported surface — every symbol names its consumer

This table lists additions; existing exports stay intact.

| Exported symbol                          | Kind                    | Consumer / real code path that READS it                                                      |
| ---------------------------------------- | ----------------------- | -------------------------------------------------------------------------------------------- |
| `IDiagnosticsSource`                     | common interface        | Optional `IApplication.diagnostics`; script reads it; M98b later consumes the same contract. |
| `DiagnosticsSnapshot`, `DiagnosticsNode` | common DTO types        | Kernel snapshot projection and script output; M98b protocol validation.                      |
| `DiagnosticsEvent`, `DiagnosticsBatch`   | common DTO types        | Kernel ring/read implementation and script polling; M98b event responses.                    |
| `KernelDiagnosticsOptions`               | kernel interface        | `createApplication` constructs the collector and compiles label allowlists.                  |
| `ApplicationOptions.diagnostics`         | optional field          | Application construction; absent preserves the existing path.                                |
| `IApplication.diagnostics`               | optional readonly field | Script and connector; not a registry token or writer.                                        |

### 4.1 Options — every option names its consumer

| Option                | Consumer                          | Behavior (per implementation)                                         |
| --------------------- | --------------------------------- | --------------------------------------------------------------------- |
| `diagnostics`         | application factory               | Omitted disables allocation/instrumentation; supplied object enables. |
| `labels.plugins`      | registration projection           | Exact approved plugin names only.                                     |
| `labels.capabilities` | registry/declared-edge projection | Exact approved token labels only; values never read.                  |
| `labels.routes`       | route projection                  | Exact approved registered templates only.                             |
| `labels.middleware`   | pipeline projection               | Exact approved declared middleware names only.                        |

## 5. Implementation files

All paths are workspace-relative. New internal modules are not barrel-exported.

| File                                                                             | Purpose                                                                                    |
| -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| `packages/common/src/services/diagnostics.ts`                                    | DTO/read contracts, no runtime dependency.                                                 |
| `packages/common/src/plugin.ts`, `packages/common/src/index.ts`                  | Optional application member and documented type exports.                                   |
| `packages/kernel/src/diagnostics/projection.ts`                                  | Bounded metadata copying and allowlist compilation.                                        |
| `packages/kernel/src/diagnostics/buffer.ts`                                      | Bounded event ring, cursors and loss accounting.                                           |
| `packages/kernel/src/diagnostics/collector.ts`                                   | Internal writer/read facade, state, IDs and teardown.                                      |
| `packages/kernel/src/application/application.ts`, `packages/kernel/src/index.ts` | Option/export, initialization, state, request/dispatch integration and cleanup.            |
| `packages/kernel/src/registry/service-registry.ts`                               | Metadata-only mutation reporting without changing the logging observer.                    |
| `packages/kernel/src/router/router.ts`                                           | Safe registration metadata and selected-entry identity in internal matches.                |
| `packages/kernel/src/pipeline/middleware-pipeline.ts`                            | Approved middleware descriptors and ordered identities.                                    |
| `packages/kernel/src/pipeline/execute-chain.ts`                                  | Inline stage completion observations with unchanged dispatch semantics.                    |
| `packages/kernel/src/lifecycle/lifecycle-manager.ts`                             | Fixed-phase hook observations.                                                             |
| `scripts/inspect-kernel.ts`                                                      | Executable public consumer, no server or secret capture.                                   |
| `scripts/benchmark-kernel-diagnostics.ts`                                        | Reproducible paired throughput/latency exercise; smoke-check both modes and output fields. |
| `PUBLIC_API.md`, `ARCHITECTURE.md`, kernel/common READMEs, `CHANGELOG.md`        | Contract, timing/privacy limits, examples and new option.                                  |
| `ROADMAP.md`, `CLAUDE.md`, this plan                                             | Completion/tracking; archive this single plan in the implementation PR.                    |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Kernel test filenames below are under `packages/kernel/test/`; common's are under
`packages/common/test/`. Tests use `describe`/`it` and `expect` from the first draft.

| Test file                                                    | src covered                          | Key assertions (and the signature each call type-checks against)                                                                       |
| ------------------------------------------------------------ | ------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------- |
| common `unit/diagnostics-contract.test.ts`                   | common diagnostics/plugin/index      | Structural old application remains valid; public imports and consumer return types compile.                                            |
| kernel `unit/diagnostics-projection.test.ts`                 | projection                           | Exact labels, accessor omission, bounded strings, unknown fields absent, fixed errors.                                                 |
| kernel `unit/diagnostics-buffer.test.ts`                     | buffer                               | `read(after, limit)` cursor validation, truncation, overflow, non-destructive readers and saturated counters.                          |
| kernel `unit/diagnostics-contract.test.ts`                   | collector                            | `snapshot()` state/DTO freezing, runtime-not-ready null fields, closed reads and buffer disposal.                                      |
| kernel `integration/diagnostics-activation.test.ts`          | application/index, common exports    | Explicit options, absent property/allocations, no listener, public consumer signature.                                                 |
| kernel `integration/diagnostics-registration.test.ts`        | registry/router/pipeline/application | No lazy resolution, owners/declared edges, ordered priorities, removal/multi-provider and both match paths.                            |
| kernel `integration/diagnostics-lifecycle.test.ts`           | lifecycle/application/collector      | Early resolution failure, runtime initialization, per-hook ordering, startup/close failures and unconditional diagnostic cleanup.      |
| kernel `integration/diagnostics-execution.test.ts`           | execute-chain/pipeline/application   | Inclusive timings, nested parents, route chains, no-next, ended-then-next, double-next and same thrown error.                          |
| kernel `integration/diagnostics-protocol-boundaries.test.ts` | application/router                   | HTTP, upgrade and gRPC boundary labels; no claim of frame tracing; streaming body never consumed.                                      |
| kernel `integration/diagnostics-canaries.test.ts`            | projection/collector/application     | Secrets in headers/cookies/body/path/query/config/error/attributes never reach snapshots or batches; allowed labels and timing remain. |
| kernel `integration/diagnostics-equivalence.test.ts`         | all kernel files above               | Same responses/effects with capture off/on and failed/overloaded readers; deterministic sync path and 100,000-operation bounds.        |
| `test/inspect-kernel.test.ts`                                | script, public barrels               | Real subprocess output contains useful DTOs; no port, raw response body or private imports.                                            |

Retain existing tests for modified files; the table adds behavioral cases, not replacement suites.
No external runtime dependency is introduced, so no lazy-import test is required. Source-level
contracts work on all runtimes; real connector support is a separate M98b claim.

## 7. Verification gates

```bash
git branch --show-current   # feat/m98a-kernel-diagnostics during implementation
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage
```

Read the ANSI-stripped per-file coverage table: every changed source file must meet 90% branch,
function and line coverage. Exercise the real script and record the non-vacuous canary and
performance results. Grep changed source for the forbidden constructs listed in CLAUDE.md. Commit,
then run `deno task publish:check` and `deno task release:verify` with the actual committed
workspace version. No placeholder version is prescribed. Update public docs/status and archive this
plan in that PR. The current documentation change runs plan/format/docs checks; it does not claim
any of these future implementation gates have passed.

## 8. Risks & mitigations

- Safe-looking names contain secrets: exact opt-in labels, no default labels, bounded identifiers.
- An internal hook alters dispatch timing: preserve sync paths and prove equivalence/performance.
- Mutable object inspection executes getters: retain primitive projections at registration and never
  traverse application objects during a read; document the trusted-process boundary.
- Partial startup has no runtime: null timings and no ambient clock, with value-free failure state.
- Overload creates retention or availability problems: fixed caps, loss counters and no consumer
  callbacks in the request path.
- Plans precede code: security acceptance stays pending until the adversarial exercises pass.

## 9. Out of scope

- M98b: listener, pairing, protocol authentication and native extension connection.
- M98 follow-ons in ROADMAP.md: data access, payload/log/error capture, source files, policy
  explanations, non-HTTP instrumentation, controls, replay, recording and remote access.
- Separate devtool repository: UI, subscription management, Free/Pro enforcement and analytics.
