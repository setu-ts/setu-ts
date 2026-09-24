# Milestone 98d — Minimized Health Observations

> **Status:** Implemented on `feat/m98d-health-observations`; the committed-tree security audit
> (gate 2) is recorded in the implementation PR. `main` remains protected.

## 0. Objective & scope

Add an opt-in health inspector that records minimized results produced by ordinary health checks
and, when separately enabled, performs bounded scheduled checks. The health plugin owns collection
and minimization; the diagnostics connector only authenticates, projects a fixed DTO, and transports
it.

- **In scope:** typed health diagnostics contracts, `CAPABILITIES.HEALTH_DIAGNOSTICS`, latest-only
  observations for approved indicator aliases, an optional bounded scheduler, `/v1/health`, the
  native client's `health()` method, documentation, tests, and both M98 security gates.
- **NOT this milestone:** raw `HealthCheckResult.data`, exception text, remote/production access,
  alerting, historical health charts, or changes to `/health`, `/live`, `/ready` and Kubernetes
  probes.

## 1. Contracts verified from SOURCE (not names)

| Reference                         | Source (file:line)                                                   | Verified surface / fact                                                                                         |
| --------------------------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `IHealthService` / `HealthReport` | `packages/common/src/services/health.ts:55`                          | Checks execute application callbacks; reports contain arbitrary `data` and optional latency.                    |
| `HealthService`                   | `packages/health-plugin/src/services/health-service.ts:87`           | Selected indicators run concurrently behind per-indicator deadlines; timeout does not cancel underlying work.   |
| `HealthPluginOptions`             | `packages/health-plugin/src/interfaces/index.ts:59`                  | Existing options configure endpoints, indicators, and one indicator timeout; no observation policy exists.      |
| `HealthPlugin`                    | `packages/health-plugin/src/plugin/health-plugin.ts:59`              | Registers instances immediately, factories and contributions at `onInit`, then serves three existing endpoints. |
| `IDiagnosticsSource`              | `packages/common/src/services/diagnostics.ts:300`                    | Kernel reader has only frozen `snapshot()` and `read()`; it must not run application callbacks.                 |
| Connector dispatch                | `packages/diagnostics-plugin/src/transport/connector-handler.ts:248` | Every operation passes method, authority, origin, MAC, replay, instance, byte, and post-await session checks.   |
| Status/client compatibility       | `packages/diagnostics-plugin/src/protocol/protocol.ts:260`           | Status is an exact three-field v1 body today; the client rejects extra fields and all non-200 responses.        |
| Plugin ordering                   | `packages/kernel/src/registry/plugin-resolver.ts:38`                 | An optional capability dependency orders its provider first when present without requiring it.                  |
| Registry semantics                | `packages/common/src/registry.ts:86`                                 | Eager `register` avoids lazy construction; the application registry is sealed after bootstrap.                  |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                          | Resolution (picked side)                                                                                 | Doc deliverable (same PR)                                                                                                                 |
| -- | --------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `PUBLIC_API.md` and `ARCHITECTURE.md` describe health reports and M98a/M98b only; the roadmap now promises a minimized inspector. | Keep health endpoint contracts unchanged and document a separate opt-in diagnostics source and wire DTO. | Update both documents plus `docs/diagnostics-protocol.md`, the health/diagnostics READMEs, `CHANGELOG.md`, `ROADMAP.md`, and `CLAUDE.md`. |

## 3. Design decisions

### 3.1 Typed source, token, and fixed operation

- **Decision:** Add `CAPABILITIES.HEALTH_DIAGNOSTICS` (`health-diagnostics`) and an eager
  `IHealthDiagnosticsSource`. `HealthPlugin` always registers one source: it reports `disabled` when
  `options.diagnostics` is absent and performs no capture. `DiagnosticsPlugin` declares the token as
  optional, resolves it once during registration, and serves only `GET /v1/health`. An absent source
  produces a typed `unsupported` snapshot. This is a hard-coded operation and projector, not a
  generic provider bus.
- **Why:** The connector can distinguish unsupported, disabled, empty, stale, and failed states
  without importing the health plugin or inferring support from plugin names.
- **Test home:** common contract tests, health `plugin.test.ts`, and diagnostics protocol/connector
  tests.

### 3.2 Protocol support is negotiated before an addon read

