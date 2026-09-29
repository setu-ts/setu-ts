# Milestone 98m — Storage Operation Observations

> **Status:** Complete. Implementation and fixes: `feat/m98m-storage-observations`. The design
> security assessment (§10.1, recorded 2026-09-28 before implementation) was approved before
> implementation. The committed-tree implementation security audit passed on `e3ddbfd4` (333 probes,
> 6 negative controls, no findings).

## 0. Objective & scope

Provide bounded, opt-in storage operation observations through the authenticated local connector.

- **In scope:** Operation/acquisition timings, not transfer progress, inventory or object browsing.
  Owner: `packages/storage-plugin`; common and connector changes are necessary consumers.
- **NOT this milestone:** raw-data inspection, remote access, persistent history, controls or
  replay.

Depends on the M98a/M98b boundaries and M98d's revised eleven-key manifest. No runtime dependency on
the other inspector providers. Each source states observed-instance coverage, never automatic
visibility into all application code.

## 1. Contracts verified from SOURCE (not names)

| Reference     | Source (file:line)                                                   | Verified surface / fact                                                                                               |
| ------------- | -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| Source seam   | `packages/common/src/services/storage.ts:60`                         | IStorage exposes object operations and optional getStream; metadata and signed URLs carry arbitrary sensitive values. |
| Source seam   | `packages/storage-plugin/src/services/storage-service.ts:30`         | StorageService converts absent get into an error containing the path and has a buffered stream fallback.              |
| Registry      | `packages/common/src/registry.ts:86`                                 | register supports multi; getAll resolves providers; do not resolve application services for inspection.               |
| Connector     | `packages/diagnostics-plugin/src/transport/connector-handler.ts:248` | Existing authenticated dispatch and post-await session checks must govern new operations.                             |
| Compatibility | `packages/diagnostics-plugin/src/protocol/protocol.ts:409`           | Eleven exact inspector keys are implemented; storage remains false until this route ships.                            |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                  | Resolution (picked side)                                                                                              | Doc deliverable (same PR)                                             |
| -- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| C1 | Existing public APIs expose application operations, not this source.      | Add dedicated source contracts; retain application method signatures.                                                 | PUBLIC_API.md, ARCHITECTURE.md, owning package README and CHANGELOG.  |
| C2 | This plan incorrectly described the eleven-key manifest as unimplemented. | Retain the existing eleven-key manifest; activate only `storage` when implemented. No retrospective M98d plan change. | docs/diagnostics-protocol.md and PUBLIC_API.md during implementation. |

## 3. Design decisions

### 3.1 Authoritative capture seam

**Decision:** Observe service operation settlement once. For put/get record byteLength already
available from the application argument/result, without copying bytes. getStream records only stream
acquisition duration and outcome; bytes remain null and transfer completion is unknown. Its buffered
fallback must not double count internal get as another public operation. getSignedUrl records
success/failure only and never reads the returned URL. No additional exists/get/list/probe call is
allowed.

**Why:** Counters describe executed work rather than inventing backend or cluster state. **Test
home:** owning package `test/unit/storage-observations.test.ts`.

Attach the internal collector to the owned implementation during plugin registration through a
non-barrel-exported WeakMap attachment helper. Existing exported constructor signatures remain
unchanged. Each hot path checks for an attachment before reading clocks or deriving labels. The
collector accepts only the fixed operation, approved alias, primitive outcome and measured values;
raw inputs and errors never cross that seam. The source uses the same bounded collector and owns no
reference to business payloads. Close detaches first, then clears collector state.

Use a private unobserved buffered-read helper shared by public get and the getStream fallback; never
use a shared suppression flag, which could suppress concurrent public gets. Preserve absent object
conversion, optional put argument arity, provider receiver, returned byte/stream identity, and
original rejection identity. False exists/delete results are successful settlements. Observe service
failures, including null-to-error conversion, without reading errors. Do not attach a detached
promise rejection handler that changes the application's unhandled-rejection behavior.

