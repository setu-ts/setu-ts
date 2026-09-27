# Milestone 98i — Cache Observations

> **Status:** Implementation on `feat/m98i-cache-observations`; plan reviewed and verified by the
> maintainer before implementation. The design security review is recorded in §10 (written after
> implementation at the maintainer's direction). The committed-tree security audit PASSED on
> re-audit of `aab0bd78` (independent agent, after fixing its finding F2); record in the PR.

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
non-barrel-exported attachment helper. **As implemented** the helper writes a private `CacheService`
field (through a setter bound in the class's static block) rather than a `WeakMap`: the unobserved
hot path is then one field read, and the fair benchmark measured it indistinguishable from the
pre-M98i `CacheService`. Existing exported constructor signatures remain unchanged. Each hot path
checks for an attachment before reading clocks or deriving labels. The collector accepts only the
fixed operation, approved alias, primitive outcome and measured values; raw inputs and errors never
cross that seam. The source uses the same bounded collector and owns no reference to business
payloads. Close detaches first, then clears collector state.

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
`count: number`, `lastDurationMs: number | null`, `ageMs: number`, plus `succeeded`, `failed`,
`hits`, `misses`, `present`, `absent`, `removed`, `notRemoved` (nonnegative safe integers). Every
settled backend call increments count and exactly one outcome counter: succeeded on fulfillment,
failed on rejection or a synchronous backend throw. A null get, false has, or false delete is a
successful call; increment its miss/absent/notRemoved detail counter as well. The detail counters
increment only for their matching successful operation. set and clear therefore have explicit
success/failure outcomes even though all detail counters remain zero. Before saturation, count
equals succeeded + failed; after saturation each counter independently clamps. A backend failure is
observed application behavior, not a collection-failed source state. Numbers are finite, nonnegative
and clamped at Number.MAX_SAFE_INTEGER; durations are integer milliseconds. count counts settled
observations, not currently active calls. Counters are cumulative within the retention window.
Nonapplicable numeric counters are zero. lastDurationMs is null for instantaneous lifecycle
observations; otherwise it is the last settled duration. **As implemented** it is the last TIMED
call's duration: the built-in source times the first call per operation and one in every eight after
it (see §3.4's measurement), and reports `null` when no call in the retention window was timed.
Record alias is exactly the configured source alias (snapshot.alias); no event/job mapping exists.
On failed collection the source clears records and exposes only state, approved alias, coverage and
dropped. Lifecycle-closed and disabled states take precedence over collection-failed. Read only
framework-owned primitive fields; never pass a business object or an Error to the collector.

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
aliases by truncating or hashing sensitive values. Only one configured alias per source is
supported; no event/job maps or dynamic mapping callbacks are accepted.

Each source's records are keyed by approved alias and fixed operation. **As implemented** the
built-in collector has exactly one alias and five operations, so it holds at most five records by
construction and can never run out of slots: its `dropped` is always `0`. The 64-record bound and
`dropped` remain on the source CONTRACT, which the connector validates for any (third-party) source
whose slot set is not fixed. Records expire after 60 seconds without an observation, checked during
update/read; clear their counters on expiry. age >30 seconds means stale; any fresh record means
ready; no records means no-data. No background timer and no per-request diagnostic queue. On close
mark closed before clearing; late results cannot repopulate state, and snapshot returns disabled.
Each observed call retains only primitive timing/alias state, no additional wait on external work,
body copy or diagnostic I/O. Promise observation may add a microtask; tests must preserve
application ordering guarantees without claiming identical promise identity or a literally zero-cost
enabled path.

Use runtime.hrtime for plugin durations; SDK uses the injected monotonic now. Clamp negative deltas.
Catch observer and clock failures without changing application errors or results; latch
collection-failed and stop capture until source recreation. No diagnostic error logging with values.
Benchmark disabled/enabled on the same workload; require zero extra backend calls and no growing
memory after steady state. Target <=5% median throughput regression at 10,000 warmed operations;
record five runs and investigate failures before completion rather than claiming a universal bound.

**Measurement, first pass (superseded below).** Five paired runs of 10,000 warmed `set`+`get` pairs
against `MemoryStore` gave an enabled/disabled time ratio of 2.08–2.71 (median 2.45). Diagnosis by
elimination: with the collector's clock replaced by a constant, the ratio is ~1.5 — the one promise
hop `observeCacheCall` adds to observe settlement — and the remainder is the two `performance.now()`
reads per call. A `MemoryStore` call costs a fraction of a microsecond, so no instrumentation that
measures a per-call duration can stay within 5% of it; against a network backend the same fixed cost
is a small fraction of each round trip, but that was not measured (no Redis was available). Zero
extra backend calls is met (the enabled/disabled/failing comparison test asserts identical backend
call sequences) and memory is bounded (five records).

**Measurement against real Redis, and the reductions it drove (maintainer asked for both).** The
first pass was biased: two instances in one process differ by ~11% with NO code difference (an A/A
control), because the second-constructed instance runs slower under the JIT. The fair harness runs
each configuration (`main`'s pre-M98i `CacheService`, disabled, enabled) in its own fresh process,
alternated, with 10,000 (Redis) or 100,000 (memory) warmed `set`+`get` pairs. Three changes then
landed: settlement was observed on a SIDE branch of the backend's own promise (later reverted — see
the correction below); only the first call per operation and one in every eight after it reads a
start time (one clock read per call instead of two); and the unobserved path reads a private field
instead of a `WeakMap`. Results (medians, ops/s):

| workload              | pre-M98i | disabled | enabled | enabled vs disabled |
| --------------------- | -------- | -------- | ------- | ------------------- |
| Redis 7, 50 in flight | 367k     | 361k     | 338k    | -6.2% (11 rounds)   |
| Redis 7, 1 in flight  | 52.8k    | 57.7k    | 53.1k   | within noise        |
| `MemoryStore`, serial | 8.63M    | 9.44M    | 4.54M   | about 2× slower     |

Isolation at Redis-50 (each variant 7 rounds, enabled path only): removing the side branch, or
replacing the clock with a constant, each left throughput at ~340k, while a collector that returns
the call untouched matched disabled (~356k). The remaining cost is the collector's per-call work
plus the one promise reaction every settlement observation needs; replacing the collector's `Map`s
with fixed slots made no measurable difference and was not kept. The disabled path is
indistinguishable from pre-M98i in every workload. **Status: the ≤5% target is met for serial Redis
and not for 50-concurrent Redis (-6.2%) or the in-memory store; the residual is the cost of
observing each settlement. Accepted by the maintainer on 2026-09-27 ("6% is acceptable"), and
recorded in §10's approved budgets.**

**Correction after the committed-tree audit (2026-09-27).** The side branch was a defect: attaching
`then(onFulfilled, onRejected)` to the caller's own promise marks it HANDLED, so a fire-and-forget
cache call whose backend rejects stopped surfacing as an unhandled rejection whenever diagnostics
were on — an application error silently hidden (audit finding F2, Low). The caller again receives a
derived promise that re-rejects with the original reason; a test drives a fire-and-forget rejection
and asserts exactly one unhandled-rejection event with diagnostics off and on. The isolation above
had already shown the side branch bought nothing measurable, and re-measured with the derived
promise (Redis 7, 50 in flight, 11 rounds): pre-M98i 378k, disabled 377k, enabled 358k — **-5.0%**,
within the accepted budget.

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
| `CacheDiagnosticsOperation`      | common type                | `CacheDiagnosticsRecord.operation`; the validator's enum.  |

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
than fabricated. For each of get/set/delete/has/clear, assert one fulfilled call yields count=1,
succeeded=1, failed=0, and one rejection yields count=1, succeeded=0, failed=1 in separate fresh
collectors. Repeat with synchronous backend throws and verify original error identity. Assert null
get and false has/delete count as succeeded, with the correct detail counter; failed operations
never increment those detail counters. Exercise mixed outcomes, saturation and retention reset.
Connector/client exact-key tests require both outcome fields and reject missing, extra or invalid
fields. A backend failure must remain visible as a ready observation.

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

## 10. Design security review

**Recorded 2026-09-27, after implementation, at the maintainer's direction.** The maintainer
reviewed and verified this plan before implementation began, but that review was not written down,
and the committed-tree audit (correctly) refused to treat the requirement list that stood here as a
completed review. This section records the review's substance. It was written after the code
existed, so it is checked against the plan's §3 decisions — the design the maintainer reviewed —
rather than reverse-engineered from the implementation; where the implementation departed from §3,
the departure is named below and assessed in its own right.

**Purpose it serves.** M98 is the groundwork for the Setu-TS devtool: a developer inspects a running
application on their own machine without the devtool gaining access to live services, application
data, credentials, or any mutation control (ROADMAP M98 objective). For the cache inspector that
means the devtool may learn HOW the owned cache is behaving — per operation, how often, whether it
hit or failed, how long it took — and never WHAT it holds.

**Reviewed flow:** application code → the plugin's own `CacheService` → backend call → the wrapper
classifies the settled result into a primitive outcome (`=== null` for `get`, `=== true` for
`has`/`delete`, fulfilled/rejected otherwise) → bounded per-instance collector (fixed operation,
outcome code, monotonic readings only) → frozen `ICacheDiagnosticsSource` snapshot under the
multi-provider `CAPABILITIES.CACHE_DIAGNOSTICS` → connector resolves at most 16 sources once at
bootstrap → authenticated `GET /v1/cache` (every M98b control: MAC over canonical fields, sequence
replay refusal, loopback authority, Origin refusal, session expiry and revocation, instance binding)
→ copy-once projector with per-source isolation → exact validator → signed frame ≤ 256 KiB → native
client re-validates and binds the instance. Minimization happens at the wrapper, BEFORE the
collector: no key, prefix, value, TTL, factory result or error value ever reaches collector state.

**Assets.**

| Asset                              | Why it is sensitive                                                                 |
| ---------------------------------- | ----------------------------------------------------------------------------------- |
| Cache keys                         | Commonly embed user ids, emails, session ids, tenant ids, resource names.           |
| Cached values and factory results  | Application data: sessions, tokens, rendered pages, query results.                  |
| Key prefixes                       | Reveal tenancy and application topology.                                            |
| Redis URLs and injected clients    | Carry hosts and credentials.                                                        |
| Backend errors                     | May quote hosts, commands, keys and driver diagnostics.                             |
| Operation counts and timings       | Low sensitivity; reveal activity levels, aggregated across every tenant of the app. |
| The session key and signed channel | Owned by M98b; this letter adds a route behind it and must not weaken it.           |

**Attackers and their reach.**

| Attacker                                                                                                                                                           | Must not be able to                                                                                                                                                                   |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An unpaired local process, or a browser tab on the host                                                                                                            | Read any cache observation, cause a source read, or obtain an unsigned response.                                                                                                      |
| A website using DNS rebinding (an attacker's hostname re-resolved to `127.0.0.1` after the page loads, so the page reaches the connector as same-origin to itself) | Read any cache observation or cause a source read — even though, after the rebind, its requests may carry no `Origin` header and are not blocked by the browser's same-origin policy. |
| The paired devtool (trusted reader of the minimized DTO)                                                                                                           | Obtain any asset above except counts/timings, or perform any cache operation.                                                                                                         |
| A third-party in-process plugin registering a hostile source                                                                                                       | Put an unvalidated field, control character or oversized list into the signed frame, or break other sources' reporting.                                                               |
| Application traffic with attacker-chosen keys                                                                                                                      | Grow collector or connector state.                                                                                                                                                    |
| A failing or hung cache backend                                                                                                                                    | Change any application result, error, rejection reason, ordering or unhandled-rejection reporting, or leak its error text.                                                            |

**Out of the threat model (unchanged from M98b):** a privileged local sniffer (loopback carries no
encryption), remote access, and shared multi-tenant production use. A third-party source runs with
application privileges and is not sandboxed: it can hang the event loop with a synchronous loop,
which no validator can prevent. The reader's job is to keep its OUTPUT from crossing into the signed
frame, not to contain its code.

**Approved budgets.** At most five records per built-in source (one approved alias × five fixed
operations — bounded by construction, so `dropped` stays `0`); a 64-record ceiling per source on the
contract, enforced by the connector for third-party sources; at most 16 sources, and more refuses
startup with a fixed error; 60-second retention and 30-second staleness; every counter saturates at
`Number.MAX_SAFE_INTEGER`; no timer, queue, I/O or allocation per key; a 256 KiB response,
collapsing to a fixed `collection-failed` rather than truncating. Overhead: the disabled path is
unchanged from pre-M98i; enabled costs one clock read per call (two on a timed one-in-eight sample)
plus one settlement reaction, measured at about 6% of throughput at 50 concurrent real-Redis calls
and **accepted by the maintainer on 2026-09-27** in place of §3.4's 5% target.

| Finding                                                                            | Resolution                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ---------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Keys, values or errors could enter capture.                                        | The wrapper classifies before the collector; the collector's API accepts only an operation, an outcome code and clock readings. A rejection is recorded without reading the error.                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Per-key labels would grow with attacker-chosen keys and disclose them.             | No per-key label exists; one alias per instance, fixed and validated when `CachePlugin(...)` is called.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| An alias could carry a secret or forge terminal output.                            | Aliases are explicit and approving one authorizes its disclosure; 1–64 UTF-8 bytes, no C0/C1 control character, validated on the plugin, the connector and the client.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| Observation could change application semantics.                                    | The caller receives a promise derived from the backend's: same value, ORIGINAL rejection reason, and an unhandled rejection stays unhandled (a side branch on the caller's promise would mark it handled — audit F2). Enabled, disabled and failing observers are compared by test.                                                                                                                                                                                                                                                                                                                                                                            |
| A failing observer could break the cache.                                          | Every collector entry point catches its own failures and latches a value-free `collection-failed`; application results are unaffected.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| A hostile third-party source could smuggle fields or run code during the read.     | Copy-once reader: plain objects of own DATA properties only (a getter is never invoked), lists by index, exact keys and enums, per-source isolation to a fixed failed snapshot.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Two sources claiming one alias would make the report ambiguous.                    | Duplicate non-null aliases collapse the whole response to `collection-failed` with no sources.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| Named instances collide on one token.                                              | Eager multi-provider registration, never claimed in `provides`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| A replacement service could be mislabeled as observed.                             | Coverage is `owned-instance`: a source describes only the service its plugin created.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Evictions inferred from misses would be fabricated.                                | No eviction counter exists in any layer.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| A DNS-rebinding page reaches the loopback port as same-origin to its own hostname. | Four independent layers, the first sufficient on its own: (1) the `Host` header must be exactly `127.0.0.1:<port>` (`connector-handler.ts:659`, and the parsed URL authority at `:682`), and a rebound page's `Host` names the attacker's hostname, so it is refused before any cryptography or source read; (2) any `Origin` header is refused (`:665`) — NOT relied on here, because a same-origin GET after a rebind may omit it; (3) every request needs a MAC under the per-launch session key, which the page never has; (4) the response carries no CORS permission. The listener binds `127.0.0.1` only (runtime `local-diagnostics-listener.ts:214`). |
| A source could be read before authentication.                                      | Sources are read only inside the authenticated dispatch, after the shared M98b gate.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| An older connector cannot serve the route.                                         | The negotiated manifest answers a local `unsupported` without a request.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Counts aggregate every tenant's activity.                                          | Documented: enable on an approved development dataset; no tenant selector or per-user identifier is added.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |

**Implementation departures from §3, assessed.** (1) The attachment is a private `CacheService`
field set through a non-barrel internal function rather than a `WeakMap` — equivalent isolation (no
public way to read or replace a collector), less hot-path work. (2) Only one call in eight per
operation is timed, so `lastDurationMs` reports the most recent TIMED call — this narrows what is
measured and discloses nothing new. (3) A side-branch observation briefly replaced the derived
promise and was reverted: it hid unhandled rejections (audit F2). None widens the boundary.

**Amended after approval (2026-09-27), flagged for the maintainer:** the backend-attacker row above
originally listed "promise identity" among what must not change. The F2 correction returns a derived
promise when diagnostics are on, so identity does change; identity is not a security property, and
the row now names what is — unhandled-rejection reporting — instead. **Confirmed by the maintainer,
2026-09-27.**

**Added at the maintainer's request (2026-09-27):** the DNS-rebinding attacker above. The audit must
probe it on a RAW socket (the Fetch API cannot set `Host`): a request whose `Host` is
`rebind.example:<port>`, carrying NO `Origin` header and an otherwise VALID MAC for the paired
session, must be refused with no source read — proving the `Host` check holds without the `Origin`
and MAC layers — with the identical request under `Host: 127.0.0.1:<port>` served as the positive
control. The negative control reverts the `Host` check and observes that request served.

**Approved by:** the maintainer, 2026-09-27 — recorded text confirmed, including the DNS-rebinding
attacker.

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