- **Decision:** Before `packages/diagnostics-plugin` is first PUBLISHED — a hard gate, established
  by reading the shipped validator rather than assumed — extend the authenticated v1 status body
  with one exact `inspectors` object containing the eleven fixed boolean keys `health`,
  `configuration`, `queues`, `traces`, `authorization`, `cache`, `events`, `scheduler`, `realtime`,
  `storage`, and `outboundHttp`. M98d sets only `health: true`; M98e–M98n turn on their reserved key
  when their connector operation ships. A key means that the connector implements and validates that
  operation, independent of whether the application registered its owning source. The new client
  recognizes the exact legacy M98b three-field status body and the exact new four-field body; legacy
  means all eleven keys are false. It caches the authenticated manifest, returns a frozen typed
  `unsupported` DTO without sending an addon request when a key is false, and uses the operation's
  `unsupported` response only when the key is true but its source is absent. Unknown/missing/extra
  manifest keys and non-booleans fail pairing. Inspectors beyond these eleven require a new protocol
  version.
- **Why:** Client/server release skew has an explicit authenticated contract and never probes an
  unknown route or infers support from a generic protocol error.

  The publication gate is not a preference, and the legacy reading does NOT make it one — it covers
  only one of the two skew directions. A NEW client against an OLD server reads the three-field body
  as all keys false, which is the case above. An OLD client against a NEW server is the case that
  breaks: `isStatusBody` requires EXACTLY the three keys `version`, `instanceId` and `expiresInMs`,
  rejecting any other key count outright
  (`packages/diagnostics-plugin/src/protocol/protocol.ts:294-322`). The client then latches
  `pairingFailed` and every later call throws (`client/client.ts:335-338`, `216-218`), and the error
  it surfaces is `CLIENT_ERRORS.connection` — so a version skew reaches the user as a connection
  fault, which is a misdiagnosis rather than merely a failure. The server cannot avoid this by
  serving the old body to an old client: the request carries `x-setu-session`, `x-setu-sequence`,
  `x-setu-instance` and `x-setu-mac` and NOTHING identifying the client's protocol capability
  (`transport/connector-handler.ts:213-233`), so there is no signal to branch on. Adding one is
  possible — absence of a new client header would mean "old" — but it would have to enter the MAC
  canonicalization or be strippable, and it buys nothing while no client is published.

  That is what makes the gate cheap: M98a–M98c are merged and awaiting publication, so there is no
  client in the field to break, and settling the shape now costs one edit. Once the package
  publishes, the status body is frozen for its lifetime and the manifest can no longer live there at
  all — it would need its own authenticated target plus a compatibility rule, which is a separate
  design decision, not this plan's.
- **Test home:** diagnostics protocol/client compatibility matrix: legacy M98b status, M98d status,
  false health key, true key with absent source, malformed manifests, and no request on false. The
  matrix pins BOTH directions, so the asymmetry above cannot be forgotten: a new client against the
  legacy body pairs and reports all keys false, and the shipped `isStatusBody` rejects the new
  four-field body — the test asserting the second is the reason the gate exists.

Implementation must verify the package publication state before changing the wire shape. If any
released client already accepts the five-key manifest or the legacy body only, stop this in-place
change and amend the plan with an authenticated version-negotiation design and skew tests first. The
historical unpublished assumption is not permission to break a released client.

This reservation expands the earlier five-key planning proposal before first publication. No new
inspector is advertised as supported until its route and client validation ship. All keys remain
present and false in earlier implementations. No generic plugin-supplied keys are accepted.

### 3.3 Exact public DTO

- **Decision:** Add
  `DiagnosticsInspectorState = 'unsupported' | 'disabled' | 'no-data' | 'ready' |
  'stale' | 'collection-failed'`,
  `HealthObservationState = 'reported' | 'timed-out' | 'failed' |
  'never-observed'`,
  `HealthDiagnosticsObservation`, `HealthDiagnosticsSnapshot`, and `IHealthDiagnosticsSource` to
  common diagnostics contracts. A snapshot contains only `version: 1`, `instanceId`, inspector
  state, `observations`, `truncated`, and `droppedObservations`. Each observation contains approved
  `indicatorAlias`, `status` when reported, fixed observation state, `latencyMs`, `ageMs`, and
  origin (`application` or `scheduled`). No absolute time or arbitrary data is admitted.