Read byte length using the intrinsic typed-array byte-length accessor, not an overridable property
on a supplied object. Capture put length before invoking the provider and get length on successful
settlement; retain only the number. A byte-length observation failure must not change the operation.
Never enumerate options/metadata, inspect a URL, consume/tee/wrap a native stream, or install stream
listeners. The existing buffered fallback remains buffered; no new backpressure guarantee is made.

### 3.2 Source ownership and registration

Owning plugins eagerly register `IStorageDiagnosticsSource` under `CAPABILITIES.STORAGE_DIAGNOSTICS`
(`storage-diagnostics`) with `multi: true`. Keep plugin names and application capability `provides`
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

Expose a frozen snapshot-only facade, not the collector or its mutation methods. Built-in sources
are eager values; getAll can execute third-party factories, so it is not a sandbox guarantee. The
current storage plugin still owns one instance and keeps its existing name; multi-registration does
not introduce named storage instances. Register cleanup alongside attachment: failed startup and
shutdown must detach/close before awaiting provider disconnect, including disconnect failure.

### 3.3 Exact public projection and reader

Add common `IStorageDiagnosticsSource`, `StorageDiagnosticsSnapshot`, `StorageDiagnosticsRecord`,
and `StorageDiagnosticsResponse`.

`IStorageDiagnosticsSource.snapshot(): StorageDiagnosticsSnapshot` is synchronous, takes no
caller-selected resource, and returns a deeply frozen exact-key object:
`{ state: DiagnosticsInspectorState, alias: string | null, coverage: 'owned-instance', records: readonly StorageDiagnosticsRecord[], dropped: number }`.

A record has exactly `alias: string`,
`operation: 'put' | 'get' | 'delete' | 'exists' | 'getSignedUrl' | 'getStream'`, `count: number`,
`lastDurationMs: number | null`, `ageMs: number`, plus `succeeded`, `failed`, `lastBytes` (safe
integer or null; only successful buffered get/put have a byte count). Numbers are finite,
nonnegative and clamped at Number.MAX_SAFE_INTEGER; durations are integer milliseconds. count counts
settled observations, not currently active calls. Counters accumulate until that operation's idle
expiry; they are not a rolling 60-second total. lastDurationMs is null for getSignedUrl, which
records outcome and age only; otherwise it is the last settled duration. lastBytes is null after
failure and for all operations except successful put/get, including getStream's buffered fallback.
Zero bytes is valid. Age, duration and bytes describe the same last settlement. Record alias is
exactly the configured source alias (snapshot.alias); no event/job mapping exists. On failed
collection the source clears records and exposes only state, approved alias, coverage and dropped.
Lifecycle-closed and disabled states take precedence over collection-failed. Read only
framework-owned primitive fields; never pass a business object or an Error to the collector.

`StorageDiagnosticsResponse` is exactly
`{ version: 1, instanceId: string, state: DiagnosticsInspectorState, sources: readonly { sourceId: string, snapshot: StorageDiagnosticsSnapshot }[] }`.
`IDiagnosticsClient.storage(): Promise<StorageDiagnosticsResponse>` reads only `GET /v1/storage`
through the existing signed, serialized exchange. All authentication, origin/authority, replay,
expiry, revocation, instance and post-read session checks precede returning any data; request
authentication must succeed before snapshot is called. Pairing sees `storage: false` as a local
typed unsupported response without a request. A supported operation with no sources returns
unsupported and []. Per-source invalid reads become fixed collection-failed snapshots with no
records; no error text. Response state is ready if any source is ready, otherwise collection-failed,
stale, no-data, disabled, unsupported in that priority order. Individual states remain visible.

Projectors accept exact own data properties and reject getters, prototypes with unexpected shape,
extra object keys, invalid enums or oversized arrays. Snapshot and record values are plain objects
(Object.prototype or null prototype) containing only own data properties; custom prototypes are
rejected. Proxy traps cannot be sandboxed: catch their failures and never copy unknown fields. Copy
approved primitives individually. The full response is limited to 256 KiB; on exceeding it return a
fixed collection-failed response, never a partial JSON document. The client independently validates
the same contract.

