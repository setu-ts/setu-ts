# Milestone 98l — Realtime Lifecycle Observations

> **Status:** In implementation on `feat/m98l-realtime-observations`. The design security review is
> recorded in §10.1 (2026-09-28, before implementation) and awaits the maintainer's approval. No
> completed security audit is claimed.

## 0. Objective & scope

Provide bounded, opt-in realtime lifecycle observations through the authenticated local connector.

- **In scope:** Aggregate local outcomes. No delivery guarantee, message inspection, native
  websocket backlog measurement or per-user presence. Owner: `packages/websocket-plugin`; common and
  connector changes are necessary consumers. SSE and backplane changes are explicitly scoped
  co-owners of the same realtime flow.
- **NOT this milestone:** raw-data inspection, remote access, persistent history, controls or
  replay.

Depends on the M98a/M98b boundaries and M98d's revised eleven-key manifest. No runtime dependency on
the other inspector providers. Each source states observed-instance coverage, never automatic
visibility into all application code.

## 1. Contracts verified from SOURCE (not names)

| Reference     | Source (file:line)                                                   | Verified surface / fact                                                                                       |
| ------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| Source seam   | `packages/common/src/services/websocket.ts:1`                        | WebSocket hub exposes connectionCount/roomCount and non-creating peek.                                        |
| Source seam   | `packages/common/src/services/sse.ts:1`                              | SSE exposes connectionCount/channelCount and non-creating peek.                                               |
| Source seam   | `packages/sse-plugin/src/connection/sse-connection.ts:125`           | Existing enqueue path closes on excessive backlog; send is not a delivery acknowledgement.                    |
| Source seam   | `packages/common/src/services/realtime.ts:1`                         | Backplane publish forwards frames with names, payloads and origin; transport completion is not peer delivery. |
| Registry      | `packages/common/src/registry.ts:86`                                 | register supports multi; getAll resolves providers; do not resolve application services for inspection.       |
| Connector     | `packages/diagnostics-plugin/src/transport/connector-handler.ts:248` | Existing authenticated dispatch and post-await session checks must govern new operations.                     |
| Compatibility | `packages/diagnostics-plugin/src/protocol/protocol.ts:294`           | Current status validator has exact keys; M98d's manifest is planned, not implemented.                         |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                             | Resolution (picked side)                                                                                                          | Doc deliverable (same PR)                                                         |
| -- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| C1 | Existing public APIs expose application operations, not this source. | Add dedicated source contracts; retain application method signatures.                                                             | PUBLIC_API.md, ARCHITECTURE.md, owning package README and CHANGELOG.              |
| C2 | Earlier M98d reserved only five inspectors.                          | Revise unpublished manifest to eleven exact keys in this planning change; this letter activates `realtime` only when implemented. | M98d plan and ROADMAP.md now; docs/diagnostics-protocol.md during implementation. |

## 3. Design decisions

### 3.1 Authoritative capture seam

**Decision:** Each WebSocket/SSE plugin owns a separate source. Capture open/close and local
send/enqueue outcomes at the existing connection code. Read only existing aggregate connection/group
counts. SSE backlog closes get a fixed backpressure category; websocket native pressure is
unsupported in this milestone. Backplane sources count publish and receive callbacks without
inspecting frame fields. Do not enumerate memberships, call room/channel to inspect them, or add a
network subscription. Transport publish completion is not remote delivery. Count sends at the
connection boundary only, not again at room broadcast.

**Why:** Counters describe executed work rather than inventing backend or cluster state. **Test
home:** owning package `test/unit/realtime-observations.test.ts`.

Each owning package exports its own structurally identical RealtimeDiagnosticsOptions type;
applications consume it through that package's existing options. All three use the common
IRealtimeDiagnosticsSource and REALTIME_DIAGNOSTICS token. Capture backplane publish completion and
existing subscription dispatch inside the three transport implementations, using an internal
attachment seam; no wrapper subscription or extra frame delivery. The plugin closes that attachment
before transport teardown. Connection/group gauges belong to a separate current-state snapshot, not
operation records. Each enabled WS/SSE source captures a private reader for its original owned
service's built-in size getters at registration. snapshot invokes that reader once, after connector
authentication, to read connectionCount and roomCount/channelCount. These getters read existing Set
or registry sizes (websocket-service.ts:232 and sse-service.ts:156); they perform no network work,
allocation of groups, membership enumeration or application callback. Do not resolve a service from
the registry on a read or invoke a replacement provider's getters. Backplane gauges are unsupported.
The immutable sourceKind identifies websocket, sse or backplane independently of display aliases.
Backpressure counts are supported only on SSE close records; all other kinds/operations use null,
not zero. A supported SSE close record with zero backpressure closes carries the number 0.

Attach the internal collector to the owned implementation during plugin registration through a
non-barrel-exported WeakMap attachment helper. Existing exported constructor signatures remain
unchanged. Each hot path checks for an attachment before reading clocks or deriving labels. The
collector accepts only the fixed operation, approved alias, primitive outcome and measured values;
raw inputs and errors never cross that seam. The source uses the same bounded collector and owns no
reference to business payloads. Close detaches first, then clears collector state.

