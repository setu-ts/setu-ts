# Milestone 98n — Outbound HTTP Attempt Observations

> **Status:** Planning. Implementation and fixes: `feat/m98n-outbound-http-observations`. The design
> security review is recorded in §10.1 (2026-09-29) and awaits maintainer approval; implementation
> does not start before that approval. No implementation or committed-tree audit is claimed.

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
| Compatibility | `packages/diagnostics-plugin/src/protocol/protocol.ts:414`           | The eleven-key manifest is IMPLEMENTED; `outboundHttp` is reserved and `false` (`:457`, `:516`).        |
| Delegation    | `packages/sdk/src/http/http-client.ts:242`                           | SDK calls `this.#fetch(url.toString(), fetchInit)`: receiver is the client, two args, string input.     |
| Default fetch | `packages/sdk/src/http/http-client.ts:126`                           | Default resolves `globalThis.fetch` at call time with the global as receiver (the M70e X11-1 fix).      |
| Clock         | `packages/sdk/src/http/timing.ts:18`                                 | `createDefaultClientTiming()` wraps `performance.now()`; detached `performance.now` throws on Deno.     |
| SDK imports   | `packages/sdk/src/http/contracts.ts:16`                              | Every SDK import of `common` is `import type` via the inline `jsr:@setu-ts/common@^0.7.0` specifier.    |
| SSE consumer  | `packages/sdk/src/realtime/sse-client.ts:99`                         | `SseClient` also accepts an injected fetch; an observed fetch there measures connect attempts only.     |
| App surface   | `packages/common/src/plugin.ts:434`                                  | `IApplication` has NO `onClose` (only `ILifecycleApi`, `:397`, reached from a plugin context).          |
| Own-data read | `packages/diagnostics-plugin/src/protocol/protocol.ts:1141`          | Shared `copyOwnData`/`copyOwnDataList` used by every inspector projector since M98e.                    |
| Route grammar | `packages/diagnostics-plugin/src/protocol/protocol.ts:96`            | Targets are exact constants per operation (`REALTIME_TARGET`); no pattern routing.                      |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                    | Resolution (picked side)                                                                                                                       | Doc deliverable (same PR)                                            |
| -- | --------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------- |
| C1 | Existing public APIs expose application operations, not this source.        | Add dedicated source contracts; retain application method signatures.                                                                          | PUBLIC_API.md, ARCHITECTURE.md, owning package README and CHANGELOG. |
| C2 | Earlier M98d reserved only five inspectors.                                 | Superseded: the eleven-key manifest shipped in M98d. This letter flips only `outboundHttp` to `true`, in the implementation PR.                | docs/diagnostics-protocol.md during implementation.                  |
| C3 | ROADMAP and §3.2 said the app registers `close` with application `onClose`. | `IApplication` has no `onClose` (§1). The application calls `observed.close()` after `app.stop()` resolves; state is bounded if it never does. | ROADMAP.md M98n bullet and the SDK README, same PR.                  |
| C4 | ROADMAP says "explicitly injected fetch and monotonic clock".               | The clock is an optional `timing` OBJECT called as a method, defaulting to `createDefaultClientTiming()` (§3.3, finding D3).                   | ROADMAP.md M98n bullet, same PR.                                     |

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
DiagnosticsPlugin, and calls `observed.close()` after `app.stop()` resolves (`IApplication` has no
`onClose`, C3). This avoids an SDK dependency on kernel or diagnostic-plugin. DiagnosticsPlugin does
not own or close external helpers. The option array is copied index by index at plugin construction,
bounded at 17 reads (the M98e bypass class); a non-object element, a 17th element, or the SAME
source object supplied twice refuses construction with a fixed value-free error that names no alias.
Construction reads no property of any source — `snapshot` is invoked only inside an authenticated
read. A closed helper retains pass-through fetch behavior with capture disabled. SDK common-type
imports follow its existing versioned JSR convention: the implementation release must publish
compatible common contracts before the SDK, update its pinned common import, and exercise the public
dependency graph. No diagnostics-plugin import enters the SDK.

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