- **Why:** Every wire field has a useful consumer meaning and a bounded primitive shape.
- **Test home:** common diagnostics types compile checks and diagnostics `protocol.test.ts`
  exact-key tests.

### 3.4 Capture normal checks once

- **Decision:** Add an internal `HealthObservationCollector` and a non-barrel-exported
  `attachHealthObservation(service, collector)` WeakMap seam in `health-service.ts`. The existing
  runner reports its already-computed outcome to the collector after each indicator settles; it
  never invokes an indicator again. The collector reads only framework-owned status, fixed failure
  category, measured latency, and the registered name needed for exact alias lookup. It never reads
  `result.data`.
- **Why:** Observation follows the authoritative evaluation while preserving the public service and
  route behavior.
- **Test home:** `health-service.test.ts` and `health-observation-collector.test.ts` compare
  callback counts, reports, and snapshots.

### 3.5 Approval and fixed bounds

- **Decision:** `HealthDiagnosticsOptions` requires `enabled: true`, an `indicators` record mapping
  exact registered names to display aliases, and optional `staleAfterMs` (default 30,000). Accept at
  most 64 entries; source names are never retained after the alias map is compiled; aliases are
  unique, 1–64 UTF-8 bytes, and contain no controls. The collector retains one frozen observation
  per approved alias, never a history. Invalid options fail at plugin construction with fixed,
  value-free errors.
- **Why:** Indicator names and topology are sensitive metadata and memory stays constant.
- **Test home:** `health-observation-options.test.ts` and sustained-input tests.

### 3.6 Separately controlled scheduled collection

- **Decision:** `diagnostics.scheduled` is absent by default. When present it names a subset of
  approved indicators and supplies `intervalMs` (1,000–300,000), `timeoutMs` (1–30,000), and
  `concurrency` (1–4). `onBootstrap` starts one guarded, non-awaited cycle and then one
  runtime-owned interval; `onClose` marks the collector closed FIRST, then clears the interval and
  every retained observation. Startup never awaits an application indicator. A cycle never overlaps
  its predecessor. Each raw callback promise remains marked in-flight after its reporting deadline,
  so no replacement check starts until that callback actually settles. A closed collector accepts no
  write: an outcome from a callback that settles after `onClose` — the ordinary case, since a
  reporting deadline bounds a callback without cancelling it — is discarded and never retained,
  logged, or projected. Work is capped at four callbacks and sixteen scheduled indicators. Each
  cycle covers every scheduled indicator not still in flight, starting from a rotating cursor, and
  waits only for each check's REPORTING race: an unsettled callback keeps its own concurrency slot
  (so it counts toward the cap of four) but never blocks the cycle, and the remaining slots keep
  refreshing the other indicators. (Verification found the first implementation took the same first
  `concurrency` names every cycle and awaited raw settlement, so one hung check froze every
  scheduled indicator; both are pinned by collector and real-socket e2e tests.)
- **Why:** A timeout is a reporting bound, not cancellation; retaining the in-flight gate prevents a
  hung callback from accumulating work. Closing before clearing is M98a's own teardown order
  (`DiagnosticsCollector.markClosed` at `packages/kernel/src/diagnostics/collector.ts:321` closes
  the ring and only then discards retained state), and it exists for this exact case: clearing alone
  leaves a later write able to repopulate state the shutdown path had just discarded.
- **Test home:** scheduler tests with hung, slow, rejecting, overlapping, and teardown cases,
  including a callback still in flight at `onClose` whose later settlement retains no observation
  and leaves the snapshot empty.

### 3.7 Connector and native client behavior

- **Decision:** `IHealthDiagnosticsSource.snapshot(instanceId: string): HealthDiagnosticsSnapshot`
  is synchronous. It requires a non-empty instance ID, throws one fixed value-free `RangeError` for
  invalid input, and returns a deeply frozen snapshot whose `instanceId` exactly equals the
  argument. The connector validates own data properties and exact enums/numbers, copies fields
  individually, applies the existing 256 KiB serialized ceiling, and catches source failure as a
  value-free `collection-failed` snapshot. `IDiagnosticsClient.health()` uses the existing
  serialized, signed exchange and exact DTO validator. All original session and request checks run
  before the source is called.
- **Why:** Additive data uses the reviewed M98b boundary and cannot smuggle extra properties onto
  the wire.
