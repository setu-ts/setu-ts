# Milestone 98k — Scheduler Execution Observations

> **Status:** Planning. Implementation and fixes: `feat/m98k-scheduler-observations`. Design
> security assessment below requires recorded review before implementation; no implementation or
> completed security audit is claimed.

## 0. Objective & scope

Provide bounded, opt-in scheduler execution observations through the authenticated local connector.

- **In scope:** Local observed execution only; durable history, cluster completeness and job control
  are excluded. Owner: `packages/scheduler-plugin`; common and connector changes are necessary
  consumers.
- **NOT this milestone:** raw-data inspection, remote access, persistent history, controls or
  replay.

Depends on the M98a/M98b boundaries and M98d's revised eleven-key manifest. No runtime dependency on
the other inspector providers. Each source states observed-instance coverage, never automatic
visibility into all application code.

## 1. Contracts verified from SOURCE (not names)

| Reference     | Source (file:line)                                                   | Verified surface / fact                                                                                 |
| ------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Source seam   | `packages/common/src/services/scheduler.ts:83`                       | IScheduler has cron/every/delay, controls and getNextRun; no inspection listing.                        |
| Source seam   | `packages/scheduler-plugin/src/services/scheduler-service.ts:450`    | Handler lock and fire-slot acquisition precede dispatch and can skip execution.                         |
| Source seam   | `packages/scheduler-plugin/src/jobs/job-executor.ts:44`              | run executes retry attempts; ingress behavior wraps handlers inside the lock.                           |
| Registry      | `packages/common/src/registry.ts:86`                                 | register supports multi; getAll resolves providers; do not resolve application services for inspection. |
| Connector     | `packages/diagnostics-plugin/src/transport/connector-handler.ts:248` | Existing authenticated dispatch and post-await session checks must govern new operations.               |
| Compatibility | `packages/diagnostics-plugin/src/protocol/protocol.ts:294`           | Current status validator has exact keys; M98d's manifest is planned, not implemented.                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                             | Resolution (picked side)                                                                                                           | Doc deliverable (same PR)                                                         |
| -- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| C1 | Existing public APIs expose application operations, not this source. | Add dedicated source contracts; retain application method signatures.                                                              | PUBLIC_API.md, ARCHITECTURE.md, owning package README and CHANGELOG.              |
| C2 | Earlier M98d reserved only five inspectors.                          | Revise unpublished manifest to eleven exact keys in this planning change; this letter activates `scheduler` only when implemented. | M98d plan and ROADMAP.md now; docs/diagnostics-protocol.md during implementation. |

## 3. Design decisions

### 3.1 Authoritative capture seam

**Decision:** Observe timer fire, slot-lock and handler-lock outcomes inside SchedulerService, and
actual attempt settlement inside the executor. Use runtime.now only to compare intended epoch fire
and actual start; use hrtime for duration. Distinguish contention, lock failure, actual attempt
failure and completion. Record lateness as max(0, actualStart-intendedFire), not an absolute
schedule. Observation never acquires a lock or invokes a handler. A skipped local fire is not a
globally missed execution.

**Why:** Counters describe executed work rather than inventing backend or cluster state. **Test
home:** owning package `test/unit/scheduler-observations.test.ts`.

Attach the internal collector to the owned implementation during plugin registration through a
non-barrel-exported WeakMap attachment helper. Existing exported constructor signatures remain
unchanged. Each hot path checks for an attachment before reading clocks or deriving labels. The
collector accepts only the fixed operation, approved alias, primitive outcome and measured values;
raw inputs and errors never cross that seam. The source uses the same bounded collector and owns no
reference to business payloads. Close detaches first, then clears collector state.

### 3.2 Source ownership and registration

Owning plugins eagerly register `ISchedulerDiagnosticsSource` under
`CAPABILITIES.SCHEDULER_DIAGNOSTICS` (`scheduler-diagnostics`) with `multi: true`. Keep plugin names
and application capability `provides` unchanged: no instance claims the shared diagnostic token in
`provides`, avoiding duplicate-provider rejection. The connector resolves getAll once at onBootstrap
after all register hooks, using the fixed common token, never arbitrary service enumeration. Read
only these explicitly registered eager sources; no get on the application capability and no backend
probing. A source describes its original owned service, not the current registration: coverage is
always `owned-instance`, including if replaced; custom replacement behavior is not represented.
Never claim final-provider completeness.