A record has exactly `alias: string`, `operation: 'attempt'`, `started: number`, `count: number`,
`lastDurationMs: number | null`, `ageMs: number`, plus `responses`, `failures`, `lastStatusClass`
('1xx' | '2xx' | '3xx' | '4xx' | '5xx' | 'other' | null); HTTP errors are responses, not fetch
rejections. `lastStatusClass` is derived from `Number.isInteger(status)` and `100 <= status <= 599`;
everything else (a status of `0` from an opaque or opaqueredirect response, a non-integer, a value
outside the range) is `'other'`, so the wire never carries a raw status number. Numbers are finite,
nonnegative and clamped at Number.MAX_SAFE_INTEGER; durations are integer milliseconds. `started`
counts delegations begun (the M98j precedent) and `count` counts settled observations, so
`started - count` is the in-flight attempts — a hung upstream is visible rather than invisible
(finding D5). Each record carries an internal generation that expiry or a collection failure
advances; a settlement whose start belongs to an earlier generation is discarded, so `count` never
exceeds `started` and no reading moves backwards (the M98j review lesson). Counters are cumulative
within the retention window. Nonapplicable numeric counters are zero. lastDurationMs is null for
instantaneous lifecycle observations; otherwise it is the last settled duration. Record alias is
exactly the configured source alias (snapshot.alias); no event/job mapping exists. On failed
collection the source clears records and exposes only state, approved alias, coverage and dropped.
Lifecycle-closed and disabled states take precedence over collection-failed. Read only
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
createClient calls remain unchanged.

**Transparency is the controlling rule** (findings D1, D2): wrapped and unwrapped delegation must be
indistinguishable to the injected fetch and to its caller.

- The wrapper is a plain `function` (never an arrow, never `async`) that forwards its OWN receiver
  and its exact argument list: `Reflect.apply(inner, this, args)` over a rest parameter. It never
  names, reads, spreads or normalizes `input` or `init` — so an omitted `init` stays omitted and the
  SDK's receiver (the client, `http-client.ts:242`) reaches the injected fetch unchanged. The plan's
  earlier "call with `globalThis` as receiver" is withdrawn: it would silently turn a receiver-bound
  failure into a success, which is a behavior change, not transparency.
- The start reading is taken inside its own `try` BEFORE delegation; a throwing or non-finite clock
  latches `collection-failed` and delegation still happens exactly once. Observation code never sits
  between the caller and the one delegation call.
- A synchronous throw from the injected fetch is recorded as a failure and the SAME value is
  rethrown synchronously. This deliberately departs from the repository's "a `Promise`-typed
  function never throws synchronously" rule (M52b/M52c/M70j): that rule governs framework code,
  while this wrapper must not alter the behavior of application code it wraps. The JSDoc states the
  departure and its reason.
- A returned value is adopted exactly as `await` adopts it:
  `Promise.resolve(result).then(onOk,
  onErr)`, where `onOk` returns the IDENTICAL `Response` and
  `onErr` rethrows the IDENTICAL reason. The caller receives the derived promise, never a side
  branch, so an unhandled rejection is still reported to the host when the caller drops it (the M98i
  defect: a side branch marks the original handled). The derived promise adds one microtask; promise
  identity is not preserved and is not claimed.
- Inside `onOk`, `response.status` is the only property read, inside a guard; a throwing getter
  latches `collection-failed` and the Response is still returned. Nothing reads `headers`, `body`,
  `bodyUsed`, `url`, `redirected` or `type`. Inside `onErr`, the reason is never inspected.
- Every internal collector call is non-throwing, and the collector's inputs are exactly
  `(ok: boolean, statusClass, startGeneration, startReading)` — no parameter exists through which a
  URL, header, body, signal or error could arrive.

`close` is idempotent; after close the wrapper still delegates exactly as before and records
nothing. `source` is a frozen facade whose only own key is `snapshot` (the M98l finding: handing the
collector itself to the connector would let any reader forge counts or call `close`); a test pins
that single key. The returned `ObservedFetch` object is frozen.

The collector lives in `packages/sdk/src/diagnostics/`, NOT in `common` beside the M98l realtime
collector. It has one consumer, so §11.1 duplication does not arise, and keeping it in the SDK
preserves the SDK's standing property that its only in-repo import is type-level (§1, "SDK
imports"), which is what lets the SDK run in a browser with no `common` runtime code. A test asserts
every `@setu-ts/common` import under `packages/sdk/src` is `import type`.

