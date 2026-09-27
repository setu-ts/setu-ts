# Milestone 98j — Event Dispatch Observations

> **Status:** Implemented on `feat/m98j-event-observations`; verification and code review done
> (2026-09-27), with every finding fixed on this branch. The design security review is recorded and
> approved (§10.1). The independent committed-tree security audit (§10) is PENDING; the milestone is
> not complete until it is recorded.

## 0. Objective & scope

Provide bounded, opt-in event dispatch observations through the authenticated local connector.

- **In scope:** Only the in-process InMemoryEventBus; broker acknowledgements and cross-service
  delivery remain separate messaging work. Owner: `packages/events-plugin`; common and connector
  changes are necessary consumers.
- **NOT this milestone:** raw-data inspection, remote access, persistent history, controls or
  replay.

Depends on the M98a/M98b boundaries and M98d's revised eleven-key manifest. No runtime dependency on
the other inspector providers. Each source states observed-instance coverage, never automatic
visibility into all application code.

## 1. Contracts verified from SOURCE (not names)

| Reference     | Source (file:line)                                                   | Verified surface / fact                                                                                 |
| ------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Source seam   | `packages/common/src/services/events.ts:60`                          | IEventBus exposes publish/publishBatch/subscribe; payloads and event identities are arbitrary.          |
| Source seam   | `packages/events-plugin/src/bus/in-memory-event-bus.ts:20`           | Dispatch awaits handlers in order; async mode returns before pending dispatch settles.                  |
| Registry      | `packages/common/src/registry.ts:86`                                 | register supports multi; getAll resolves providers; do not resolve application services for inspection. |
| Connector     | `packages/diagnostics-plugin/src/transport/connector-handler.ts:248` | Existing authenticated dispatch and post-await session checks must govern new operations.               |
| Compatibility | `packages/diagnostics-plugin/src/protocol/protocol.ts:294`           | Current status validator has exact keys; M98d's manifest is planned, not implemented.                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                             | Resolution (picked side)                                                                                                        | Doc deliverable (same PR)                                                         |
| -- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| C1 | Existing public APIs expose application operations, not this source. | Add dedicated source contracts; retain application method signatures.                                                           | PUBLIC_API.md, ARCHITECTURE.md, owning package README and CHANGELOG.              |
| C2 | Earlier M98d reserved only five inspectors.                          | Revise unpublished manifest to eleven exact keys in this planning change; this letter activates `events` only when implemented. | M98d plan and ROADMAP.md now; docs/diagnostics-protocol.md during implementation. |

## 3. Design decisions

### 3.1 Authoritative capture seam

**Decision:** Instrument publish entry and each existing handler await, without subscribing an extra
handler or changing dispatch. Count publications, handler starts, successes and failures separately.
async publication completion is not handler completion. A thrown errorHandler retains its existing
propagation behavior. Aggregate handlers under their approved event alias; individual handler names
and function identities are excluded. publishBatch counts constituent publish calls once.

**Why:** Counters describe executed work rather than inventing backend or cluster state. **Test
home:** owning package `test/unit/event-observations.test.ts`.

Attach the internal collector to the owned implementation during plugin registration through a
non-barrel-exported WeakMap attachment helper. Existing exported constructor signatures remain
unchanged. Each hot path checks for an attachment before reading clocks or deriving labels. The
collector accepts only the fixed operation, approved alias, primitive outcome and measured values;
raw inputs and errors never cross that seam. The source uses the same bounded collector and owns no
reference to business payloads. Close detaches first, then clears collector state.

### 3.2 Source ownership and registration

Owning plugins eagerly register `IEventDiagnosticsSource` under `CAPABILITIES.EVENTS_DIAGNOSTICS`
(`event-diagnostics`) with `multi: true`. Keep plugin names and application capability `provides`
unchanged: no instance claims the shared diagnostic token in `provides`, avoiding duplicate-provider
rejection. The connector resolves getAll once at onBootstrap after all register hooks, using the
fixed common token, never arbitrary service enumeration. Read only these explicitly registered eager
sources; no get on the application capability and no backend probing. A source describes its
original owned service, not the current registration: coverage is always `owned-instance`, including
if replaced; custom replacement behavior is not represented. Never claim final-provider
completeness.

The connector admits at most 16 sources, refusing excess sources with a fixed value-free
configuration error. Duplicate non-null aliases discovered during a read yield a fixed
collection-failed response with no sources; validation does not invoke snapshot at registration.
Disabled plugin sources need no configured alias: connector assigns session-local `sourceId` values
`s1` through `s16` by registration order, while alias is null. IDs remain stable until connector
teardown. Configured aliases must be unique across this inspector. Built-in source reads perform no
application operation. Third-party source code runs with application privileges and is not sandboxed
by this interface.

