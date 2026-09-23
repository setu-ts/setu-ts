# Milestone 98i — Cache Observations

> **Status:** Planning. Implementation and fixes: `feat/m98i-cache-observations`. Design security
> assessment below requires recorded review before implementation; no implementation or completed
> security audit is claimed.

## 0. Objective & scope

Provide bounded, opt-in cache observations through the authenticated local connector.

- **In scope:** Only calls through the owned CacheService; direct store calls and replacement
  services are outside coverage. Owner: `packages/cache-plugin`; common and connector changes are
  necessary consumers.
- **NOT this milestone:** raw-data inspection, remote access, persistent history, controls or
  replay.

Depends on the M98a/M98b boundaries and M98d's revised eleven-key manifest. No runtime dependency on
the other inspector providers. Each source states observed-instance coverage, never automatic
visibility into all application code.

## 1. Contracts verified from SOURCE (not names)

| Reference     | Source (file:line)                                                   | Verified surface / fact                                                                                 |
| ------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Source seam   | `packages/common/src/services/cache.ts:19`                           | ICacheStore exposes get/set/delete/has/clear; no eviction or enumeration API.                           |
| Source seam   | `packages/cache-plugin/src/services/cache-service.ts:19`             | CacheService owns prefix/TTL delegation and coalesced getOrSet.                                         |
| Source seam   | `packages/cache-plugin/src/plugin/cache-plugin.ts:62`                | Named instances use cache.<name> and distinct plugin names.                                             |
| Registry      | `packages/common/src/registry.ts:86`                                 | register supports multi; getAll resolves providers; do not resolve application services for inspection. |
| Connector     | `packages/diagnostics-plugin/src/transport/connector-handler.ts:248` | Existing authenticated dispatch and post-await session checks must govern new operations.               |
| Compatibility | `packages/diagnostics-plugin/src/protocol/protocol.ts:294`           | Current status validator has exact keys; M98d's manifest is planned, not implemented.                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                             | Resolution (picked side)                                                                                                       | Doc deliverable (same PR)                                                         |
| -- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------- |
| C1 | Existing public APIs expose application operations, not this source. | Add dedicated source contracts; retain application method signatures.                                                          | PUBLIC_API.md, ARCHITECTURE.md, owning package README and CHANGELOG.              |
| C2 | Earlier M98d reserved only five inspectors.                          | Revise unpublished manifest to eleven exact keys in this planning change; this letter activates `cache` only when implemented. | M98d plan and ROADMAP.md now; docs/diagnostics-protocol.md during implementation. |

## 3. Design decisions

### 3.1 Authoritative capture seam

**Decision:** Instrument actual CacheService backend calls once. get records hit only for a non-null
result; null is miss, and rejection is failure. has records present/absent separately from get hit
rate. getOrSet internal get/set calls count as backend operations; joining the coalescer does not
invent a backend read. Do not change factory execution or fallback behavior. Noop remains a
legitimate miss-producing implementation. No eviction count is inferred from misses or expiration.

**Why:** Counters describe executed work rather than inventing backend or cluster state. **Test
home:** owning package `test/unit/cache-observations.test.ts`.

Attach the internal collector to the owned implementation during plugin registration through a
non-barrel-exported WeakMap attachment helper. Existing exported constructor signatures remain
unchanged. Each hot path checks for an attachment before reading clocks or deriving labels. The
collector accepts only the fixed operation, approved alias, primitive outcome and measured values;
raw inputs and errors never cross that seam. The source uses the same bounded collector and owns no
reference to business payloads. Close detaches first, then clears collector state.

### 3.2 Source ownership and registration

Owning plugins eagerly register `ICacheDiagnosticsSource` under `CAPABILITIES.CACHE_DIAGNOSTICS`
(`cache-diagnostics`) with `multi: true`. Keep plugin names and application capability `provides`
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

Add common `ICacheDiagnosticsSource`, `CacheDiagnosticsSnapshot`, `CacheDiagnosticsRecord`, and
`CacheDiagnosticsResponse`.