**One collector, in `common` (maintainer decision, 2026-09-28).** The three owning packages need the
same collector: one approved alias per source, the fixed operations, one retention and state rule,
and the gauge snapshot. §2.2 forbids any of them importing another, so the only way to avoid three
copies (§11.1) is `@setu-ts/common`. This follows the M47 `encodeFrameData` and M52 `splitWorkerEnv`
precedents. `common` gains `compileRealtimeDiagnosticsAlias` (the one option validation) and
`createRealtimeObservationCollector` (the one collector; a plugin registers only its frozen,
snapshot-only `source` facade, never the collector with its `observe` and `close`), in
`packages/common/src/diagnostics/realtime-observations.ts`. That is public surface beyond the
original §4 and is listed there. Each owning package keeps a small internal
`diagnostics/realtime-observations.ts` holding only its WeakMap attachment helpers.
`RealtimeDiagnosticsOptions` is declared once in `common` and re-exported by the three barrels, so
the three option types are not merely structurally identical but the same type.

### 3.2 Source ownership and registration

Owning plugins eagerly register `IRealtimeDiagnosticsSource` under
`CAPABILITIES.REALTIME_DIAGNOSTICS` (`realtime-diagnostics`) with `multi: true`. Keep plugin names
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

Add common `IRealtimeDiagnosticsSource`, `RealtimeDiagnosticsSnapshot`, `RealtimeDiagnosticsRecord`,
and `RealtimeDiagnosticsResponse`.

`IRealtimeDiagnosticsSource.snapshot(): RealtimeDiagnosticsSnapshot` is synchronous, takes no
caller-selected resource, and returns a deeply frozen exact-key object:
`{ state: DiagnosticsInspectorState, alias: string | null, sourceKind: 'websocket' | 'sse' | 'backplane' | 'unknown', coverage: 'owned-instance', gauges: { state: 'available' | 'unsupported' | 'disabled' | 'collection-failed', openConnections: number | null, groups: number | null }, records: readonly RealtimeDiagnosticsRecord[], dropped: number }`.

Built-in sources set their fixed sourceKind at construction, including when disabled or closed.
`unknown` is reserved for the connector's synthetic collection-failed snapshot when a source throws
or fails validation; it is never a built-in provider kind. The synthetic snapshot has alias=null,
gauges.state=collection-failed, both gauge values null, records=[] and dropped=0. Never salvage a
kind or alias from an invalid source result. No sourceKind is inferred from alias, sourceId or
plugin registration order.

For enabled healthy WS/SSE sources, gauges.state=available and both values are current nonnegative
safe integers, including measured zeros before any connection opens. For an enabled healthy
backplane, gauges.state=unsupported and both values are null. Disabled/closed sources use disabled
and null values without calling the gauge reader. A collection failure uses collection-failed and
null values. Validators reject mixed combinations, including numeric backplane gauges, null
available gauges and unknown kinds with usable records. The native client uses sourceKind and the
explicit gauge state to select labels and distinguish measured zero from unavailable data.

A record has exactly `alias: string`,
`operation: 'open' | 'close' | 'send' | 'backplane-publish' | 'backplane-receive'`, `count: number`,
`lastDurationMs: number | null`, `ageMs: number`, plus `succeeded`, `failed` (safe integers), and
`backpressureCloses: number | null`. The latter is a safe integer only for sourceKind=sse with
operation=close; otherwise it must be null. Websocket/SSE admit open/close/send operations, while
backplane admits only backplane-publish/backplane-receive. Reject mismatched kind/operation pairs.
openConnections and groups are absent from records: their only home is snapshot.gauges. Numbers are
finite, nonnegative and clamped at Number.MAX_SAFE_INTEGER; durations are integer milliseconds.
count counts settled observations, not currently active calls. Counters are cumulative within the
retention window. succeeded and failed are zero before their first matching outcome;
backpressureCloses follows the nullable support rule above. lastDurationMs is null for instantaneous
lifecycle observations; otherwise it is the last settled duration. Record alias is exactly the
configured source alias (snapshot.alias); no event/job mapping exists. On failed collection the
source clears records, sets gauges to collection-failed with null values, and retains its fixed kind
and approved alias in the exact snapshot shape. Lifecycle-closed and disabled states take precedence
over collection-failed. Read only framework-owned primitive fields; never pass a business object or
an Error to the collector.

`RealtimeDiagnosticsResponse` is exactly
`{ version: 1, instanceId: string, state: DiagnosticsInspectorState, sources: readonly { sourceId: string, snapshot: RealtimeDiagnosticsSnapshot }[] }`.
`IDiagnosticsClient.realtime(): Promise<RealtimeDiagnosticsResponse>` reads only `GET /v1/realtime`
through the existing signed, serialized exchange. All authentication, origin/authority, replay,
expiry, revocation, instance and post-read session checks precede returning any data; request
authentication must succeed before snapshot is called. Pairing sees `realtime: false` as a local
typed unsupported response without a request. A supported operation with no sources returns
unsupported and []. Per-source invalid reads become fixed collection-failed snapshots with no
records; no error text. Response state is ready if any source is ready, otherwise collection-failed,
stale, no-data, disabled, unsupported in that priority order. Individual states remain visible.