### 3.3 Exact public projection and reader

Add common `IEventDiagnosticsSource`, `EventDiagnosticsSnapshot`, `EventDiagnosticsRecord`, and
`EventDiagnosticsResponse`.

`IEventDiagnosticsSource.snapshot(): EventDiagnosticsSnapshot` is synchronous, takes no
caller-selected resource, and returns a deeply frozen exact-key object:
`{ state: DiagnosticsInspectorState, alias: string | null, coverage: 'owned-instance', records: readonly EventDiagnosticsRecord[], dropped: number }`.

A record has exactly `alias: string`, `operation: 'publish' | 'handler'`, `count: number`,
`lastDurationMs: number | null`, `ageMs: number`, plus `started`, `succeeded`, `failed`,
`noSubscribers` (safe integers; noSubscribers applies only to publish); publish success means
dispatch accepted, not delivered. Numbers are finite, nonnegative and clamped at
Number.MAX_SAFE_INTEGER; durations are integer milliseconds. count counts settled observations, not
currently active calls. Counters are cumulative within the retention window. Nonapplicable numeric
counters are zero. Read only framework-owned primitive fields; never pass a business object or an
Error to the collector.

`EventDiagnosticsResponse` is exactly
`{ version: 1, instanceId: string, state: DiagnosticsInspectorState, sources: readonly { sourceId: string, snapshot: EventDiagnosticsSnapshot }[] }`.
`IDiagnosticsClient.events(): Promise<EventDiagnosticsResponse>` reads only `GET /v1/event` through
the existing signed, serialized exchange. All authentication, origin/authority, replay, expiry,
revocation, instance and post-read session checks precede returning any data; request authentication
must succeed before snapshot is called. Pairing sees `events: false` as a local typed unsupported
response without a request. A supported operation with no sources returns unsupported and [].
Per-source invalid reads become fixed collection-failed snapshots with no records; no error text.
Response state is ready if any source is ready, otherwise collection-failed, stale, no-data,
disabled, unsupported in that priority order. Individual states remain visible.

Projectors accept exact own data properties and reject getters, prototypes with unexpected shape,
extra keys, invalid enums or oversized arrays. Snapshot and record values are plain objects
(Object.prototype or null prototype) containing only own data properties; custom prototypes are
rejected. Proxy traps cannot be sandboxed: catch their failures and never copy unknown fields. Copy
approved primitives individually. The full response is limited to 256 KiB; on exceeding it return a
fixed collection-failed response, never a partial JSON document. The client independently validates
the same contract.

### 3.4 Opt-in, retention and overhead

Plugin option
`diagnostics?: { enabled: true, alias: string, events: Readonly<Record<string, string>> }` is absent
by default; absent means an inert disabled source with no collector or observation clock reads. When
diagnostics is supplied, `events` is required; an empty map approves no observations.
`diagnostics.events: Readonly<Record<string, string>>` maps exact event types to approved aliases;
unknown types are omitted before capture. No dynamic handler enumeration.

Aliases are explicit non-secret labels, unique, 1–64 UTF-8 bytes, without controls; do not derive
aliases by truncating or hashing sensitive values. The events map admits at most 64 exact entries.
Map lookup must use own entries, not inherited properties. Configuration maps may retain approved
source names for matching; diagnostic records never retain those names. No user mapping callback.

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

| Exported symbol                   | Kind                       | Consumer / real code path that READS it                    |
| --------------------------------- | -------------------------- | ---------------------------------------------------------- |
| `IEventDiagnosticsSource`         | common interface           | Owning source and connector reader.                        |
| `EventDiagnosticsSnapshot`        | common type                | Source, exact projector and client.                        |
| `EventDiagnosticsRecord`          | common type                | Bounded collector and devtool summary.                     |
| `EventDiagnosticsResponse`        | common type                | Connector and native client method.                        |
| `IDiagnosticsClient.events`       | client method              | Devtool inspector.                                         |
| `EventDiagnosticsOptions`         | owning package option type | Application opt-in and collector construction.             |
| `CAPABILITIES.EVENTS_DIAGNOSTICS` | common token               | Owning plugin multi-registration and connector resolution. |

Collectors, attachment helpers and projectors remain internal. No general observer/event-bus API.

### 4.1 Options — every option names its consumer

