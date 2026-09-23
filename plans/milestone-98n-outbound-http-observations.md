# Milestone 98n — Outbound HTTP Attempt Observations

> **Status:** Planning. Implementation and fixes: `feat/m98n-outbound-http-observations`. Design
> security assessment below requires recorded review before implementation; no implementation or
> completed security audit is claimed.

## 0. Objective & scope

Provide bounded, opt-in outbound http attempt observations through the authenticated local
connector.

- **In scope:** Explicitly adopted server-side fetch attempts only. Browser SDK collection is not
  automatically sent to the framework; unrelated fetches and third-party internal calls are
  invisible. Owner: `packages/sdk`; common and connector changes are necessary consumers.
- **NOT this milestone:** raw-data inspection, remote access, persistent history, controls or
  replay.

Depends on the M98a/M98b boundaries and M98d's revised eleven-key manifest. No runtime dependency on
the other inspector providers. Each source states observed-instance coverage, never automatic
visibility into all application code.

## 1. Contracts verified from SOURCE (not names)

| Reference     | Source (file:line)                                                   | Verified surface / fact                                                                                 |
| ------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Source seam   | `packages/sdk/src/http/contracts.ts:150`                             | ClientOptions.fetch accepts an injected fetch function; IClientTiming.now supplies a monotonic clock.   |
| Source seam   | `packages/sdk/src/http/http-client.ts:1`                             | Each retry reaches injected fetch; response interceptors run only after successful response parsing.    |
| Source seam   | `packages/sdk/src/index.ts:1`                                        | SDK exports client helpers; there is no server http-client-plugin.                                      |
| Registry      | `packages/common/src/registry.ts:86`                                 | register supports multi; getAll resolves providers; do not resolve application services for inspection. |
| Connector     | `packages/diagnostics-plugin/src/transport/connector-handler.ts:248` | Existing authenticated dispatch and post-await session checks must govern new operations.               |
| Compatibility | `packages/diagnostics-plugin/src/protocol/protocol.ts:294`           | Current status validator has exact keys; M98d's manifest is planned, not implemented.                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                             | Resolution (picked side)                                                                                                              | Doc deliverable (same PR)                                                         |
| -- | -------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| C1 | Existing public APIs expose application operations, not this source. | Add dedicated source contracts; retain application method signatures.                                                                 | PUBLIC_API.md, ARCHITECTURE.md, owning package README and CHANGELOG.              |
| C2 | Earlier M98d reserved only five inspectors.                          | Revise unpublished manifest to eleven exact keys in this planning change; this letter activates `outboundHttp` only when implemented. | M98d plan and ROADMAP.md now; docs/diagnostics-protocol.md during implementation. |

## 3. Design decisions

### 3.1 Authoritative capture seam

**Decision:** Export createObservedFetch with an explicitly injected fetch and monotonic clock.
Applications pass the returned fetch to ClientOptions.fetch or call it directly. Call the injected
fetch exactly once with unchanged input/init and return the original Response or throw the original
rejection. Record elapsed time until response headers or rejection, status class and fixed
success/failure only. Never read request URLs, headers, bodies, signals or rejection properties. No
monkey-patching global fetch. Retries appear as separate attempts; logical request counts,
redirect-hop counts and timeout attribution are explicitly unavailable. No new HTTP client plugin is
introduced.

**Why:** Counters describe executed work rather than inventing backend or cluster state. **Test
home:** owning package `test/unit/outbound-http-observations.test.ts`.

### 3.2 Source ownership and registration

No new capability token. Add
`DiagnosticsPluginOptions.outboundHttpSources?: readonly IOutboundHttpDiagnosticsSource[]`, at most
16 explicitly supplied sources. The application creates the helper, supplies its source to
DiagnosticsPlugin, and registers helper.close with application onClose. This avoids an SDK
dependency on kernel or diagnostic-plugin. DiagnosticsPlugin does not own or close external helpers.
A closed helper retains pass-through fetch behavior with capture disabled. SDK common-type imports
follow its existing versioned JSR convention: the implementation release must publish compatible
common contracts before the SDK, update its pinned common import, and exercise the public dependency
graph. No diagnostics-plugin import enters the SDK.

The connector admits at most 16 sources, refusing excess sources with a fixed value-free
configuration error. Duplicate non-null aliases discovered during a read yield a fixed
collection-failed response with no sources; validation does not invoke snapshot at registration.
Disabled plugin sources need no configured alias: connector assigns session-local `sourceId` values
`s1` through `s16` by registration order, while alias is null. IDs remain stable until connector
teardown. Configured aliases must be unique across this inspector. Built-in source reads perform no
application operation. Third-party source code runs with application privileges and is not sandboxed
by this interface.

### 3.3 Exact public projection and reader