The six-operation vocabulary allows at most six records, one per operation. Require safe integers,
matching record/source aliases, unique operations and source IDs, and state/record consistency:
disabled has null alias and no records; no-data and collection-failed have no records; ready/stale
have records. Unsupported is a response state, not a producer state. Inspect array indices as own
data descriptors within the bound; do not invoke element getters, iterators, map or toJSON hooks.
Validate the copied projection and serialize it once; hash, sign and send those exact bytes. For
each nonempty record, count is positive and equals the saturating sum of succeeded and failed.
Validate operation-specific duration/byte nullability and ready/stale age consistency as well.

### 3.4 Opt-in, retention and overhead

Plugin option `diagnostics?: { enabled: true, alias: string }` is absent by default; absent means an
inert disabled source with no collector or observation clock reads. Only the storage instance alias
is approved; no object-level grouping.

Aliases are explicit non-secret labels, unique, 1–64 UTF-8 bytes, without controls; do not derive
aliases by truncating or hashing sensitive values. Only one configured alias per source is
supported; no event/job maps or dynamic mapping callbacks are accepted.

Each source has six fixed operation slots and at most 1,024 active observation tokens. A call beyond
the active-token cap runs normally but is not observed; increment saturating dropped once, without
reading a start clock or adding an observation callback. The cap bounds diagnostic state, not
application concurrency. Never queue, cancel or time out application work to enforce it. Tokens
retain only operation, primitive timing/byte values and lifecycle identity, not payloads or errors.
Release tokens on settlement even on observer failure; hung calls cannot retain more than the cap.

Records expire at age >=60 seconds since their last settlement, checked during update/read; clear
their counters before recording a new settlement after expiry. age >30 seconds means stale; any
fresh record means ready; no records means no-data. A long-running call creates its record only at
settlement and never resurrects an expired counter. dropped is source-lifetime cumulative until
close, not reset on record expiry. No background timer or per-request diagnostic queue. On close
mark closed before clearing; late results cannot repopulate state, and snapshot returns disabled
with null alias, empty records and dropped zero. No additional wait on external work, body copy or
diagnostic I/O. Promise observation may add a microtask; tests must preserve application ordering
guarantees without claiming identical promise identity or a literally zero-cost enabled path.

Use runtime.hrtime for plugin durations and ages. Clamp backward movement against the last accepted
reading; reject non-finite clock values as collection failures. Clamp negative deltas. Catch
observer and clock failures without changing application errors or results; latch collection-failed
and stop capture until source recreation. No diagnostic error logging with values. Benchmark
disabled/enabled on the same workload; require zero extra backend calls and no growing memory after
steady state. Target <=5% median throughput regression at 10,000 warmed operations; record five runs
and investigate failures before completion rather than claiming a universal bound.

### 3.5 Scope and isolation

Local pairing authorizes the configured application instance, not a per-tenant login. Counts may
aggregate tenants in that development instance. Do not advertise tenant isolation from aliases. Only
enable on an explicitly approved development dataset; shared multi-tenant production use is
unsupported. No tenant selectors, per-user identifiers, resource lookups or controls are added.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                    | Kind                       | Consumer / real code path that READS it                    |
| ---------------------------------- | -------------------------- | ---------------------------------------------------------- |
| `IStorageDiagnosticsSource`        | common interface           | Owning source and connector reader.                        |
| `StorageDiagnosticsSnapshot`       | common type                | Source, exact projector and client.                        |
| `StorageDiagnosticsRecord`         | common type                | Bounded collector and devtool summary.                     |
| `StorageDiagnosticsResponse`       | common type                | Connector and native client method.                        |
| `IDiagnosticsClient.storage`       | client method              | Devtool inspector.                                         |
| `StorageDiagnosticsOptions`        | owning package option type | Application opt-in and collector construction.             |
| `CAPABILITIES.STORAGE_DIAGNOSTICS` | common token               | Owning plugin multi-registration and connector resolution. |

Collectors, attachment helpers and projectors remain internal. No general observer/event-bus API.

### 4.1 Options — every option names its consumer

