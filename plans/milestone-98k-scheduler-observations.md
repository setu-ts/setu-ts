# Milestone 98k — Scheduler Execution Observations

> **Status:** Implemented on `feat/m98k-scheduler-observations`. No design review was recorded
> before implementation; it is recorded retroactively in §10.1. The committed-tree security audit
> runs in a fresh context before the PR merges; its history is in §12.

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

**Design gate — the requirement as planned.** It was not met before implementation; the review is
recorded retroactively in §10.1. Review this exact dataflow: real producer -> primitive-only
observation -> bounded source -> authenticated fixed route -> exact projector -> validating native
client. Confirm field allowlist, instance/data scope, budgets, retention and negative tests. Resolve
security-boundary findings in this plan first.

### 10.1 Design security review

**Recorded 2026-09-29, AFTER implementation.** The design gate above called for a recorded review
before implementation. None was recorded: the plan's status line claimed a maintainer plan review,
but nothing in this file records one, and the first committed-tree audit (`e7de8812`) failed on
exactly that (finding F1). This review is therefore retroactive — the M98i precedent — and is
checked against the §3 decisions AND the code as repaired in §11, not written from the code alone:
every obligation below existed in §3 or §10 before implementation, and each implementation choice is
assessed against it rather than adopted because it exists. It was written by the Claude Code
verification session, which also authored the §11 repairs, at the maintainer's direction. It is not
the committed-tree audit, which runs in a fresh context (§12).

**Purpose it serves.** M98 lets a developer inspect a running application on their own machine
without the devtool gaining access to live services, application data, credentials or any mutation
control. For the scheduler inspector the devtool may learn HOW the plugin's own `SchedulerService`
behaved for each APPROVED job: how many local timer fires dispatched, were skipped because a lock
was held elsewhere, or were skipped because a lock operation rejected; how late the last fire
started; how many handler invocations began, succeeded, failed or were retries; and the last
duration. It never learns WHAT a job carries, WHICH job it is beyond its approved alias, WHEN it is
scheduled, or WHY it failed.

**Reviewed flow:** a timer fire → `SchedulerService#fire` → one private-field read for an attached
collector (none → the pre-M98k path unchanged) → `fireBegin(name, intendedFireMs)`: an exact-name
lookup in the approved `jobs` map (unapproved → `null`, nothing retained) and one wall-clock read
for lateness, normalized to integer milliseconds → the fire-slot and overlap-mutex decisions, each
reported as a fixed outcome (`contended`, `lock-failed`, `dispatched`) → for a dispatch, the
executor hands the job to the handler, and an attempt observer records a start only when the
application's handler is actually INVOKED (inside the behaviour chain when one is configured) and a
settlement with a boolean outcome and a retry flag → every clock read on the observed path goes
through the collector's guard → the bounded collector (at most 64 (job alias, operation) records,
monotonic readings only) → the plugin registers a frozen snapshot-only source under the
multi-provider `CAPABILITIES.SCHEDULER_DIAGNOSTICS` → the connector resolves sources once at
bootstrap (more than 16 refuses startup) → authenticated `GET /v1/scheduler` behind every M98b
control (exact `Host` authority, `Origin` refusal, forwarding-header refusal, MAC over canonical
fields, sequence replay refusal, expiry and revocation, instance binding) → own-data copy of each
snapshot with per-source isolation → exact validator (exact keys, fixed operations, integer
counters, unique tuples, state/record consistency) → fixed 256 KiB budget → signed frame → native
client re-validates and binds the instance. Minimization happens at the capture site: the job name
(beyond the approval lookup), the cron expression, the payload, the job id, the lock keys and
tokens, the `ScheduledJob`, and every thrown value stay in the scheduler's locals. The collector's
signatures accept only a name to look up, an epoch number, a fixed outcome, booleans and numbers.

**Assets.**