Projectors accept exact own data properties and reject getters, prototypes with unexpected shape,
extra keys, invalid enums or oversized arrays. Snapshot, gauges and record values are plain objects
(Object.prototype or null prototype) containing only own data properties; custom prototypes are
rejected. Proxy traps cannot be sandboxed: catch their failures and never copy unknown fields. Copy
approved primitives individually. The full response is limited to 256 KiB; on exceeding it return a
fixed collection-failed response, never a partial JSON document. The client independently validates
the same contract.

### 3.4 Opt-in, retention and overhead

Plugin option `diagnostics?: { enabled: true, alias: string }` is absent by default; absent means an
inert disabled source with no collector or observation clock reads. One approved instance alias per
websocket, SSE or backplane provider; no route, room or channel labels.

Aliases are explicit non-secret labels, unique, 1–64 UTF-8 bytes, without controls; do not derive
aliases by truncating or hashing sensitive values. Only one configured alias per source is
supported; no event/job maps or dynamic mapping callbacks are accepted.

Each source admits at most 64 record slots keyed by approved alias and fixed operation. At capacity,
ignore new tuples and increment saturating dropped; existing tuples continue updating. Records
expire after 60 seconds without an observation, checked during update/read; clear their counters on
expiry. This TTL applies only to operation records. Current gauges never expire because of missing
traffic and are freshly read on each enabled healthy snapshot. WS/SSE source state is ready whenever
gauges are available, even with records=[] after 60 seconds, or before any operations occur. Record
age still indicates operation freshness independently. Backplane has no available gauges: any record
aged <=30 seconds means ready; only older retained records means stale; records=[] means no-data.
Disabled/closed and collection-failed override these readiness rules. No background timer and no
per-request diagnostic queue. On close mark closed before clearing; late results cannot repopulate
state, and snapshot returns disabled with empty records and disabled null gauges. Release the
private gauge reader on close so later snapshots never read a closed service. Each observed call
retains only primitive timing/alias state, no additional wait on external work, body copy or
diagnostic I/O. Promise observation may add a microtask; tests must preserve application ordering
guarantees without claiming identical promise identity or a literally zero-cost enabled path.

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

### 3.6 What each operation counts (fixed before implementation)

§3.1–§3.4 fix the shape. This section fixes the meaning of each counter at each capture site, so the
tests have one definition to assert and the three packages cannot drift. Every outcome below is a
boolean the owning code already computes; no frame, reason, code value or error reaches the
collector.

| Kind      | Operation           | Captured at                                                                                                                                                                                            | `succeeded`                                                        | `failed`                                                                                                                                          |
| --------- | ------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| websocket | `open`              | the upgrade sink's `onOpen`, or its `onClose` arriving before `onOpen`                                                                                                                                 | the socket opened and was registered                               | the adapter accepted the upgrade and the handshake then failed (the existing slot-release path)                                                   |
| websocket | `close`             | the sink's `onClose` for an opened connection                                                                                                                                                          | any close not below                                                | the transport reported an error on that connection (`onError`), or the close code is `1006` (abnormal closure). Only the boolean leaves the sink. |
| websocket | `send`              | `WebSocketConnection.send` (so `sendJson`, room broadcasts and heartbeats are all counted once, at the connection)                                                                                     | the transport accepted the frame                                   | the connection was not open, or the transport's `send` threw. The throw is rethrown unchanged.                                                    |
| sse       | `open`              | `SseService.open`                                                                                                                                                                                      | the connection was constructed and registered                      | construction threw (rethrown unchanged)                                                                                                           |
| sse       | `close`             | `SseConnection`'s one idempotent cleanup                                                                                                                                                               | client abort, stream cancel, application `close()`, shutdown       | the backlog guard closed it (also counted in `backpressureCloses`), or `enqueue` threw                                                            |
| sse       | `send`              | `SseConnection`'s one enqueue path (so `send`, `comment` and heartbeats are all counted; the initial `retry:` frame is written while the connection is constructed, before it is attached, and is not) | the frame was enqueued                                             | the backlog guard refused it, or `enqueue` threw. A write on an already-closed connection is the existing silent no-op and is not counted.        |
| backplane | `backplane-publish` | `publish()` of the memory, redis and messaging transports                                                                                                                                              | `publish()` resolved — transport completion, never remote delivery | `publish()` rejected (the rejection is returned unchanged)                                                                                        |
| backplane | `backplane-receive` | each transport's existing dispatch, after its own frame-shape and own-origin filters (a filtered frame is not a receive)                                                                               | every local handler returned                                       | at least one local handler threw (the existing isolation already continues to the rest)                                                           |

`lastDurationMs` is a number only for `backplane-publish`, the one operation that settles
asynchronously. Every other operation is instantaneous at its capture site and carries `null`, which
also keeps the per-frame send path at one clock read. Heartbeat frames count as sends because they
are frames the connection writes; §6's idle-connection test disables them for that reason. The
`'custom'` backplane arm is an application-supplied transport and is never observed: its options
carry no `diagnostics` field, and its source answers `disabled`.