| Option          | Consumer                     | Behavior (per implementation)                  |
| --------------- | ---------------------------- | ---------------------------------------------- |
| enabled / alias | Owning collector constructor | Explicit activation and approved display name. |
| events          | Exact collector allowlist    | Approve source-name-to-alias mapping only.     |

## 5. Implementation files

| File                                                             | Purpose                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/common/src/services/diagnostics.ts`                    | Typed contract, export, authenticated projection or reader. |
| `packages/common/src/tokens.ts`                                  | Typed contract, export, authenticated projection or reader. |
| `packages/common/src/index.ts`                                   | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/interfaces/index.ts`            | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`   | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/protocol/protocol.ts`           | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/transport/connector-handler.ts` | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/client/client.ts`               | Typed contract, export, authenticated projection or reader. |
| `packages/events-plugin/src/bus/in-memory-event-bus.ts`          | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/events-plugin/src/plugin/events-plugin.ts`             | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/events-plugin/src/interfaces/index.ts`                 | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/events-plugin/src/index.ts`                            | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/events-plugin/src/diagnostics/event-observations.ts`   | Opt-in capture, source, options or lifecycle wiring.        |

Also update PUBLIC_API.md, ARCHITECTURE.md, docs/diagnostics-protocol.md, package READMEs,
CHANGELOG.md, ROADMAP.md and CLAUDE.md. SDK dependency metadata changes in M98n accompany its common
contract release; no external dependency is introduced.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                             | src covered                                                      | Key assertions (and the signature each call type-checks against)                                        |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts` | `packages/common/src/services/diagnostics.ts`                    | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                 |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts` | `packages/common/src/tokens.ts`                                  | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                 |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts` | `packages/common/src/index.ts`                                   | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                 |
| `packages/diagnostics-plugin/test/unit/event-observations.test.ts`    | `packages/diagnostics-plugin/src/interfaces/index.ts`            | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                 |
| `packages/diagnostics-plugin/test/unit/event-observations.test.ts`    | `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`   | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                 |
| `packages/diagnostics-plugin/test/unit/event-observations.test.ts`    | `packages/diagnostics-plugin/src/protocol/protocol.ts`           | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                 |
| `packages/diagnostics-plugin/test/unit/event-observations.test.ts`    | `packages/diagnostics-plugin/src/transport/connector-handler.ts` | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                 |
| `packages/diagnostics-plugin/test/unit/event-observations.test.ts`    | `packages/diagnostics-plugin/src/client/client.ts`               | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                 |
| `packages/events-plugin/test/unit/event-observations.test.ts`         | `packages/events-plugin/src/bus/in-memory-event-bus.ts`          | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                 |
| `packages/events-plugin/test/unit/event-observations.test.ts`         | `packages/events-plugin/src/plugin/events-plugin.ts`             | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                 |
| `packages/events-plugin/test/unit/event-observations.test.ts`         | `packages/events-plugin/src/interfaces/index.ts`                 | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                 |
| `packages/events-plugin/test/unit/event-observations.test.ts`         | `packages/events-plugin/src/index.ts`                            | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                 |
| `packages/events-plugin/test/unit/event-observations.test.ts`         | `packages/events-plugin/src/diagnostics/event-observations.ts`   | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                 |
| `packages/diagnostics-plugin/test/e2e/event-observations.test.ts`     | All owning producers and connector reader                        | Real producer -> source.snapshot() -> signed socket -> client.events(); positive controls and canaries. |

Exercise sync/async dispatch, handler rejection, errorHandler throwing, publishBatch, unsubscribe
during dispatch, and shutdown while handlers are pending. Assert exact invocation order/count and no
second evaluation.

Every mapped test calls the §3 signatures. Exercise legacy status and all eleven reserved keys,
false-key no-request, absent source, source throw, malformed source objects including throwing
getters, snapshot overrun, duplicate aliases, unpaired/replayed/expired/revoked/cross-instance
requests and refusal of mutation methods. Custom application replacements remain outside source
coverage, do not get instantiated by snapshot, and cannot be mislabeled as observed.

## 7. Verification gates

```bash
git branch --show-current   # feat/m98j-event-observations
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

Only the in-process InMemoryEventBus; broker acknowledgements and cross-service delivery remain
separate messaging work.

No database inspector, persistent history, raw payloads, admin controls, replay, remote transport or
billing integration. Future adapter-specific visibility requires separately planned contracts and
audits; it is not implied by completing this milestone.

## 10. Required security reviews and acceptance evidence

### 10.1 Design security review