### 3.4 Opt-in, retention and overhead

There is no plugin option: calling `createObservedFetch` IS the opt-in, and not calling it is the
disabled path (no collector, no clock read, no wrapper). `ObservedFetchOptions` is exactly
`{ alias: string, fetch: (input: RequestInfo, init?: RequestInit) => Promise<Response>, timing?: Pick<IClientTiming, 'now'> }`.
The `enabled: true` literal the other letters carry is cut: there it distinguishes a present
`diagnostics` option from an absent one, while here no absent form exists, so the field would be
read by nothing (the dead-option rule; finding D4). `timing` is an OBJECT whose `now()` is called as
a method, defaulting to `createDefaultClientTiming()` — the same shape `ClientOptions.timing` takes,
so an application passes one object to both. A bare `now: () => number` is rejected as a design: its
most natural argument, `performance.now`, throws `Illegal invocation` when detached (measured on
Deno 2.9), which would latch `collection-failed` on the first call and leave a helper that reports
nothing (the M52c detached-method class; finding D3). A helper instance represents one explicitly
approved call-site scope; alias is never derived from destination.

Options are read once at construction and copied to primitives/function references; `fetch` must be
a function and `timing.now` a function, and a refusal message is fixed and never echoes the alias
(the M98l audit-round-3 lesson). Aliases are explicit non-secret labels, 1–64 UTF-8 bytes, without
controls; do not derive aliases by truncating or hashing sensitive values. No URL mapping or dynamic
alias callback is accepted. Uniqueness across helpers is enforced by the connector at read time.

A source holds exactly ONE record (one alias, one fixed operation), so no capacity refusal exists
and `dropped` is always `0`; the shared 64-slot contract bound still applies to what the connector
accepts from any source. The collector retains two readings per call only in the call's own pending
closure (start reading and generation), which lives exactly as long as the application's own pending
fetch promise — no per-call table, so a hung upstream grows no diagnostic state. Records expire
after 60 seconds without an observation, checked during update/read; clear their counters on expiry.
age >30 seconds means stale; any fresh record means ready; no records means no-data. No background
timer and no per-request diagnostic queue. On close mark closed before clearing; late results cannot
repopulate state, and snapshot returns disabled. Each observed call retains only primitive
timing/alias state, no additional wait on external work, body copy or diagnostic I/O. Promise
observation may add a microtask; tests must preserve application ordering guarantees without
claiming identical promise identity or a literally zero-cost enabled path.

Durations use only `timing.now()` (monotonic); `Date.now()` and `runtime.now()` never appear, and
`ageMs` is measured on the same clock. Clamp negative deltas. Catch observer and clock failures (a
throw, or a non-finite reading) without changing application errors or results; latch
collection-failed and stop capture until source recreation. The SDK has no logger, so no diagnostic
error is logged at all. Benchmark disabled (unwrapped) against enabled on the same workload — a real
local HTTP server on loopback, not a no-op fake, since a no-op transport inflates the ratio (the
M98l component-level lesson); require zero extra fetch calls and no growing memory after steady
state. Target <=5% median throughput regression at 10,000 warmed operations; record five runs and
investigate failures before completion rather than claiming a universal bound.

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