| Asset                                 | Why it is sensitive                                                                             |
| ------------------------------------- | ----------------------------------------------------------------------------------------------- |
| Job payloads (`ScheduledJob.data`)    | Application data: ids, tokens, PII carried to a handler.                                        |
| Job names                             | Routinely derived from tenants, users or resources (`invoice-tenant-42`); unbounded if dynamic. |
| Cron expressions and intervals        | Reveal business schedules; low but real sensitivity.                                            |
| Job ids                               | Correlate a run with application logs and records.                                              |
| Lock keys and lock tokens             | Keys embed job names; a token is a capability to release a held lock.                           |
| Thrown errors (message, cause, stack) | Routinely quote payloads, hosts, SQL or credentials.                                            |
| Counts, lateness and durations        | Low sensitivity; reveal activity levels and timing, aggregated across every tenant.             |
| The session key and signed channel    | Owned by M98b; this letter adds a route behind it and must not weaken it.                       |

**Attackers and their reach.**

| Attacker                                                                                   | Must not be able to                                                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An unpaired local process, or a browser tab on the host                                    | Read any scheduler observation, cause a source read, or obtain an unsigned response.                                                                                                                                                                                                                                                                                                                      |
| A website using DNS rebinding (its hostname resolved to `127.0.0.1`; may send no `Origin`) | Read any scheduler observation or cause a source read.                                                                                                                                                                                                                                                                                                                                                    |
| The paired devtool (trusted reader of the minimized DTO)                                   | Obtain any asset above except counts, lateness and durations under approved aliases; schedule, pause, resume, remove or trigger a job; acquire or release a lock; enumerate the job registry.                                                                                                                                                                                                             |
| Whoever controls job registration (dynamic job names from request data)                    | Make a raw name reach a record, or grow collector state: only EXACT names pre-approved in `jobs` are observed, and the table is capped.                                                                                                                                                                                                                                                                   |
| A peer replica sharing the distributed lock                                                | Have its fires, names or tokens observed on this replica; it can only make this replica's fires report `contended`, which is the truth.                                                                                                                                                                                                                                                                   |
| An ingress behaviour or the handler itself                                                 | Have a declined dispatch reported as a handler attempt, or make observation change the handler's result, retries or ordering.                                                                                                                                                                                                                                                                             |
| A third-party in-process plugin registering a hostile source                               | Put an unvalidated field, an accessor result, a control character, a non-integer counter, a forged operation or an oversized list into the signed frame, or make the connector invoke its getters. It MAY blank every source's report through the two deliberate whole-response collapses (claiming another source's alias; pushing the body over budget), which answer a value-free `collection-failed`. |
| A failing or throwing clock, collector or lock                                             | Change any fire, lock acquire/release, handler result, retry, error identity or schedule, or leak error text.                                                                                                                                                                                                                                                                                             |

**Out of the threat model (unchanged from M98b and M98i–M98l):** a privileged local sniffer, remote
access, and shared multi-tenant production use. A third-party source runs with application
privileges and is not sandboxed; the reader keeps its OUTPUT out of the signed frame, it does not
contain its code. Existing application logging (the scheduler's `warn`/`error` lines, which do quote
job names and error messages) is a separate path this change neither alters nor sanitizes. An
application-constructed `SchedulerService` and a replacement registered under
`CAPABILITIES.SCHEDULER` are not observed and never labelled observed. Cluster completeness is not
claimed: a record describes local fires of this instance only.

**Approved budgets.** At most 64 approved job names; at most 64 (job alias, operation) records per
source — reachable once more than 32 approved jobs are active, so a NEW tuple at capacity first
reclaims expired slots and only then is refused, counting one saturating `dropped` per ignored
observation. Records expire 60 seconds after their last observation, checked on write (at capacity)
and on read, never by a timer; `stale` when every record is older than 30 seconds. Every counter
saturates at `Number.MAX_SAFE_INTEGER`; lateness and durations are integer milliseconds. Per
observed dispatched fire: one wall-clock read and five monotonic reads (two more per retried attempt
or extra handler invocation), plus, per handler invocation, one settlement closure and — for a
handler that returns a promise — one derived promise settling with the handler's own result, one
fire observation and one attempt observer; a contended or lock-failed fire costs one wall and one
monotonic read. Per unapproved fire on an attached service: one map lookup. Unattached (the
default): one private-field read per fire; a behaviour-wrapped handler pays one `WeakMap.get` per
dispatch whether observed or not. No queue, no I/O, no background timer, no extra lock or backend
call. At most 16 sources; a 17th refuses startup with a fixed error. A 256 KiB response that
collapses to a fixed `collection-failed` with no sources rather than truncating. Overhead is
measured in §11: no extra lock calls, no memory growth, and inside run-to-run noise against real
timers; on a synthetic no-op microtask loop the observed path adds ~0.7 µs per fire, beyond §3.4's
≤5% target in that setting — **accepted by the maintainer on 2026-09-29** (the M98a and M98j
precedent): the cost is per observed fire, scheduler fires are infrequent, and the disabled path is
unchanged.