**Recorded 2026-09-27, after implementation, at the maintainer's direction; approved the same day
(see the end of this section).** No design review was recorded before implementation (§11 records
that this plan's header and the tracking docs claimed one anyway). As with M98i, this section is
checked against the §3 decisions — the design as planned — and every place the implementation
departed from §3 is named and assessed below rather than silently adopted. It was written by the
context that verified and fixed the milestone, not by its implementer; it is NOT the committed-tree
audit, which must still run in a fresh context.

**Purpose it serves.** M98 lets a developer inspect a running application on their own machine
without the devtool gaining access to live services, application data, credentials or any mutation
control. For the event inspector the devtool may learn HOW the owned in-process bus is dispatching —
per approved event alias, how many publications, how many handler runs started and settled, how many
failed, how long the last one took — and never WHAT was dispatched or WHO handled it.

**Reviewed flow:** application code → `publish`/`publishBatch` on the plugin-created
`InMemoryEventBus` → one `WeakMap` probe for an attached collector (none → the pre-M98j path,
byte-identical) → exact-type lookup in the compiled allowlist `Map` (miss → the unobserved path, no
clock read) → `begin`/`end` calls carrying only
`(alias, fixed operation, boolean outcome, boolean
noSubscribers)` → bounded collector (64 slots
keyed alias × operation, monotonic readings only) → frozen `IEventDiagnosticsSource` snapshot under
the multi-provider `CAPABILITIES.EVENTS_DIAGNOSTICS` → connector resolves the sources once at
bootstrap (more than 16 refuses startup) → authenticated `GET /v1/event` behind every M98b control
(exact `Host` authority, `Origin` refusal, forwarding-header refusal, MAC over canonical fields,
sequence replay refusal, expiry and revocation, instance binding) → own-data copy of each snapshot
with per-source isolation → exact validator → fixed 256 KiB budget → signed frame → native client
re-validates and binds the instance. Minimization happens in the BUS, before the collector: the
event object, its type, payload, id, aggregate id, the handler function and any thrown value stay in
the bus's own locals and are never passed across the observer seam.

**Assets.**

| Asset                              | Why it is sensitive                                                                                     |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Event payloads (`data`)            | Application data: orders, users, tokens, PII.                                                           |
| Event ids and aggregate ids        | Correlate to users, tenants and resources.                                                              |
| Event type names                   | May carry domain or tenant naming (`tenant-42.invoice.paid`); unbounded if attacker-influenced.         |
| Handler function names/identities  | Reveal code structure and third-party integrations.                                                     |
| Handler / `errorHandler` errors    | May quote payloads, hosts, SQL, credentials.                                                            |
| Counts, starts and timings         | Low sensitivity; reveal activity levels and handler latency, aggregated across every tenant of the app. |
| The session key and signed channel | Owned by M98b; this letter adds a route behind it and must not weaken it.                               |

**Attackers and their reach.**

| Attacker                                                                                      | Must not be able to                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An unpaired local process, or a browser tab on the host                                       | Read any event observation, cause a source read, or obtain an unsigned response.                                                                                                                                                                                                                                                                                                                                                                                    |
| A website using DNS rebinding (its hostname re-resolved to `127.0.0.1`; may send no `Origin`) | Read any event observation or cause a source read.                                                                                                                                                                                                                                                                                                                                                                                                                  |
| The paired devtool (trusted reader of the minimized DTO)                                      | Obtain any asset above except counts/starts/timings under approved aliases, publish an event, invoke a handler, subscribe, or enumerate subscriptions.                                                                                                                                                                                                                                                                                                              |
| A third-party in-process plugin registering a hostile source                                  | Put an unvalidated field, accessor result, control character or oversized list into the signed frame, or make the connector invoke its getters. It MAY blank every source's reporting through the two deliberate whole-response collapses (claiming another source's alias; pushing the body over budget), which answer a value-free `collection-failed` rather than ambiguous or partial data; any other hostile snapshot isolates to its own `collection-failed`. |
| Application traffic publishing attacker-chosen event types                                    | Grow collector or connector state, or have an unapproved type observed, counted or named.                                                                                                                                                                                                                                                                                                                                                                           |
| A failing, throwing or hung handler, `errorHandler`, or clock                                 | Change any dispatch result, ordering, rejection, unhandled-rejection reporting or `whenIdle()` outcome, reject a `publish`, reach `errorHandler`, or leak error text.                                                                                                                                                                                                                                                                                               |

