# Milestone 20 — Health Plugin (`@hono-enterprise/health-plugin`)

> **Status:** Planning. Branch: `feat/20-health-plugin-health-checks`. `main` is protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

This milestone provides the health-check capability: a `HealthPlugin` that registers an
`IHealthService` under `CAPABILITIES.HEALTH` (`'health'`), drains the
`CAPABILITIES.HEALTH_INDICATOR` contributions that other plugins (database, cache, queue, scheduler,
…) push via `ctx.health.register(name, indicator)`, and serves three HTTP endpoints — `/health`
(overall), `/live` (liveness), and `/ready` (readiness) — returning an aggregated JSON report. The
boundary is the health aggregation and reporting layer; it does NOT own the per-backend checks,
which each capability plugin self-registers.

- **In scope:** `HealthPlugin` factory; `HealthService` implementing a new `IHealthService` contract
  added to `@hono-enterprise/common`; the three endpoints with configurable paths and status codes;
  a runtime "self" liveness indicator; an HTTP-probe indicator (outbound URL check via an injectable
  fetcher); draining `CAPABILITIES.HEALTH_INDICATOR` contributions at `onInit`; barrel exports;
  PUBLIC_API.md / ARCHITECTURE.md / ROADMAP.md doc updates; the `IHealthService` addition to
  `common` and its PUBLIC_API row.
- **NOT this milestone:** Disk and Memory resource indicators — they require a runtime
  resource-usage seam (`process.memoryUsage()` / `fs.statfs`) that does not exist in
  `IRuntimeServices`; deferred alongside the M19 metrics memory/cpu collectors, to be revisited when
  a resource seam is added (a future runtime-extension milestone). Database/Cache/Queue indicators
  are NOT built-in here — those plugins already self-register their own indicators via
  `ctx.health.register(...)` (verified in source, §1), so the health plugin only aggregates them.

## 1. Contracts verified from SOURCE (not names)