`ICacheDiagnosticsSource.snapshot(): CacheDiagnosticsSnapshot` is synchronous, takes no
caller-selected resource, and returns a deeply frozen exact-key object:
`{ state: DiagnosticsInspectorState, alias: string | null, coverage: 'owned-instance', records: readonly CacheDiagnosticsRecord[], dropped: number }`.

A record has exactly `alias: string`, `operation: 'get' | 'set' | 'delete' | 'has' | 'clear'`,
`count: number`, `lastDurationMs: number | null`, `ageMs: number`, plus `hits`, `misses`, `present`,
`absent`, `removed`, `notRemoved` (nonnegative safe integers; increment only for the matching
successful operation). Numbers are finite, nonnegative and clamped at Number.MAX_SAFE_INTEGER;
durations are integer milliseconds. count counts settled observations, not currently active calls.
Counters are cumulative within the retention window. Nonapplicable numeric counters are zero.
lastDurationMs is null for instantaneous lifecycle observations; otherwise it is the last settled
duration. Record alias is the approved event/job alias when configured, and the instance alias for
other inspectors. On failed collection the source clears records and exposes only state, approved
alias, coverage and dropped. Lifecycle-closed and disabled states take precedence over
collection-failed. Read only framework-owned primitive fields; never pass a business object or an
Error to the collector.

`CacheDiagnosticsResponse` is exactly
`{ version: 1, instanceId: string, state: DiagnosticsInspectorState, sources: readonly { sourceId: string, snapshot: CacheDiagnosticsSnapshot }[] }`.
`IDiagnosticsClient.cache(): Promise<CacheDiagnosticsResponse>` reads only `GET /v1/cache` through
the existing signed, serialized exchange. All authentication, origin/authority, replay, expiry,
revocation, instance and post-read session checks precede returning any data; request authentication
must succeed before snapshot is called. Pairing sees `cache: false` as a local typed unsupported
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

Plugin option `diagnostics?: { enabled: true, alias: string }` is absent by default; absent means an
inert disabled source with no collector or observation clock reads. Only the plugin instance alias
is approved; no per-key labels.

Aliases are explicit non-secret labels, unique, 1–64 UTF-8 bytes, without controls; do not derive
aliases by truncating or hashing sensitive values. Event/job maps admit at most 64 exact entries.
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

| Exported symbol                  | Kind                       | Consumer / real code path that READS it                    |
| -------------------------------- | -------------------------- | ---------------------------------------------------------- |
| `ICacheDiagnosticsSource`        | common interface           | Owning source and connector reader.                        |
| `CacheDiagnosticsSnapshot`       | common type                | Source, exact projector and client.                        |
| `CacheDiagnosticsRecord`         | common type                | Bounded collector and devtool summary.                     |
| `CacheDiagnosticsResponse`       | common type                | Connector and native client method.                        |
| `IDiagnosticsClient.cache`       | client method              | Devtool inspector.                                         |
| `CacheDiagnosticsOptions`        | owning package option type | Application opt-in and collector construction.             |
| `CAPABILITIES.CACHE_DIAGNOSTICS` | common token               | Owning plugin multi-registration and connector resolution. |

Collectors, attachment helpers and projectors remain internal. No general observer/event-bus API.

### 4.1 Options — every option names its consumer

| Option                      | Consumer                     | Behavior (per implementation)                  |
| --------------------------- | ---------------------------- | ---------------------------------------------- |
| enabled / alias             | Owning collector constructor | Explicit activation and approved display name. |
| No additional plugin labels | Construction contract        | No dynamic label extraction.                   |

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
| `packages/cache-plugin/src/services/cache-service.ts`            | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/cache-plugin/src/plugin/cache-plugin.ts`               | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/cache-plugin/src/interfaces/index.ts`                  | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/cache-plugin/src/index.ts`                             | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/cache-plugin/src/diagnostics/cache-observations.ts`    | Opt-in capture, source, options or lifecycle wiring.        |