The connector admits at most 16 sources, refusing excess sources with a fixed value-free
configuration error. Duplicate non-null aliases discovered during a read yield a fixed
collection-failed response with no sources; validation does not invoke snapshot at registration.
Disabled plugin sources need no configured alias: connector assigns session-local `sourceId` values
`s1` through `s16` by registration order, while alias is null. IDs remain stable until connector
teardown. Configured aliases must be unique across this inspector. Built-in source reads perform no
application operation. Third-party source code runs with application privileges and is not sandboxed
by this interface.

### 3.3 Exact public projection and reader

Add common `ISchedulerDiagnosticsSource`, `SchedulerDiagnosticsSnapshot`,
`SchedulerDiagnosticsRecord`, and `SchedulerDiagnosticsResponse`.

`ISchedulerDiagnosticsSource.snapshot(): SchedulerDiagnosticsSnapshot` is synchronous, takes no
caller-selected resource, and returns a deeply frozen exact-key object:
`{ state: DiagnosticsInspectorState, alias: string | null, coverage: 'owned-instance', records: readonly SchedulerDiagnosticsRecord[], dropped: number }`.

A record has exactly `alias: string`, `operation: 'fire' | 'attempt'`, `count: number`,
`lastDurationMs: number | null`, `ageMs: number`, plus `started`, `succeeded`, `failed`,
`contended`, `lockFailed`, `retryAttempts`, `lastLatenessMs` (safe nonnegative integers; lateness is
milliseconds). Numbers are finite, nonnegative and clamped at Number.MAX_SAFE_INTEGER; durations are
integer milliseconds. count counts settled observations, not currently active calls. Counters are
cumulative within the retention window. Nonapplicable numeric counters are zero. lastDurationMs is
null for instantaneous lifecycle observations; otherwise it is the last settled duration. Record
alias is the approved job alias from diagnostics.jobs; snapshot.alias identifies the owning source.
On failed collection the source clears records and exposes only state, approved alias, coverage and
dropped. Lifecycle-closed and disabled states take precedence over collection-failed. Read only
framework-owned primitive fields; never pass a business object or an Error to the collector.

`SchedulerDiagnosticsResponse` is exactly
`{ version: 1, instanceId: string, state: DiagnosticsInspectorState, sources: readonly { sourceId: string, snapshot: SchedulerDiagnosticsSnapshot }[] }`.
`IDiagnosticsClient.scheduler(): Promise<SchedulerDiagnosticsResponse>` reads only
`GET /v1/scheduler` through the existing signed, serialized exchange. All authentication,
origin/authority, replay, expiry, revocation, instance and post-read session checks precede
returning any data; request authentication must succeed before snapshot is called. Pairing sees
`scheduler: false` as a local typed unsupported response without a request. A supported operation
with no sources returns unsupported and []. Per-source invalid reads become fixed collection-failed
snapshots with no records; no error text. Response state is ready if any source is ready, otherwise
collection-failed, stale, no-data, disabled, unsupported in that priority order. Individual states
remain visible.

Projectors accept exact own data properties and reject getters, prototypes with unexpected shape,
extra keys, invalid enums or oversized arrays. Snapshot and record values are plain objects
(Object.prototype or null prototype) containing only own data properties; custom prototypes are
rejected. Proxy traps cannot be sandboxed: catch their failures and never copy unknown fields. Copy
approved primitives individually. The full response is limited to 256 KiB; on exceeding it return a
fixed collection-failed response, never a partial JSON document. The client independently validates
the same contract.

### 3.4 Opt-in, retention and overhead

Plugin option
`diagnostics?: { enabled: true, alias: string, jobs: Readonly<Record<string, string>> }` is absent
by default; absent means an inert disabled source with no collector or observation clock reads. When
diagnostics is supplied, `jobs` is required; an empty map approves no observations.
`diagnostics.jobs: Readonly<Record<string, string>>` maps exact declared or imperatively registered
job names to aliases; all others are omitted.

Aliases are explicit non-secret labels, unique, 1–64 UTF-8 bytes, without controls; do not derive
aliases by truncating or hashing sensitive values. The jobs map admits at most 64 exact entries. Map
lookup must use own entries, not inherited properties. Configuration maps may retain approved source
names for matching; diagnostic records never retain those names. No user mapping callback.

Each source admits at most 64 record slots keyed by approved alias and fixed operation. At capacity,
ignore new tuples and increment saturating dropped; existing tuples continue updating. Records
expire after 60 seconds without an observation, checked during update/read; clear their counters on
expiry. age >30 seconds means stale; any fresh record means ready; no records means no-data. No
background timer and no per-request diagnostic queue. On close mark closed before clearing; late
results cannot repopulate state, and snapshot returns disabled. Each observed call retains only
primitive timing/alias state, no additional wait on external work, body copy or diagnostic I/O.
Promise observation may add a microtask; tests must preserve application ordering guarantees without
claiming identical promise identity or a literally zero-cost enabled path.