| Finding                                                                                                                                    | Resolution                                                                                                                                                                                                                                                                                                                                               |
| ------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Job names are the tempting label and are often tenant- or user-derived.                                                                    | Only EXACT, pre-approved names are observed, each under an explicit alias the application chose; own-entry lookup only. A raw name never enters a record. Aliases are validated (1–64 UTF-8 bytes, no controls, unique) with fixed, value-free messages.                                                                                                 |
| A lock key embeds the job name; a token is a capability.                                                                                   | Neither is passed to the collector. Outcomes cross as a fixed enum.                                                                                                                                                                                                                                                                                      |
| A thrown error quotes secrets.                                                                                                             | The executor passes only a boolean outcome; observation code never reads `message`, `cause` or `stack`. Canary tests plant error text and assert it absent at snapshot, wire and client.                                                                                                                                                                 |
| Observation could change scheduling — a throwing clock between a lock acquire and its release, or after a handler succeeded.               | Found in verification (§11): the service and executor read the runtime clock directly. Every observation clock read now goes through the collector's guard, which latches `collection-failed` and answers `null`; the executor reads no clock. An off / on / throwing-clock equivalence test asserts identical handler calls, lock traffic and schedule. |
| A behaviour that declines a dispatch was counted as a successful handler attempt.                                                          | Found by the first audit (F3). An attempt is begun and settled AROUND the application handler's own invocation, at the chain's terminal step. A declined or refused dispatch records no attempt; its fire still reports the dispatch's settlement.                                                                                                       |
| A behaviour calling `next()` after its step returned left an attempt started and never settled; one calling it twice recorded one attempt. | Found by the second audit (G1, introduced by the F3 fix; G2, pre-existing). Each invocation gets its own settlement carrying its own start reading and origin record, settled by the handler's OWN result (fulfilled, rejected, or a synchronous throw). Nothing is shared between invocations.                                                          |
| A fractional `delay`/`every` time produced a non-integer lateness, which the wire refuses — blanking the whole source.                     | Found in verification (§11): lateness and durations are normalized to integer milliseconds at the collector boundary. Unit and real-socket e2e tests.                                                                                                                                                                                                    |
| A full table of expired slots refused live work; a refused attempt counted two drops; `started` could fall below `count`.                  | Found in verification (§11): reclaim at capacity (the M98j precedent), one drop per ignored observation, and a per-start record identity so a settlement landing in a replaced record counts its start there.                                                                                                                                            |
| Lock losers could produce handler records and make a skipped local fire look like work.                                                    | A skipped fire is recorded as `contended`/`lock-failed` on the fire record only; no attempt observer is built. Two-replica tests over a shared lock assert dispatched = contended = handler runs = attempts.                                                                                                                                             |
| Registering the collector would hand every `getAll` reader its mutators.                                                                   | The plugin registers a frozen `{ snapshot }` source; the collector is reachable only through a private field whose sole writer is the non-exported attach/detach helpers.                                                                                                                                                                                |
| A hostile third-party source could smuggle fields, forge an operation, or have the connector run its code.                                 | The shared `copyOwnData`/`copyOwnDataList` reader (own DATA properties only, exact keys, plain prototype, no getter invoked) plus the exact validator; per-source isolation to a fixed `collection-failed`.                                                                                                                                              |
| Two sources claiming one alias would make the report ambiguous.                                                                            | Duplicate non-null aliases collapse the whole response to `collection-failed` with no sources (the M98i–M98l rule).                                                                                                                                                                                                                                      |
| A source could be read before authentication.                                                                                              | Sources are read only inside the authenticated dispatch, after the shared M98b gate; bootstrap only collects the list.                                                                                                                                                                                                                                   |
| Shutdown could resurrect state.                                                                                                            | `onClose` detaches first, then closes the collector (marked closed before clearing). A late observation is discarded; `snapshot()` answers `disabled`.                                                                                                                                                                                                   |
| A DNS-rebinding page reaches the loopback port as same-origin to its own hostname.                                                         | Identical to M98i–M98l: exact `Host` authority, any `Origin` refused, per-launch-key MAC, no CORS permission, `127.0.0.1`-only listener. The audit re-probes it on a raw socket.                                                                                                                                                                         |
| Counts aggregate every tenant; lateness and durations are a coarse timing side channel.                                                    | As M98i–M98l: enable on an approved development dataset only; no tenant selector or per-user identifier exists; timings are integer milliseconds of the last observation, not per run.                                                                                                                                                                   |