**Source kinds and gauges per kind.** A websocket or sse source that is enabled and healthy answers
`state: 'ready'` with `gauges.state: 'available'` in every case, including before any operation and
after every record has expired. A backplane source answers `gauges.state: 'unsupported'`, and its
state comes from record age alone (§3.4). `dropped` is structurally `0` for every built-in source:
one alias and at most three operations per source can never reach the 64-slot bound. The field stays
on the wire contract, where a third-party source may use it.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                      | Kind                       | Consumer / real code path that READS it                    |
| ------------------------------------ | -------------------------- | ---------------------------------------------------------- |
| `IRealtimeDiagnosticsSource`         | common interface           | Owning source and connector reader.                        |
| `RealtimeDiagnosticsSnapshot`        | common type                | Source, exact projector and client.                        |
| `RealtimeDiagnosticsRecord`          | common type                | Bounded collector and devtool summary.                     |
| `RealtimeDiagnosticsResponse`        | common type                | Connector and native client method.                        |
| `IDiagnosticsClient.realtime`        | client method              | Devtool inspector.                                         |
| `RealtimeDiagnosticsOptions`         | owning package option type | Application opt-in and collector construction.             |
| `CAPABILITIES.REALTIME_DIAGNOSTICS`  | common token               | Owning plugin multi-registration and connector resolution. |
| `RealtimeSourceKind`                 | common type                | Snapshot `sourceKind`, collector construction, validators. |
| `RealtimeObservationOperation`       | common type                | Record `operation`, collector entry points, validators.    |
| `RealtimeGaugeState`                 | common type                | Snapshot `gauges.state`, validators and client labels.     |
| `compileRealtimeDiagnosticsAlias`    | common function            | The three plugin factories, at construction (§3.1).        |
| `createRealtimeObservationCollector` | common function            | The three plugins' `register()` (§3.1).                    |
| `IRealtimeObservationCollector`      | common interface           | The three packages' capture sites and attachment helpers.  |

The last three are the §3.1 maintainer decision: one collector in `common` instead of three copies.
`RealtimeDiagnosticsOptions` is declared in `common` and re-exported unchanged by each owning
barrel. Attachment helpers and projectors remain internal. No general observer/event-bus API.

### 4.1 Options — every option names its consumer

| Option                      | Consumer                     | Behavior (per implementation)                  |
| --------------------------- | ---------------------------- | ---------------------------------------------- |
| enabled / alias             | Owning collector constructor | Explicit activation and approved display name. |
| No additional plugin labels | Construction contract        | No dynamic label extraction.                   |

## 5. Implementation files