Use runtime.hrtime for plugin durations; SDK uses the injected monotonic now. Clamp negative deltas.
Catch observer and clock failures without changing application errors or results; latch
collection-failed and stop capture until source recreation. No diagnostic error logging with values.
Benchmark disabled/enabled on the same workload; require zero extra backend calls and no growing
memory after steady state. Target <=5% median throughput regression at 10,000 warmed operations;
record five runs and investigate failures before completion rather than claiming a universal bound.

### 3.5 Scope and isolation

Local pairing authorizes the configured application instance, not a per-tenant login. Counts may
aggregate tenants in that development instance. Do not advertise tenant isolation from aliases. Only
enable on an explicitly approved development dataset; shared multi-tenant production use is
unsupported. No tenant selectors, per-user identifiers, resource lookups or controls are added.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                      | Kind                       | Consumer / real code path that READS it                    |
| ------------------------------------ | -------------------------- | ---------------------------------------------------------- |
| `ISchedulerDiagnosticsSource`        | common interface           | Owning source and connector reader.                        |
| `SchedulerDiagnosticsSnapshot`       | common type                | Source, exact projector and client.                        |
| `SchedulerDiagnosticsRecord`         | common type                | Bounded collector and devtool summary.                     |
| `SchedulerDiagnosticsResponse`       | common type                | Connector and native client method.                        |
| `IDiagnosticsClient.scheduler`       | client method              | Devtool inspector.                                         |
| `SchedulerDiagnosticsOptions`        | owning package option type | Application opt-in and collector construction.             |
| `CAPABILITIES.SCHEDULER_DIAGNOSTICS` | common token               | Owning plugin multi-registration and connector resolution. |

Collectors, attachment helpers and projectors remain internal. No general observer/event-bus API.

### 4.1 Options — every option names its consumer

| Option          | Consumer                     | Behavior (per implementation)                  |
| --------------- | ---------------------------- | ---------------------------------------------- |
| enabled / alias | Owning collector constructor | Explicit activation and approved display name. |
| jobs            | Exact collector allowlist    | Approve source-name-to-alias mapping only.     |

## 5. Implementation files

| File                                                                  | Purpose                                                     |
| --------------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/common/src/services/diagnostics.ts`                         | Typed contract, export, authenticated projection or reader. |
| `packages/common/src/tokens.ts`                                       | Typed contract, export, authenticated projection or reader. |
| `packages/common/src/index.ts`                                        | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/interfaces/index.ts`                 | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`        | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/protocol/protocol.ts`                | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/transport/connector-handler.ts`      | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/client/client.ts`                    | Typed contract, export, authenticated projection or reader. |
| `packages/scheduler-plugin/src/services/scheduler-service.ts`         | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/scheduler-plugin/src/jobs/job-executor.ts`                  | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts`            | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/scheduler-plugin/src/interfaces/index.ts`                   | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/scheduler-plugin/src/index.ts`                              | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/scheduler-plugin/src/diagnostics/scheduler-observations.ts` | Opt-in capture, source, options or lifecycle wiring.        |

Also update PUBLIC_API.md, ARCHITECTURE.md, docs/diagnostics-protocol.md, package READMEs,
CHANGELOG.md, ROADMAP.md and CLAUDE.md. SDK dependency metadata changes in M98n accompany its common
contract release; no external dependency is introduced.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                              | src covered                                                           | Key assertions (and the signature each call type-checks against)                                           |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts`  | `packages/common/src/services/diagnostics.ts`                         | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                    |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts`  | `packages/common/src/tokens.ts`                                       | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                    |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts`  | `packages/common/src/index.ts`                                        | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                    |
| `packages/diagnostics-plugin/test/unit/scheduler-observations.test.ts` | `packages/diagnostics-plugin/src/interfaces/index.ts`                 | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                    |
| `packages/diagnostics-plugin/test/unit/scheduler-observations.test.ts` | `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`        | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                    |
| `packages/diagnostics-plugin/test/unit/scheduler-observations.test.ts` | `packages/diagnostics-plugin/src/protocol/protocol.ts`                | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                    |
| `packages/diagnostics-plugin/test/unit/scheduler-observations.test.ts` | `packages/diagnostics-plugin/src/transport/connector-handler.ts`      | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                    |
| `packages/diagnostics-plugin/test/unit/scheduler-observations.test.ts` | `packages/diagnostics-plugin/src/client/client.ts`                    | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                    |
| `packages/scheduler-plugin/test/unit/scheduler-observations.test.ts`   | `packages/scheduler-plugin/src/services/scheduler-service.ts`         | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                    |
| `packages/scheduler-plugin/test/unit/scheduler-observations.test.ts`   | `packages/scheduler-plugin/src/jobs/job-executor.ts`                  | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                    |
| `packages/scheduler-plugin/test/unit/scheduler-observations.test.ts`   | `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts`            | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                    |
| `packages/scheduler-plugin/test/unit/scheduler-observations.test.ts`   | `packages/scheduler-plugin/src/interfaces/index.ts`                   | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                    |
| `packages/scheduler-plugin/test/unit/scheduler-observations.test.ts`   | `packages/scheduler-plugin/src/index.ts`                              | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                    |
| `packages/scheduler-plugin/test/unit/scheduler-observations.test.ts`   | `packages/scheduler-plugin/src/diagnostics/scheduler-observations.ts` | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                    |
| `packages/diagnostics-plugin/test/e2e/scheduler-observations.test.ts`  | All owning producers and connector reader                             | Real producer -> source.snapshot() -> signed socket -> client.scheduler(); positive controls and canaries. |