**For the audit (in addition to the implementation gate below):** drive the REAL Redis lock
(`distributedLock: { enabled: true, storage: 'redis', url }` against a live Redis) with two replicas
and assert dispatched = contended = handler runs = attempts, with no lock key or token on the wire;
drive a REAL cron fire (a `* * * * *` job started shortly before a minute boundary) and assert its
record; drive a behaviour that declines and one that refuses by throwing; drive the client's
`scheduler: false` manifest branch against a live server that advertises it; probe DNS rebinding on
a raw socket; probe hostile sources (accessor, index-getter, class-instance, symbol-key, `Proxy`,
non-integer counter, forged operation); and compare behaviour observed versus unobserved under a
throwing clock and a throwing lock.

**Approved by the maintainer on 2026-09-29,** as drafted, including the overhead decision above.

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

## 11. Verification-review repairs and implementation evidence

A verification and code review of `9c6e7805` found defects that every gate and the per-file bar had
passed. The fixes are on this branch, and each carries a test that fails without it (all six
negative controls were observed failing, then reverted):

- **Fractional times collapsed the whole source.** Lateness was stored unrounded, and the wire
  admits only integer counters, so `delay(name, 20.5)` or `every(name, 100.5)` made the SOURCE
  `collection-failed` and hid every other job's records (a fractional `every` flickered between
  `ready` and `collection-failed` indefinitely). Lateness and durations now pass through one
  `toWireMs` normalization. Guarded by a collector unit test and a real-socket e2e.
- **Expired slots were not reclaimed at capacity.** Only a read swept expired records, so with more
  than 32 approved jobs a full table of dead slots refused live work. A NEW tuple at capacity now
  reclaims expired slots first (the M98j precedent).
- **A refused attempt counted two drops**, one at its start and one at its settlement; only the
  settlement counts now.
- **`started` could fall below `count`** when a record expired while its handler ran. The attempt
  observer now carries the record its start was counted in, and a settlement landing in a different
  record counts the start there (the M98j per-start slot token).
- **Observation-only clock reads were unguarded on the observed path**, contrary to §3.4. The
  service read `runtime.hrtime()` for dispatch timing between the lock acquire and the `try` whose
  `finally` releases it, and the executor read it inside the handler's `try`, so a throw after a
  successful handler would have been treated as a failure and retried. All observation clock reads
  now go through the collector's guard (`monotonic()` / `elapsedSince()`, and the attempt observer
  times itself); the executor reads no clock.

**Off / on / failing equivalence (§6).** One scenario — cron, every and a retried delay job, a
contended fire slot, a held overlap mutex, pause/resume/remove — runs with no collector, a working
collector, and a collector over a runtime whose `hrtime` always throws (bound exactly as the plugin
binds it). Handler calls, lock traffic, the next-run time and the pending timer count are asserted
identical across all three (`packages/scheduler-plugin/test/unit/scheduler-observations.test.ts`).

**Overhead (§3.4).** The service is driven through `every(1)` over the real runtime, with a lock
that always grants. Each configuration runs in a fresh process, alternating, five runs each. GC is
forced at the warm-up boundary and at the end.