| File                                                                 | Purpose                                                                                                         |
| -------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/diagnostics.ts`                        | Typed contract, export, authenticated projection or reader.                                                     |
| `packages/common/src/index.ts`                                       | Typed contract, export, authenticated projection or reader.                                                     |
| `packages/diagnostics-plugin/src/interfaces/index.ts`                | Typed contract, export, authenticated projection or reader.                                                     |
| `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`       | Typed contract, export, authenticated projection or reader.                                                     |
| `packages/diagnostics-plugin/src/protocol/protocol.ts`               | Typed contract, export, authenticated projection or reader.                                                     |
| `packages/diagnostics-plugin/src/protocol/outbound-http-protocol.ts` | Copy-once projector, exact validator and 256 KiB budget (the per-inspector file every letter since M98i ships). |
| `packages/diagnostics-plugin/src/transport/connector-handler.ts`     | Typed contract, export, authenticated projection or reader.                                                     |
| `packages/diagnostics-plugin/src/client/client.ts`                   | Typed contract, export, authenticated projection or reader.                                                     |
| `packages/sdk/src/http/observed-fetch.ts`                            | Opt-in capture, source, options or lifecycle wiring.                                                            |
| `packages/sdk/src/index.ts`                                          | Opt-in capture, source, options or lifecycle wiring.                                                            |
| `packages/sdk/src/diagnostics/outbound-http-observations.ts`         | Opt-in capture, source, options or lifecycle wiring.                                                            |

Also update PUBLIC_API.md, ARCHITECTURE.md, docs/diagnostics-protocol.md, package READMEs,
CHANGELOG.md, ROADMAP.md and CLAUDE.md. SDK dependency metadata changes in M98n accompany its common
contract release; no external dependency is introduced.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                  | src covered                                                          | Key assertions (and the signature each call type-checks against)                                                                   |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts`      | `packages/common/src/services/diagnostics.ts`                        | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                                            |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts`      | `packages/common/src/index.ts`                                       | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                                            |
| `packages/diagnostics-plugin/test/unit/outbound-http-observations.test.ts` | `packages/diagnostics-plugin/src/interfaces/index.ts`                | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                                            |
| `packages/diagnostics-plugin/test/unit/outbound-http-observations.test.ts` | `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`       | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                                            |
| `packages/diagnostics-plugin/test/unit/outbound-http-observations.test.ts` | `packages/diagnostics-plugin/src/protocol/protocol.ts`               | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                                            |
| `packages/diagnostics-plugin/test/unit/outbound-http-observations.test.ts` | `packages/diagnostics-plugin/src/protocol/outbound-http-protocol.ts` | Hostile snapshots (accessor, index getter, class instance, symbol key, Proxy, `toJSON`), bounds, duplicate alias collapse, budget. |
| `packages/diagnostics-plugin/test/unit/outbound-http-observations.test.ts` | `packages/diagnostics-plugin/src/transport/connector-handler.ts`     | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                                            |
| `packages/diagnostics-plugin/test/unit/outbound-http-observations.test.ts` | `packages/diagnostics-plugin/src/client/client.ts`                   | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                                            |
| `packages/sdk/test/unit/outbound-http-observations.test.ts`                | `packages/sdk/src/http/observed-fetch.ts`                            | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                                            |
| `packages/sdk/test/unit/outbound-http-observations.test.ts`                | `packages/sdk/src/index.ts`                                          | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                                            |
| `packages/sdk/test/unit/outbound-http-observations.test.ts`                | `packages/sdk/src/diagnostics/outbound-http-observations.ts`         | Exact contract, disabled path, failure isolation, bounds, export consumer and teardown.                                            |
| `packages/diagnostics-plugin/test/e2e/outbound-http-observations.test.ts`  | All owning producers and connector reader                            | Real producer -> source.snapshot() -> signed socket -> client.outboundHttp(); positive controls and canaries.                      |
| `packages/sdk/test/unit/observed-fetch-transparency.test.ts`               | `packages/sdk/src/http/observed-fetch.ts`                            | §10.2 A2: arity, receiver, identity, sync throw, rejection reason, unhandled rejection in a subprocess.                            |
| `packages/sdk/test/unit/type-only-common.test.ts`                          | all of `packages/sdk/src`                                            | Every `@setu-ts/common` import is `import type` (§3.3).                                                                            |

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

### 10.1 Design security review

**Recorded 2026-09-29, before implementation**, against base commit
`d6b77e4f826a27e04eb412281203cb664564628c`, checked against the §3 decisions as amended by this
review. Written by Claude in the M98n worktree at the maintainer's request. It is not the
committed-tree audit, which must run in a fresh context (§10.3). Findings D1–D9 below are resolved
as plan requirements in §2–§6; none is claimed fixed in executable code.

Reviewed: `packages/sdk/src/http/{contracts,http-client,timing}.ts`,
`packages/sdk/src/realtime/{sse-contracts,sse-client}.ts`, the SDK manifest and its type-only
`common` imports, `packages/common/src/plugin.ts` (`IApplication`), the `common` diagnostics
contracts and the M98l shared collector,
`packages/diagnostics-plugin/src/protocol/{protocol,cache-protocol}.ts` (manifest keys, exact
targets, `copyOwnData`), the connector handler's source reads and the plugin's bootstrap source
collection. Two runtime facts were measured on Deno 2.9 rather than assumed: a detached
`performance.now` throws `Illegal invocation`, and Deno's `fetch` does not enforce its receiver (an
object-held `fetch` resolves).

**Purpose it serves.** The devtool may learn HOW the application's explicitly adopted outbound HTTP
calls behave: how many attempts started, how many settled as responses and as failures, the status
CLASS of the last response, the last attempt's time to headers, and how long ago the last attempt
settled. It never learns WHERE a call went, WHAT it sent or received, WHO it was made for, or WHY it
failed.

**Reviewed flow:** application code (or the SDK client, `http-client.ts:242`) calls `observed.fetch`
→ one guarded `timing.now()` read and a `started` increment → exactly one delegation
`Reflect.apply(inner, receiver, args)` with the caller's own receiver and argument list, neither
read → a synchronous throw is recorded and rethrown, a returned value is adopted by
`Promise.resolve` → the derived promise records `(ok, statusClass, generation, start)` on
settlement, reading `response.status` alone inside a guard, and resolves with the identical
`Response` or rejects with the identical reason → the one SDK collector (one record, monotonic
readings, no per-call table) → the frozen snapshot-only `source` facade → supplied by the
application in `DiagnosticsPluginOptions.outboundHttpSources` (copied at construction, bounded, no
property read) → authenticated `GET /v1/outbound-http` behind every M98b control (exact `Host`
authority, `Origin` refusal, forwarding-header refusal, MAC over canonical fields, sequence replay
refusal, expiry and revocation, instance binding) → own-data copy of each snapshot with per-source
isolation → exact validator → fixed 256 KiB budget → signed frame → native client `outboundHttp()`
re-validates and binds the instance. Minimization happens at the capture site: the URL (and any
userinfo, query or fragment in it), the `Request` object, `init` (method, headers, body, signal,
credentials mode), the `Response` headers, cookies and body, the abort reason and every rejection
value stay in the caller's locals. No collector signature can accept any of them.

**Assets.**

| Asset                                                                  | Why it is sensitive                                                                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| Request URL: origin, hostname, path, query, fragment, userinfo         | Names internal services and tenants; query strings and userinfo routinely carry tokens and API keys. |
| Request headers and body (`Authorization`, API keys, cookies, payload) | Credentials and application data.                                                                    |
| Response headers and body (`Set-Cookie`, tokens, PII)                  | Credentials and application data returned by the upstream.                                           |
| Abort reasons and rejection values (`TypeError` text, `cause`)         | Network errors quote the URL and host; an application abort reason may carry anything.               |
| The injected `fetch` and `timing` implementations                      | Application code; observation must not change how or with what receiver they run.                    |
| Counts, status classes and times to headers                            | Low sensitivity; reveal activity volume and upstream latency, aggregated across every tenant.        |
| The session key and signed channel                                     | Owned by M98b; this letter adds a route behind it and must not weaken it.                            |

**Attackers and their reach.**

| Attacker                                                                               | Must not be able to                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An unpaired local process, or a browser tab on the host                                | Read any outbound observation, cause a source read, or obtain an unsigned response.                                                                                                                                                                                                                                                      |
| A website using DNS rebinding (hostname resolved to `127.0.0.1`; may send no `Origin`) | Read any outbound observation or cause a source read.                                                                                                                                                                                                                                                                                    |
| The paired devtool (trusted reader of the minimized DTO)                               | Obtain any asset above except counts, status classes and timings under approved aliases; learn a destination; cause any outbound request; replay or modify a call.                                                                                                                                                                       |
| A remote upstream server (untrusted network input)                                     | Put a byte it chose into a record beyond one of seven fixed status-class values; grow diagnostic state by answering slowly, never answering, redirecting or erroring; change the `Response` the application receives or the order it receives it in.                                                                                     |
| A caller whose input is attacker-influenced (a user-supplied URL, header or body)      | Have any of it read by observation code, reach the collector, or change the delegation (arguments, arity, receiver, call count).                                                                                                                                                                                                         |
| A third-party in-process plugin or an application-supplied hostile source              | Put an unvalidated field, an accessor result, a control character or an oversized list into the signed frame, or make the connector invoke its getters. It MAY blank all outbound reporting through the two deliberate whole-response collapses (a duplicate alias; an over-budget body), which answer a value-free `collection-failed`. |
| A throwing or non-finite clock, a throwing `status` getter, a throwing injected fetch  | Change the delegation count, the returned `Response` identity, the thrown or rejected value's identity, or synchrony; leak error text into a record.                                                                                                                                                                                     |

**Out of the threat model (unchanged from M98b and M98i–M98l):** a privileged local sniffer, remote
access, and shared multi-tenant production use. Application code runs with application privileges;
the injected `fetch`, `timing` and any hostile source are not sandboxed — the reader keeps their
OUTPUT out of the signed frame, it does not contain their code. Unadopted fetches (a bare
`globalThis.fetch`, a third-party SDK's internal client, `SseClient` without the wrapper) are
invisible and never labelled observed. A browser SDK instance may construct a helper, but nothing
transmits its state: the connector reads only sources handed to a `DiagnosticsPlugin` in the same
process. Existing application logging of fetch errors is a separate path this change neither alters
nor sanitizes.

**Approved budgets.** One approved alias per source and exactly one record per source, so no
capacity refusal exists and `dropped` stays `0`; the shared 64-slot and 16-source bounds still apply
to what the connector accepts. A record expires 60 s after its last settlement, checked on write and
read, never by a timer; stale beyond 30 s. Counters saturate at `Number.MAX_SAFE_INTEGER`. Per
attempt: two clock reads (start, settle), one `started` increment, one derived promise with two
settlement closures and one guarded `status` read; no queue, no I/O, no body access, no per-call
table — a hung upstream holds only the closure its own pending promise already holds. At most 16
sources; a 17th, a repeated source object or a non-object element refuses `DiagnosticsPlugin`
construction with a fixed error naming no alias. A 256 KiB response that collapses to a fixed
`collection-failed` with no sources rather than truncating. The disabled path is the absence of the
wrapper: no collector, no clock read, no extra microtask. Enabled overhead target ≤ 5 % median
throughput against a real loopback HTTP server, five warmed 10,000-attempt runs, measured during
implementation and recorded here with the harness outside the tree.

| #  | Finding                                                                                                                                                                                                                                                                                                              | Resolution (where)                                                                                                                                                                                                                                                       |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| D1 | The plan fixed the receiver to `globalThis`. The SDK calls `this.#fetch(...)` (`http-client.ts:242`), so the injected fetch's receiver is the client; rebinding changes it, and turns a receiver-bound failure into a success — observation altering application behavior, the property the audit must prove absent. | Forward the caller's own receiver and exact argument list via `Reflect.apply` over a rest parameter, in a plain non-async `function` (§3.3). Test: a `this`-recording fetch sees the identical receiver wrapped and unwrapped, through the SDK and directly.             |
| D2 | "Unchanged input/init" was underspecified: a `(input, init) => inner(input, init)` wrapper turns an omitted `init` into an explicit `undefined` and must NAME both, inviting a read.                                                                                                                                 | Rest-parameter forwarding: the wrapper never binds, reads or normalizes `input`/`init` (§3.3). Test: Proxy-wrapped input, init and headers whose every trap records access — zero traps fire in observation code; `arguments.length` is identical wrapped and unwrapped. |
| D3 | `now: () => number` invites `performance.now`, which throws when detached (measured), latching `collection-failed` on the first call — a helper that silently reports nothing (the M52c detached-method class).                                                                                                      | Optional `timing` object called as a method, default `createDefaultClientTiming()`, same shape as `ClientOptions.timing` (§3.4, C4). A non-finite reading latches `collection-failed` exactly as a throw does. Test both, plus a detached-method control.                |
| D4 | `ObservedFetchOptions.enabled: true` and §3.4's `diagnostics?: { enabled, alias }` plugin option were template carry-overs: no absent form exists (calling the helper is the opt-in), so the field would be read by nothing.                                                                                         | Cut both (§3.4, dead-option rule). Disabled = not calling `createObservedFetch`; the test asserts the unwrapped path allocates no collector.                                                                                                                             |
| D5 | `count` counted only settled attempts, so a hung upstream — the case an operator most needs — was invisible; and a counter reset by expiry while a call was in flight could let a late settlement push `count` above `started` or move a reading backwards (the M98j review defects).                                | Add `started` (the M98j precedent) and a per-record generation; a settlement from an earlier generation is discarded (§3.3). Test: an unresolved fetch shows `started - count === 1`; expiry during flight never yields `count > started`.                               |
| D6 | The plan said the application registers `close` with "application onClose"; `IApplication` has no such member (`plugin.ts:434`), so the documented lifecycle was unimplementable.                                                                                                                                    | The application calls `observed.close()` after `app.stop()`; unclosed state is one bounded record (§3.2, C3). Test: close is idempotent, a settlement after close records nothing, `snapshot()` answers `disabled`.                                                      |
| D7 | Handing the collector to `DiagnosticsPlugin` would let any `outboundHttpSources` reader forge counts or call `close` (the M98l finding).                                                                                                                                                                             | `source` is a frozen facade whose only key is `snapshot` (§3.3). Test pins the single key.                                                                                                                                                                               |
| D8 | The source list is an application-supplied array: a hostile array (index getters, a `Proxy`, a `toJSON`) or the same source twice would reach the connector unchecked, and a duplicate object would collapse every read permanently.                                                                                 | Copy index by index at construction, bounded at 17 reads, reading no property of any element; refuse a non-object, a 17th element and a repeated object with a fixed value-free error (§3.2, the M98e bypass class). Test each refusal and that no element getter runs.  |
| D9 | Putting the collector in `common` (the M98l precedent) would give the SDK its first RUNTIME import of `common`, ending its browser-portable type-only property; and a raw status number on the wire is attacker-chosen input.                                                                                        | Collector in `packages/sdk/src/diagnostics/` with a type-only-import test (§3.3); status reduced to seven fixed classes before the collector, `0` and out-of-range → `'other'` (§3.3).                                                                                   |