| Reference                                 | Source (file:line)                                            | Verified surface / fact                                                                                                                                                                                                                          |
| ----------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IHealthIndicator`                        | `packages/common/src/services/health.ts:44`                   | `{ readonly name: string; check(): Promise<HealthCheckResult> }` — the named-indicator contract.                                                                                                                                                 |
| `HealthCheckResult`                       | `packages/common/src/services/health.ts:13`                   | `{ readonly status: HealthStatus; readonly data?: Readonly<Record<string, unknown>> }`.                                                                                                                                                          |
| `HealthIndicatorFn`                       | `packages/common/src/services/health.ts:26`                   | `() => Promise<HealthCheckResult>` — the function form `ctx.health.register` accepts.                                                                                                                                                            |
| `HealthStatus`                            | `packages/common/src/types.ts:60`                             | `'up' \| 'down' \| 'degraded'` — the three-state union.                                                                                                                                                                                          |
| `IHealthApi.register`                     | `packages/common/src/plugin.ts:156`                           | `register(name: string, indicator: HealthIndicatorFn): void` — the plugin-context contribution surface.                                                                                                                                          |
| `ctx.health.register` impl                | `packages/kernel/src/application/application.ts:165`          | Stores `{ name, check: indicator }` under `CAPABILITIES.HEALTH_INDICATOR` with `{ multi: true }`. The drained contribution shape is `{ name: string; check: HealthIndicatorFn }`.                                                                |
| `CAPABILITIES.HEALTH`                     | `packages/common/src/tokens.ts:67`                            | `'health'` — the service-resolution token (single provider).                                                                                                                                                                                     |
| `CAPABILITIES.HEALTH_INDICATOR`           | `packages/common/src/tokens.ts:101`                           | `'health-indicator'` — the multi-provider contribution token, already defined.                                                                                                                                                                   |
| `IMetricsService` precedent               | `packages/common/src/services/metrics.ts:154`                 | M19 added the service contract to `common` and exported it from `packages/common/src/index.ts:104`. `IHealthService` follows the same precedent.                                                                                                 |
| MetricsPlugin drain pattern               | `packages/metrics-plugin/src/plugin/metrics-plugin.ts:94`     | Drains `ctx.services.getAll<…>(CAPABILITIES.METRIC_REGISTRATION)` inside `ctx.lifecycle.onInit(...)`. HealthPlugin drains `CAPABILITIES.HEALTH_INDICATOR` the same way at `onInit`.                                                              |
| `IRuntimeServices.now()`                  | `packages/common/src/runtime.ts:147`                          | `now(): number` — wall-clock ms since epoch, used for the response `timestamp`.                                                                                                                                                                  |
| `IRuntimeServices.hrtime()`               | `packages/common/src/runtime.ts:154`                          | `hrtime(): number` — monotonic ms, used to measure each indicator's latency.                                                                                                                                                                     |
| `IRuntimeServices.platform()`/`version()` | `packages/common/src/runtime.ts:112`/`118`                    | Used by the self liveness indicator's `data`.                                                                                                                                                                                                    |
| `IResponse` chain                         | `packages/common/src/http.ts:83`                              | `status(code).json(body)` and `.header(name, value)` — the endpoint response builder.                                                                                                                                                            |
| Duplicate-name / duplicate-provider rules | `packages/kernel/src/registry/plugin-resolver.ts:64`/`83`     | Duplicate plugin names throw; a capability provided by two plugins throws. `HealthPlugin` is the sole provider of `CAPABILITIES.HEALTH`; `CAPABILITIES.HEALTH_INDICATOR` is multi-provider so contributions never collide at the resolver.       |
| Database self-registers                   | `packages/database-plugin/src/plugin/database-plugin.ts:115`  | `ctx.health.register(token, async () => { … service.isHealthy() … })` — the DB plugin registers its own indicator. NOT a health-plugin built-in.                                                                                                 |
| Cache self-registers                      | `packages/cache-plugin/src/plugin/cache-plugin.ts:112`        | `ctx.health.register(token, async () => { … backend.isReady() … })`.                                                                                                                                                                             |
| Queue self-registers                      | `packages/queue-plugin/src/plugin/queue-plugin.ts:100`        | `ctx.health.register(token, service.createHealthIndicator())`.                                                                                                                                                                                   |
| Scheduler self-registers                  | `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts:76` | `ctx.health.register('scheduler', healthIndicator)`.                                                                                                                                                                                             |
| `IRuntimeServices.hostname()`             | `packages/common/src/runtime.ts:124`                          | `hostname(): string` — the host name; used by the self liveness indicator's `data`.                                                                                                                                                              |
| No runtime resource seam                  | `packages/common/src/runtime.ts:106`                          | `IRuntimeServices` has `platform/version/hostname/uuid/randomBytes/subtle/now/hrtime/timers/env/exit/fs?` — NO disk-usage or memory-usage method. Disk/Memory indicators are therefore not implementable without violating runtime independence. |
| `fetch` usage                             | `packages/runtime/test/...` only                              | `fetch` is used only in runtime tests; no production plugin calls it. It is a web standard available on Node/Deno/Bun, but to keep the abstraction discipline the HTTP indicator takes an injectable fetcher defaulting to global `fetch`.       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                 | Resolution (picked side)                                                                                                                                                                                                                                                                                                                      | Doc deliverable (same PR)                                                                                                                                                   |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `IHealthService` is referenced as a public contract in PUBLIC_API.md (`ctx.services.get<IHealthService>('health')`, line 2326) and ARCHITECTURE.md (line 1280: "Public API: `HealthPlugin()`; `IHealthService`; `IHealthIndicator`"), but it does NOT exist in `packages/common/src/services/health.ts` and is NOT listed in the PUBLIC_API.md common-exports table (line 3554 lists only `IHealthIndicator`, `HealthIndicatorFn`, `HealthCheckResult`). | Add `IHealthService` to `packages/common/src/services/health.ts`, export it from `packages/common/src/index.ts`, and add it to the PUBLIC_API.md common Health row. This matches the M19 `IMetricsService` precedent (contract lives in `common`, plugin re-exports the type).                                                                | Edit `packages/common/src/services/health.ts` + `packages/common/src/index.ts`; update PUBLIC_API.md "Health" common row and the `@hono-enterprise/health-plugin` section.  |
| C2 | ROADMAP.md M20 "Built-in Indicators: Database, Cache, Queue, Disk, Memory, HTTP" and the file list (`src/indicators/database-indicator.ts`, `cache-indicator.ts`, `queue-indicator.ts`, `disk-indicator.ts`, `memory-indicator.ts`) imply the health plugin owns DB/Cache/Queue checks. Source proves those plugins self-register their own indicators (§1), so DB/Cache/Queue indicators in the health plugin would be dead/duplicated surface.         | Do NOT ship `database-indicator.ts`/`cache-indicator.ts`/`queue-indicator.ts`. The health plugin aggregates `CAPABILITIES.HEALTH_INDICATOR` contributions; it does not re-probe other capabilities. Ship only the indicators that are genuinely the health plugin's: a runtime "self" liveness indicator and an HTTP-probe indicator.         | Update ROADMAP.md M20 file list and "Built-in Indicators" line to reflect aggregation + self/HTTP indicators; note DB/Cache/Queue are self-registered by their own plugins. |
| C3 | ROADMAP.md M20 lists `disk-indicator.ts` and `memory-indicator.ts`, but `IRuntimeServices` has no disk/memory resource seam (§1).                                                                                                                                                                                                                                                                                                                        | Defer Disk and Memory indicators — same deferral rationale as M19's memory/cpu resource collectors ("pending a runtime resource seam"). Do NOT ship stub indicators that read `process.memoryUsage()` (that is a runtime-specific API outside `packages/runtime`, forbidden by AI_GUIDELINES §4).                                             | Update ROADMAP.md M20 to mark Disk/Memory deferred with the resource-seam reason; update PUBLIC_API.md if it lists them.                                                    |
| C4 | PUBLIC_API.md M20 registration example uses `indicators: ['database', 'cache', 'queue']` (string list, line 2310), but the actual contribution mechanism is `ctx.health.register(name, fn)` pushed by each plugin — the health plugin does not instantiate indicators from string names.                                                                                                                                                                 | Replace the string-list `indicators` option with an `indicators: IHealthIndicator[]` option (named objects with `name` + `check`), matching the committed `IHealthIndicator` contract, plus the existing contribution drain. App-supplied indicators are registered directly on the service; plugin-contributed ones are drained at `onInit`. | Update PUBLIC_API.md M20 registration example to the `IHealthIndicator[]` shape.                                                                                            |

## 3. Design decisions

### 3.1 `IHealthService` contract shape

- **Decision:** Add to `packages/common/src/services/health.ts` an `IHealthService` interface with
  `registerIndicator(name: string, indicator: HealthIndicatorFn): void` and
  `check(): Promise<HealthReport>` and `checkLive(): Promise<HealthReport>` and
  `checkReady(): Promise<HealthReport>`, where `HealthReport` is a new exported type
  `{ readonly status: HealthStatus; readonly timestamp: string; readonly checks: Readonly<Record<string, Readonly<HealthCheckResult & { latencyMs?: number }>>> }`.
  The service is resolved via `ctx.services.get<IHealthService>(CAPABILITIES.HEALTH)`.
- **Why:** PUBLIC_API.md and ARCHITECTURE.md already promise `IHealthService` as the public contract
  (§2 C1); M19 set the precedent of putting the service contract in `common`. `registerIndicator`
  matches the ROADMAP example (`health.registerIndicator('external-api', fn)`). `HealthReport`
  carries the aggregated shape the endpoints serialize, matching the PUBLIC_API.md response example
  (status/timestamp/checks).
- **Test home:** `test/unit/health-service.test.ts` asserts `registerIndicator` stores and
  `check()`/`checkLive()`/`checkReady()` aggregate; `test/integration/health-integration.test.ts`
  asserts the resolved service via the kernel.

### 3.2 Liveness vs readiness vs overall aggregation

- **Decision:** Every registered indicator contributes to `/health` (overall) and `/ready`
  (readiness). `/live` (liveness) runs ONLY the built-in "self" indicator (runtime is up) and does
  NOT run contributed indicators — liveness probes must be cheap and never depend on downstream
  backends, matching Kubernetes probe semantics. `checkLive()` selects the liveness participant by
  the reserved indicator name `'self'` (the name the plugin registers the self indicator under in
  §3.6); it runs that single indicator and ignores all contributed indicators. No app-supplied or
  drained indicator may claim the reserved name `'self'` — attempting to (via `options.indicators`
  or the `onInit` drain) hits the §3.4 duplicate-name throw, since the plugin registers `'self'`
  first in `register()`. Overall status is the worst of the participating indicators: `down` beats
  `degraded` beats `up`. `/ready` is `503` when any contributed indicator is `down` or `degraded`;
  `/health` is `503` only when any participating indicator is `down` (degraded stays `200` so
  operators see detail without tripping hard alerts); `/live` is `200` while the process responds,
  `503` only if the self indicator reports `down` (which it never does unless `runtime` itself is
  unreachable — it always returns `up`).
- **Why:** Kubernetes liveness probes should not cascade-fail on a downstream outage; readiness
  probes should. The `200`-on-degraded choice for `/health` is a deliberate, documented deviation
  from a naive "non-up = 503" rule so degraded states are observable without hard restarts.
- **Test home:** `test/unit/health-service.test.ts` covers the worst-of aggregation and the
  live/ready/health participant sets; `test/integration/health-integration.test.ts` asserts the
  per-endpoint status codes (200 vs 503) for up/degraded/down indicator mixes.

### 3.3 Contribution drain timing

- **Decision:** `HealthPlugin.register` creates the `HealthService`, registers it under
  `CAPABILITIES.HEALTH`, registers the built-in self indicator, registers any `options.indicators`
  directly, and registers the three routes. It then registers an `onInit` hook that drains
  `ctx.services.getAll<{ name: string; check: HealthIndicatorFn }>(CAPABILITIES.HEALTH_INDICATOR)`
  and calls `service.registerIndicator(name, check)` for each. This mirrors the MetricsPlugin
  `onInit` drain of `METRIC_REGISTRATION` (§1).
- **Why:** Contributions arrive during other plugins' `register()` calls, which all run before
  `onInit`; draining at `onInit` guarantees every contributed indicator is present before the first
  request. App-supplied `options.indicators` are registered synchronously in `register()` so they
  are present even if a test bypasses the lifecycle.
- **Test home:** `test/unit/health-plugin.test.ts` asserts the service is registered and routes
  added; `test/integration/health-integration.test.ts` asserts a contributed indicator (via a fake
  plugin using `ctx.health.register`) appears in the drained report after `onInit`.

### 3.4 Duplicate indicator names

- **Decision:** `registerIndicator(name, fn)` throws `Error` on a duplicate name (last-wins is
  rejected) for app-supplied and drained indicators alike. The drain dedupes by name across
  contributions; if two contributions share a name, the second drained throws. This is a fail-fast
  contract: an indicator name is unique per application (matches `IHealthApi.register`'s "unique per
  application" JSDoc).
- **Why:** Silent overwrite would hide a misconfigured duplicate; the kernel's multi-provider store
  does not dedupe by the inner `name` field, so the health plugin must enforce uniqueness itself.
- **Test home:** `test/unit/health-service.test.ts` asserts `registerIndicator` throws on a
  duplicate; `test/unit/health-plugin.test.ts` asserts the drain path surfaces a duplicate as a
  thrown error during `onInit` (caught and re-thrown so startup fails loudly).

### 3.5 HTTP-probe indicator

- **Decision:** Ship `createHttpIndicator(name, { url, timeoutMs?, fetcher? })` returning an
  `IHealthIndicator` whose `check()` calls `fetcher ?? globalThis.fetch` (web standard,
  cross-runtime) with an `AbortController` timeout, returning
  `{ status: 'up', data: { statusCode, latencyMs } }` on 2xx/3xx and
  `{ status: 'down', data: { statusCode?, error } }` otherwise. The `fetcher` injection seam lets
  tests drive it without a real network and is the only place `fetch` is referenced; production
  defaults to the global. It is NOT auto-registered; apps add it via `options.indicators` or
  `service.registerIndicator`.
- **Why:** `fetch` is a web standard on Node 18+/Deno/Bun, but the framework forbids
  runtime-specific APIs outside `packages/runtime`; `fetch` is not Node-specific, yet the injectable
  seam keeps the branch testable and avoids a hard global dependency. The timeout uses
  `AbortController` (web standard) plus `runtime.setTimeout` is NOT needed because
  `AbortSignal.timeout`/`AbortController` are web standards.
- **Test home:** `test/unit/http-indicator.test.ts` drives up/down/timeout branches via an injected
  fake fetcher; one guarded test exercises the real `globalThis.fetch` against a loopback only when
  `RUN_INTEGRATION` is set (no real external dependency in the default suite).

### 3.6 Self liveness indicator

- **Decision:** A built-in indicator named `'self'` registered by the plugin, whose `check()`
  returns
  `{ status: 'up', data: { platform: runtime.platform(), version: runtime.version(), hostname: runtime.hostname() } }`.
  It is the sole participant in `/live` (§3.2). It is always registered (not configurable away)
  because liveness must have at least one participant.
- **Why:** Liveness is "the process is alive and the runtime is reachable"; the runtime metadata in
  `data` gives operators cheap diagnostics. It uses only `IRuntimeServices` methods, so it is
  runtime-independent.
- **Test home:** `test/unit/health-plugin.test.ts` asserts the self indicator is registered;
  `test/unit/health-service.test.ts` asserts `checkLive()` includes only `self`.

### 3.7 Endpoint response shape and status codes

- **Decision:** Each endpoint returns `ctx.response.status(code).json(report)` where `report` is the
  `HealthReport` from §3.1. Status codes: `/live` → `200` (self is up) always, since the process is
  responding; `/ready` → `200` when all contributed indicators are `up`, `503` when any is
  `degraded` or `down`; `/health` → `200` when no participating indicator is `down` (degraded
  allowed), `503` when any is `down`. The `timestamp` is `new Date(runtime.now()).toISOString()`
  (wall-clock from the runtime service, not `Date.now()`). Each check entry includes `latencyMs`
  measured via `runtime.hrtime()` around the indicator call.
- **Why:** Matches the PUBLIC_API.md response example shape and the CLAUDE.md clock rule (use
  `runtime.now()`/`runtime.hrtime()`, never `Date.now()` outside `packages/runtime`). The
  `new Date(ms).toISOString()` is a pure standard conversion, not a runtime API call.
- **Test home:** `test/integration/health-integration.test.ts` asserts the JSON shape field-by-field
  (status, timestamp, checks with latencyMs) and the status-code matrix.

### 3.8 Configurable endpoint paths and disabling endpoints

- **Decision:** `HealthPluginOptions.endpoints` is
  `{ health?: string; live?: string; ready?: string }` defaulting to
  `{ health: '/health', live: '/live', ready: '/ready' }`. A path set to `undefined` (or omitted
  with the key present and explicitly `undefined`) skips registering that endpoint. Because
  `exactOptionalPropertyTypes` is on, the option type uses `string | undefined` and the plugin tests
  `!== undefined` before registering.
- **Why:** Operators need to relocate or disable probes (e.g. serve only `/ready`).
  Explicit-undefined-skip avoids a dead default path.
- **Test home:** `test/unit/health-plugin.test.ts` asserts custom paths register and an `undefined`
  path skips registration.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                             | Kind       | Consumer / real code path that READS it                                                                                                                     |
| ------------------------------------------- | ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `HealthPlugin`                              | factory fn | App `app.register(HealthPlugin(...))`; registers `HealthService` under `CAPABILITIES.HEALTH`, drains contributions, adds routes.                            |
| `HealthService`                             | class      | The concrete `IHealthService` implementation; exported for direct instantiation in tests and advanced wiring; resolved by apps via the token in production. |
| `createHttpIndicator`                       | factory fn | App `options.indicators` array or `service.registerIndicator` — produces an `IHealthIndicator` for outbound HTTP probes.                                    |
| `IHealthService` (re-export from common)    | type       | Apps and other plugins: `ctx.services.get<IHealthService>(CAPABILITIES.HEALTH)`.                                                                            |
| `IHealthIndicator` (re-export from common)  | type       | App `options.indicators` array element type.                                                                                                                |
| `HealthCheckResult` (re-export from common) | type       | Indicator return type referenced by app indicator authors.                                                                                                  |
| `HealthIndicatorFn` (re-export from common) | type       | `service.registerIndicator(name, fn)` parameter type.                                                                                                       |
| `HealthStatus` (re-export from common)      | type       | Indicator author reference.                                                                                                                                 |
| `HealthReport` (re-export from common)      | type       | The aggregated report type returned by `IHealthService.check()`; consumed by the endpoint handlers and by apps calling the service directly.                |
| `HealthPluginOptions`                       | type       | The `HealthPlugin(options?)` parameter; consumed by the factory.                                                                                            |

### 4.1 Options — every option names its consumer

| Option             | Consumer                                              | Behavior (per implementation)                                                                                                                                                   |
| ------------------ | ----------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoints.health` | `HealthPlugin.register` route registration            | Path for the overall endpoint; default `'/health'`; `undefined` skips registration.                                                                                             |
| `endpoints.live`   | `HealthPlugin.register` route registration            | Path for the liveness endpoint; default `'/live'`; `undefined` skips registration.                                                                                              |
| `endpoints.ready`  | `HealthPlugin.register` route registration            | Path for the readiness endpoint; default `'/ready'`; `undefined` skips registration.                                                                                            |
| `indicators`       | `HealthPlugin.register` → `service.registerIndicator` | `IHealthIndicator[]` registered directly on the service during `register()` (before `onInit`), so app-supplied indicators are present even without the lifecycle. Default `[]`. |