- **Test home:** diagnostics client, protocol, connector, and real-socket e2e tests.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                   | Kind               | Consumer / real code path that READS it                                     |
| --------------------------------- | ------------------ | --------------------------------------------------------------------------- |
| `DiagnosticsInspectorState`       | common type        | All planned inspector DTOs and devtool state rendering.                     |
| `HealthDiagnosticsObservation`    | common interface   | Health source, connector validator/projector, client, devtool health panel. |
| `HealthDiagnosticsSnapshot`       | common interface   | `IHealthDiagnosticsSource`, `IDiagnosticsClient.health`, and devtool.       |
| `IHealthDiagnosticsSource`        | common interface   | HealthPlugin registers it; DiagnosticsPlugin consumes it.                   |
| `CAPABILITIES.HEALTH_DIAGNOSTICS` | common token       | HealthPlugin provider and DiagnosticsPlugin optional consumer.              |
| `HealthDiagnosticsOptions`        | health option type | `HealthPluginOptions.diagnostics` validation and collector construction.    |
| `IDiagnosticsClient.health`       | interface method   | Native devtool reads the typed health projection.                           |

`IHealthDiagnosticsSource.snapshot(instanceId)` has the exact synchronous signature and behavior in
§3.7. `IDiagnosticsClient.health(): Promise<HealthDiagnosticsSnapshot>` performs pairing first and
returns the negotiated typed `unsupported` snapshot without an addon request when
`inspectors.health` is false.

`HealthObservationCollector`, scheduler helpers, attachment seam, validators, and projectors remain
internal.

### 4.1 Options — every option names its consumer

| Option                      | Consumer                  | Behavior (per implementation)                                                  |
| --------------------------- | ------------------------- | ------------------------------------------------------------------------------ |
| `diagnostics.enabled: true` | `HealthPlugin`            | Creates active capture; absence registers an inert disabled source.            |
| `diagnostics.indicators`    | option compiler/collector | Exact source-name to safe-alias allowlist; no fallback label.                  |
| `diagnostics.staleAfterMs`  | source snapshot           | Computes `stale` and `ageMs` from runtime monotonic time.                      |
| `diagnostics.scheduled.*`   | scheduler                 | Controls approved subset, cadence, deadline, and concurrency under fixed caps. |

## 5. Implementation files