Also update PUBLIC_API.md, ARCHITECTURE.md, docs/diagnostics-protocol.md, package READMEs,
CHANGELOG.md, ROADMAP.md and CLAUDE.md. SDK dependency metadata changes in M98n accompany its common
contract release; no external dependency is introduced.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                             | src covered                                                      | Key assertions (and the signature each call type-checks against)                                       |
| --------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts` | `packages/common/src/services/diagnostics.ts`                    | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts` | `packages/common/src/tokens.ts`                                  | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts` | `packages/common/src/index.ts`                                   | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                |
| `packages/diagnostics-plugin/test/unit/cache-observations.test.ts`    | `packages/diagnostics-plugin/src/interfaces/index.ts`            | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                |
| `packages/diagnostics-plugin/test/unit/cache-observations.test.ts`    | `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`   | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                |
| `packages/diagnostics-plugin/test/unit/cache-observations.test.ts`    | `packages/diagnostics-plugin/src/protocol/protocol.ts`           | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                |
| `packages/diagnostics-plugin/test/unit/cache-observations.test.ts`    | `packages/diagnostics-plugin/src/transport/connector-handler.ts` | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                |
| `packages/diagnostics-plugin/test/unit/cache-observations.test.ts`    | `packages/diagnostics-plugin/src/client/client.ts`               | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                |
| `packages/cache-plugin/test/unit/cache-observations.test.ts`          | `packages/cache-plugin/src/services/cache-service.ts`            | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                |
| `packages/cache-plugin/test/unit/cache-observations.test.ts`          | `packages/cache-plugin/src/plugin/cache-plugin.ts`               | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                |
| `packages/cache-plugin/test/unit/cache-observations.test.ts`          | `packages/cache-plugin/src/interfaces/index.ts`                  | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                |
| `packages/cache-plugin/test/unit/cache-observations.test.ts`          | `packages/cache-plugin/src/index.ts`                             | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                |
| `packages/cache-plugin/test/unit/cache-observations.test.ts`          | `packages/cache-plugin/src/diagnostics/cache-observations.ts`    | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                |
| `packages/diagnostics-plugin/test/e2e/cache-observations.test.ts`     | All owning producers and connector reader                        | Real producer -> source.snapshot() -> signed socket -> client.cache(); positive controls and canaries. |

Compare TTL, prefix, concurrent getOrSet factory counts, null semantics and original rejection
identity with observation enabled, disabled and failing. Assert evictions are unsupported rather
than fabricated.

Every mapped test calls the §3 signatures. Exercise legacy status and all eleven reserved keys,
false-key no-request, absent source, source throw, malformed source objects including throwing
getters, snapshot overrun, duplicate aliases, unpaired/replayed/expired/revoked/cross-instance
requests and refusal of mutation methods. Custom application replacements remain outside source
coverage, do not get instantiated by snapshot, and cannot be mislabeled as observed.

## 7. Verification gates

```bash
git branch --show-current   # feat/m98i-cache-observations
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

Only calls through the owned CacheService; direct store calls and replacement services are outside
coverage.

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

Plant canaries in keys, prefixes, values, Redis URLs, factory results, raw errors. Assert absence at
the diagnostic collector boundary, retained records, source reads, frames, client results and
diagnostics-generated logs/errors. Existing application logging is a separate path; do not claim
this change sanitizes it. Include approved-data positive controls so dropping all records cannot
pass. Reject hostile strings and extra keys, and exercise secret-bearing errors without reading
their message/cause/stack.

Compare disabled, enabled, observer-throwing, overflowing and shutdown behavior. Test arbitrary
local probes and browser origins, credentials/replay/session lifetime, source-read order and
resource exhaustion. Review connection/frame integrity failures separately from optional collection
failure: authentication must never degrade into a usable unsigned response. The devtool separately
must pass safe rendering, secret-free logs/export and credential-storage acceptance tests.