Compare fire times, pause/resume/remove, delay/cron/every, retries, slot dedup and overlap locks
with diagnostics off/on/failing. Prove lock losers do not produce handler records.

Every mapped test calls the §3 signatures. Exercise legacy status and all eleven reserved keys,
false-key no-request, absent source, source throw, malformed source objects including throwing
getters, snapshot overrun, duplicate aliases, unpaired/replayed/expired/revoked/cross-instance
requests and refusal of mutation methods. Custom application replacements remain outside source
coverage, do not get instantiated by snapshot, and cannot be mislabeled as observed.

## 7. Verification gates

```bash
git branch --show-current   # feat/m98k-scheduler-observations
deno task check:plan
deno task fmt:check
deno task lint
deno task check
deno task check:docs
deno task test
deno task test:coverage
```

Read the ANSI-stripped per-file table: every changed src file >=90% branch/function/line. On the
committed implementation run deno task publish:check and deno task release:verify with the actual
release version. Run dependency audit and the existing applicable guarded real-import and
runtime/adapter tests. Record both security gates below before marking complete or publishing.

## 8. Risks & mitigations

- Sensitive metadata in otherwise harmless counters: explicit approved aliases and declared scope.
- Observation distorts semantics: compare exact results, errors, side effects and backend call
  counts.
- Sustained input exhausts memory: fixed slots, source limit, retention, saturating counters and
  wire cap.
- Partial instrumentation looks complete: owned-instance coverage and explicit exclusions.

## 9. Out of scope

Local observed execution only; durable history, cluster completeness and job control are excluded.

No database inspector, persistent history, raw payloads, admin controls, replay, remote transport or
billing integration. Future adapter-specific visibility requires separately planned contracts and
audits; it is not implied by completing this milestone.

## 10. Required security reviews and acceptance evidence

**Design gate — pending recorded review before implementation.** Review this exact dataflow: real
producer -> primitive-only observation -> bounded source -> authenticated fixed route -> exact
projector -> validating native client. Confirm field allowlist, instance/data scope, budgets,
retention and negative tests. Resolve security-boundary findings in this plan first.

**Implementation gate — pending committed-tree audit before completion/publication.** Record commit,
reviewed files, tested adapters/runtimes, findings and dispositions in the implementation PR. Test
real operations through the connector. No untested adapter can be listed as audited support.

Plant canaries in job data, raw names, job IDs, cron expressions, lock keys/tokens, exception
messages. Assert absence at the diagnostic collector boundary, retained records, source reads,
frames, client results and diagnostics-generated logs/errors. Existing application logging is a
separate path; do not claim this change sanitizes it. Include approved-data positive controls so
dropping all records cannot pass. Reject hostile strings and extra keys, and exercise secret-bearing
errors without reading their message/cause/stack.

Compare disabled, enabled, observer-throwing, overflowing and shutdown behavior. Test arbitrary
local probes and browser origins, credentials/replay/session lifetime, source-read order and
resource exhaustion. Review connection/frame integrity failures separately from optional collection
failure: authentication must never degrade into a usable unsigned response. The devtool separately
must pass safe rendering, secret-free logs/export and credential-storage acceptance tests.