| Workload                                         | Off (median)       | On (median)     | Extra lock calls | Heap after GC |
| ------------------------------------------------ | ------------------ | --------------- | ---------------- | ------------- |
| Real `setTimeout(0)` timers, 10,000 warmed fires | 482 fires/s        | 482 fires/s     | 0 (3 per fire)   | —             |
| Microtask timers, 100,000 warmed fires, no-op    | ~1.9–2.4 M fires/s | ~0.90 M fires/s | 0 (3 per fire)   | +0–1 KiB      |
| Same, pre-repair code (`9c6e7805`)               | ~2.4 M fires/s     | ~0.64 M fires/s | 0                | +5–6 KiB      |

Zero extra backend calls and no memory growth hold. The ≤5% throughput target holds against real
timers, where the enabled path is inside the run-to-run noise. It does NOT hold on the synthetic
microtask loop: there a no-op handler costs ~0.4 µs per fire, and observation adds ~0.7 µs (six
monotonic reads, the fire observation and the attempt observer). The repairs made the enabled path
faster than the implementation under review, not slower. The maintainer accepted that cost on
2026-09-29 (§10.1).

## 12. Security audit record

**Round 1 — `e7de8812`, 2026-09-29: failed.** Run by a freshly spawned Claude agent following
`.roo/skills/security-audit/SKILL.md`; the implementation was by the milestone's implementing
session and the §11 repairs by the Claude Code verification session. 132 checks across 8 probes,
every one with a positive control; 8 negative controls, each observed failing. No data-leak,
authentication or availability defect. Findings and dispositions:

| #  | Severity | Finding                                                                           | Disposition                                                                                         |
| -- | -------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| F1 | Blocking | No completed design review recorded in the plan.                                  | Fixed: recorded retroactively in §10.1; approval recorded there.                                    |
| F2 | Low      | ROADMAP and CLAUDE.md claimed both security gates passed.                         | Fixed: both now read "pending" until an audit passes.                                               |
| F3 | Low      | A behaviour that declines a dispatch was counted as a successful handler attempt. | Fixed: an attempt is recorded only when the chain invokes the handler; tests for decline and throw. |
| F4 | Low      | The e2e job-id canary could never fail (no job id was ever set to it).            | Fixed: the e2e collects every delivered job id and asserts each absent, with a positive control.    |

Support limits of round 1 (Deno only; no live Redis lock; no cron fire; client `scheduler: false`
branch not driven live) are carried into §10.1's audit obligations.

**Round 2 — `351c128d`, 2026-09-29: failed.** Run by a new freshly spawned Claude agent following
`.roo/skills/security-audit/SKILL.md` (Steps 1–7); implementation by the milestone's implementing
session, fixes by the Claude Code verification session, round 1 by a different fresh agent. Every
§10.1 obligation driven with a positive control: the real Redis lock across two replicas (dispatched
= contended = handler runs = attempts = 17, 20 real lock keys and 54 tokens absent from the wire), a
real `* * * * *` cron fire (recorded once, loser `contended`), declining and throwing behaviours,
the client's `scheduler: false` branch against a live re-signing server, DNS rebinding on a raw
socket, 13 hostile sources, and observed-vs-unobserved equivalence under a throwing clock and five
failing lock modes. 15 negative controls, each observed failing. F1–F4 resolved.

| #  | Severity | Finding                                                                                                            | Disposition                                                                                                                                                                |
| -- | -------- | ------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| G1 | Low      | A behaviour calling `next()` after returning leaves a started attempt that never settles (introduced by F3's fix). | Fixed: each handler invocation is begun and settled around the handler's own result. A real-app test fails against `351c128d`'s code.                                      |
| G2 | Low      | A behaviour calling `next()` twice records one attempt for two invocations; contradicts the new doc claim.         | Fixed: every invocation begins its own attempt. A real-app test fails against `351c128d`'s code; an async-rejecting handler test pins settlement by the handler's promise. |

Remaining support limits of round 2: Deno only; Redis driven healthy only (outages via injected
locks); the `scheduler: false` server was a re-signing proxy, not a pre-M98k build.
