# Milestone 98n — Outbound HTTP Attempt Observations

> **Status:** Complete (PR pending). Implementation and fixes:
> `feat/m98n-outbound-http-observations`. The design security review is recorded in §10.1
> (2026-09-29) and was approved by the maintainer. The independent committed-tree security audit
> (§10.3) failed on F1, then on F2 (both Low, both fixed on the branch) and passed on `cfd20fe0`
> with no finding open; the audit record is in the PR.

## 0. Objective & scope

Provide bounded, opt-in outbound HTTP attempt observations through the authenticated local
connector.

- **In scope:** explicitly adopted server-side fetch attempts only — calls made through a fetch the
  application wrapped with `createObservedFetch`. Unrelated fetches, third-party SDKs' internal
  clients and browser instances are invisible. Owner: `packages/sdk`; `common` (contracts + one
  token) and `diagnostics-plugin` (reader, route, client method) are necessary consumers.
- **NOT this milestone:** raw-data inspection, destinations, remote access, persistent history,
  controls or replay; CLI scaffolding of the helper (§3.2 documents and tests the composition by
  hand).

Depends on the M98a/M98b boundaries and M98d's eleven-key manifest. No runtime dependency on the
other inspector providers. Each source states observed-instance coverage, never automatic visibility
into all application code.

## 1. Contracts verified from SOURCE (not names)