| File                                                                          | Purpose                                                     |
| ----------------------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/common/src/services/diagnostics.ts`                                 | Typed contract, export, authenticated projection or reader. |
| `packages/common/src/tokens.ts`                                               | Typed contract, export, authenticated projection or reader. |
| `packages/common/src/index.ts`                                                | Typed contract, export, authenticated projection or reader. |
| `packages/common/src/diagnostics/realtime-observations.ts`                    | The one realtime collector and option validation (§3.1).    |
| `packages/diagnostics-plugin/src/interfaces/index.ts`                         | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`                | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/protocol/protocol.ts`                        | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/protocol/realtime-protocol.ts`               | Copy-once source read, response build and wire validator.   |
| `packages/diagnostics-plugin/src/transport/connector-handler.ts`              | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/client/client.ts`                            | Typed contract, export, authenticated projection or reader. |
| `packages/websocket-plugin/src/services/websocket-service.ts`                 | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/websocket-plugin/src/connection/websocket-connection.ts`            | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/websocket-plugin/src/interfaces/index.ts`                           | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/websocket-plugin/src/plugin/websocket-plugin.ts`                    | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/websocket-plugin/src/index.ts`                                      | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/websocket-plugin/src/diagnostics/realtime-observations.ts`          | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/sse-plugin/src/services/sse-service.ts`                             | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/sse-plugin/src/connection/sse-connection.ts`                        | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/sse-plugin/src/plugin/sse-plugin.ts`                                | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/sse-plugin/src/interfaces/index.ts`                                 | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/sse-plugin/src/index.ts`                                            | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/sse-plugin/src/diagnostics/realtime-observations.ts`                | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts`  | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/realtime-backplane-plugin/src/interfaces/index.ts`                  | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/realtime-backplane-plugin/src/index.ts`                             | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/realtime-backplane-plugin/src/transports/memory-backplane.ts`       | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/realtime-backplane-plugin/src/transports/redis-backplane.ts`        | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/realtime-backplane-plugin/src/transports/messaging-backplane.ts`    | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/realtime-backplane-plugin/src/diagnostics/realtime-observations.ts` | Opt-in capture, source, options or lifecycle wiring.        |

Also update PUBLIC_API.md, ARCHITECTURE.md, docs/diagnostics-protocol.md, package READMEs,
CHANGELOG.md, ROADMAP.md and CLAUDE.md. SDK dependency metadata changes in M98n accompany its common
contract release; no external dependency is introduced.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                    | src covered                                                                   | Key assertions (and the signature each call type-checks against)                                          |
| ---------------------------------------------------------------------------- | ----------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts`        | `packages/common/src/services/diagnostics.ts`                                 | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts`        | `packages/common/src/tokens.ts`                                               | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts`        | `packages/common/src/index.ts`                                                | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/common/test/unit/realtime-observations.test.ts`                    | `packages/common/src/diagnostics/realtime-observations.ts`                    | Option validation, per-kind state/gauge rules, retention, latching, close, clamping and saturation.       |
| `packages/diagnostics-plugin/test/unit/realtime-observations.test.ts`        | `packages/diagnostics-plugin/src/protocol/realtime-protocol.ts`               | Hostile sources, kind/operation/gauge combinations, duplicate aliases, budget collapse, wire validator.   |
| `packages/diagnostics-plugin/test/unit/realtime-observations.test.ts`        | `packages/diagnostics-plugin/src/interfaces/index.ts`                         | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/diagnostics-plugin/test/unit/realtime-observations.test.ts`        | `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`                | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/diagnostics-plugin/test/unit/realtime-observations.test.ts`        | `packages/diagnostics-plugin/src/protocol/protocol.ts`                        | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/diagnostics-plugin/test/unit/realtime-observations.test.ts`        | `packages/diagnostics-plugin/src/transport/connector-handler.ts`              | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/diagnostics-plugin/test/unit/realtime-observations.test.ts`        | `packages/diagnostics-plugin/src/client/client.ts`                            | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/websocket-plugin/test/unit/realtime-observations.test.ts`          | `packages/websocket-plugin/src/services/websocket-service.ts`                 | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/websocket-plugin/test/unit/realtime-observations.test.ts`          | `packages/websocket-plugin/src/connection/websocket-connection.ts`            | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/websocket-plugin/test/unit/realtime-observations.test.ts`          | `packages/websocket-plugin/src/interfaces/index.ts`                           | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/websocket-plugin/test/unit/realtime-observations.test.ts`          | `packages/websocket-plugin/src/plugin/websocket-plugin.ts`                    | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/websocket-plugin/test/unit/realtime-observations.test.ts`          | `packages/websocket-plugin/src/index.ts`                                      | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/websocket-plugin/test/unit/realtime-observations.test.ts`          | `packages/websocket-plugin/src/diagnostics/realtime-observations.ts`          | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/sse-plugin/test/unit/realtime-observations.test.ts`                | `packages/sse-plugin/src/services/sse-service.ts`                             | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/sse-plugin/test/unit/realtime-observations.test.ts`                | `packages/sse-plugin/src/connection/sse-connection.ts`                        | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/sse-plugin/test/unit/realtime-observations.test.ts`                | `packages/sse-plugin/src/plugin/sse-plugin.ts`                                | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/sse-plugin/test/unit/realtime-observations.test.ts`                | `packages/sse-plugin/src/interfaces/index.ts`                                 | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/sse-plugin/test/unit/realtime-observations.test.ts`                | `packages/sse-plugin/src/index.ts`                                            | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/sse-plugin/test/unit/realtime-observations.test.ts`                | `packages/sse-plugin/src/diagnostics/realtime-observations.ts`                | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/realtime-backplane-plugin/test/unit/realtime-observations.test.ts` | `packages/realtime-backplane-plugin/src/plugin/realtime-backplane-plugin.ts`  | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/realtime-backplane-plugin/test/unit/realtime-observations.test.ts` | `packages/realtime-backplane-plugin/src/interfaces/index.ts`                  | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/realtime-backplane-plugin/test/unit/realtime-observations.test.ts` | `packages/realtime-backplane-plugin/src/index.ts`                             | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/realtime-backplane-plugin/test/unit/realtime-observations.test.ts` | `packages/realtime-backplane-plugin/src/transports/memory-backplane.ts`       | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/realtime-backplane-plugin/test/unit/realtime-observations.test.ts` | `packages/realtime-backplane-plugin/src/transports/redis-backplane.ts`        | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/realtime-backplane-plugin/test/unit/realtime-observations.test.ts` | `packages/realtime-backplane-plugin/src/transports/messaging-backplane.ts`    | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/realtime-backplane-plugin/test/unit/realtime-observations.test.ts` | `packages/realtime-backplane-plugin/src/diagnostics/realtime-observations.ts` | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                   |
| `packages/diagnostics-plugin/test/e2e/realtime-observations.test.ts`         | All owning producers and connector reader                                     | Real producer -> source.snapshot() -> signed socket -> client.realtime(); positive controls and canaries. |

Exercise SSE overflow, client abort, websocket normal/error close, heartbeat, broadcast exceptions,
backplane rejection and own-origin filtering. Assert identical sends, disconnect timing, membership
and transport calls.

Unit and real-connector tests must cover the following review regressions:

- Use opaque aliases unrelated to provider kinds. Assert websocket/sse/backplane sourceKind survives
  projection; a websocket close carries backpressureCloses=null, while an SSE normal close carries 0
  and an SSE backlog close increments it. Reject forged kind/operation and kind/gauge combinations.
- Open an idle connection with heartbeats disabled; advance beyond 60 seconds and read via the
  client. Records expire, but gauges remain available, openConnections=1 and source state=ready.
  Repeat at zero traffic before any open: both measured counts are zero, not unsupported or no-data.
- Create a room/channel through the normal application API without a send/open/close event. The next
  authenticated snapshot reports the new group count. Repeated reads do not create additional
  groups, iterate members, connect the backplane, invoke application callbacks, or instantiate lazy
  services.
- Close the last connection and check the next snapshot reports openConnections=0. On plugin
  shutdown, verify reader detachment, disabled/null gauges and no calls to the service after close.
  Failed collection latches collection-failed; malformed/throwing sources yield the unknown
  synthetic kind.