**Out of the threat model (unchanged from M98b/M98i):** a privileged local sniffer, remote access,
and shared multi-tenant production use. A third-party source runs with application privileges and is
not sandboxed — it can block the event loop in `snapshot()`; the reader's job is to keep its OUTPUT
out of the signed frame, not to contain its code. Existing application logging (the default
`errorHandler` logs through `ctx.logger`) is a separate path this change neither alters nor
sanitizes. Other buses (an application-constructed `InMemoryEventBus`, a replacement registered
under `CAPABILITIES.EVENTS`, or a broker) are not observed and never mislabeled as observed.

**Approved budgets.** At most 64 approved event types per source and at most 64 record slots, one
per (alias, operation) — so more than 32 active aliases can reach capacity, at which point new
tuples are ignored and a saturating `dropped` counts one per refused settlement; 60-second retention
and 30-second staleness checked during update and read, never by a timer; every counter saturates at
`Number.MAX_SAFE_INTEGER`; per publication `1 + handlers` monotonic clock reads (each handler starts
at the previous boundary's settlement reading; a no-subscriber publish reads once), an alias-indexed
slot lookup with no per-event string building, and an O(64) expiry walk at most once per second on
the write path (every `snapshot()` still walks, so a read never reports a record past retention); no
queue, I/O or per-event allocation; at most 16 sources (a 17th refuses startup with a fixed error);
a 256 KiB response that collapses to a fixed `collection-failed` with no sources rather than
truncating or refusing. The disabled path is one `WeakMap.get` per publish.

**Overhead — measured on real instances on Deno, Node and Bun; §3.4's ≤5% target is met on Node and
Bun and NOT met on Deno, so the maintainer must accept or reject it before approving.**

_Application level (the number to judge)._ A real kernel application per process — `RuntimePlugin`

- `EventsPlugin` — serving `GET /json`, which publishes one approved event to two handlers and
  returns JSON; Node and Bun run the same branch source bundled with `deno bundle`, and each runtime
  was confirmed to detect itself and (when enabled) to record the publications. Three configurations
  per runtime — `none` (the route does not publish), `off` (publishes, diagnostics absent), `on`
  (publishes, diagnostics enabled) — alternated within each of 9 passes (order reversed on even
  passes), server pinned to cores 8–15 and bombardier to 16–31, 64 connections, 15 s warm-up then a
  20 s window, non-2xx hard-failing. Medians over 9 passes:

| Runtime | `off` rps | `on` rps | Paired median on/off | Passes with on ≥ off | p50 off → on | p99 off → on   |
| ------- | --------- | -------- | -------------------- | -------------------- | ------------ | -------------- |
| Deno    | 209,393   | 186,032  | **−11.8%**           | 1 / 9                | 290 → 316 µs | 466 → 517 µs   |
| Node    | 106,947   | 106,011  | **−1.2%**            | 2 / 9                | 548 → 565 µs | 1015 → 1039 µs |
| Bun     | 191,951   | 185,353  | **−3.4%**            | 2 / 9                | 294 → 311 µs | 737 → 751 µs   |

Per-pass spread was 7–25% (above the harness's 15% quotable threshold for Deno `none`/`off`, Node
`off` and Bun `off`), so the Node and Bun deltas sit inside the noise while the Deno regression is
consistent — 8 of 9 passes negative, −3% to −17%. For scale, publishing at all (`off` vs `none`)
cost −1.1% on Deno, −6.8% on Node and −8.2% on Bun. This route does almost nothing but publish, so
it is close to the worst case an application can present; a handler doing real I/O would dilute all
of these.

_Bus in isolation (for context)._ A microbenchmark of the bus alone (one process per configuration,
20 × 10,000 publications, five paired runs, Deno) puts enabled at about 0.25–0.4 µs per publication:
3–4× a no-op handler's bus cost and about +20–30% against a handler doing a small JSON write. Clock
reads dominate (~62 ns each, measured); an interim version reading four per publication cost ~5×,
and threading readings between boundaries halved that. A timing sample (M98i's one-in-eight) was
rejected: an unsampled call would not advance the record's activity reading, so a slow-moving alias
could expire from retention while in use. The cost is paid only when `diagnostics` is enabled, on
the development instance the inspector exists for.

| Finding                                                                                       | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| --------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Payloads, ids, handler identities or errors could enter capture.                              | The collector's only entry points are `begin(alias, operation, at?)` and `end(alias, operation, startedAt, succeeded, noSubscribers?, at?)` — an alias string, a fixed operation, booleans and monotonic readings; the bus keeps the event, handler and thrown value in its own locals and passes a boolean. A test plants canaries in payload, event id, aggregate id, error and an unapproved type and asserts absence at snapshot, wire and client DTO, with approved aggregates as the positive control.                                                                 |
| Event type names could disclose domain naming or grow state with attacker-chosen types.       | Only exact types in the approved allowlist are observed, and each is replaced by its alias before anything is retained; an unapproved type costs one `Map` miss, no clock read, no slot, no `dropped` increment. The allowlist is compiled once at `EventsPlugin(...)` from OWN entries only, so `toString`/`__proto__` cannot become an approval.                                                                                                                                                                                                                           |
| An alias could carry a secret or forge terminal output.                                       | Aliases are explicit; approving one authorizes its disclosure. 1–64 UTF-8 bytes, no C0/C1 control, unique within the source, validated in the plugin, the connector and the client. The instance alias never derives from the plugin name.                                                                                                                                                                                                                                                                                                                                   |
| Observation could change dispatch semantics.                                                  | **Found and fixed in review (§11):** an async `errorHandler` throw was absorbed only when observed, and an unguarded clock read could reject `publish`. Now every collector call is non-throwing, a failing clock latches `collection-failed`, and the observed async path rethrows so the rejection stays unhandled and `whenIdle()` still rejects. Parity is tested observed vs unobserved, and at every clock-read position in sync and async mode.                                                                                                                       |
| A hung handler would be invisible, hiding the failure an operator most needs to see.          | **Found and fixed in review:** `started` is counted at `begin`, so `started - count` is in-flight work; a never-settled slot still ages out after 60 s through `lastSeenAtMs`.                                                                                                                                                                                                                                                                                                                                                                                               |
| A hostile third-party source could smuggle fields or have the connector run its code.         | **Found in this review and fixed:** §3.3 requires rejecting getters and non-plain prototypes, but the reader destructured the snapshot and indexed `records` directly, invoking accessors. Snapshot and records now go through the shared `copyOwnData`/`copyOwnDataList` (own DATA properties only, exact keys including symbols, plain prototype, arrays read by descriptor), extracted from the M98i cache reader so both inspectors share one implementation. A test proves no getter is invoked and each malformed source isolates to a value-free `collection-failed`. |
| Two sources claiming one alias would make the report ambiguous.                               | Duplicate non-null instance aliases collapse the whole response to `collection-failed` with no sources.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Too many sources or an oversized body could truncate, refuse or leak partial data.            | **Found and fixed in review:** more than 16 sources refuses startup (was: silently read the first 16); an over-budget body is the fixed `collection-failed` (was: a 503 the client reported as a connection failure).                                                                                                                                                                                                                                                                                                                                                        |
| A DNS-rebinding page reaches the loopback port as same-origin to its own hostname.            | Identical to M98i: (1) `Host` must be exactly `127.0.0.1:<port>` (`connector-handler.ts:800`, and the parsed URL authority at `:823`), refused before any cryptography or source read; (2) any `Origin` is refused (`:806`), not relied on; (3) a per-launch-key MAC is required; (4) no CORS permission is emitted. The listener binds `127.0.0.1` only (runtime `local-diagnostics-listener.ts:214`).                                                                                                                                                                      |
| A source could be read before authentication.                                                 | The event sources are read only inside the authenticated dispatch (`connector-handler.ts:996`), after the shared M98b gate; bootstrap only collects the list.                                                                                                                                                                                                                                                                                                                                                                                                                |
| Shutdown could resurrect state or strand work.                                                | `onClose` detaches the observer first, then closes the collector (marking it closed before clearing), then clears the bus; a late settlement is discarded and the source answers `disabled`. Tested with a pending handler.                                                                                                                                                                                                                                                                                                                                                  |
| An older connector cannot serve the route.                                                    | The negotiated manifest answers a local `unsupported` without a request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Counts and timings aggregate every tenant; `lastDurationMs` is a coarse latency side channel. | Documented as in M98i: enable on an approved development dataset; no tenant selector or per-user identifier exists, and timings are integer milliseconds of the last settled call per alias, not per event.                                                                                                                                                                                                                                                                                                                                                                  |

**Implementation departures from §3, assessed.** (1) Source ids are positional `s1`…`s16`, as §3.2
specified; an interim `e<N>` departure was reverted in review. (2) The route is `/v1/event` beside
the paged kernel `/v1/events`; §3.3 named it, the distinction is documented, and a path cannot be
confused into the other because each target is parsed exactly. (3) `started` is counted at `begin`,
which is what §3.1's "count handler starts" requires; the first implementation counted it at
settlement. (4) The own-data reader is shared with M98i rather than a second copy. None widens the
boundary.

**For the audit (in addition to the implementation gate below):** probe DNS rebinding on a RAW
socket exactly as M98i did (`Host: rebind.example:<port>`, no `Origin`, a valid MAC → refused with
no source read; `Host: 127.0.0.1:<port>` → served; negative control reverts the `Host` check). Probe
a hostile source with accessor, index-getter, class-instance, symbol-key and `Proxy` snapshots and
assert no getter runs. Compare dispatch observed vs unobserved under a throwing handler, a throwing
async `errorHandler` and a throwing clock.

**Amended after approval (2026-09-27), flagged for the maintainer:** the third-party-source attacker
row originally said a hostile source "must not … break other sources' reporting". The approved
duplicate-alias and over-budget collapses (findings table, same section) do exactly that, by design,
so the row overstated the guarantee (audit round 1, F3); it now states the two collapses as the
exceptions. No behaviour changed.

**Approved by:** the maintainer, 2026-09-27 — recorded text accepted, including the measured
overhead (Deno −11.8% on the publish-only route, above §3.4's 5% target, accepted as the cost of an
opt-in development-instance inspector).

**Implementation gate — pending committed-tree audit before completion/publication.** Record commit,
reviewed files, tested adapters/runtimes, findings and dispositions in the implementation PR. Test
real operations through the connector. No untested adapter can be listed as audited support.

Plant canaries in event data, event IDs, aggregate IDs, handler function names, arbitrary event
types, raw errors. Assert absence at the diagnostic collector boundary, retained records, source
reads, frames, client results and diagnostics-generated logs/errors. Existing application logging is
a separate path; do not claim this change sanitizes it. Include approved-data positive controls so
dropping all records cannot pass. Reject hostile strings and extra keys, and exercise secret-bearing
errors without reading their message/cause/stack.

Compare disabled, enabled, observer-throwing, overflowing and shutdown behavior. Test arbitrary
local probes and browser origins, credentials/replay/session lifetime, source-read order and
resource exhaustion. Review connection/frame integrity failures separately from optional collection
failure: authentication must never degrade into a usable unsigned response. The devtool separately
must pass safe rendering, secret-free logs/export and credential-storage acceptance tests.

## 11. Verification and code review record (2026-09-27)

Run by a context that did not implement the milestone, on `7a705283`, then fixed on this branch.
This is NOT the §10 security audit.

| Finding                                                                                                                                          | Disposition                                                                                                                                                              |
| ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `deno task lint` failed (two `require-await` in the unit test).                                                                                  | Fixed.                                                                                                                                                                   |
| Plan header, ROADMAP and CLAUDE.md claimed both §10 gates passed; §10 still read "pending".                                                      | Corrected: all three now state the gates are pending.                                                                                                                    |
| Async mode + throwing `errorHandler`: the observed bus absorbed the rejection (§3.1 violated).                                                   | Fixed: the rejection is rethrown, so it stays unhandled and `whenIdle()` rejects exactly as unobserved; parity test driven both ways.                                    |
| The bus read the clock unguarded, so a failing clock rejected `publish` (§3.4 violated).                                                         | Fixed: the collector's `begin`/`end` own every clock read and never throw; a failing clock latches `collection-failed`. Tested at every read position, sync and async.   |
| `started` was counted at settlement, duplicating `count`.                                                                                        | Fixed: `begin` counts the start, so `started - count` is in-flight work; a never-settled slot ages out through `lastSeenAtMs`.                                           |
| An over-budget body answered a 503 refusal (§3.3 says fixed `collection-failed`).                                                                | Fixed: collapses to the fixed collection-failed response.                                                                                                                |
| More than 16 sources were silently truncated (§3.2 says refuse); ids were `e<N>` not `s<N>`.                                                     | Fixed: startup refuses the 17th with a fixed error (the M98i rule); ids are positional `s1`…`s16`, validated positionally on both sides.                                 |
| Doc inaccuracies (capacity "unreachable", `collection-failed` "connector-only", stale/retention, CHANGELOG "handler rejection rejects publish"). | Fixed in source JSDoc, `common`, CHANGELOG, PUBLIC_API and the protocol doc.                                                                                             |
| Dead surface: collector `generation`; `EventSourceReader` type.                                                                                  | Deleted.                                                                                                                                                                 |
| `alias`/`dropped` read twice by the snapshot validator.                                                                                          | Fixed: every field read once through its descriptor, and (per §10.1) no getter is ever invoked; a test pins it.                                                          |
| `/v1/event` beside `/v1/events`.                                                                                                                 | Kept (this plan names the route, and M98i's `/v1/cache` set the singular-snapshot pattern); the one-letter distinction is now stated in PUBLIC_API and the protocol doc. |
| Missing tests: unsubscribe during dispatch, async `errorHandler` throw, shutdown with a pending handler.                                         | Added.                                                                                                                                                                   |
| `IDiagnosticsClient.events` is a new required member.                                                                                            | CHANGELOG now marks it breaking for implementors.                                                                                                                        |
| Design review (§10.1) found the snapshot reader invoked getters and indexed `records` directly, violating §3.3.                                  | Fixed: shared own-data reader (`copyOwnData`/`copyOwnDataList` in `protocol.ts`, extracted from the M98i cache reader); no-getter test.                                  |
| Branch conflicted with `main` (M98i).                                                                                                            | Merged `main`; the status fixture was re-signed for the combined manifest.                                                                                               |

## 12. Security audit record

**Round 1 — `12b412d7`, verdict FAILED on three Lows**, by a freshly spawned independent agent (no
implementation or fix involvement), Deno 2.9.6. 8 obligation probe groups (raw-socket DNS rebinding,
44 hostile-source cases, canaries at five layers, 120 parity comparisons plus microtask and
late-settlement probes, exhaustion, 19 session cases, a re-signing client MITM, shutdown and
configuration), 15 defect classes (12 applied, 3 N/A), 14 negative controls observed failing and
restored. No Critical, High or Medium finding; the full record is outside the tree
(`.verify-98j/audit/AUDIT-98j.md`).

| Finding                                                                                                                                                                                                                                     | Disposition                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **F1 (Low)** — a caller-held reading bypassed the closed/latched check in `end`/`observe`, so a settlement landing one microtask after `close()` re-created an (invisible) slot, contradicting §3.4 "late results cannot repopulate state". | Fixed: both entry points refuse after close or a latch before touching a slot. Tests count collector map writes after `close()` (the only way to see an invisible slot) directly and through the bus at every microtask position; they fail without the fix (the latch half only after round 2's R2-F1 correction). |
| **F2 (Low)** — the observed path read `event.type` twice, so an accessor-typed event ran its getter an extra time and a flipping one was counted under a different approved alias than it dispatched to.                                    | Fixed: `publish` reads `type` once for both dispatch and observation. Tested observed and unobserved; fails without the fix.                                                                                                                                                                                        |
| **F3 (Low)** — §10.1's third-party attacker row claimed a hostile source cannot break other sources' reporting, while the approved duplicate-alias and over-budget collapses blank every source.                                            | Fixed in the review text (amendment flagged above); documentation only.                                                                                                                                                                                                                                             |

Observations the audit recorded and did not raise: an observed `publish` resolves one microtask
later (§3.4 allows it); U+2028/U+202E are admitted in aliases (the shared C0/C1 rule, M98d–M98i
precedent — a devtool rendering concern); an honest-MAC cross-instance request consumes its sequence
(M98b behaviour).

**Round 2 — `1f364f1c`, verdict FAILED on one Low**, by a second freshly spawned independent agent
(no implementation, fix or round-1 involvement), Deno 2.9.6. F1, F2 and F3 were confirmed fixed with
no regression: two new probes (slot-object capture across close and latch at every microtask
position, with a keep-legitimate positive control; seven hostile `event.type` values observed vs
unobserved) fail on `12b412d7` and pass on HEAD, every round-1 probe re-ran green apart from the
approved one-microtask rows, and the F3 amendment was checked accurate against the connector's two
collapses. The round also surfaced that on `12b412d7` F2 could make an observed `publish` reject
where the unobserved one resolved — closed by the same fix. 9 negative controls. Record outside the
tree (`.verify-98j/audit2/AUDIT-98j-round2.md`).

| Finding                                                                                                                                                                                                                                                                     | Disposition                                                                                                                                                                                          |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **R2-F1 (Low)** — the latch half of the F1 regression test could not fail: it counted `Map.set` calls, but after a latch the in-flight slot already exists, so the pre-fix leak was an in-place update. Removing `#collectionFailed` from both guards left the suite green. | Fixed: the test captures the slot object when `begin` creates it and asserts its fingerprint is unchanged by a late `end`/`observe`. Verified to fail with only the latch half of the guard removed. |

**Round 3 — re-audit of the R2-F1 fix: pending.**