Add common `IOutboundHttpDiagnosticsSource`, `OutboundHttpDiagnosticsSnapshot`,
`OutboundHttpDiagnosticsRecord`, and `OutboundHttpDiagnosticsResponse`.

`IOutboundHttpDiagnosticsSource.snapshot(): OutboundHttpDiagnosticsSnapshot` is synchronous, takes
no caller-selected resource, and returns a deeply frozen exact-key object:
`{ state: DiagnosticsInspectorState, alias: string | null, coverage: 'owned-instance', records: readonly OutboundHttpDiagnosticsRecord[], dropped: number }`.

A record has exactly `alias: string`, `operation: 'attempt'`, `count: number`,
`lastDurationMs: number | null`, `ageMs: number`, plus `responses`, `failures`, `lastStatusClass`
('1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'other' | null); HTTP errors are responses, not fetch
rejections. Numbers are finite, nonnegative and clamped at Number.MAX_SAFE_INTEGER; durations are
integer milliseconds. count counts settled observations, not currently active calls. Counters are
cumulative within the retention window. Nonapplicable numeric counters are zero. lastDurationMs is
null for instantaneous lifecycle observations; otherwise it is the last settled duration. Record
alias is exactly the configured source alias (snapshot.alias); no event/job mapping exists. On
failed collection the source clears records and exposes only state, approved alias, coverage and
dropped. Lifecycle-closed and disabled states take precedence over collection-failed. Read only
framework-owned primitive fields; never pass a business object or an Error to the collector.

`OutboundHttpDiagnosticsResponse` is exactly
`{ version: 1, instanceId: string, state: DiagnosticsInspectorState, sources: readonly { sourceId: string, snapshot: OutboundHttpDiagnosticsSnapshot }[] }`.
`IDiagnosticsClient.outboundHttp(): Promise<OutboundHttpDiagnosticsResponse>` reads only
`GET /v1/outbound-http` through the existing signed, serialized exchange. All authentication,
origin/authority, replay, expiry, revocation, instance and post-read session checks precede
returning any data; request authentication must succeed before snapshot is called. Pairing sees
`outboundHttp: false` as a local typed unsupported response without a request. A supported operation
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

`createObservedFetch(options: ObservedFetchOptions): ObservedFetch` returns exactly
`{ fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>, source: IOutboundHttpDiagnosticsSource, close(): void }`.
`ObservedFetchOptions` and `ObservedFetch` are SDK exports consumed by server applications. The
fetch wrapper catches only to record a primitive failure and rethrows the identical value;
observation code cannot mask the application result. Construction is explicit opt-in; ordinary
createClient calls remain unchanged. Preserve fetch receiver by calling the injected function with
globalThis as its receiver; application methods needing another receiver must supply a bound
function. Do not wrap the delegation in an async function: an injected synchronous throw remains
synchronous after the failure counter is updated. Resolve response status inside the guarded
observation block, so a hostile custom Response cannot change the application result. `close` is
idempotent.

### 3.4 Opt-in, retention and overhead

Plugin option `diagnostics?: { enabled: true, alias: string }` is absent by default; the SDK helper
uses ObservedFetchOptions instead of a plugin option. ObservedFetchOptions contains enabled: true,
alias: string, fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>, now: () =>
number. A helper instance represents one explicitly approved call-site scope; alias is never derived
from destination.

Aliases are explicit non-secret labels, unique, 1–64 UTF-8 bytes, without controls; do not derive
aliases by truncating or hashing sensitive values. No URL mapping or dynamic alias callback is
accepted.

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

| Exported symbol                                                | Kind             | Consumer / real code path that READS it        |
| -------------------------------------------------------------- | ---------------- | ---------------------------------------------- |
| `IOutboundHttpDiagnosticsSource`                               | common interface | Owning source and connector reader.            |
| `OutboundHttpDiagnosticsSnapshot`                              | common type      | Source, exact projector and client.            |
| `OutboundHttpDiagnosticsRecord`                                | common type      | Bounded collector and devtool summary.         |
| `OutboundHttpDiagnosticsResponse`                              | common type      | Connector and native client method.            |
| `IDiagnosticsClient.outboundHttp`                              | client method    | Devtool inspector.                             |
| `createObservedFetch`, `ObservedFetch`, `ObservedFetchOptions` | SDK helper/types | Application opt-in and collector construction. |

Collectors, attachment helpers and projectors remain internal. No general observer/event-bus API.

### 4.1 Options — every option names its consumer

| Option                      | Consumer                     | Behavior (per implementation)                                |
| --------------------------- | ---------------------------- | ------------------------------------------------------------ |
| enabled / alias             | Owning collector constructor | Explicit activation and approved display name.               |
| No additional plugin labels | Construction contract        | No dynamic label extraction.                                 |
| fetch / now                 | SDK helper                   | Delegate unchanged transport and measure monotonic duration. |
| outboundHttpSources         | DiagnosticsPlugin            | Explicit maximum-16 source bridge, no auto-discovery.        |

## 5. Implementation files

| File                                                             | Purpose                                                     |
| ---------------------------------------------------------------- | ----------------------------------------------------------- |
| `packages/common/src/services/diagnostics.ts`                    | Typed contract, export, authenticated projection or reader. |
| `packages/common/src/index.ts`                                   | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/interfaces/index.ts`            | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`   | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/protocol/protocol.ts`           | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/transport/connector-handler.ts` | Typed contract, export, authenticated projection or reader. |
| `packages/diagnostics-plugin/src/client/client.ts`               | Typed contract, export, authenticated projection or reader. |
| `packages/sdk/src/http/observed-fetch.ts`                        | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/sdk/src/index.ts`                                      | Opt-in capture, source, options or lifecycle wiring.        |
| `packages/sdk/src/diagnostics/outbound-http-observations.ts`     | Opt-in capture, source, options or lifecycle wiring.        |

Also update PUBLIC_API.md, ARCHITECTURE.md, docs/diagnostics-protocol.md, package READMEs,
CHANGELOG.md, ROADMAP.md and CLAUDE.md. SDK dependency metadata changes in M98n accompany its common
contract release; no external dependency is introduced.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                  | src covered                                                      | Key assertions (and the signature each call type-checks against)                                              |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts`      | `packages/common/src/services/diagnostics.ts`                    | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                       |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts`      | `packages/common/src/index.ts`                                   | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                       |
| `packages/diagnostics-plugin/test/unit/outbound-http-observations.test.ts` | `packages/diagnostics-plugin/src/interfaces/index.ts`            | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                       |
| `packages/diagnostics-plugin/test/unit/outbound-http-observations.test.ts` | `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`   | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                       |
| `packages/diagnostics-plugin/test/unit/outbound-http-observations.test.ts` | `packages/diagnostics-plugin/src/protocol/protocol.ts`           | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                       |
| `packages/diagnostics-plugin/test/unit/outbound-http-observations.test.ts` | `packages/diagnostics-plugin/src/transport/connector-handler.ts` | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                       |
| `packages/diagnostics-plugin/test/unit/outbound-http-observations.test.ts` | `packages/diagnostics-plugin/src/client/client.ts`               | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                       |
| `packages/sdk/test/unit/outbound-http-observations.test.ts`                | `packages/sdk/src/http/observed-fetch.ts`                        | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                       |
| `packages/sdk/test/unit/outbound-http-observations.test.ts`                | `packages/sdk/src/index.ts`                                      | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                       |
| `packages/sdk/test/unit/outbound-http-observations.test.ts`                | `packages/sdk/src/diagnostics/outbound-http-observations.ts`     | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                       |
| `packages/diagnostics-plugin/test/e2e/outbound-http-observations.test.ts`  | All owning producers and connector reader                        | Real producer -> source.snapshot() -> signed socket -> client.outboundHttp(); positive controls and canaries. |

Verify exact input/init and Response identity, stream untouched, original synchronous throws and
promise rejections, abort, SDK retry count and redirects delegated unchanged. Test with real local
HTTP via SDK injected fetch; no public network test dependency.

Every mapped test calls the §3 signatures. Exercise legacy status and all eleven reserved keys,
false-key no-request, absent source, source throw, malformed source objects including throwing
getters, snapshot overrun, duplicate aliases, unpaired/replayed/expired/revoked/cross-instance
requests and refusal of mutation methods. Custom application replacements remain outside source
coverage, do not get instantiated by snapshot, and cannot be mislabeled as observed.

## 7. Verification gates

```bash
git branch --show-current   # feat/m98n-outbound-http-observations
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

Explicitly adopted server-side fetch attempts only. Browser SDK collection is not automatically sent
to the framework; unrelated fetches and third-party internal calls are invisible.

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

Plant canaries in URLs, origin/hostnames, headers, cookies, request/response bodies, signal reasons,
exception properties. Assert absence at the diagnostic collector boundary, retained records, source
reads, frames, client results and diagnostics-generated logs/errors. Existing application logging is
a separate path; do not claim this change sanitizes it. Include approved-data positive controls so
dropping all records cannot pass. Reject hostile strings and extra keys, and exercise secret-bearing
errors without reading their message/cause/stack.

Compare disabled, enabled, observer-throwing, overflowing and shutdown behavior. Test arbitrary
local probes and browser origins, credentials/replay/session lifetime, source-read order and
resource exhaustion. Review connection/frame integrity failures separately from optional collection
failure: authentication must never degrade into a usable unsigned response. The devtool separately
must pass safe rendering, secret-free logs/export and credential-storage acceptance tests.