**Accepted residual risks** (documented, not sanitized): timing and volume of outbound calls reach
the paired devtool; an alias an application chooses badly (a hostname, a customer name) is disclosed
as written; counts aggregate every tenant; a `Response` subclass or `Proxy` returned by application
code runs its own `status` getter; the derived promise adds one microtask, so promise identity is
not preserved. No unresolved design alternative is delegated to implementation.

**Approved by:** pending — the maintainer.

### 10.2 Required implementation audit matrix — not yet executed

Use the §6 homes. Every row needs an approved-data positive control so a collector recording
nothing, or an endpoint refusing everything, fails. For every new control, disable it locally,
observe its regression test fail, and restore it. Record commands, exit statuses and observed
behavior.

| ID                              | Exercise                                                                                                                                                                                                                                                                                   | Pass condition                                                                                                                                                                                                                                                           |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| O1 — Minimization               | Canaries in URL userinfo, path, query and fragment; request and response headers (mixed-case `Authorization`, `Cookie`, `Set-Cookie`); request and response bodies; an abort reason; a rejection whose `message`/`cause`/`stack` getters record access. Through the SDK and directly.      | No canary in collector inputs, retained state, snapshot, signed frame, client DTO or any diagnostics-generated log or error; no secret-bearing getter runs. Alias, counts, status class and duration present.                                                            |
| O2 — Transparency               | Proxy-recorded `input`/`init`; `this`-recording fetch; one-argument and two-argument calls; `Request` input; omitted `init`.                                                                                                                                                               | Zero observation-code property reads on arguments; identical receiver, arity and arguments wrapped vs unwrapped; exactly one delegation per call.                                                                                                                        |
| O3 — Result fidelity            | Resolved `Response` (identity and `bodyUsed === false`, stream unlocked); rejection with an object reason; synchronous throw; non-Promise return; thenable; a `Response` whose `status` getter throws; a throwing and a `NaN` clock.                                                       | Identical `Response`, identical reason, synchronous throw stays synchronous, one delegation in every case; collection latches `collection-failed` and application results are unchanged. Unhandled-rejection reporting identical wrapped and unwrapped, in a subprocess. |
| O4 — Real traffic               | A real loopback HTTP server: 2xx, 3xx with `redirect: 'follow'` and `'manual'`, 4xx, 5xx, a connection refusal, an abort mid-headers, a never-answering server; SDK client retries, breaker open, rate-limiter wait; `SseClient` with the wrapper.                                         | Status classes and failures match; retries count as separate attempts; a breaker-refused request is not an attempt; redirects count once; the hung call shows in `started - count`; no public network is contacted.                                                      |
| O5 — Bounds and time            | Sustained attempts past `MAX_SAFE_INTEGER` via a seam; expiry at 59,999 / 60,000 ms and stale at 30,000 / 30,001 ms on a fake clock; expiry during a pending call; backward clock.                                                                                                         | Saturating counters, exact state transitions, `count <= started` always, no reading moves backwards, memory flat in steady state, no timer armed.                                                                                                                        |
| O6 — Registration and lifecycle | 0, 16 and 17 sources; repeated object; non-object element; array with index getters, `Proxy` and `toJSON`; close before, during and after a pending call; closed helper still delegating.                                                                                                  | Fixed value-free refusals naming no alias; no element property read at construction; no late revival; closed source answers `disabled`; delegation unchanged after close.                                                                                                |
| O7 — Hostile projection         | Snapshots with accessors, custom prototypes, extra keys, symbol keys, `Proxy` throws, oversized and sparse arrays, invalid enums, `NaN`/negative/fractional/unsafe numbers, `count > started`, control-character and 65-byte aliases, duplicate aliases; response over 256 KiB via a seam. | Own-data copy only; per-source value-free `collection-failed`; duplicate aliases and over-budget collapse the whole response; the client independently rejects each malformed frame.                                                                                     |
| O8 — Admission and transport    | Raw `Deno.connect` probes (never `fetch`, which strips forbidden headers): unpaired, wrong key, replay, wrong instance, `Origin`, preflight, forwarding headers, wrong and rebound `Host`, noncanonical and encoded target, query, non-GET method, body.                                   | No rejected request reaches `snapshot()`; no unsigned success; a correctly paired canonical GET succeeds.                                                                                                                                                                |
| O9 — Session and compatibility  | Revoke/expire during verify, source read and signing; tampered body/MAC/sequence; concurrent client calls; eleven-key manifest with `outboundHttp: true`, legacy three-field status, `outboundHttp: false` pairing, no sources.                                                            | Post-await gates discard data; an integrity failure is never masked by a collection failure; `false` answers a local typed unsupported with no request; no sources answers `unsupported` with `[]`; other inspectors unaffected.                                         |
| O10 — Performance and graph     | Five warmed 10,000-attempt runs, unwrapped vs wrapped, real loopback server; `deno info` of the SDK graph.                                                                                                                                                                                 | Medians recorded, zero extra fetch calls, flat memory; the SDK graph contains no runtime `@setu-ts/common` module and no `diagnostics-plugin` import.                                                                                                                    |

Runtime ledger: the SDK wrapper is runtime-agnostic and is exercised on Deno in the suite; the
connector is Deno-only (M98b). Node and Bun wrapper behavior is supported only if a real-fetch run
on each is recorded; otherwise it is listed as untested, not audited.

### 10.3 Completion gate and evidence record

Before implementation: maintainer approval of §10.1. Before completion or publication: the
independent committed-tree audit per `.roo/skills/security-audit/SKILL.md`, in a context that did
not implement or fix M98n, covering its defect classes and O1–O10. This design review does not
satisfy it. Record in the implementation PR the audited commit, reviewed files, runtime coverage,
O1–O10 results and negative controls, every finding with severity and disposition, and remaining
limitations. A fix after the audit changes the audited tree: commit it and re-audit the affected
controls. Unresolved security or correctness findings block completion. Also supply the §7 gates,
the ANSI-stripped per-file coverage table, the forbidden-construct scan and both publish-gate exit
statuses on the committed tree. The devtool separately passes its own safe-rendering,
secret-free-log/export and credential-storage acceptance tests.