| File                                                                                                                 | Purpose                                                                   |
| -------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `packages/common/src/services/diagnostics.ts`, `packages/common/src/tokens.ts`, `packages/common/src/index.ts`       | Health DTO/source contracts, token, exports.                              |
| `packages/health-plugin/src/interfaces/index.ts`, `src/diagnostics/health-observation-collector.ts`                  | Public options and bounded collector/scheduler.                           |
| `packages/health-plugin/src/services/health-service.ts`, `src/plugin/health-plugin.ts`, `src/index.ts`               | Single-evaluation observation, lifecycle, registration, exports.          |
| `packages/diagnostics-plugin/src/interfaces/index.ts`, `src/plugin/diagnostics-plugin.ts`                            | Client method and optional source resolution.                             |
| `packages/diagnostics-plugin/src/protocol/protocol.ts`, `src/transport/connector-handler.ts`, `src/client/client.ts` | Fixed target, projection/validation, authenticated dispatch, native read. |
| `PUBLIC_API.md`, `ARCHITECTURE.md`, `docs/diagnostics-protocol.md`, package READMEs, release/tracking docs           | Public behavior, security limits, support and audit evidence.             |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                       | src covered                     | Key assertions (and the signature each call type-checks against)                                                                                                    |
| --------------------------------------------------------------------------------------------------------------- | ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/diagnostics-contract.test.ts`, `test/unit/tokens.test.ts`, `test/unit/index.test.ts` | common diagnostics/tokens/index | DTO/source signatures and exact legal token.                                                                                                                        |
| `packages/health-plugin/test/unit/health-observation-options.test.ts`                                           | interfaces/index                | Bounds, aliases, duplicate/control refusal, disabled defaults.                                                                                                      |
| `packages/health-plugin/test/unit/health-observation-collector.test.ts`                                         | collector                       | Latest-only state, age/stale/failure, truncation, no data/error/path leakage, bounded hung work.                                                                    |
| `packages/health-plugin/test/unit/health-service.test.ts`                                                       | health-service                  | One callback per normal check; identical report; collector throws/overflow without behavior change.                                                                 |
| `packages/health-plugin/test/unit/health-plugin.test.ts`, `test/unit/barrel-exports.test.ts`                    | plugin/index                    | Eager token/source, lifecycle start/clear, configured subset, public exports.                                                                                       |
| `packages/diagnostics-plugin/test/unit/protocol.test.ts`                                                        | protocol                        | Legacy/new status shapes, fixed support manifest, canonical `/v1/health`, exact projection refusal.                                                                 |
| `packages/diagnostics-plugin/test/unit/connector-handler.test.ts`, `test/unit/plugin.test.ts`                   | connector/plugin                | Auth before read, unsupported/disabled states, source failure isolation, instance binding.                                                                          |
| `packages/diagnostics-plugin/test/unit/client.test.ts`, `test/index.test.ts`                                    | client/interfaces/index         | Legacy/manifest negotiation, no false-key request, `health()` verification, close/deadline behavior.                                                                |
| `packages/diagnostics-plugin/test/e2e/health-observations.test.ts`                                              | all changed paths               | Real socket and health callbacks; canaries planted in indicator data and errors, absent at the collector callback, source, frame and client; useful status remains. |

## 7. Verification gates

```bash
git branch --show-current   # feat/m98d-health-observations during implementation
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage
```

Read the ANSI-stripped per-file table and require 90% branch/function/line for every changed source.
On the committed tree run `deno task publish:check` and `deno task release:verify <version>`. Record
the design review and committed-tree security audit revision, tests, findings, dispositions, and
support limits in the implementation PR before marking M98d complete.

## 8. Risks & mitigations

- Health reads trigger side effects: capture only the already-produced result; test exact callback
  counts.
- Timed-out scheduled work accumulates: retain the in-flight gate until the raw promise settles and
  skip cycles.
- `data` or errors cross the seam: collector API accepts neither, and canary tests inspect every
  layer.
- Labels reveal topology: require explicit aliases and reject unapproved names rather than
  truncating them.
- Diagnostics failure changes readiness: guard every observer call and compare responses and side
  effects.
- Release-skew looks like connector failure: pair against the fixed support manifest; map the exact
  legacy status shape to addon-unsupported without probing an unknown target.

## 9. Out of scope

- Historical health storage, alert rules, and remote dashboards.
- Cancellation of arbitrary indicator promises; the bounded scheduler prevents replacement work
  instead.
- Treating `up` as proof of external reachability or changing readiness semantics.

## 10. Design security review — completed before implementation

**Reviewed flow:** indicator callback → existing health runner → primitive-only collector call →
latest-only map → typed source → authenticated connector → exact projector → signed bounded frame →
validating native client. Minimization occurs at the runner/collector boundary, before retention.

**Assets and attackers:** indicator data/errors may contain credentials, URLs and paths; names
reveal topology; callbacks may hang or be attacker-influenced; an unpaired local process or browser
may probe the port. M98b's MAC, replay, authority, origin, expiry and instance controls remain
mandatory for the new target.

**Budgets approved:** 64 approved aliases, 64 latest records, 16 scheduled indicators, four
callbacks, one non-overlapping cycle, 128 protocol objects only where applicable, 256 KiB wire
ceiling, runtime-owned timers, and full cleanup on close/failure.

| Finding                                                    | Resolution in this plan                                                        |
| ---------------------------------------------------------- | ------------------------------------------------------------------------------ |
| Reusing `HealthReport` would retain arbitrary `data`.      | Collector cannot accept `data`; DTO has no extension field.                    |
| Timeout alone could create unbounded callbacks.            | Deadline controls reporting while raw-promise gates suppress replacement work. |
| A generic inspector provider could widen the wire surface. | Dedicated token, route, source, validator and projector only.                  |
| Disabled collection could still schedule work.             | Inert source has no buffer, timer, callback wrapper, or registration observer. |
| An older connector cannot serve the new route.             | Authenticated status negotiation prevents the request and returns unsupported. |

The implementation audit must plant canaries in successful data, thrown errors, names and paths;
prove their absence from collector callbacks, memory, frames, errors and logs; exercise
wrong/replayed/expired/revoked and cross-instance credentials; and include positive controls showing
approved status, latency and age survive.