- Verify disabled capture and failed authentication never call the gauge reader. Gauge reads use
  only the original framework-owned instance even after an application capability is replaced.

Every mapped test calls the §3 signatures. Exercise legacy status and all eleven reserved keys,
false-key no-request, absent source, source throw, malformed source objects including throwing
getters, snapshot overrun, duplicate aliases, unpaired/replayed/expired/revoked/cross-instance
requests and refusal of mutation methods. Custom application replacements remain outside source
coverage, do not get instantiated by snapshot, and cannot be mislabeled as observed.

## 7. Verification gates

```bash
git branch --show-current   # feat/m98l-realtime-observations
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

Aggregate local outcomes. No delivery guarantee, message inspection, native websocket backlog
measurement or per-user presence.

No database inspector, persistent history, raw payloads, admin controls, replay, remote transport or
billing integration. Future adapter-specific visibility requires separately planned contracts and
audits; it is not implied by completing this milestone.

## 10. Required security reviews and acceptance evidence

### 10.1 Design security review

**Recorded 2026-09-28, before implementation.** Checked against the §3 decisions as planned,
including the two recorded on 2026-09-28 (one collector in `common`, §3.1; per-operation meaning,
§3.6). It was written by the context that is implementing the milestone, at the maintainer's
direction. It is not the committed-tree audit, which must still run in a fresh context. **Awaiting
the maintainer's approval.**

**Purpose it serves.** M98 lets a developer inspect a running application on their own machine
without the devtool gaining access to live services, application data, credentials or any mutation
control. For the realtime inspector the devtool may learn HOW the owned WebSocket hub, SSE hub and
backplane transport are behaving: how many connections opened, closed and failed, how many frames
were written or refused, how many SSE streams were closed for backlog, how many backplane
publications resolved or rejected and how many arriving frames reached local handlers, and the
current open-connection and group counts. It never learns WHAT was sent, WHO is connected, WHICH
room or channel exists, or WHERE a frame came from.

**Reviewed flow:** a socket or stream event, an application `send`, a room/channel broadcast, a
heartbeat tick, or a backplane `publish`/delivery → the owning object's existing code path → one
`WeakMap` probe for an attached collector (none → the pre-M98l path unchanged) → a call carrying
only `(fixed operation, boolean outcome, boolean backpressure)` or, for `backplane-publish`, a
monotonic start reading → the one `common` collector (at most three records per source, keyed by
operation under the source's single approved alias, monotonic readings only) → the same object
answers `IRealtimeDiagnosticsSource.snapshot()`, calling its captured gauge reader (two size getters
of the plugin's own service) only on an enabled, healthy, websocket or sse source → registered under
the multi-provider `CAPABILITIES.REALTIME_DIAGNOSTICS` → the connector resolves the sources once at
bootstrap (more than 16 refuses startup) → authenticated `GET /v1/realtime` behind every M98b
control (exact `Host` authority, `Origin` refusal, forwarding-header refusal, MAC over canonical
fields, sequence replay refusal, expiry and revocation, instance binding) → own-data copy of each
snapshot with per-source isolation → exact validator including the kind/operation/gauge combination
rules → fixed 256 KiB budget → signed frame → native client re-validates and binds the instance.
Minimization happens at the capture site, before the collector: the frame, the `SseMessage`, the
close code and reason, the request, its headers and query, the principal, the connection id, the
room or channel name, the backplane `RealtimeFrame` (origin, name, payload, `exceptId`) and any
thrown value stay in the owning code's locals. The collector's signatures cannot accept any of them.

**Assets.**

| Asset                                                     | Why it is sensitive                                                                                    |
| --------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Frame and message payloads (WS data, `SseMessage`)        | Application data: chat text, tokens, PII.                                                              |
| Upgrade request: URL, query, headers, cookies             | Carry credentials, session ids and tenant selectors.                                                   |
| The principal on `WebSocketConnectionContext.user`        | Identifies a user.                                                                                     |
| Connection ids, `exceptId`, backplane `origin`            | Correlate to users and instances; `origin` identifies a replica.                                       |
| Room and channel names                                    | Routinely derived from user or tenant ids (`user-42`, `tenant-acme.orders`); unbounded if user-chosen. |
| Close codes and reason text, handler and transport errors | Reason text and errors may quote payloads, hosts or credentials.                                       |
| Counts, gauges and publish timings                        | Low sensitivity; reveal activity levels and connection counts, aggregated across every tenant.         |
| The session key and signed channel                        | Owned by M98b; this letter adds a route behind it and must not weaken it.                              |

**Attackers and their reach.**

| Attacker                                                                                   | Must not be able to                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| An unpaired local process, or a browser tab on the host                                    | Read any realtime observation, cause a source read or a gauge read, or obtain an unsigned response.                                                                                                                                                                                                                                                                                                          |
| A website using DNS rebinding (its hostname resolved to `127.0.0.1`; may send no `Origin`) | Read any realtime observation or cause a source read.                                                                                                                                                                                                                                                                                                                                                        |
| The paired devtool (trusted reader of the minimized DTO)                                   | Obtain any asset above except counts, gauges and publish timings under approved source aliases; open, close or write to a connection; create or enumerate a room or channel; publish to or subscribe on the backplane.                                                                                                                                                                                       |
| A remote WebSocket or SSE client (untrusted network input)                                 | Make observation grow any state, reach the collector with a byte it sent, change how its own or anyone else's connection behaves, or turn a close reason, a frame or a subprotocol into a retained or projected value.                                                                                                                                                                                       |
| A peer replica, or anything able to publish on the shared backplane topic                  | Have an origin, a room or channel name, a payload or a malformed frame observed or retained; its frames only ever move a receive counter, and only after the transport's existing shape and origin filters admit them.                                                                                                                                                                                       |
| A third-party in-process plugin registering a hostile source                               | Put an unvalidated field, an accessor result, a control character, a forged kind/operation/gauge combination or an oversized list into the signed frame, or make the connector invoke its getters. It MAY blank every source's reporting through the two deliberate whole-response collapses (claiming another source's alias; pushing the body over budget), which answer a value-free `collection-failed`. |
| A failing or throwing clock, gauge reader, handler or transport                            | Change any send, close, broadcast, publish or delivery result, error identity, ordering or membership, or leak error text.                                                                                                                                                                                                                                                                                   |

**Out of the threat model (unchanged from M98b and M98i–M98j):** a privileged local sniffer, remote
access, and shared multi-tenant production use. A third-party source runs with application
privileges and is not sandboxed; the reader keeps its OUTPUT out of the signed frame, it does not
contain its code. Existing application logging (the websocket and SSE plugins' `warn` on a failed
backplane publish, and the upgrade-routing `error` log) is a separate path this change neither
alters nor sanitizes. A custom backplane transport, an application-constructed `WebSocketService` or
`SseService`, and a replacement registered under `CAPABILITIES.WEBSOCKET`, `SSE` or
`REALTIME_BACKPLANE` are not observed and are never labelled observed.

**Approved budgets.** One approved alias per source and at most three records per source (one per
operation its kind admits), so no capacity refusal exists and `dropped` stays `0`; the 64-slot and
16-source bounds of the shared contract still apply to what the connector accepts. A record expires
60 seconds after its last observation, checked on write and read, never by a timer; a backplane
source is `stale` when every record is older than 30 seconds. Every counter saturates at
`Number.MAX_SAFE_INTEGER`. Per observed event: one clock read, and a second only for
`backplane-publish` (its start). No queue, no I/O, no per-event allocation beyond the one settlement
closure `backplane-publish` already needs to observe its promise. Gauges: two synchronous
size-getter reads per authenticated read of an enabled websocket or sse source; zero for a
backplane, disabled, closed or failed source; never on a write path. At most 16 sources; a 17th
refuses startup with a fixed error. A 256 KiB response that collapses to a fixed `collection-failed`
with no sources rather than truncating. The disabled path is one `WeakMap.get` per observed event.

**Overhead — measured on Deno 2.9 during implementation, 2026-09-28.** _Application level (the
number to judge)._ A real kernel application with a real `WebSocket` client echoing 10,000 frames
per sample (one inbound frame and one `send` each), one process per run, 5 warm-up and 15 measured
samples, 10 runs alternating the order of `off` and `on`: median 31.8 ms off against 32.5 ms on,
about 2.3% more time. The per-pair delta spread from −13.9% to +15.9% with a median of +3.5%, so the
difference is inside the noise and within §3.4's ≤5% target, not a precise figure. _Component level
(context)._ Over a no-op transport, 10,000 sends cost 0.04 ms unobserved and 1.0 ms observed — about
100 ns per send, dominated by the one clock read — and 10,000 backplane publishes through a no-op
broker cost 0.4 ms against 2.2 ms, about 190 ns per publish for the extra clock read and the derived
promise. Those ratios are large only because the fake transports do nothing; a real socket write or
broker publish costs microseconds. SSE enqueue timings were dominated by stream noise and showed no
measurable difference. The harnesses are outside the tree (`.tmp/m98l-bench/`).

| Finding                                                                                                                                     | Resolution                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Room and channel names are the most tempting label and the most sensitive one (user and tenant ids).                                        | No per-group label exists anywhere: one alias per source, fixed operations, and a `groups` gauge that is a count. Nothing iterates, names or `peek`s a group; the gauge reads `roomCount`/`channelCount`, which are `Map.size` reads.                                                                                                                                              |
| A close code or reason is attacker-supplied (the client chooses both).                                                                      | Only a boolean leaves the sink: `code === 1006` or an error seen. The reason string is never read by observation code. Canary test plants reason text and asserts it absent at snapshot, wire and client DTO.                                                                                                                                                                      |
| A remote client can drive the send, open and close paths at will.                                                                           | Every observation lands in one of at most three fixed records, so no input grows collector state. Counters saturate.                                                                                                                                                                                                                                                               |
| The backplane topic is shared infrastructure; a peer can publish anything on it.                                                            | Receive is counted after the transport's existing `isRealtimeFrame` and own-origin filters, and only as a count. A frame one of those filters drops is not a receive and is not otherwise observed. The frame's fields are never read by observation code.                                                                                                                         |
| The gauge reader runs application-reachable code on a read.                                                                                 | It is a closure over the plugin's OWN service instance, captured at `register()`, reading two getters that return `Set.size`/`Map.size`. It is never resolved from the registry, so a replacement provider is never invoked. It runs only inside an authenticated read of an enabled, healthy websocket or sse source; a throw latches `collection-failed`. `close()` releases it. |
| A wrapping observer could change an application-visible result: a `send` that throws, a publish that rejects, a handler that throws.        | `send` records and rethrows the SAME value. `backplane-publish` returns a promise derived from the transport's that re-rejects with the ORIGINAL reason (the M98i lesson: a side branch would mark it handled). Dispatch isolation is unchanged; observation reads only whether `onError` fired. Every collector call is non-throwing.                                             |
| A hostile third-party source could smuggle fields, forge a kind, or have the connector run its code.                                        | The shared `copyOwnData`/`copyOwnDataList` reader (own DATA properties only, exact keys, plain prototype, no getter invoked) plus a validator enforcing the kind/operation, kind/gauge and state/gauge combinations; `unknown` is admitted on the wire only in the connector's exact synthetic shape and refused from a source.                                                    |
| Two sources claiming one alias would make the report ambiguous.                                                                             | Duplicate non-null aliases collapse the whole response to `collection-failed` with no sources (the M98i/M98j rule).                                                                                                                                                                                                                                                                |
| A source could be read before authentication.                                                                                               | Sources are read only inside the authenticated dispatch, after the shared M98b gate; bootstrap only collects the list.                                                                                                                                                                                                                                                             |
| Shutdown could resurrect state, or a late read could touch a closed service.                                                                | `onClose` detaches first, then closes the collector (marked closed before clearing, gauge reader released). A late observation is discarded; `snapshot()` answers `disabled` with `disabled` gauges and never calls the reader.                                                                                                                                                    |
| A DNS-rebinding page reaches the loopback port as same-origin to its own hostname.                                                          | Identical to M98i/M98j: exact `Host` authority, any `Origin` refused, per-launch-key MAC, no CORS permission, `127.0.0.1`-only listener. The audit re-probes it on a raw socket.                                                                                                                                                                                                   |
| A shared collector in `common` is new public surface an application could call.                                                             | It is a pure, allocation-bounded object with no I/O and no registry access; calling it only builds another collector nobody reads. The source registration and the attachment remain inside the owning plugins.                                                                                                                                                                    |
| Registering the collector would hand every `getAll` reader its `observe` and `close`, so any plugin could forge counts or silence a source. | Found while writing this review: each plugin registers the collector's frozen `source` facade, which exposes `snapshot()` alone. A test pins the facade's single key.                                                                                                                                                                                                              |
| Counts aggregate every tenant; publish timings are a coarse latency side channel.                                                           | As M98i/M98j: enable on an approved development dataset only; no tenant selector or per-user identifier exists; `lastDurationMs` is integer milliseconds of the last publish, not per frame.                                                                                                                                                                                       |

**Implementation departures from §3, assessed (recorded 2026-09-28).** (1) The collector lives in
`common` (§3.1, maintainer decision); the three packages keep only their WeakMap attachment helpers.
(2) Each plugin registers the collector's frozen snapshot-only `source` facade, found while writing
this review (findings table). (3) SSE's initial `retry:` frame is not counted: it is written inside
the exported `SseConnection` constructor, before the service can attach, and attaching earlier would
need a constructor change (§3.6). (4) The client's realtime tests live in
`packages/diagnostics-plugin/test/unit/client.test.ts` beside every other inspector's, where the
signed fake server is, rather than in the realtime test file §6 names. (5) The internal
`dispatchFrame` helper now returns whether every handler returned, so the three transports record a
receive's outcome from one place. None widens the boundary.

**For the audit (in addition to the implementation gate below):** probe DNS rebinding on a raw
socket; probe a hostile source with accessor, index-getter, class-instance, symbol-key and `Proxy`
snapshots, and with forged `unknown`/`sse`-backpressure-on-`send`/numeric-backplane-gauge
combinations; drive a real WebSocket and a real SSE stream with canaries in frames, messages, close
reasons, query strings and room/channel names; compare send, close, publish and delivery behaviour
observed versus unobserved under a throwing transport, a throwing handler, a throwing clock and a
throwing gauge reader.

**Approved by:** pending — the maintainer.

**Implementation gate — pending committed-tree audit before completion/publication.** Record commit,
reviewed files, tested adapters/runtimes, findings and dispositions in the implementation PR. Test
real operations through the connector. No untested adapter can be listed as audited support.

Plant canaries in frames, messages, headers, query strings, principals, connection IDs, group names,
close reason text, backplane origin. Assert absence at the diagnostic collector boundary, retained
records, source reads, frames, client results and diagnostics-generated logs/errors. Existing
application logging is a separate path; do not claim this change sanitizes it. Include approved-data
positive controls so dropping all records cannot pass. Reject hostile strings and extra keys, and
exercise secret-bearing errors without reading their message/cause/stack.

Compare disabled, enabled, observer-throwing, overflowing and shutdown behavior. Test arbitrary
local probes and browser origins, credentials/replay/session lifetime, source-read order and
resource exhaustion. Review connection/frame integrity failures separately from optional collection
failure: authentication must never degrade into a usable unsigned response. The devtool separately
must pass safe rendering, secret-free logs/export and credential-storage acceptance tests.