## 5. Implementation files

| File                                     | Purpose                                                                                                                                                                                                                                                 |
| ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                           | Barrel: `HealthPlugin`, `HealthService`, `createHttpIndicator`, `HealthPluginOptions`, and re-exports of `IHealthService`, `IHealthIndicator`, `HealthCheckResult`, `HealthIndicatorFn`, `HealthStatus`, `HealthReport` from `@hono-enterprise/common`. |
| `src/plugin/health-plugin.ts`            | `HealthPlugin(options?)` factory: creates `HealthService`, registers under `CAPABILITIES.HEALTH`, registers the self indicator, registers `options.indicators`, registers the three routes, drains `CAPABILITIES.HEALTH_INDICATOR` at `onInit`.         |
| `src/services/health-service.ts`         | `HealthService` implementing `IHealthService`: indicator registry, `registerIndicator` (duplicate-throws), `check`/`checkLive`/`checkReady` aggregation with worst-of status and `latencyMs` via `runtime.hrtime()`.                                    |
| `src/indicators/self-indicator.ts`       | `createSelfIndicator(runtime): IHealthIndicator` — the always-up liveness baseline using `runtime.platform()`/`version()`/`hostname()`.                                                                                                                 |
| `src/indicators/http-indicator.ts`       | `createHttpIndicator(name, { url, timeoutMs?, fetcher? }): IHealthIndicator` — outbound HTTP probe with `AbortController` timeout and injectable fetcher.                                                                                               |
| `src/interfaces/index.ts`                | `HealthPluginOptions` type (`endpoints`, `indicators`).                                                                                                                                                                                                 |
| `packages/common/src/services/health.ts` | ADD `IHealthService` and `HealthReport` (and `HealthCheckWithLatency` if needed) to the existing file.                                                                                                                                                  |
| `packages/common/src/index.ts`           | ADD `IHealthService`, `HealthReport` to the Health re-export line.                                                                                                                                                                                      |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                     | src covered                                                                 | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------- | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `test/unit/health-service.test.ts`            | `src/services/health-service.ts`                                            | `registerIndicator(name, fn)` stores; duplicate name throws `Error`; `check()` aggregates worst-of (`up`/`degraded`/`down`); `checkLive()` includes only `self`; `checkReady()` includes all contributed; `latencyMs` is a non-negative number; `timestamp` is an ISO string from `runtime.now()`. Calls type-check against `IHealthService.registerIndicator(name: string, indicator: HealthIndicatorFn): void` and `check(): Promise<HealthReport>`.                                                                                           |
| `test/unit/health-plugin.test.ts`             | `src/plugin/health-plugin.ts`                                               | Plugin `name`/`version`/`provides`/`priority`; registers `HealthService` under `CAPABILITIES.HEALTH`; self indicator registered; `options.indicators` registered; three routes added at default and custom paths; `undefined` endpoint path skips registration; `onInit` drain calls `service.registerIndicator` for each `CAPABILITIES.HEALTH_INDICATOR` contribution; duplicate-drain throws. Driven with a fake `IPluginContext` (fake registry capturing `getAll`, fake router capturing routes, fake lifecycle capturing `onInit`).         |
| `test/unit/self-indicator.test.ts`            | `src/indicators/self-indicator.ts`                                          | `createSelfIndicator(runtime).check()` returns `{ status: 'up', data: { platform, version, hostname } }` against a fake `IRuntimeServices`.                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/http-indicator.test.ts`            | `src/indicators/http-indicator.ts`                                          | Up branch (2xx → `up` with `statusCode` + `latencyMs`); down branch (5xx → `down`); network-error branch (rejected → `down` with `error`); timeout branch (`AbortController` fires → `down` with `error: 'timeout'`). All via an injected fake `fetcher`; one `describe.skipIf(!Deno.env.get('RUN_INTEGRATION'))` block exercises real `globalThis.fetch` against a loopback server started in the test.                                                                                                                                         |
| `test/unit/barrel-exports.test.ts`            | `src/index.ts`                                                              | Asserts every named export is present and the common re-exports are wired.                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `test/integration/health-integration.test.ts` | `src/plugin/health-plugin.ts` + `src/services/health-service.ts` end-to-end | Boots a real kernel `Application` with `RuntimePlugin` + `HealthPlugin` + a fake contributing plugin that calls `ctx.health.register('db', fn)`; drives `/health`, `/live`, `/ready` via `app.inject()`; asserts the JSON `HealthReport` shape field-by-field (status, timestamp, checks keys, `latencyMs` present, forbidden fields absent); asserts the status-code matrix (up→200, degraded→/ready 503 + /health 200, down→503); asserts a contributed indicator appears only after `onInit`; asserts `self` is the sole `/live` participant. |
| `test/fixtures/fake-runtime.ts`               | (fixture)                                                                   | A fake `IRuntimeServices` with controllable `now()`/`hrtime()`/`platform()`/`version()`/`hostname()` for deterministic latency and timestamp assertions.                                                                                                                                                                                                                                                                                                                                                                                         |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/20-health-plugin-health-checks, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

## 8. Risks & mitigations

- **`fetch` outside `packages/runtime`** → The HTTP indicator references `globalThis.fetch` only via
  an injectable `fetcher` seam with the global as the default; the branching logic (timeout, status
  mapping) is unit-tested through the injected fake, so no production path depends on a
  runtime-specific shape. `fetch` is a web standard on all three supported runtimes, not a Node-only
  API.
- **`onInit` drain ordering vs first request** → Contributions are pushed during `register()`;
  `onInit` runs after all `register()` calls and before the server listens, so the drain completes
  before any probe request. A test asserts a contributed indicator is absent before `onInit` and
  present after.
- **Duplicate indicator name across contributions** → `registerIndicator` throws on duplicates; the
  drain re-throws so a misconfigured app fails at startup rather than silently overwriting.
  Documented in §3.4.
- **`exactOptionalPropertyTypes` on the `endpoints` option** → The option type uses
  `string | undefined` and the plugin checks `!== undefined` before registering each route; tests
  cover the skip path.
- **Clock mixing** → `timestamp` uses `new Date(runtime.now()).toISOString()` and `latencyMs` uses
  `runtime.hrtime()` deltas; no `Date.now()` anywhere in `src/`. A grep gate confirms this.
- **Per-file coverage on the HTTP indicator's real-fetch branch** → The real-`fetch` path is behind
  a `RUN_INTEGRATION`-guarded test; the decidable logic (status mapping, timeout handling) is
  extracted into the injectable-seam path that is fully unit-tested, satisfying the "branching logic
  must not live only behind a skipped test" rule.

## 9. Out of scope

- **Disk and Memory resource indicators** — deferred; require a runtime resource-usage seam absent
  from `IRuntimeServices` (same deferral as M19's memory/cpu collectors). Revisit when a resource
  seam is added to `packages/runtime`.
- **Database/Cache/Queue built-in indicators** — NOT built here; those plugins self-register their
  own indicators via `ctx.health.register(...)` (verified in §1). Adding them to the health plugin
  would duplicate dead surface.
- **Caching of health results / TTL throttling** — a future enhancement; this milestone computes the
  report on every request. Throttling adds statefulness and a timer seam best designed separately.
- **OpenAPI contribution for the health endpoints** — the OpenAPI plugin (M21) owns spec generation;
  health endpoints will be documented by that milestone's route-schema mechanism.
- **Auth on the probe endpoints** — operators protect probes via the http-security plugin or a
  reverse proxy; adding auth here would couple health to the auth plugin.