| Reference      | Source (file:line)                                                         | Verified surface / fact                                                                                                        |
| -------------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| Fetch seam     | `packages/sdk/src/http/contracts.ts:158`                                   | `ClientOptions.fetch?: (input: RequestInfo, init?: RequestInit) => Promise<Response>`; `timing?: IClientTiming` (`:161`).      |
| Clock          | `packages/sdk/src/http/contracts.ts:116`                                   | `IClientTiming.now()` is a monotonic method.                                                                                   |
| Delegation     | `packages/sdk/src/http/http-client.ts:242`                                 | SDK calls `this.#fetch(url.toString(), fetchInit)`: receiver is the client, two args, string input.                            |
| Default fetch  | `packages/sdk/src/http/http-client.ts:126`                                 | Default `(input, init) => globalThis.fetch(input, init)` resolves at call time with the global as receiver (M70e X11-1).       |
| Retry/breaker  | `packages/sdk/src/http/http-client.ts:197-260`                             | Each retry calls the fetch again; an open breaker and the rate limiter act before any fetch call.                              |
| Default timing | `packages/sdk/src/http/timing.ts:18`, `packages/sdk/src/index.ts:31`       | `createDefaultClientTiming()` wraps `performance.now()` and is exported. Detached `performance.now` throws on Deno (measured). |
| SDK imports    | `packages/sdk/src/http/contracts.ts:16`, `packages/sdk/deno.json`          | All four SDK imports of `common` are `import type`; the manifest pins `jsr:@setu-ts/common@0.7.0` exactly.                     |
| SSE consumer   | `packages/sdk/src/realtime/sse-client.ts:99`                               | `(opts.fetch ?? defaultFetch)(…)`: receiver `undefined`; an observed fetch there measures connect attempts only.               |
| App surface    | `packages/common/src/plugin.ts:434-491`                                    | `IApplication` has NO `onClose`; `ILifecycleApi.onClose` (`:397`) is reached from `IPluginContext.lifecycle` (`:519`).         |
| Plugin shape   | `packages/common/src/plugin.ts:560-588`                                    | `IPlugin` is an interface (`name`, `version`, optional `provides`, `register(ctx)`) — a type-only import suffices.             |
| Registry       | `packages/common/src/registry.ts:99`                                       | `register(token, service, { multi: true })`; registration after `runBootstrap()` throws.                                       |
| Tokens         | `packages/common/src/tokens.ts:22`, `:172-192`                             | `CapabilityToken = string`; the M98i/j/l diagnostics tokens are multi-provider, registered without `provides`.                 |
| Resolver       | `packages/kernel/src/registry/plugin-resolver.ts:110-131`                  | Duplicate plugin names throw; a plugin's NAME also enters the provider index, so a name must never equal a capability token.   |
| Bootstrap read | `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts:258-348`     | Sources are collected with `getAll` in `onBootstrap`; exceeding a per-inspector cap refuses startup.                           |
| Connector      | `packages/diagnostics-plugin/src/transport/connector-handler.ts:1132-1155` | Per-operation dispatch runs after every session and request check; the built response passes the shared wire validator.        |
| Manifest       | `packages/diagnostics-plugin/src/protocol/protocol.ts:414`, `:457`, `:516` | Eleven-key manifest implemented; `outboundHttp` reserved `false`.                                                              |
| Own-data read  | `packages/diagnostics-plugin/src/protocol/protocol.ts:1141`, `:1180`       | `copyOwnData`/`copyOwnDataList` read descriptors; no getter is invoked.                                                        |
| Route grammar  | `packages/diagnostics-plugin/src/protocol/protocol.ts:96`                  | Targets are exact constants per operation.                                                                                     |
| Devtool param  | `packages/cli/src/templates/project-files.ts:52`, `:423`                   | Every generated factory takes `devtool?: { plugins?, diagnostics? }` second; production entries never pass it.                 |
| Devtool entry  | `packages/cli/src/devtool/dev-entry.ts:112-120`                            | `DiagnosticsPlugin(...)` is constructed BEFORE `createApp(...)` runs, so an option on it cannot receive app-created sources.   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                  | Resolution (picked side)                                                                                                                            | Doc deliverable (same PR)                                               |
| -- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| C1 | Existing public APIs expose application operations, not this source.      | Add dedicated source contracts; retain application method signatures.                                                                               | PUBLIC_API.md, ARCHITECTURE.md, SDK and diagnostics READMEs, CHANGELOG. |
| C2 | Earlier M98d reserved only five inspectors.                               | Superseded: the eleven-key manifest shipped in M98d. This letter flips only `outboundHttp` to `true`.                                               | docs/diagnostics-protocol.md.                                           |
| C3 | ROADMAP: no new plugin, no token; the source is handed to the connector.  | The helper returns a small registration plugin (not an HTTP client plugin) and `common` gains one multi-provider token (§3.2; maintainer decision). | ROADMAP.md M98n bullets.                                                |
| C4 | ROADMAP: "explicitly injected fetch and monotonic clock".                 | `fetch` is optional (defaults to the SDK's call-time global fetch); the clock is an optional `timing` OBJECT called as a method (§3.4).             | ROADMAP.md M98n bullet.                                                 |
| C5 | ROADMAP: "applications … register helper.close with application onClose". | `IApplication` has no `onClose`; the returned plugin registers the close through its own `ctx.lifecycle.onClose` (§3.2).                            | ROADMAP.md M98n bullet.                                                 |

## 3. Design decisions

### 3.1 Authoritative capture seam

**Decision:** export `createObservedFetch`. It wraps one fetch, and the application passes the
returned `fetch` to `ClientOptions.fetch`, `SseClientOptions.fetch`, or calls it directly. The
wrapper calls the wrapped fetch exactly once with the caller's own arguments, returns the identical
value or rethrows the identical value, and records only: that an attempt started, whether it settled
as a response or a failure, the response's status class, and the time from start to settlement
(headers, not body). It never reads the request URL, headers, body or signal, the response's headers
or body, or any rejection property. No global fetch is patched. Retries appear as separate attempts;
logical request counts, redirect-hop counts and timeout attribution are explicitly unavailable.

**Why:** counters describe executed work; nothing about a destination or payload is captured. **Test
home:** `packages/sdk/test/unit/outbound-http-observations.test.ts` and
`observed-fetch-transparency.test.ts`.

**Counting table (fixed before implementation).**

| Event                                                              | `started` | `count` | `responses` | `failures` | `lastStatusClass` | `lastDurationMs` |
| ------------------------------------------------------------------ | --------- | ------- | ----------- | ---------- | ----------------- | ---------------- |
| Delegation begins                                                  | +1        | —       | —           | —          | —                 | —                |
| Wrapped fetch throws synchronously                                 | —         | +1      | —           | +1         | unchanged         | elapsed (≈0)     |
| Promise resolves with a value whose `status` is readable           | —         | +1      | +1          | —          | class of status   | elapsed          |
| Promise resolves; `status` getter throws or value is not an object | —         | +1      | +1          | —          | `'other'`         | elapsed          |
| Promise rejects (network error, abort, any reason)                 | —         | +1      | —           | +1         | unchanged         | elapsed          |
| Adopting the value throws (e.g. a promise's `constructor` getter)  | —         | +1      | —           | +1         | unchanged         | elapsed (≈0)     |
| Settlement from an earlier generation (§3.4)                       | —         | —       | —           | —          | —                 | —                |

An HTTP error status is a response, not a failure. `responses + failures === count` and
`count <= started` always hold. The status class is `'2xx'`–`'5xx'` for an integer in `200..599` and
`'other'` for everything else (a `0` opaque/opaqueredirect status, a `1xx` a fetch never exposes, a
non-integer, an out-of-range value), so the wire never carries a raw status number.

### 3.2 Source ownership and registration (maintainer decision, 2026-09-29)

`createObservedFetch` returns `{ fetch, plugin }`. `plugin` is an `IPlugin` (type-only import from
`common`) whose `register(ctx)` does exactly two things: registers the helper's frozen snapshot-only
source under the new multi-provider `CAPABILITIES.OUTBOUND_HTTP_DIAGNOSTICS` (value
`'outbound-http-diagnostics'`) with `{ multi: true }` and no `provides` (the M98i/j/l precedent),
and registers the helper's internal close with `ctx.lifecycle.onClose`. It has no dependencies and
no routes. `DiagnosticsPlugin` collects every source with `getAll` in `onBootstrap`, exactly as for
the other inspectors; more than 16 refuses startup with a fixed error. The earlier
`DiagnosticsPluginOptions.outboundHttpSources` option is CUT: the CLI-generated devtool entry builds
`DiagnosticsPlugin` before `createApp` runs (§1), so an option could only be fed by a module-level
holder — the M70d defect class — and would keep capture running in production.

- **Token value in the SDK.** The SDK writes the literal `'outbound-http-diagnostics'` rather than
  importing `CAPABILITIES`, so its only `common` imports stay type-only (§3.3). A test in
  `packages/sdk/test` imports `CAPABILITIES` from `common` and asserts equality, so the two cannot
  drift. `common` declares the token with JSDoc naming the SDK helper as its producer.
- **Plugin name.** `outbound-http-diagnostics-<hex>`, where `<hex>` is 16 bytes from
  `crypto.getRandomValues`, hex-encoded, drawn once per helper. A module-level counter was rejected:
  two SDK copies in one process would each start at 1 and collide at `start()` (probed, round 2 N1).
  `crypto.randomUUID()` was rejected too (round 3 L1): browsers expose it only in secure contexts,
  so a plain-`http` intranet page would throw at construction, while `getRandomValues` is available
  in insecure contexts, Deno, Bun, workerd and Node ≥ 19. Where the global is absent, construction
  refuses with a fixed error naming the requirement; the SDK README states the Node ≥ 19 floor for
  this helper (Node 18 is past end of life, and unverified here). The name is nondeterministic, is
  never logged as meaningful, never equals a capability token and never contains the alias; tests
  match `/^outbound-http-diagnostics-[0-9a-f]{32}$/`.
- **One application per helper.** The helper remembers the first `ctx.app` it registered with.
  `register(ctx)` refuses, with a fixed error, a DIFFERENT application; otherwise one application's
  `stop()` would close the source another still reads (round 2 N5). The SAME application may
  register again after its own failed `start()` — the kernel rolls back and runs `runClose()`, and
  re-registration reopens the collector rather than refusing (round 3 M1). **Correction (code
  review, 2026-09-29):** the second `start()` the kernel comment calls its recovery does not work
  for any real application — `RuntimePlugin` re-registers `runtime` and the retry throws
  `Capability 'runtime' is already registered` (reproduced identically on `main`, a pre-existing
  kernel defect outside this letter), and an application cannot be started again after a normal
  `stop()` at all (`#started` stays set). The reopen branch is therefore tolerance, not a working
  recovery, and the docs say so. Registering the same plugin object twice in ONE application is
  refused by the kernel's duplicate-name check. A test that reuses one module-level helper across
  applications is refused by design; the README says to build the helper inside the factory.
- **`version`.** A string literal equal to the SDK's own `deno.json` version, pinned by a test that
  reads the manifest. A static JSON import was rejected: it would be the browser-portable SDK's
  first import attribute (Node ≥ 20.10, attribute-aware bundlers, no older Safari) and bundle the
  whole manifest (round 2 N3). The literal is a release bump site; `docs/releasing.md` gains it.
- **Lifecycle.** `onClose` marks the collector closed before clearing (late settlements record
  nothing; `snapshot()` answers `disabled`); the wrapper keeps delegating unchanged. The kernel runs
  every `onClose` hook, including after a failed `start()` (M86). If startup fails before the plugin
  registers, nothing was attached and nothing needs releasing: the collector holds no timer, socket
  or listener. A helper whose plugin is never registered keeps one bounded record that nothing
  reads.
- **Production exposure.** The documented and tested composition constructs the helper only when the
  factory's `devtool` parameter is present, so a production entry (which never passes one) builds no
  wrapper, no collector and no plugin:

  ```ts
  import type { IPlugin } from '@setu-ts/common';
  import type { KernelDiagnosticsOptions } from '@setu-ts/kernel';
  import { createApplication } from '@setu-ts/kernel';
  import { RuntimePlugin } from '@setu-ts/runtime';
  import { createClient, createObservedFetch } from '@setu-ts/sdk';

  const PAYMENTS_URL = 'https://payments.internal.example';

  export function createApp(
    _env?: Readonly<Record<string, unknown>>,
    devtool?: { plugins?: readonly IPlugin[]; diagnostics?: KernelDiagnosticsOptions },
  ) {
    const observed = devtool ? createObservedFetch({ alias: 'payments-api' }) : undefined;
    const payments = createClient({
      baseUrl: PAYMENTS_URL,
      ...(observed ? { fetch: observed.fetch } : {}),
    });
    void payments; // routes use `payments`; a bare unused local fails TS6133
    return createApplication({
      plugins: [
        RuntimePlugin(),
        ...(observed ? [observed.plugin] : []),
        ...(devtool?.plugins ?? []),
      ],
      ...(devtool?.diagnostics !== undefined ? { diagnostics: devtool.diagnostics } : {}),
    });
  }
  ```

  The parameter types are the ones `packages/cli/src/templates/project-files.ts:52` emits; the first
  parameter is NOT read, because `setu commands` passes an inert proxy and the dev entry passes
  `undefined` (`dev-entry.ts:118`). The same example ships in the SDK README and is compiled by
  `test/package-readme-fence-compiler.test.ts` (the M70i fence class; round 2 N2).
  Pre-implementation evidence (2026-09-29): this example, with `createObservedFetch` stubbed to the
  §3.3 signature, passes `deno check` against the workspace's real `common`/`kernel`/`runtime`/`sdk`
  types (exit 0); the negative control reading `_env.PAYMENTS_URL` fails with `TS18048`, and the
  earlier draft's unused `payments` local failed `TS6133`, so the check discriminates.

  An application may construct the helper unconditionally; that is its choice and costs one bounded
  record. The README says so. No CLI template change is made in this letter.

Duplicate non-null aliases discovered during a read yield a fixed `collection-failed` response with
no sources. The connector assigns session-local `sourceId` values `s1`–`s16` by registration order,
stable until connector teardown. A third-party plugin may register its own source under the token;
its code runs with application privileges and is not sandboxed — the reader only keeps its output
out of the signed frame.

### 3.3 Exact public projection and reader

`common` adds `IOutboundHttpDiagnosticsSource`, `OutboundHttpDiagnosticsSnapshot`,
`OutboundHttpDiagnosticsRecord`, `OutboundHttpDiagnosticsResponse`, `OutboundHttpStatusClass` and
the token.

`IOutboundHttpDiagnosticsSource.snapshot(): OutboundHttpDiagnosticsSnapshot` is synchronous, takes
no caller-selected resource, and returns a deeply frozen exact-key object
`{ state: DiagnosticsInspectorState, alias: string | null, coverage: 'owned-instance', records: readonly OutboundHttpDiagnosticsRecord[] }`.
`dropped` is deliberately absent: a source holds one record, so it would always be `0` (dead
surface).

A record has exactly `alias: string`, `operation: 'attempt'`, `started`, `count`, `responses`,
`failures` (numbers), `lastStatusClass: '2xx' | '3xx' | '4xx' | '5xx' | 'other' | null`,
`lastDurationMs: number | null`, `ageMs: number`. `lastStatusClass` is `null` until a response
settles; `lastDurationMs` is `null` until any attempt settles; `ageMs` is time since the record's
last activity (start or settlement). Numbers are finite, nonnegative integers clamped at
`Number.MAX_SAFE_INTEGER`; durations are integer milliseconds.

**Snapshot invariants** (enforced by the collector, checked by the connector's validator and again
by the client): at most ONE record; `record.alias === snapshot.alias`; `operation === 'attempt'`;
`responses + failures === count`; `count <= started`; `lastStatusClass === null` iff
`responses === 0`; `lastDurationMs === null` iff `count === 0`. State rules: `disabled` (closed
helper) and `collection-failed` carry `records: []`; `disabled` has `alias: null`; `ready` and
`stale` carry exactly one record; `no-data` carries `records: []`; a source may never report
`unsupported` (connector-side only). `coverage` is always `'owned-instance'`.

`OutboundHttpDiagnosticsResponse` is exactly
`{ version: 1, instanceId: string, state: DiagnosticsInspectorState, sources: readonly { sourceId: string, snapshot: OutboundHttpDiagnosticsSnapshot }[] }`.
`IDiagnosticsClient.outboundHttp(): Promise<OutboundHttpDiagnosticsResponse>` reads only
`GET /v1/outbound-http` through the existing signed, serialized exchange; every authentication,
origin/authority, replay, expiry, revocation, instance and post-read session check precedes any
source read. Pairing that sees `outboundHttp: false` answers a local typed `unsupported` with no
request. A supported operation with no sources answers `unsupported` and `[]`. A source whose read
throws or fails validation becomes a fixed `collection-failed` snapshot with no records and no error
text. Response state is `ready` if any source is ready, otherwise `collection-failed`, `stale`,
`no-data`, `disabled`, in that priority; individual states remain visible.

The projector (`outbound-http-protocol.ts`) copies each snapshot once through
`copyOwnData`/`copyOwnDataList` — own data properties only, plain prototype, exact keys, no getter
invoked, `Proxy` trap failures caught — and copies approved primitives individually. The full
response is limited to 256 KiB; over budget answers a fixed `collection-failed` with no sources,
never a partial document. The client runs the SAME validator.

**Transparency is the controlling rule** — wrapped and unwrapped delegation must be
indistinguishable to the wrapped fetch and to its caller, on every supported runtime.

- `fetch` is defined with METHOD shorthand (never an arrow, never `async`, never a `function`
  declaration) over a rest parameter: it has a dynamic `this` and is not constructible, so
  `new observed.fetch()` throws as `new fetch()` does. Its `name` is `'fetch'` and its `length` is
  `0` where the platform `fetch.length` is `1` — the one documented difference (round 2 N7, round 3
  L2). It forwards the exact argument list with `Reflect.apply(inner, receiver, args)` and never
  names, reads, spreads or normalizes `input` or `init`, so an omitted `init` stays omitted.
- `receiver` is the caller's own `this`, EXCEPT when `this` is the `ObservedFetch` object itself, in
  which case it is `undefined`. The SDK calls `this.#fetch(...)` with the client as receiver
  (`http-client.ts:242`), and that receiver is forwarded unchanged; but a direct
  `observed.fetch(url)` would otherwise hand the helper object — and so `plugin` — to the wrapped
  fetch, and the platform `fetch` throws `Illegal invocation` on workerd with that receiver (probed)
  where the unwrapped `fetch(url)` works. Deno, Node and Bun ignore the receiver (probed). The
  README states that a wrapped fetch should not depend on its receiver and recommends
  `(input, init) => fetch(input, init)`.
- When `fetch` is omitted, the wrapped function is the SDK's existing call-time global default
  (`http-client.ts:126`), extracted to one internal `createDefaultFetch()` seam that both
  `HttpClient` and the helper call — one implementation, and it ignores its receiver.
- The start reading is taken inside its own `try` BEFORE delegation; a throwing or non-finite clock
  latches `collection-failed` and delegation still happens exactly once. No observation code sits
  between the caller and the delegation call.
- A synchronous throw from the wrapped fetch is recorded and the SAME value is rethrown
  synchronously. This deliberately departs from the repository's "a `Promise`-typed function never
  throws synchronously" rule (M52b/M52c/M70j): that rule governs framework code, while this wrapper
  must not change the behavior of the application code it wraps. The JSDoc states the departure.
- A returned value is adopted BY `await`, inside an async function the caller receives
  (`value = await result`, settle, return it; `catch` settles and rethrows) — so it returns the
  IDENTICAL value and rethrows the IDENTICAL reason, reads a native promise's `constructor` exactly
  once, performs no species lookup and never calls an own `then`. (Audit F1/F2, 2026-09-29: an
  earlier `Promise.resolve(result).then(onOk, onErr)` read `constructor` twice and called an own
  `then`, so a hostile promise could make the wrapper throw synchronously where `await` resolves,
  leaving a permanently in-flight attempt.) The caller gets the derived promise, never a side
  branch, so a dropped rejection is still reported exactly once (probed; the M98i defect was a side
  branch marking the original handled). One added microtask; promise identity is not preserved and
  not claimed. A thenable's `then` is application code and runs in the same job order `await` would
  give it.
- On success, `status` is the only property read, inside a guard (side-effect-free on a real
  `Response`, probed). Nothing reads `headers`, `body`, `bodyUsed`, `url`, `redirected` or `type`.
  On failure, the reason is never inspected. **Measured during implementation:** against the
  unwrapped baseline, the only extra reads on a resolved value are `status` and one `then` — the
  derived promise resolving with the value, the same thenable check `await` performs (the one added
  resolution step above), not observation code. A throwing `status` getter or a non-object value is
  counted as a response of class `'other'` (the §3.1 counting table), not a collection failure.
- Every collector call is non-throwing, and the collector's inputs are exactly
  `(ok: boolean, statusClass, generation, startReading)` — no parameter through which a URL, header,
  body, signal or error could arrive.

The returned `ObservedFetch` and the source are frozen; the source's only own key is `snapshot` (the
M98l finding — the collector itself would let any `getAll` reader forge counts or close it). A test
pins both key sets.

**Collector placement.** The collector lives in `packages/sdk/src/diagnostics/`, NOT in `common`:
putting it in `common` would give the SDK its first runtime import of `common` and end its
type-only, browser-portable property. It is a **deliberate local copy** (the M30b `pemToDer`
precedent) of three small pieces that also exist in
`common/src/diagnostics/realtime-observations.ts` — alias validation, the saturating counter and the
freshness rule. A shared alias test table runs against both implementations so they cannot drift. A
test asserts every `@setu-ts/common` import under `packages/sdk/src` is `import type`.

### 3.4 Opt-in, retention and overhead

Calling `createObservedFetch` IS the opt-in; not calling it is the disabled path (no wrapper, no
collector, no clock read, no microtask). `ObservedFetchOptions` is exactly
`{ alias: string, fetch?: (input: RequestInfo, init?: RequestInit) => Promise<Response>, timing?: Pick<IClientTiming, 'now'> }`.
There is no `enabled` field: no absent form exists, so it would be read by nothing.

Options are read once at construction. `alias` is copied as a string; `fetch` is kept as a function
reference; `timing` is kept as the OBJECT and `now` is always called as `timing.now()` — never
copied out, which would re-create the detached-method defect the object form exists to prevent.
Construction calls `timing.now()` once and refuses with a fixed error if it throws or returns a
non-finite value, so a timing object whose `now` needs another receiver (`{ now: performance.now }`
throws on Deno and Node, works on Bun) fails loudly at construction instead of silently latching
later. Refusal messages are fixed and never echo the alias or any value (the M98l audit-round-3
lesson). Aliases are explicit non-secret labels, 1–64 UTF-8 bytes, no control characters; never
derived from a destination or by truncating or hashing a sensitive value. No URL mapping or dynamic
alias callback exists. A helper instance represents one approved call-site scope.

**Retention.** One record per source. The record's `ageMs` is time since its last start or
settlement. It expires 60 s after its last activity, checked on write and read, never by a timer —
EXCEPT that a record with attempts in flight (`started > count`) is never expired, so a hung call
stays visible indefinitely and ages into `stale` after 30 s (freshness: ≤ 30 s `ready`, > 30 s
`stale`, no record `no-data`). "Indefinitely" includes an abandoned call whose promise never
settles: it reports a permanent in-flight attempt, stale, which is the honest reading; nothing
leaks, since the closures are collected with the abandoned promise (round 2 N4). On expiry the
counters clear and the generation advances. Each attempt captures its start reading and generation
in the closures its own derived promise already needs; a settlement whose generation is older than
the record's is discarded, so no reading moves backwards and `count <= started` survives expiry and
failure latches. Diagnostic memory is one record per helper plus, per pending attempt, the derived
promise and its two reactions — O(pending attempts), released when the attempt settles; there is no
per-call table and no queue.

Durations use only `timing.now()` (monotonic); `Date.now()` never appears and `ageMs` uses the same
clock. Negative deltas clamp to 0. A throwing or non-finite reading after construction, or a
collector fault, latches `collection-failed` (records cleared) until the helper is recreated; the
application's results are unchanged. The SDK has no logger, so no diagnostic error is logged.

**Overhead.** Benchmark unwrapped against wrapped against a real loopback HTTP server (not a no-op
fake, which inflates the ratio — M98l). Target ≤ 5 % median throughput regression at 10,000 warmed
attempts, five runs, zero extra fetch calls, flat memory after steady state; investigate a miss
before completion rather than claiming a universal bound. Harness outside the tree.

### 3.5 Scope and isolation

Local pairing authorizes the configured application instance, not a per-tenant login. Counts may
aggregate tenants in that development instance. Do not advertise tenant isolation from aliases. Only
enable on an approved development dataset; shared multi-tenant production use is unsupported. No
tenant selectors, per-user identifiers, destinations, resource lookups or controls are added.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                               | Kind             | Consumer / real code path that READS it                                  |
| --------------------------------------------------------------------------------------------- | ---------------- | ------------------------------------------------------------------------ |
| `CAPABILITIES.OUTBOUND_HTTP_DIAGNOSTICS`                                                      | common token     | `DiagnosticsPlugin` `getAll` at bootstrap; SDK literal pinned by a test. |
| `IOutboundHttpDiagnosticsSource`                                                              | common interface | SDK source facade; connector reader.                                     |
| `OutboundHttpDiagnosticsSnapshot`, `OutboundHttpDiagnosticsRecord`, `OutboundHttpStatusClass` | common types     | SDK collector, projector, client validator.                              |
| `OutboundHttpDiagnosticsResponse`                                                             | common type      | Connector and native client method.                                      |
| `IDiagnosticsClient.outboundHttp`                                                             | client method    | Devtool inspector.                                                       |
| `createObservedFetch`, `ObservedFetch`, `ObservedFetchOptions`                                | SDK helper/types | Application opt-in (§3.2 composition).                                   |

Collector, `createDefaultFetch`, projector and validator remain internal. No general observer or
event-bus API.

### 4.1 Options — every option names its consumer

| Option   | Consumer                          | Behavior                                                                                     |
| -------- | --------------------------------- | -------------------------------------------------------------------------------------------- |
| `alias`  | Collector constructor             | Approved display label; validated at construction.                                           |
| `fetch`  | Wrapper delegation                | The function called once per attempt; defaults to the SDK's call-time global fetch.          |
| `timing` | Collector (start/settle, `ageMs`) | Monotonic clock object, called as `timing.now()`; defaults to `createDefaultClientTiming()`. |

`DiagnosticsPlugin` gains no option.

## 5. Implementation files

| File                                                                 | Purpose                                                                          |
| -------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `packages/common/src/services/diagnostics.ts`                        | Outbound HTTP source, snapshot, record, status-class and response contracts.     |
| `packages/common/src/tokens.ts`                                      | `OUTBOUND_HTTP_DIAGNOSTICS` multi-provider token with JSDoc naming its producer. |
| `packages/common/src/index.ts`                                       | Barrel exports.                                                                  |
| `packages/sdk/src/http/observed-fetch.ts`                            | `createObservedFetch`, wrapper, registration plugin.                             |
| `packages/sdk/src/http/default-fetch.ts`                             | Internal `createDefaultFetch()` shared with `HttpClient`.                        |
| `packages/sdk/src/http/http-client.ts`                               | Uses `createDefaultFetch()` (no behavior change).                                |
| `packages/sdk/src/diagnostics/outbound-http-observations.ts`         | Bounded collector, generation guard, frozen source facade.                       |
| `packages/sdk/src/index.ts`                                          | Barrel exports.                                                                  |
| `packages/sdk/deno.json`                                             | Bump the pinned `common` specifier to the release carrying the new types.        |
| `packages/diagnostics-plugin/src/plugin/diagnostics-plugin.ts`       | Collect outbound sources at bootstrap; more than 16 refuses startup.             |
| `packages/diagnostics-plugin/src/protocol/protocol.ts`               | `OUTBOUND_HTTP_TARGET`; manifest `outboundHttp: true`.                           |
| `packages/diagnostics-plugin/src/protocol/outbound-http-protocol.ts` | Copy-once projector, invariant validator, 256 KiB budget.                        |
| `packages/diagnostics-plugin/src/transport/connector-handler.ts`     | `GET /v1/outbound-http` dispatch behind the existing gates.                      |
| `packages/diagnostics-plugin/src/client/client.ts`                   | `outboundHttp()` with local unsupported and the shared validator.                |
| `packages/diagnostics-plugin/src/interfaces/index.ts`                | Client interface member.                                                         |

Also update PUBLIC_API.md, ARCHITECTURE.md, docs/diagnostics-protocol.md, the SDK and diagnostics
READMEs (the SDK README carries the compiled §3.2 example), CHANGELOG.md, docs/releasing.md (the
plugin version literal as a bump site), ROADMAP.md (C3–C5 — applied during planning, 2026-09-29) and
CLAUDE.md. No external dependency is introduced. No `docs/upgrading.md` entry is owed (code review,
2026-09-29, correcting an earlier draft): the SDK's `common` pin is internal to the published
package and moves with the release bump already in `docs/releasing.md`, so it asks nothing of an
application. The SDK's pinned `common` specifier moves with the release that publishes the new
contracts (the alpha.3 inline-specifier trap: check the SDK's inline specifiers too).

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                  | src covered                                                                                                                     | Key assertions                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/application-diagnostics-contracts.test.ts`      | `common/src/services/diagnostics.ts`, `tokens.ts`, `index.ts`                                                                   | Token value and grammar; barrel exports pinned at compile time.                                                                                                                                                                     |
| `packages/sdk/test/unit/outbound-http-observations.test.ts`                | `sdk/src/diagnostics/outbound-http-observations.ts`                                                                             | Counting table row by row; invariants; retention incl. in-flight non-expiry and generation discard; saturation; latch; close; alias table shared with `common`.                                                                     |
| `packages/sdk/test/unit/observed-fetch-transparency.test.ts`               | `sdk/src/http/observed-fetch.ts`, `default-fetch.ts`, `http-client.ts`                                                          | Proxy-recorded args (zero reads); arity; receiver forwarding and the self-receiver rule; identity; sync throw; thenable; unhandled rejection in a subprocess.                                                                       |
| `packages/sdk/test/unit/observed-fetch-plugin.test.ts`                     | `sdk/src/http/observed-fetch.ts`, `sdk/src/index.ts`                                                                            | Plugin name uniqueness across two module copies, version literal equals `deno.json`, no `provides`; second-app refusal; multi registration; `onClose`; token literal equals `CAPABILITIES`; frozen key sets; construction refusals. |
| `packages/sdk/test/unit/type-only-common.test.ts`                          | all of `packages/sdk/src`                                                                                                       | Every `@setu-ts/common` import is `import type`; no dependency edge into `common` carries runtime code (`deno info --json`).                                                                                                        |
| `packages/diagnostics-plugin/test/unit/outbound-http-observations.test.ts` | `outbound-http-protocol.ts`, `protocol.ts`, `connector-handler.ts`, `diagnostics-plugin.ts`, `client.ts`, `interfaces/index.ts` | Hostile snapshots; every invariant; budget via seam; duplicate aliases; 0/16/17 sources; manifest; local unsupported.                                                                                                               |
| `packages/diagnostics-plugin/test/e2e/outbound-http-observations.test.ts`  | all producers and the connector                                                                                                 | Real loopback HTTP server → SDK client with observed fetch → signed socket → `client.outboundHttp()`; §3.2 composition with and without `devtool`; canaries.                                                                        |

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

Read the ANSI-stripped per-file table: every changed `src` file ≥ 90 % branch/function/line. On the
committed implementation run `deno task publish:check` and `deno task release:verify <version>`.
Record both security gates (§10) before marking complete or publishing.

## 8. Risks & mitigations

- Sensitive metadata in otherwise harmless counters: explicit approved aliases, no destination
  capture, declared scope.
- Observation distorts semantics: the transparency rule and its tests compare results, errors,
  receivers and call counts.
- Sustained or hung traffic exhausts memory: one record per helper, O(pending) closures only, 16
  sources, saturating counters, wire cap.
- Partial instrumentation looks complete: `owned-instance` coverage and explicit exclusions.
- Capture left on in production: the documented composition gates on the `devtool` parameter.

## 9. Out of scope

Explicitly adopted server-side fetch attempts only. Browser SDK collection is not sent to the
framework; unrelated fetches and third-party internal calls are invisible. No destinations,
persistent history, raw payloads, admin controls, replay, remote transport, CLI scaffolding or
billing integration.

## 10. Required security reviews and acceptance evidence

### 10.1 Design security review

**Recorded 2026-09-29, before implementation**, against base commit
`d6b77e4f826a27e04eb412281203cb664564628c`. Written by Claude in the M98n worktree at the
maintainer's request, then reviewed by an independent agent that did not write it (probes on Deno,
Node 24, Bun and real workerd); its findings R1–R14 (round 1), N1–N7 (round 2) and M1, L1–L3
(round 3) are resolved below and in §2–§6. It is not the committed-tree audit (§10.3). Nothing here
is claimed fixed in executable code.

**Purpose it serves.** The devtool may learn HOW the application's explicitly adopted outbound calls
behave: attempts started and in flight, responses and failures, the last response's status class,
the last time to headers, and how long ago the helper was last active. It never learns WHERE a call
went, WHAT it sent or received, WHO it was for, or WHY it failed.

**Reviewed flow:** application code or the SDK client calls `observed.fetch` → a guarded
`timing.now()` read and `started`+1 → exactly one `Reflect.apply(inner, receiver, args)` with the
caller's arguments unread and the §3.3 receiver rule → a synchronous throw recorded and rethrown, a
returned value adopted by `await` inside the returned async function → the derived promise records
`(ok, statusClass, generation, start)` on settlement, reading only `status`, and settles with the
identical value or reason → the one SDK collector (one record, monotonic, generation-guarded) → the
frozen snapshot-only source, registered by `observed.plugin` under
`CAPABILITIES.OUTBOUND_HTTP_DIAGNOSTICS` with `{ multi: true }` → `DiagnosticsPlugin` collects
sources at `onBootstrap` (more than 16 refuses startup) → authenticated `GET /v1/outbound-http`
behind every M98b control (exact `Host` authority, `Origin` refusal, forwarding-header refusal, MAC
over canonical fields, sequence replay refusal, expiry and revocation, instance binding) → own-data
copy per source with isolation → invariant validator → 256 KiB budget → signed frame →
`client.outboundHttp()` re-validates and binds the instance. Minimization happens at the capture
site: the URL (userinfo, query, fragment), the `Request`, `init` (method, headers, body, signal,
credentials), response headers, cookies, `url`, `Location` and body, abort reasons and rejection
values stay in the caller's locals. No collector signature can accept any of them.

**Assets.**

| Asset                                                                  | Why it is sensitive                                                                                    |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Request URL: origin, hostname, path, query, fragment, userinfo         | Names internal services and tenants; queries and userinfo routinely carry tokens and API keys.         |
| Request headers and body (`Authorization`, API keys, cookies, payload) | Credentials and application data.                                                                      |
| Response headers, `url`, `Location` on a manual redirect, and body     | Credentials (`Set-Cookie`), internal hostnames, application data.                                      |
| Abort reasons and rejection values (`TypeError` text, `cause`)         | Network errors quote the URL and host; an application abort reason may carry anything.                 |
| The wrapped `fetch`, `timing` and the helper's own `plugin`            | Application code and a registration handle; observation must not change how they run or leak `plugin`. |
| The alias                                                              | Disclosed to the devtool as written; a badly chosen alias could name a customer or host.               |
| Counts, status classes, durations                                      | Low sensitivity; reveal activity volume and upstream latency, aggregated across every tenant.          |
| The session key and signed channel                                     | Owned by M98b; this letter adds a route behind it and must not weaken it.                              |

**Attackers and their reach.**

| Attacker                                                                               | Must not be able to                                                                                                                                                                                                                                                                                                                      |
| -------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| An unpaired local process, or a browser tab on the host                                | Read any outbound observation, cause a source read, or obtain an unsigned response.                                                                                                                                                                                                                                                      |
| A website using DNS rebinding (hostname resolved to `127.0.0.1`; may send no `Origin`) | Read any outbound observation or cause a source read.                                                                                                                                                                                                                                                                                    |
| The paired devtool (trusted reader of the minimized DTO)                               | Obtain any asset above except counts, status classes, durations and approved aliases; learn a destination; cause, replay or modify any request.                                                                                                                                                                                          |
| A remote upstream server (untrusted network input)                                     | Put anything into a record beyond one of five fixed status classes and a duration; grow diagnostic state beyond O(pending) by answering slowly, never answering, redirecting or erroring; change the `Response` the application receives or its order.                                                                                   |
| A caller whose input is attacker-influenced (user-supplied URL, header, body)          | Have any of it read by observation code or reach the collector; change the delegation's arguments, arity, receiver or call count.                                                                                                                                                                                                        |
| A third-party in-process plugin registering a hostile source under the token           | Put an unvalidated field, accessor result, control character, invariant-violating record or oversized list into the signed frame, or make the connector invoke its getters. It MAY blank all outbound reporting through the two deliberate collapses (duplicate alias; over-budget body), which answer a value-free `collection-failed`. |
| A throwing or non-finite clock, a throwing `status` getter, a throwing wrapped fetch   | Change the delegation count, the returned or thrown value's identity, or synchrony; leak error text into a record.                                                                                                                                                                                                                       |

**Out of the threat model (unchanged from M98b and M98i–M98l):** a privileged local sniffer, remote
access, and shared multi-tenant production use. Application code runs with application privileges;
the wrapped fetch, timing, thenables and hostile sources are not sandboxed — the reader keeps their
OUTPUT out of the signed frame. Unadopted fetches are invisible and never labelled observed. A
browser instance of the helper has no path to a connector: the connector reads only sources
registered in its own process. Outbound volume and latency reach the paired devtool by design.
Existing application logging of fetch errors is a separate path this change neither alters nor
sanitizes.

**Approved budgets.** One record per source; at most 16 sources per application (a 17th refuses
startup with a fixed error). Record expiry 60 s after last activity, never while attempts are in
flight; `stale` beyond 30 s; checked on write and read, never by a timer. Counters saturate at
`Number.MAX_SAFE_INTEGER`. Per attempt: two clock reads, one derived promise with two reactions, one
guarded `status` read; no queue, no I/O, no body access, no per-call table — O(pending attempts),
released on settlement. Response ≤ 256 KiB, else a fixed `collection-failed`. The disabled path is
the absence of the helper. Enabled overhead target ≤ 5 % median (§3.4).

**Round-0 findings (author, before the independent review).**

| #  | Finding                                                                                                                                                    | Resolution                                                                                             |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| D1 | Fixing the receiver to `globalThis` changes the SDK's call (`http-client.ts:242`, receiver = client) and can turn a receiver-bound failure into a success. | Forward the caller's receiver, refined by R1 (§3.3).                                                   |
| D2 | A `(input, init) => inner(input, init)` wrapper names both arguments and turns an omitted `init` into an explicit `undefined`.                             | Rest-parameter forwarding, arguments never read (§3.3).                                                |
| D3 | `now: () => number` invites detached `performance.now`, which throws (measured), latching `collection-failed` silently.                                    | `timing` object called as a method; refined by R4 (§3.4).                                              |
| D4 | `enabled: true` and a plugin `diagnostics` option were template carry-overs read by nothing.                                                               | Cut (§3.4, §4.1).                                                                                      |
| D5 | Counting only settled attempts hides a hung upstream; expiry during flight could push `count` above `started`.                                             | `started` counter plus generation guard; refined by R3 (§3.1, §3.4).                                   |
| D6 | "Register close with application onClose" was unimplementable — `IApplication` has no `onClose`.                                                           | Superseded by R2: the helper's plugin registers `onClose` (§3.2, C5).                                  |
| D7 | Handing the collector to the connector lets any reader forge counts or close it.                                                                           | Frozen snapshot-only source facade (§3.3).                                                             |
| D8 | An application-supplied source array could be hostile or repeat an object.                                                                                 | Superseded by R2: sources arrive through the kernel registry; the option is cut.                       |
| D9 | A `common`-resident collector ends the SDK's type-only import property; a raw status number is attacker-chosen.                                            | Collector in the SDK as a declared local copy (R7); status reduced to five fixed classes (§3.1, §3.3). |

**Independent review findings (round 1) and resolutions.**

| #   | Sev    | Finding                                                                                                                                                                                                                  | Resolution                                                                                                                                                                                          |
| --- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | High   | Forwarding `this` hands the helper object to the wrapped fetch on a direct `observed.fetch(url)` call; on workerd the platform `fetch` then throws `Illegal invocation` (probed) while the unwrapped `fetch(url)` works. | Forward `undefined` when `this` is the `ObservedFetch` object, the SDK client's receiver otherwise; an omitted `fetch` uses a receiver-agnostic default; workerd rows in O2/O4 (§3.3).              |
| R2  | High   | `DiagnosticsPlugin` is built before `createApp` in the generated devtool entry (`dev-entry.ts:112-120`), so a sources option forces a module-level holder and keeps capture on in production.                            | Maintainer decision: the helper returns a registration plugin; a new multi-provider token is read at bootstrap; the composition gates on the `devtool` parameter, documented and e2e-tested (§3.2). |
| R3  | Medium | Two expiry rules; `ageMs` undefined while only in flight; a call hung longer than 60 s vanished on expiry.                                                                                                               | One rule: 60 s after last start or settlement, never while in flight; `ageMs` from last activity (§3.4); O5 rows.                                                                                   |
| R4  | Medium | "Copied to function references" contradicts calling `timing.now()` as a method; `{ now: performance.now }` still throws.                                                                                                 | Keep the object, never copy the method; probe once at construction and refuse loudly (§3.4); O3 row.                                                                                                |
| R5  | Medium | Validator invariants were unspecified; the "64-slot bound" would admit 64 records.                                                                                                                                       | Invariants and state rules written out (§3.3); each is an O7 row.                                                                                                                                   |
| R6  | Medium | O10 as written fails for the wrong reason: the SDK graph already lists `common` modules via type edges; the exact `common` pin in `sdk/deno.json` was missing from §5.                                                   | Pass condition is "no edge into `common` carries runtime code"; `deno.json` pin in §5 and the upgrading notes.                                                                                      |
| R7  | Low    | "No §11.1 duplication" was false — alias, saturation and freshness code exists in `common`.                                                                                                                              | Declared a deliberate local copy with a shared alias test table (§3.3).                                                                                                                             |
| R8  | Low    | Template leftovers (`enabled`, `now`, "disabled plugin sources", "lifecycle observations") contradicted decisions.                                                                                                       | Removed; `alias` is `null` only when `disabled` (§3.3, §4.1).                                                                                                                                       |
| R9  | Low    | `dropped` is always `0`.                                                                                                                                                                                                 | Cut from the snapshot (§3.3).                                                                                                                                                                       |
| R10 | Low    | No counting table (synchronous throw, non-`Response` value).                                                                                                                                                             | Counting table added (§3.1).                                                                                                                                                                        |
| R11 | Low    | Three §1 citations were imprecise.                                                                                                                                                                                       | §1 rebuilt with verified locations.                                                                                                                                                                 |
| R12 | Low    | No audit rows for backpressure, failed-startup cleanup, production exposure.                                                                                                                                             | O11–O13 added (§10.2).                                                                                                                                                                              |
| R13 | Low    | "Grows no diagnostic state" overstated — each pending call holds a derived promise and two reactions.                                                                                                                    | Restated as O(pending), released on settlement (§3.4, budgets).                                                                                                                                     |
| R14 | Nit    | `'1xx'` cannot come from a real `fetch`.                                                                                                                                                                                 | Removed; any value outside `200..599` is `'other'` (§3.1).                                                                                                                                          |

**Independent review findings (round 2, at `36ad3c11`) and resolutions.** All R1–R14 resolutions
were confirmed to hold.

| #  | Sev    | Finding                                                                                                                                                     | Resolution                                                                                                         |
| -- | ------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| N1 | Medium | A module-level name counter collides across two SDK module copies (probed: both `-1`), so `start()` throws a confusing duplicate-name error.                | `crypto.randomUUID()` per helper; O6 two-copy row (§3.2).                                                          |
| N2 | Medium | The §3.2 example failed `deno check` (`env` possibly undefined), read a parameter that is an inert proxy or `undefined`, and named types that do not exist. | Rewritten with the generator's inline types and no read of the first parameter; compiled as a README fence (§3.2). |
| N3 | Low    | A static JSON import of `deno.json` would be the browser SDK's first import attribute (measured on the published CLI tarball).                              | Literal pinned by a test; a release bump site (§3.2).                                                              |
| N4 | Low    | An abandoned never-settling call pins `started > count` forever.                                                                                            | Documented as the honest reading; no leak (§3.4).                                                                  |
| N5 | Low    | One plugin in two applications is closed by the first app's `stop()`.                                                                                       | `register` refuses a second application or a closed helper (§3.2); O6 row.                                         |
| N6 | Nit    | Detached `performance.now` throws on Deno and Node but works on Bun.                                                                                        | O3 expectation per runtime.                                                                                        |
| N7 | Nit    | A `function` wrapper is constructible where `fetch` is not; `length`/`name` differ.                                                                         | Method shorthand (non-constructible, dynamic `this`); differences documented (§3.3).                               |

**Independent review findings (round 3, at `42427431`) and resolutions.** N2, N3, N4, N6 and N7 were
confirmed to hold, including probes of the method-shorthand receiver rule.

| #  | Sev    | Finding                                                                                                                                | Resolution                                                                                              |
| -- | ------ | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| M1 | Medium | A boolean "registered/closed" refusal breaks the kernel's documented retry of a failed `start()`: the retry's `register()` is refused. | Refusal keyed on `ctx.app`; the same app may re-register and reopens the collector (§3.2); O6/O12 rows. |
| L1 | Low    | `crypto.randomUUID()` throws in insecure browser contexts (and Node 18).                                                               | 16 bytes from `crypto.getRandomValues`; fixed refusal when absent; Node ≥ 19 floor documented (§3.2).   |
| L2 | Nit    | "`length` and `name` differ" was underspecified.                                                                                       | Exact: `name === 'fetch'`, `length === 0` vs native `1` (§3.3).                                         |
| L3 | Nit    | The plugin name is nondeterministic.                                                                                                   | Tests match a pattern; never logged as meaningful (§3.2).                                               |

The reviewer's confirmations are kept as evidence: the SDK call site and default fetch, the exported
default timing, the type-only imports, the SSE call's `undefined` receiver, the missing
`IApplication.onClose`, the reserved manifest key, descriptor-based `copyOwnData`, the derived
promise reporting a dropped rejection exactly once with the identical reason (and zero times when
handled), `await`-equivalent thenable ordering with one added microtask, and side-effect-free
`status` on a real `Response`.

**Accepted residual risks** (documented, not sanitized): outbound volume and latency reach the
paired devtool; a badly chosen alias is disclosed as written; counts aggregate every tenant; a
`Response` subclass or `Proxy` returned by application code runs its own `status` getter; promise
identity is not preserved; an application that constructs the helper unconditionally keeps one
bounded record in production. No unresolved design alternative is delegated to implementation.

**Approved by:** the maintainer, 2026-09-29 (the §3.2 registration design was chosen the same day).

### 10.2 Required implementation audit matrix — not yet executed

Use the §6 homes. Every row needs an approved-data positive control so a collector recording
nothing, or an endpoint refusing everything, fails. For every new control, disable it locally,
observe its test fail, and restore it. Record commands, exit statuses and observed behavior.

| ID                          | Exercise                                                                                                                                                                                                                                                                                                                                                                    | Pass condition                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| O1 — Minimization           | Canaries in URL userinfo, path, query, fragment; mixed-case `Authorization`, `Cookie`, `Set-Cookie`; request and response bodies; a manual-redirect `Location`; `response.url`; an abort reason; a rejection whose `message`/`cause`/`stack` getters record access. Through the SDK, `SseClient` and directly.                                                              | No canary in collector inputs, retained state, snapshot, signed frame, client DTO or any diagnostics-generated log or error; no secret-bearing getter runs. Alias, counts, status class and duration present.                                                                                                                                                                                                                                                                                                                       |
| O2 — Transparency           | Proxy-recorded `input`/`init`; `this`-recording fetch; one- and two-argument calls; `Request` input; omitted `init`; direct, destructured and SDK-client call sites; omitted `fetch`. On Deno and on real workerd (the `apps/cloudflare` wrangler harness).                                                                                                                 | Zero observation-code reads on arguments; arity and arguments identical wrapped vs unwrapped; receiver is the client via the SDK and `undefined` for direct and destructured calls; the platform `fetch` wrapped and called directly succeeds on workerd.                                                                                                                                                                                                                                                                           |
| O3 — Result fidelity        | Resolved `Response` (identity, `bodyUsed === false`, stream unlocked); object rejection reason; synchronous throw; non-object resolution; thenable; throwing `status` getter; throwing and `NaN` clock after construction; `{ now: performance.now }` (expected refusal per runtime: Deno and Node refuse, Bun accepts) and a throwing `now` at construction.               | Identical value and reason; a sync throw stays sync; one delegation always; post-construction faults latch `collection-failed` without changing results; construction faults refuse with a fixed error. Unhandled-rejection reporting identical wrapped vs unwrapped (subprocess).                                                                                                                                                                                                                                                  |
| O4 — Real traffic           | Real loopback HTTP server: 2xx, 3xx with `redirect: 'follow'` and `'manual'`, 4xx, 5xx, connection refused, abort mid-headers, never-answering server; SDK retries, open breaker, rate-limiter wait; `SseClient`; the core cases repeated on workerd.                                                                                                                       | Classes and failures match the counting table; retries are separate attempts; breaker-refused requests are not attempts; a followed redirect counts once; the hung call shows as `started - count`; no public network contacted.                                                                                                                                                                                                                                                                                                    |
| O5 — Bounds and time        | Saturation via seam; expiry at 59,999/60,000 ms and stale at 30,000/30,001 ms on a fake clock; a pending call across 60 s; expiry then late settlement; backward clock.                                                                                                                                                                                                     | Saturating counters; exact transitions; a record with in-flight attempts never expires; stale generations discarded; `count <= started` and `responses + failures === count` always; no reading moves backwards; no timer armed.                                                                                                                                                                                                                                                                                                    |
| O6 — Registration/lifecycle | 0, 16 and 17 helpers; two SDK module copies each creating a helper; the same plugin registered twice in one app; one helper registered in a second app, and after close; plugin name against every `CAPABILITIES` value; token literal against `CAPABILITIES`; close before, during and after a pending call; wrapper after close; the alias searched for in every refusal. | 17 refuses startup with a fixed error; two module copies boot cleanly; a double registration throws the kernel duplicate-name error; a second-app registration refuses with a fixed error; the same app re-registering after a failed `start()` (cause fixed) gets a live source; no global `crypto.getRandomValues` refuses construction with a fixed error; plugin names match the hex pattern; no name equals a token; a closed source answers `disabled`; no late revival; delegation unchanged; no refusal contains the alias. |
| O7 — Hostile projection     | Sources returning accessors, custom prototypes, extra and symbol keys, `Proxy` throws, sparse and oversized arrays, invalid enums, `NaN`/negative/fractional/unsafe numbers, each §3.3 invariant violated, `unsupported` from a source, control-character and 65-byte aliases, duplicate aliases; over 256 KiB via a seam.                                                  | Own-data copy only; per-source value-free `collection-failed`; duplicate aliases and over-budget collapse the whole response; the client independently rejects each malformed frame.                                                                                                                                                                                                                                                                                                                                                |
| O8 — Admission/transport    | Raw `Deno.connect` probes (never `fetch`, which strips forbidden headers): unpaired, wrong key, replay, wrong instance, `Origin`, preflight, forwarding headers, wrong and rebound `Host`, noncanonical and encoded target, query, non-GET, body.                                                                                                                           | No rejected request reaches `snapshot()`; no unsigned success; a correctly paired canonical GET succeeds.                                                                                                                                                                                                                                                                                                                                                                                                                           |
| O9 — Session/compatibility  | Revoke/expire during verify, source read and signing; tampered body/MAC/sequence; concurrent client calls; manifest with `outboundHttp: true`, legacy three-field status, `outboundHttp: false` pairing, no sources.                                                                                                                                                        | Post-await gates discard data; an integrity failure is never masked by a collection failure; `false` answers local `unsupported` with no request; no sources answers `unsupported` with `[]`; other inspectors unaffected.                                                                                                                                                                                                                                                                                                          |
| O10 — Performance/graph     | Five warmed 10,000-attempt runs, unwrapped vs wrapped, real loopback server; `deno info --json packages/sdk/src/index.ts`.                                                                                                                                                                                                                                                  | Medians recorded; zero extra fetch calls; flat memory; no dependency edge into `common` carries runtime code; no `diagnostics-plugin` or `kernel` import in the SDK graph.                                                                                                                                                                                                                                                                                                                                                          |
| O11 — Backpressure          | A slow consumer of the response body; many concurrent pending attempts; a slow devtool reader polling during traffic.                                                                                                                                                                                                                                                       | Capture is synchronous and unaffected by body consumption; memory O(pending) and released on settlement; reads never delay delegation.                                                                                                                                                                                                                                                                                                                                                                                              |
| O12 — Failed startup        | Startup failing before and after `observed.plugin` registers; a later plugin throwing in `register()`.                                                                                                                                                                                                                                                                      | `onClose` runs when the plugin registered; nothing to release when it did not; no timer, listener or socket left behind.                                                                                                                                                                                                                                                                                                                                                                                                            |
| O13 — Production exposure   | The §3.2 composition booted without the `devtool` parameter, and with it.                                                                                                                                                                                                                                                                                                   | Without: no helper, no plugin, no outbound source, the client uses the unwrapped fetch. With: exactly one source, observed end to end through the connector.                                                                                                                                                                                                                                                                                                                                                                        |

Runtime ledger: the wrapper is exercised on Deno (suite) and on real workerd (O2/O4). Node and Bun
wrapper behavior is supported only if a real-fetch run on each is recorded; otherwise it is listed
as untested, not audited. The connector is Deno-only (M98b).

### 10.3 Completion gate and evidence record

Before implementation: maintainer approval of §10.1 (given 2026-09-29). Before completion or
publication: the independent committed-tree audit per `.roo/skills/security-audit/SKILL.md`, in a
context that did not implement or fix M98n, covering its defect classes and O1–O13. This design
review does not satisfy it. Record in the implementation PR the audited commit, reviewed files,
runtime coverage, O1–O13 results and negative controls, every finding with severity and disposition,
and remaining limitations. A fix after the audit changes the audited tree: commit it and re-audit
the affected controls. Unresolved security or correctness findings block completion. Also supply the
§7 gates, the ANSI-stripped per-file coverage table, the forbidden-construct scan and both
publish-gate exit statuses on the committed tree. The devtool separately passes its own
safe-rendering, secret-free-log/export and credential-storage acceptance tests.