| Option                      | Consumer                     | Behavior (per implementation)                  |
| --------------------------- | ---------------------------- | ---------------------------------------------- |
| enabled / alias             | Owning collector constructor | Explicit activation and approved display name. |
| No additional plugin labels | Construction contract        | No dynamic label extraction.                   |

## 5. Implementation files

| File                                                              | Purpose                                                                                           |
| ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/diagnostics.ts`                     | Typed contract, export, authenticated projection or reader.                                       |
| `packages/common/src/tokens.ts`                                   | Typed contract, export, authenticated projection or reader.                                       |
| `packages/common/src/index.ts`                                    | Typed contract, export, authenticated projection or reader.                                       |
| `packages/diagnostics-plugin/src/interfaces/index.ts`             | Typed contract, export, authenticated projection or reader.                                       |
| `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`    | Typed contract, export, authenticated projection or reader.                                       |
| `packages/diagnostics-plugin/src/protocol/protocol.ts`            | Typed contract, export, authenticated projection or reader.                                       |
| `packages/diagnostics-plugin/src/protocol/storage-protocol.ts`    | Internal bounded own-data projector and exact shared wire validator, following cache-protocol.ts. |
| `packages/diagnostics-plugin/src/transport/connector-handler.ts`  | Typed contract, export, authenticated projection or reader.                                       |
| `packages/diagnostics-plugin/src/client/client.ts`                | Typed contract, export, authenticated projection or reader.                                       |
| `packages/storage-plugin/src/services/storage-service.ts`         | Opt-in capture, source, options or lifecycle wiring.                                              |
| `packages/storage-plugin/src/plugin/storage-plugin.ts`            | Opt-in capture, source, options or lifecycle wiring.                                              |
| `packages/storage-plugin/src/interfaces/index.ts`                 | Opt-in capture, source, options or lifecycle wiring.                                              |
| `packages/storage-plugin/src/index.ts`                            | Opt-in capture, source, options or lifecycle wiring.                                              |
| `packages/storage-plugin/src/diagnostics/storage-observations.ts` | Opt-in capture, source, options or lifecycle wiring.                                              |

Also update PUBLIC_API.md, ARCHITECTURE.md, docs/diagnostics-protocol.md, package READMEs,
CHANGELOG.md, ROADMAP.md and CLAUDE.md. SDK dependency metadata changes in M98n accompany its common
contract release; no external dependency is introduced.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                             | src covered                                                       | Key assertions (and the signature each call type-checks against)                                         |
| --------------------------------------------------------------------- | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts` | `packages/common/src/services/diagnostics.ts`                     | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                  |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts` | `packages/common/src/tokens.ts`                                   | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                  |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts` | `packages/common/src/index.ts`                                    | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                  |
| `packages/diagnostics-plugin/test/unit/storage-observations.test.ts`  | `packages/diagnostics-plugin/src/interfaces/index.ts`             | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                  |
| `packages/diagnostics-plugin/test/unit/storage-observations.test.ts`  | `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`    | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                  |
| `packages/diagnostics-plugin/test/unit/storage-observations.test.ts`  | `packages/diagnostics-plugin/src/protocol/protocol.ts`            | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                  |
| `packages/diagnostics-plugin/test/unit/storage-observations.test.ts`  | `packages/diagnostics-plugin/src/protocol/storage-protocol.ts`    | Six-record bound, hostile descriptors, numeric/state invariants, copy-once validation and byte cap.      |
| `packages/diagnostics-plugin/test/unit/storage-observations.test.ts`  | `packages/diagnostics-plugin/src/transport/connector-handler.ts`  | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                  |
| `packages/diagnostics-plugin/test/unit/storage-observations.test.ts`  | `packages/diagnostics-plugin/src/client/client.ts`                | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                  |
| `packages/storage-plugin/test/unit/storage-observations.test.ts`      | `packages/storage-plugin/src/services/storage-service.ts`         | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                  |
| `packages/storage-plugin/test/unit/storage-observations.test.ts`      | `packages/storage-plugin/src/plugin/storage-plugin.ts`            | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                  |
| `packages/storage-plugin/test/unit/storage-observations.test.ts`      | `packages/storage-plugin/src/interfaces/index.ts`                 | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                  |
| `packages/storage-plugin/test/unit/storage-observations.test.ts`      | `packages/storage-plugin/src/index.ts`                            | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                  |
| `packages/storage-plugin/test/unit/storage-observations.test.ts`      | `packages/storage-plugin/src/diagnostics/storage-observations.ts` | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                  |
| `packages/diagnostics-plugin/test/e2e/storage-observations.test.ts`   | All owning producers and connector reader                         | Real producer -> source.snapshot() -> signed socket -> client.storage(); positive controls and canaries. |

Test all existing provider arms using injected clients and existing guarded real-import suites.
Compare optional put arguments, sync provider throws, missing objects, stream
identity/cancellation/backpressure and fallback call counts.

Every mapped test calls the §3 signatures. Exercise legacy status and all eleven reserved keys,
false-key no-request, absent source, source throw, malformed source objects including throwing
getters, snapshot overrun, duplicate aliases, unpaired/replayed/expired/revoked/cross-instance
requests and refusal of mutation methods. Custom application replacements remain outside source
coverage, do not get instantiated by snapshot, and cannot be mislabeled as observed.

## 7. Verification gates

```bash
git branch --show-current   # feat/m98m-storage-observations
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

Operation/acquisition timings, not transfer progress, inventory or object browsing.

No database inspector, persistent history, raw payloads, admin controls, replay, remote transport or
billing integration. Future adapter-specific visibility requires separately planned contracts and
audits; it is not implied by completing this milestone.

## 10. Required security reviews and acceptance evidence

### 10.1 Recorded design assessment — 2026-09-28

Reviewer: Codex, in the M98m worktree, against base commit
`d6b77e4f826a27e04eb412281203cb664564628c`. This is a source-informed preimplementation assessment,
not the independent committed-tree audit. The design findings below are addressed by requirements in
this plan; none is claimed fixed in executable code. Maintainer approval remains pending.

Reviewed: the §1 contracts, storage service and plugin registration/cleanup, storage options and
provider interfaces, registry resolution, diagnostic bootstrap, protocol manifest and own-data
helpers, cache-protocol projection, connector handler/limits and native client exchange. Checked
against AI_GUIDELINES.md, relevant architecture/API documentation and the security-audit procedure.
Provider behavior informed the scope; cloud services were not contacted or audited.

**Trust and data flow:** application/provider values -> owned StorageService -> primitive-only
collector -> frozen source facade -> authenticated fixed GET /v1/storage -> bounded own-data
projection -> signed bytes -> independently validating native client. Authentication precedes source
invocation. Collection runs independently of polling; pairing authorizes reading, not starting
collection. Closing the connector/revoking pairing does not disable an explicitly enabled storage
collector; closing the storage owner does.

| Asset / attacker-controlled input                                              | Boundary and review conclusion                                                                                                                                                           |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Object paths, contents, metadata, MIME types, credentials, signed URLs, errors | Never collector inputs or DTO fields. No stringification, hashing, redaction-based fallback, error property reads or diagnostic value logging.                                           |
| Application results, rejection reasons and stream behavior                     | Observation cannot change provider arguments, I/O count, receiver, returned bytes/streams, rejection identity or cancellation.                                                           |
| CPU/memory under high concurrency, hung calls and attacker-selected keys       | Six fixed slots, bounded tokens, idle expiry, saturating counters; no key-dependent allocation or diagnostic work queue.                                                                 |
| Local unpaired process or hostile browser                                      | Existing loopback/authority, Origin, canonical-target, rate, MAC, sequence, instance and session gates apply unchanged. No source reads before admission.                                |
| Paired client                                                                  | May read aggregate activity for the approved development instance, not arbitrary objects or a selected tenant. Timing, sizes and aliases remain intentionally disclosed data.            |
| Custom source, hostile DTO, proxy traps                                        | Treat returned data as untrusted, copy allowlisted primitives once and fail closed. In-process source execution/proxy traps are not sandboxed; a malicious source can block the process. |
| Devtool display/export                                                         | Aliases are labels, not trusted HTML. UI rendering, credential storage and export auditing belong to the consuming devtool, not evidence supplied by this backend milestone.             |

**Budgets:** one explicit 1–64-byte UTF-8 alias per enabled source; six operation records and 1,024
active measurement tokens per source; 16 sources; 60-second idle retention with >30-second stale
threshold; safe-integer counters; 256 KiB serialized response ceiling. Preserve inherited connector
limits (8 handlers, 7 pre-authentication handlers, 4 verifications, 8 KiB protocol headers;
anonymous 5/s with burst 10 and session 20/s with burst 40). These are diagnostic budgets, not an
application-wide memory bound or protection from malicious in-process code. A clock failure clears
records and latches collection-failed until recreation; close takes precedence.

| Finding                                                            | Design disposition / implementation obligation                                                                                                                    |
| ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| D1 — Retained record bounds did not bound hung operations          | §3.4 adds the active-token cap, overflow accounting, settlement release and close/late-settlement rules. Test unresolved promises at and beyond the cap.          |
| D2 — Stream fallback could count twice or suppress concurrent gets | §3.1 chooses a shared private unobserved buffered read, never global suppression. Prove one fallback acquisition record and an independent concurrent get record. |
| D3 — Byte-length access could execute application getters          | §3.1 requires the intrinsic typed-array accessor and failure isolation; test subclasses/own getters and zero bytes without copying.                               |
| D4 — Retention and last-value semantics were ambiguous             | §§3.3–3.4 define idle-reset totals, exact boundaries, failure nulls, signed-URL outcome-only observation and latest-settlement semantics.                         |
| D5 — Broad record capacity and lifecycle exposure were unnecessary | Six fixed slots replace the generic 64-slot budget; a frozen read-only facade and cleanup-before-disconnect prevent collector mutation and late revival.          |
| D6 — Compatibility premise was stale                               | §2 retains the already implemented eleven-key manifest; only storage changes from false to true with implementation. Legacy false-key behavior remains tested.    |

Residual risks accepted by this design scope: aggregate activity/size leakage to paired clients,
explicit aliases accidentally containing secrets, existing application/provider logging, existing
buffered/eager stream behavior, and arbitrary privileged third-party code. Do not represent any of
these as sanitized, tenant-isolated or sandboxed. No unresolved design alternative is delegated to
implementation; maintainer approval of this plan is still a separate decision.

### 10.2 Required implementation audit matrix — not yet executed

Use the existing §6 unit/e2e homes. Every row requires an allowed positive control and the stated
adversarial case; a no-op collector or always-refusing endpoint must fail. For every new security
control, locally disable that control and demonstrate that its focused regression test fails, then
restore it. Record commands, exit statuses and observed behavior, not just test names.

| ID                             | Exercise                                                                                                                                                                                                                                      | Required evidence / pass condition                                                                                                                                                                                                                                                                 |
| ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| S1 — Minimization              | Unique canaries in paths, bytes, metadata/content type, credentials, URLs and errors, including throwing message/cause/stack getters. Execute all six public methods.                                                                         | Inspect collector inputs, retained state, snapshots, signed frames, client results and diagnostics-generated logs/errors. No canary; approved aliases, operation counts and permitted byte lengths present. No secret property getter runs.                                                        |
| S2 — Semantic fidelity         | Disabled, enabled, overflow, throwing/non-finite clock and closed collector; absent objects, synchronous provider throws, primitive rejections, false exists/delete, omitted/explicit options, zero bytes and byteLength overrides.           | Same arguments/arity, receiver, provider-call count, returned identity and rejection reason as baseline. Disabled path has no collector/timing reads. Test unhandled rejection behavior in an isolated subprocess.                                                                                 |
| S3 — Streams                   | Native acquisition, null/throw, buffered fallback with concurrent get, downstream failure, cancellation and slow consumer.                                                                                                                    | No diagnostic read/tee/listener and no completion claims. Native stream identity preserved; exactly one observation per public call. Existing adapter backpressure/cancellation assertions remain true, without upgrading buffered/eager adapters' guarantees.                                     |
| S4 — Bounds/time               | Six operations under many secret object keys; 1,024 held calls plus overflow; resolve/reject, idle expiry at 59,999/60,000 ms, stale at 30,000/30,001 ms, counter saturation and backward clock.                                              | Fixed slots/tokens, saturating dropped once per skipped call, no queue/timer, exact state transitions and idle resets. Continuous activity explicitly retains cumulative totals. Memory stabilizes; settle/close releases diagnostic state.                                                        |
| S5 — Lifecycle/coverage        | Delayed settlement after close, disconnect rejection, bootstrap failure, application capability replacement, no diagnostic sources, disabled source and 17 eager sources.                                                                     | No late revival or source-driven application resolution/I/O; fixed excess-source error, correct disabled/unsupported states, original owned-instance coverage only. No snapshot invoked during registration.                                                                                       |
| S6 — Hostile projection        | Extra keys, accessors, custom prototypes, proxy throws, sparse/oversized arrays, array hooks, duplicate operations/aliases/IDs, alias byte boundaries/controls, NaN/Infinity/fractions/negative/unsafe integers and inconsistent states.      | Own-data copy only, bounded traversal, fixed value-free per-source failure; duplicate aliases collapse the whole response. Independently reject malformed client frames. Exercise the 256 KiB guard through an internal test seam because valid bounded storage DTOs cannot naturally approach it. |
| S7 — Admission/transport       | Real local socket probes: unpaired/wrong key, replay, wrong instance, Origin/preflight, forwarding headers, wrong/raw Host, DNS-rebinding shape, noncanonical/encoded path, query, unsupported method/body, malformed framing and throttling. | No rejected request reaches snapshot; no CORS permission or usable unsigned success. A correctly paired canonical GET succeeds. Reuse raw-socket security harness, not only normalized Request objects. No external probing.                                                                       |
| S8 — Session/frame races       | Revoke/expire during verify, source read, digest/sign and response delivery; tamper body/MAC/instance/sequence; concurrent client calls.                                                                                                      | Post-await gates discard data; client refuses invalid frames and serializes exchanges. Capture bytes prove the hashed/signed bytes are exactly those sent. Optional collection failure never masks an authentication/integrity failure.                                                            |
| S9 — Compatibility/performance | Eleven-key manifest, legacy storage false, source-empty true, existing inspectors; five warmed 10,000-operation baseline/enabled runs.                                                                                                        | False-key storage call issues no storage request; other capabilities unaffected. Report medians, backend-call counts and steady-state memory. Investigate >5% throughput regression; do not present the target as a universal guarantee.                                                           |

Provider coverage ledger must distinguish injected-client tests from real-import/integration tests:
memory, local, S3, B2's S3 configuration, GCS and Azure. Reuse guarded SDK suites; record skipped
runtime/SDK/backend combinations and why. B2 configuration tests do not prove live B2 service
behavior. Separately supplied IStorage implementations (including Cloudflare R2) are not implicitly
observed. Do not access live cloud credentials or services merely to complete this review.

For S8, distinguish server admission from client acceptance: revocation before the final server gate
must prevent release, and client disposal before acceptance must reject an in-flight result. Bytes
already released cannot be recalled; do not promise retroactive revocation of delivered data.

### 10.3 Completion gate and evidence record

Before implementation, obtain maintainer approval of this design. Before completion/publication,
perform the repository's independent committed-tree security audit using
`.roo/skills/security-audit/SKILL.md`, covering its required defect classes and the matrix above.
Its implementation-audit requirement is not fulfilled by this design review. Keep scratch/probes
under workspace `.tmp/`; do not commit additional review plans or secret-bearing artifacts.

Record the exact audited commit, reviewed files and seams, actual runtime/adapter coverage, S1–S9
results and negative controls, all findings with severity and disposition, and remaining limitations
in the implementation PR evidence. Any fix changes the audited tree: commit it and re-audit affected
controls plus integration boundaries. Unresolved correctness/security findings block completion.
Supply §7 gates, ANSI-stripped per-file coverage, forbidden-construct scan and both committed-tree
publication-gate exit statuses. Do not mark M98m complete from this document.
