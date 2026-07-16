# Milestone 19 — Metrics Plugin (`@hono-enterprise/metrics-plugin`)

> **Status:** Planning. Branch: `feat/19-metrics-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

This milestone delivers a Prometheus metrics capability under the existing `CAPABILITIES.METRICS`
(`'metrics'`) token. It commits the missing `IMetricsService` port plus its typed instrument
contracts (`ICounter`, `IGauge`, `IHistogram`, `ISummary`) to `@hono-enterprise/common` — today only
the bare `IMetric` / `MetricConfig` shapes and the `METRICS` / `METRIC_REGISTRATION` tokens exist
(see §2 C1) — then implements the service with the four instrument kinds, a metrics registry, a
hand-rolled Prometheus text exposition renderer, a `/metrics` endpoint, and the built-in HTTP
collectors wired as the `MetricsMiddleware` (ARCHITECTURE §10 priority 700). The boundary: metrics
are **in-process and pull-based** (a scrape endpoint), instrument values live in memory, and the
exposition format is Prometheus text 0.0.4 only.

- **In scope:** the `IMetricsService` + `ICounter` / `IGauge` / `IHistogram` / `ISummary` +
  `MetricOptions` contracts added to `common`; `MetricsPlugin` factory; counter / gauge / histogram /
  summary instruments (get-or-create, label-aware); `MetricsRegistry`; `MetricsService`
  (`counter`/`gauge`/`histogram`/`summary`/`get` + concrete `render`/`snapshot`); the
  `renderPrometheus` renderer; the four built-in HTTP collectors (request-duration histogram, request
  counter, error counter, active-requests gauge) registered as `MetricsMiddleware` at priority 700;
  the `GET /metrics` route; draining of `METRIC_REGISTRATION` contributions at `onInit`; plugin
  options (`endpoint`, `defaultMetrics`, `httpMetrics`, `customMetrics`, `defaultBuckets`,
  `defaultQuantiles`).
- **NOT this milestone:** the `memory-collector.ts` and `cpu-collector.ts` resource collectors
  (owned by a future runtime-resource-stats milestone — see §3.7 / §9; they need a process
  resource seam that `IRuntimeServices` does not expose and that AI_GUIDELINES §4 forbids reading
  directly in a plugin); OpenMetrics / protobuf exposition (ARCHITECTURE flags "Prometheus format
  only; OpenMetrics support in future"); histogram exemplars and native histograms; a push gateway
  and multi-process aggregation; `@Metric` decorator integration (decorator-plugin, a later
  milestone); per-instance / multi-tenant metric namespacing (queue/scheduler-style
  `<token>.<name>`); replacing the runtime clock.

## 1. Contracts verified from SOURCE (not names)

| Reference                                   | Source (file:line)                                            | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IMetric`                                   | `packages/common/src/services/metrics.ts:29-46`               | `{ readonly name; readonly type: MetricType; readonly help; observe(value?: number, labels?: Readonly<Record<string,string>>): void }`. The docstring fixes per-type `observe` semantics: counter = increment (default 1), gauge = new value, histogram/summary = observed sample. **Value is the first parameter.**                                                         |
| `MetricConfig`                              | `packages/common/src/services/metrics.ts:13-22`               | `{ readonly type: MetricType; readonly help: string; readonly labels?: readonly string[]; readonly buckets?: readonly number[] }`. Declarative shape used by `ctx.metrics.register`; `type` and `help` are required.                                                                                                                                                          |
| `MetricType`                                | `packages/common/src/types.ts:67`                             | `'counter' \| 'gauge' \| 'histogram' \| 'summary'`.                                                                                                                                                                                                                                                                                                                            |
| `IMetricsApi.register`                      | `packages/common/src/plugin.ts:171-179`                       | `register(name: string, config: MetricConfig): void` — the context contribution surface (`ctx.metrics.register`). Returns void; the contributor does not get a handle back.                                                                                                                                                                                                   |
| `CAPABILITIES.METRICS`                      | `packages/common/src/tokens.ts:65`                            | Token value `'metrics'`; already committed. No `IMetricsService` ships in `common` today (C1).                                                                                                                                                                                                                                                                                 |
| `CAPABILITIES.METRIC_REGISTRATION`          | `packages/common/src/tokens.ts:103`                           | Multi-provider token `'metric-registration'`; consumers drain with `getAll`.                                                                                                                                                                                                                                                                                                  |
| `createCapabilityToken` grammar             | `packages/common/src/tokens.ts:114-149`                       | Lowercase kebab-case segments, dot namespacing; colons illegal. The bare `'metrics'` token is already valid, so no new token is invented.                                                                                                                                                                                                                                     |
| kernel `ctx.metrics.register` wiring        | `packages/kernel/src/application/application.ts:174-181`      | The kernel backs `ctx.metrics.register(name, config)` by pushing `{ name, config }` into the `METRIC_REGISTRATION` multi-provider registry. The MetricsPlugin drains these at `onInit` and materializes them (§3.3).                                                                                                                                                          |
| `IServiceRegistry`                          | `packages/common/src/registry.ts:55-119`                      | `register<T>(token, service, options?: { override?; multi? })`, `registerFactory`, `get<T>(token)`, `getAll<T>(token)`, `has`, `unregister`. The service is registered once under `'metrics'`; registrations are multi for `METRIC_REGISTRATION`.                                                                                                                             |
| `IPlugin`                                   | `packages/common/src/plugin.ts:437-458`                       | `{ name; version; dependencies?; optionalDependencies?; provides?; consumes?; priority?; register(ctx): void \| Promise<void> }`.                                                                                                                                                                                                                                              |
| `IPluginContext`                            | `packages/common/src/plugin.ts:376-415`                       | Exposes `services`, `middleware`, `router`, `lifecycle`, `metrics`, `health`, `runtime` (non-optional), `logger?`. These are the only surfaces the plugin touches.                                                                                                                                                                                                            |
| `IRouterApi.get`                            | `packages/common/src/plugin.ts:66`                            | `get(path, route: RouteHandler \| RouteDefinition)` — registers the `/metrics` scrape route.                                                                                                                                                                                                                                                                                    |
| `IMiddlewareApi.add` + `MiddlewareOptions`  | `packages/common/src/plugin.ts:41-49`                         | `add(middleware, { priority?, name? })` — registers `MetricsMiddleware` at priority 700.                                                                                                                                                                                                                                                                                      |
| `ILifecycleApi.onInit` / `onClose`          | `packages/common/src/plugin.ts:268` / `:304`                  | `onInit(fn)` runs after every plugin has registered (where `METRIC_REGISTRATION` is drained); `onClose(fn)` tears down the scrape interval, if any.                                                                                                                                                                                                                            |
| `MiddlewareFunction` + `IRequestContext`    | `packages/common/src/http.ts:162-208`                         | `(ctx: IRequestContext, next: NextFunction) => …`; `ctx.request.method`, `ctx.request.path`, `ctx.response.snapshot().status`, `ctx.startTime` (monotonic). The ARCHITECTURE example at `http.ts:195-201` measures a duration as `runtime.hrtime() - ctx.startTime` — never a wall-clock epoch.                                                                                |
| `IResponse`                                 | `packages/common/src/http.ts:83-154`                          | `status(code)`, `header(name, value)`, `text(body): HandlerResult`, `snapshot(): { status; headers; body }`. The scrape handler returns `text(service.render())` with a Prometheus content type.                                                                                                                                                                              |
| `IRuntimeServices`                          | `packages/common/src/runtime.ts:106-196`                      | `now()`, `hrtime()` (monotonic ms), `setInterval`/`clearInterval`, `platform()`. **No memory or CPU / resource-stat method exists** — the resource collectors cannot be implemented without a new runtime seam (§3.7).                                                                                                                                                         |
| `PLUGIN_PRIORITY`                           | `packages/common/src/types.ts:78-89`                          | `HIGHEST 0`, `HIGH 100`, `NORMAL 500`, `LOW 900`, `LOWEST 1000`. Metrics registers at `HIGH` (100) so the service is resolvable before `NORMAL`-band plugins that record metrics.                                                                                                                                                                                            |
| ARCHITECTURE MetricsMiddleware priority     | `ARCHITECTURE.md:1541`                                        | `MetricsMiddleware` sits at priority 700 (after `RouteHandler` 500 and `ResponseInterceptors` 600, before `ErrorHandler` 800).                                                                                                                                                                                                                                                |
| ARCHITECTURE metrics-plugin                 | `ARCHITECTURE.md:1262-1271`                                   | Responsibilities: counter/gauge/histogram/summary, metrics registry, Prometheus rendering, built-in collectors. Public API: `MetricsPlugin()` + `IMetricsService`. Extension points: custom collectors, custom renderers. Rule: Prometheus format only.                                                                                                                       |
| PUBLIC_API Metrics §23                      | `PUBLIC_API.md:2359-2426`                                     | Consumer surface: `MetricsPlugin({ endpoint, defaultMetrics, httpMetrics, customMetrics })`, `ctx.services.get<IMetricsService>('metrics')`, `counter().inc()`, `gauge().inc()`, `histogram(name,{labels,buckets}).observe(...)`, `GET /metrics` text exposition. Examples are illustrative and diverge from the committed `IMetric.observe` parameter order (C2) and `MetricConfig` required fields (C3). |
| `common` barrel pattern                     | `packages/common/src/index.ts:104`                            | Service contracts are re-exported as `export type { … } from './services/<name>.ts'`. M19 extends the metrics block here (C1 deliverable).                                                                                                                                                                                                                                     |
| SchedulerPlugin factory precedent           | `packages/scheduler-plugin/src/plugin/scheduler-plugin.ts:32-90` | Factory `<X>Plugin(options?): IPlugin`; `provides: [token]`; `priority: 100`; `async register(ctx)` builds the service, `ctx.services.register<IX>(token, service)`, `ctx.health.register(...)`, `ctx.lifecycle.onClose(...)`. MetricsPlugin mirrors this exactly (minus a health indicator — metrics has no readiness state to report).                                       |
| SchedulerService constructor precedent      | `packages/scheduler-plugin/src/services/scheduler-service.ts:43-62` | `class XxxService implements IX` with private fields, an options-bag constructor, `connect()`/`disconnect()` lifecycle. `MetricsService` follows the same shape (no timers to arm unless a scrape refresh is configured).                                                                                                                                                       |
| ROADMAP M19                                 | `ROADMAP.md:2145-2219`                                        | Scope, file list (`plugin/`, `services/`, `registry/`, `metrics/{counter,gauge,histogram,summary}`, `collectors/{http,memory,cpu}`, `renderers/`), deliverables. `memory-collector.ts` and `cpu-collector.ts` are deferred (§3.7); `base-metric.ts` is added (shared label handling).                                                                                          |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                       | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | Doc deliverable (same PR)                                                                                                                                                                                                                       |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `IMetricsService` is consumed in `PUBLIC_API.md:2383` and `PUBLIC_API.md:2394` as `ctx.services.get<IMetricsService>('metrics')` and listed as the metrics-plugin public API in `ARCHITECTURE.md:1269`, but **no `IMetricsService` contract exists in `packages/common/src/services/`** (verified: `metrics.ts` ships only `IMetric` / `MetricConfig`; the `METRICS` token at `tokens.ts:65` has no matching service port). A capability token with no committed port leaves the consumer seam undefined (the M10 `IOrmAdapter` lesson; the same gap M18 closed for `IScheduler`). | M19 **adds** `IMetricsService`, `ICounter`, `IGauge`, `IHistogram`, `ISummary`, and `MetricOptions` to `packages/common/src/services/metrics.ts` and re-exports them from `packages/common/src/index.ts` (M12/M13/M14/M15/M18 precedent: the implementing milestone commits its port). The service registers under `CAPABILITIES.METRICS`.                                                                                                                                                                                          | Edit `PUBLIC_API.md` §35 common reference (the Metrics row at `PUBLIC_API.md:3509`) to list the new types; show the committed `IMetricsService` signature block in §23. Ship the new `common` source + barrel export.                            |
| C2 | The committed `IMetric.observe(value?, labels?)` at `metrics.ts:45` is **value-first**, but `PUBLIC_API.md:2402` writes `histogram.observe({ query_type: 'full-text' }, value)` (**labels-first**). Two committed sources disagree on the record parameter order.                                                                                                                | The committed SOURCE wins: `observe` / `inc` / `set` are **value-first** (`observe(value, labels)`), consistent with `IMetric.observe` at `metrics.ts:45` and its per-type docstring.                                                                                                                                                                                                                                                                                                                                   | Edit `PUBLIC_API.md:2402` to `histogram.observe((Date.now() - start) / 1000, { query_type: 'full-text' })`; align the §23 examples.                                                                                                              |
| C3 | `MetricConfig.type` and `MetricConfig.help` are **required** (`metrics.ts:15-17`), but the `PUBLIC_API.md:2386-2398` examples call `counter('users_total').inc()` and `histogram('name', { labels, buckets })` with no `type` and no `help`.                                                                                                                                    | The typed factory methods take an ergonomic `MetricOptions` (all fields optional; `type` is injected by the method name, `help` defaults to the metric name). The committed `MetricConfig` (type + help required) stays as the **declarative** shape for `ctx.metrics.register` and `customMetrics`; both paths normalize to a full internal config. `counter(name)` with no options is therefore valid (help defaults to `name`); a declarative registration still requires `type` + `help`. | Edit `PUBLIC_API.md` §23 to document the `MetricOptions` factory shape alongside the declarative `MetricConfig`; update §35.                                                                                                                    |
| C4 | `ROADMAP.md:2196-2202` lists `src/collectors/memory-collector.ts` and `src/collectors/cpu-collector.ts` as M19 files, but `IRuntimeServices` (`runtime.ts:106-196`) exposes no process-resource seam and AI_GUIDELINES §4 (`AI_GUIDELINES.md:221-222`) forbids `process` / `Deno` / `Bun` in core packages.                                                                      | The two resource collectors are **deferred** out of M19 to a future runtime-resource-stats milestone that adds a resource seam to `IRuntimeServices` and the runtime adapters first (§3.7 / §9). M19 ships the four HTTP collectors, which need no runtime resource seam.                                                                                                                                                                                                                                                  | Edit `ROADMAP.md` M19 "Built-in Collectors" + "Implementation Files" to mark `memory-collector.ts` / `cpu-collector.ts` as deferred to the runtime-resource milestone; note the added `base-metric.ts`.                                          |

## 3. Design decisions

### 3.1 The `IMetricsService` contract and typed instruments are committed to `common` by this milestone

- **Decision:** Add to `packages/common/src/services/metrics.ts` the port below and re-export every
  new symbol from `packages/common/src/index.ts`. `MetricsService` registers under
  `CAPABILITIES.METRICS`.

  ```typescript
  /** Ergonomic options for the typed factory methods. `type` is injected by the
   *  method name; `help` defaults to the metric name. */
  export interface MetricOptions {
    readonly help?: string;
    readonly labels?: readonly string[];
    readonly buckets?: readonly number[];
    readonly quantiles?: readonly number[];
  }

  /** Monotonically increasing counter. `observe` / `inc` add a non-negative value. */
  export interface ICounter extends IMetric {
    inc(value?: number, labels?: Readonly<Record<string, string>>): void;
  }

  /** Gauge: arbitrary set / inc / dec. `observe` sets the value. */
  export interface IGauge extends IMetric {
    set(value: number, labels?: Readonly<Record<string, string>>): void;
    inc(value?: number, labels?: Readonly<Record<string, string>>): void;
    dec(value?: number, labels?: Readonly<Record<string, string>>): void;
  }

  /** Histogram: bucketed observation distribution plus sum and count. */
  export interface IHistogram extends IMetric {
    observe(value: number, labels?: Readonly<Record<string, string>>): void;
    readonly buckets: readonly number[];
  }

  /** Summary: per-quantile observations plus sum and count. */
  export interface ISummary extends IMetric {
    observe(value: number, labels?: Readonly<Record<string, string>>): void;
    readonly quantiles: readonly number[];
  }

  /** Metrics service resolved via `ctx.services.get<IMetricsService>('metrics')`. */
  export interface IMetricsService {
    counter(name: string, options?: MetricOptions): ICounter;
    gauge(name: string, options?: MetricOptions): IGauge;
    histogram(name: string, options?: MetricOptions): IHistogram;
    summary(name: string, options?: MetricOptions): ISummary;
    get(name: string): IMetric | undefined;
  }
  ```

- **Why:** Consumers register `dependencies: ['metrics']` / `optionalDependencies: ['metrics']` and
  resolve a typed service (ARCHITECTURE shows database using `optionalDependencies: ['metrics']`). A
  bare token with no port is the undefined-seam defect (M10); the typed `IXxx` instrument interfaces
  keep the `IXxx` naming convention (`AI_GUIDELINES.md:585`) and let `IMetricsService.counter(...)`
  return a typed handle so callers see `.inc()` / `.set()` / `.observe()` rather than only
  `IMetric.observe`. The committed `IMetric.observe` (value-first, per-type semantics) is inherited
  unchanged; the typed methods are ergonomic aliases over the same record path.
- **Test home:** `packages/common/test/unit/metrics.test.ts` asserts the new types compile-resolve
  from the barrel and that a stub object satisfies `IMetricsService`;
  `packages/metrics-plugin/test/unit/metrics-service.test.ts` asserts the registered object
  satisfies `IMetricsService` and that `counter()/gauge()/histogram()/summary()` return the matching
  instrument interface.

### 3.2 Typed factory methods are get-or-create and use ergonomic options (resolves C3)

- **Decision:** `counter` / `gauge` / `histogram` / `summary` are **get-or-create**: the first call
  for a `name` constructs and registers the instrument under that name; subsequent calls return the
  same handle (public-API callers invoke `metrics.counter('users_total').inc()` on every request).
  Each method injects its `MetricType`, fills `help ?? name`, and stores the merged config. Record
  methods (`inc` / `set` / `observe`) are **value-first** to match `IMetric.observe` (C2).
- **Why:** Resolves C3 to one mechanism and makes per-request usage safe (no duplicate instruments,
  no leaked state). Re-registering a name with a conflicting `type` throws at creation time
  (mirrors the kernel's duplicate-provider guard).
- **Test home:** `metrics-service.test.ts` asserts idempotency (two `counter('x')` calls return the
  same reference) and that a type mismatch throws; `counter.test.ts` / `gauge.test.ts` assert
  value-first `inc` / `set` against the signature in §3.1.

### 3.3 Declarative contributions are drained from `METRIC_REGISTRATION` at `onInit`

- **Decision:** The plugin registers `MetricsService` during `register()`, then in an `onInit` hook
  reads `ctx.services.getAll<{ name: string; config: MetricConfig }>(CAPABILITIES.METRIC_REGISTRATION)`
  (the kernel pushes each `ctx.metrics.register(name, config)` call there, `application.ts:174-181`)
  and materializes every contribution by `config.type` via the matching factory. The option
  `customMetrics` (declarative `{ name } & MetricConfig` items) is materialized the same way. The
  `MetricsRegistry` is the single source of truth for both paths.
- **Why:** A contributor's `ctx.metrics.register` runs during its own registration, which may precede
  the metrics plugin's; draining at `onInit` (after all plugins register, per `plugin.ts:268`)
  removes that ordering hazard. Converging declarative and programmatic paths on one registry avoids
  two sources of truth.
- **Test home:** `metrics-plugin.test.ts` asserts that contributions pushed into
  `METRIC_REGISTRATION` appear as instruments on the service after the init hook runs, and that
  `customMetrics` are pre-registered.

### 3.4 Prometheus rendering is hand-rolled and lives on the concrete service, not the common port

- **Decision:** No `prom-client` dependency is introduced (it is absent from the root `deno.json`
  `imports` and the per-package `deno.json`). A pure `renderPrometheus(snapshots: readonly MetricSnapshot[]): string`
  produces Prometheus text 0.0.4: counters and gauges emit `# HELP` / `# TYPE` / `<name>{labels} value`;
  histograms emit `<name>_bucket{le="…"} count` per bound plus `+Inf`, then `<name>_sum` and
  `<name>_count`; summaries emit `<name>{quantile="…"} value` plus `_sum` / `_count`. `MetricsService`
  exposes concrete `snapshot(): readonly MetricSnapshot[]` and `render(): string` (delegating to the
  renderer). The `/metrics` route closes over the `MetricsService` instance and returns
  `ctx.response.header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8').status(200).text(service.render())`.
  `render` / `snapshot` are **not** on `IMetricsService` so the common port stays exposition-agnostic
  (ARCHITECTURE: "Prometheus format only; OpenMetrics support in future"; extension point: custom
  renderers, which consume `MetricsService.snapshot()`).
- **Why:** Keeps the committed port portable (a replacement metrics plugin brings its own route) and
  adds zero dependencies. The renderer has a real consumer (`MetricsService.render`) and the route has
  a real consumer (the scrape request), so neither is dead surface.
- **Test home:** `prometheus-renderer.test.ts` asserts the exposition shape for each instrument kind,
  label formatting / escaping, and bucket / quantile output; `metrics-integration.test.ts` asserts
  the `/metrics` route returns the content type and body.

### 3.5 Summary quantiles use a bounded sliding window (simple, deterministic, testable)

- **Decision:** Each `ISummary` label-set stores a bounded ring of observed samples (default
  `maxSamples = 512`, configurable per metric). At render, quantiles are computed by sorting the
  window and interpolating. Default quantiles are `[0.5, 0.9, 0.99]`.
- **Why:** A streaming algorithm (t-digest, P²) is more complex than this milestone needs and harder
  to test deterministically; a bounded window keeps memory predictable and the output stable under
  tests. The trade-off (approximation degrades when the window is much smaller than the population)
  is documented and revisited in a future milestone.
- **Test home:** `summary.test.ts` asserts known sample sets produce the expected quantile values and
  that the window is bounded.

### 3.6 HTTP collectors and the `MetricsMiddleware` — labels are bounded, the clock is monotonic

- **Decision:** When `httpMetrics` is on, the plugin registers four built-in metrics and one
  middleware at priority 700: `http_request_duration_seconds` (histogram, labels `method`,`status`),
  `http_requests_total` (counter, labels `method`,`status`), `http_request_errors_total` (counter,
  labels `method`,`status`, incremented when `status >= 500`), and `http_active_requests` (gauge, no
  labels). The middleware increments the active gauge before `await next()`, then records the
  duration as `runtime.hrtime() - start` (a monotonic delta, never `Date.now()` per CLAUDE.md "Never
  mix clocks"), the request counter, the error counter, and decrements the active gauge. Status comes
  from `ctx.response.snapshot().status` after `next()`. **`path` is deliberately not a label**
  (unbounded cardinality); route-template labels are a future concern.
- **Why:** Bounded labels (`method` × `status`) keep the registry finite; the monotonic clock matches
  the framework's timing convention (`http.ts:195-201`). Every metric the middleware records has a
  design-decision home, so the integration test does not assert unspecified behavior.
- **Test home:** `http-collector.test.ts` (unit, with a fake request context + fake runtime) asserts
  the four metrics move correctly for a 200 and a 500 and that `path` is absent from the rendered
  output; `metrics-integration.test.ts` exercises the middleware through the plugin.

### 3.7 Memory and CPU resource collectors are deferred (no runtime resource seam exists)

- **Decision:** M19 does **not** implement `memory-collector.ts` or `cpu-collector.ts`. Those need
  process resource statistics (`process.memoryUsage()` / `process.cpuUsage()` / `Deno.memoryUsage()`),
  which are runtime-specific APIs that AI_GUIDELINES §4 (`AI_GUIDELINES.md:221-222`) forbids outside
  `packages/runtime`, and `IRuntimeServices` (`runtime.ts:106-196`) exposes no resource-stat method.
  Adding that seam is a `common` + `runtime` change that belongs to a dedicated runtime-resource-stats
  milestone, not bolted onto the metrics-plugin package.
- **Why:** Respects "one package per milestone", the runtime-independence rule, and the "no dead
  surface" rule (a collector with no data source is dead surface). The four HTTP collectors — the
  high-value operational metrics — ship now without the seam.
- **Test home:** None (no code); the deferral is asserted by this plan (C4) and the ROADMAP doc edit.

## 4. Exported surface — every symbol names its consumer

| Exported symbol        | Kind                | Consumer / real code path that READS it                                                                                                                                                                                                                                                                              |
| ---------------------- | ------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `MetricsPlugin`        | factory function    | `app.register(MetricsPlugin({...}))` — PUBLIC_API §23; the application bootstrap.                                                                                                                                                                                                                                    |
| `MetricsPluginOptions` | type                | The single argument to `MetricsPlugin`; consumed by `metrics-plugin.ts` to configure the route, middleware, collectors, and pre-registrations.                                                                                                                                                                       |
| `MetricsService`       | class               | Constructed in `MetricsPlugin.register`; registered under `'metrics'`; its `render()` is called by the `/metrics` route handler; `snapshot()` is the custom-renderer extension point.                                                                                                                               |
| `IMetricsService`      | interface (common)  | `ctx.services.get<IMetricsService>('metrics')` (PUBLIC_API §23); consumed by route handlers that record business metrics.                                                                                                                                                                                            |
| `ICounter`             | interface (common)  | Return type of `IMetricsService.counter`; consumers call `.inc()` (PUBLIC_API §23).                                                                                                                                                                                                                                  |
| `IGauge`               | interface (common)  | Return type of `IMetricsService.gauge`; consumers call `.set()` / `.inc()`.                                                                                                                                                                                                                                          |
| `IHistogram`           | interface (common)  | Return type of `IMetricsService.histogram`; consumers call `.observe()`; its `buckets` are read by the renderer.                                                                                                                                                                                                     |
| `ISummary`             | interface (common)  | Return type of `IMetricsService.summary`; consumers call `.observe()`; its `quantiles` are read by the renderer.                                                                                                                                                                                                     |
| `MetricOptions`        | interface (common)  | The options bag for every typed factory method; documented in PUBLIC_API §23 (C3).                                                                                                                                                                                                                                   |
| `Counter`              | class               | Concrete `ICounter` returned by `MetricsService.counter`; maintains per-label-set counts read by the renderer.                                                                                                                                                                                                       |
| `Gauge`                | class               | Concrete `IGauge` returned by `MetricsService.gauge`; maintains per-label-set values.                                                                                                                                                                                                                                |
| `Histogram`            | class               | Concrete `IHistogram` returned by `MetricsService.histogram`; maintains bucket counts + sum + count read by the renderer.                                                                                                                                                                                            |
| `Summary`              | class               | Concrete `ISummary` returned by `MetricsService.summary`; maintains the sample window read by the renderer.                                                                                                                                                                                                           |

`renderPrometheus`, `MetricsRegistry`, `MetricSnapshot`, and `MetricBase` are **internal** (under
`src/renderers/`, `src/registry/`, and `src/metrics/`, re-exported only within the package) — each
has an in-package consumer (`MetricsService.render` / the service / the renderer) plus its own test,
so none is dead, but none is part of the public barrel.

### 4.1 Options — every option names its consumer

| Option            | Consumer                                                                          | Behavior (per implementation)                                                                                                                                                                                                                                                                                                            |
| ----------------- | --------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`        | `ctx.router.get(endpoint, …)` in `metrics-plugin.ts`                              | Path of the scrape route. Default `'/metrics'`.                                                                                                                                                                                                                                                                                          |
| `defaultMetrics`  | master switch in `metrics-plugin.ts`                                              | When `true` (default), registers the built-in HTTP collectors and the scrape route; when `false`, neither is registered (the service still serves programmatic metrics).                                                                                                                                                                 |
| `httpMetrics`     | `ctx.middleware.add(…, { priority: 700 })` in `metrics-plugin.ts`                 | When `true` (default) and `defaultMetrics` is on, registers `MetricsMiddleware` and its four metrics.                                                                                                                                                                                                                                    |
| `customMetrics`   | `onInit` drain loop in `metrics-plugin.ts`                                        | Declarative `readonly ({ name: string } & MetricConfig)[]`; each item is materialized by `config.type` at `onInit`. Default `[]`.                                                                                                                                                                                                        |
| `defaultBuckets`  | HTTP duration histogram registration + any histogram without explicit `buckets`   | Histogram upper bounds used when a histogram omits `buckets`. Default `[0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10]`.                                                                                                                                                                                                        |
| `defaultQuantiles`| any summary without explicit `quantiles`                                          | Quantiles reported by summaries that omit `quantiles`. Default `[0.5, 0.9, 0.99]`.                                                                                                                                                                                                                                                       |

## 5. Implementation files

| File                                                  | Purpose                                                                                                                                                                                                                                                                                                                                              |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/services/metrics.ts` (EDIT)      | Add `MetricOptions`, `ICounter`, `IGauge`, `IHistogram`, `ISummary`, `IMetricsService` alongside the existing `IMetric` / `MetricConfig` (C1).                                                                                                                                                                                                       |
| `packages/common/src/index.ts` (EDIT)                 | Re-export the new types from the metrics block (`index.ts:104` today).                                                                                                                                                                                                                                                                               |
| `packages/metrics-plugin/src/plugin/metrics-plugin.ts`| `MetricsPlugin(options?): IPlugin` — registers `MetricsService` under `'metrics'`, registers the `MetricsMiddleware` (priority 700) and `/metrics` route, drains `METRIC_REGISTRATION` + `customMetrics` at `onInit`.                                                                                                                                |
| `packages/metrics-plugin/src/services/metrics-service.ts` | `class MetricsService implements IMetricsService` — owns the `MetricsRegistry`; `counter`/`gauge`/`histogram`/`summary` get-or-create factories; `get(name)`; concrete `snapshot()` / `render()`.                                                                                                                                               |
| `packages/metrics-plugin/src/registry/metrics-registry.ts` | `MetricsRegistry` — name-keyed instrument store; insert / get / iterate; duplicate-name-with-conflicting-type throws.                                                                                                                                                                                                                              |
| `packages/metrics-plugin/src/metrics/base-metric.ts`  | Abstract `MetricBase` implementing `IMetric` (`name`/`type`/`help`) with shared label-name validation and a deterministic `labelKey(labels)` used by every instrument. Added beyond ROADMAP to avoid triplicating label handling across the four instruments.                                                                                         |
| `packages/metrics-plugin/src/metrics/counter.ts`      | `class Counter extends MetricBase implements ICounter` — per-label-set monotonic counter; `inc` / `observe`.                                                                                                                                                                                                                                         |
| `packages/metrics-plugin/src/metrics/gauge.ts`        | `class Gauge extends MetricBase implements IGauge` — per-label-set gauge; `set` / `inc` / `dec` / `observe`.                                                                                                                                                                                                                                         |
| `packages/metrics-plugin/src/metrics/histogram.ts`    | `class Histogram extends MetricBase implements IHistogram` — per-label-set bucket counts + sum + count; `observe`.                                                                                                                                                                                                                                   |
| `packages/metrics-plugin/src/metrics/summary.ts`      | `class Summary extends MetricBase implements ISummary` — per-label-set bounded sample window; `observe`; quantile computation.                                                                                                                                                                                                                       |
| `packages/metrics-plugin/src/collectors/http-collector.ts` | Registers the four HTTP metrics and exports the `MetricsMiddleware` function (active-requests gauge around `next()`, duration / request / error recording after `next()`).                                                                                                                                                                       |
| `packages/metrics-plugin/src/renderers/prometheus-renderer.ts` | Pure `renderPrometheus(snapshots): string` — Prometheus text 0.0.4 for all four instrument kinds; label / value escaping.                                                                                                                                                                                                                        |
| `packages/metrics-plugin/src/interfaces/index.ts`     | Internal barrel (NOT exported from `src/index.ts`): `MetricsPluginOptions`, `NamedMetricConfig`, `MetricSnapshot`, summary window config. Mirrors `scheduler-plugin/src/interfaces/index.ts`.                                                                                                                                                         |
| `packages/metrics-plugin/src/index.ts` (EDIT)         | Public barrel: `MetricsPlugin`, `MetricsPluginOptions`, `MetricsService`, the four instrument classes, and re-export of the common types (`IMetricsService`, `ICounter`, `IGauge`, `IHistogram`, `ISummary`, `IMetric`, `MetricConfig`, `MetricOptions`).                                                                                            |

Deferred (NOT created this milestone): `src/collectors/memory-collector.ts`, `src/collectors/cpu-collector.ts` (§3.7).

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                  | src covered                                      | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/metrics.test.ts`                               | `common/src/services/metrics.ts` (additions)     | The new types compile-resolve from the `@hono-enterprise/common` barrel; a stub object satisfies `IMetricsService`; `ICounter` / `IGauge` / `IHistogram` / `ISummary` extend `IMetric` (value-first `observe`).                                                                                                                                                                                               |
| `packages/metrics-plugin/test/unit/base-metric.test.ts`                    | `src/metrics/base-metric.ts`                     | `labelKey` is deterministic and order-independent; unknown label names (not declared in config) are rejected; `name`/`type`/`help` surface.                                                                                                                                                                                                                                                                    |
| `packages/metrics-plugin/test/unit/counter.test.ts`                        | `src/metrics/counter.ts`                         | `inc()` defaults to 1; `inc(n, labels)` adds per label-set; `observe(v, labels)` equals `inc(v, labels)`; counts are monotonic.                                                                                                                                                                                                                                                                              |
| `packages/metrics-plugin/test/unit/gauge.test.ts`                          | `src/metrics/gauge.ts`                           | `set` / `inc` / `dec` per label-set; `observe(v)` sets; negative deltas allowed.                                                                                                                                                                                                                                                                                                                              |
| `packages/metrics-plugin/test/unit/histogram.test.ts`                      | `src/metrics/histogram.ts`                       | `observe(value, labels)` increments the correct bucket, `_sum`, `_count`; explicit and default `buckets` (sorted, `+Inf`); out-of-range values land in `+Inf`.                                                                                                                                                                                                                                                |
| `packages/metrics-plugin/test/unit/summary.test.ts`                        | `src/metrics/summary.ts`                         | Known sample sets produce expected quantile values (0.5/0.9/0.99); window is bounded (`maxSamples`); `_sum` / `_count` accurate.                                                                                                                                                                                                                                                                              |
| `packages/metrics-plugin/test/unit/metrics-registry.test.ts`               | `src/registry/metrics-registry.ts`               | Insert / get / iterate; duplicate name with a conflicting `type` throws; same name + same type is idempotent.                                                                                                                                                                                                                                                                                                 |
| `packages/metrics-plugin/test/unit/metrics-service.test.ts`                | `src/services/metrics-service.ts`                | `counter`/`gauge`/`histogram`/`summary` are get-or-create (same ref on repeat), inject the right `MetricType`, default `help` to the name, and return the matching `ICounter`/`IGauge`/`IHistogram`/`ISummary`; `get(name)` resolves; the registered object satisfies `IMetricsService`; `snapshot()`/`render()` return coherent data.                                                                       |
| `packages/metrics-plugin/test/unit/prometheus-renderer.test.ts`            | `src/renderers/prometheus-renderer.ts`           | Exposition shape for counter / gauge / histogram (`_bucket{le}` + `+Inf` + `_sum` + `_count`) / summary (`{quantile}` + `_sum` + `_count`); `# HELP` / `# TYPE` headers; label and value escaping; content is Prometheus 0.0.4.                                                                                                                                                                                |
| `packages/metrics-plugin/test/unit/http-collector.test.ts`                 | `src/collectors/http-collector.ts`               | With a fake request context + fake runtime: a 200 increments `http_requests_total` and records a duration, leaves `http_request_errors_total` unchanged; a 500 increments the error counter; `http_active_requests` rises before `next()` and falls after; `path` is absent from the rendered labels. Duration is computed from `runtime.hrtime()` (monotonic).                                                |
| `packages/metrics-plugin/test/unit/metrics-plugin.test.ts`                 | `src/plugin/metrics-plugin.ts`                   | Factory returns `{ name: 'metrics-plugin', provides: ['metrics'], priority: 100 }`; options defaults; `register` places a resolvable `IMetricsService` under `'metrics'`; the `onInit` hook materializes `METRIC_REGISTRATION` contributions and `customMetrics`; middleware / route registration is gated by `defaultMetrics` / `httpMetrics`.                                                              |
| `packages/metrics-plugin/test/unit/barrel-exports.test.ts`                | `src/index.ts`                                   | Every public symbol is exported; internal modules are not leaked.                                                                                                                                                                                                                                                                                                                                             |
| `packages/metrics-plugin/test/fixtures/fake-runtime.ts`                   | (fixture)                                        | Fake `IRuntimeServices` with controllable `hrtime()` / `setInterval` / `clearInterval` (mirrors `scheduler-plugin/test/fixtures/fake-runtime.ts`).                                                                                                                                                                                                                                                            |
| `packages/metrics-plugin/test/fixtures/fake-request-context.ts`           | (fixture)                                        | Fake `IRequestContext` with a controllable `response.snapshot().status` for middleware tests.                                                                                                                                                                                                                                                                                                                 |
| `packages/metrics-plugin/test/integration/metrics-integration.test.ts`    | plugin + service + middleware + renderer + route | End-to-end: register the plugin, resolve `IMetricsService`, record business metrics, run a request through `MetricsMiddleware`, and assert `GET /metrics` returns `text/plain; version=0.0.4; charset=utf-8` with the expected exposition lines (including the four HTTP metrics).                                                                                                                            |

The per-file 90% branch / function / line bar (read from the ANSI-stripped `deno task test:coverage`
table) applies to every `src/` file above. No external npm dependency is introduced, so no guarded
real-import test is required (unlike M18's `npm:ioredis`); the renderer and instruments are pure and
unit-tested directly.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/19-metrics-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
```

## 8. Risks & mitigations

- **Label cardinality explosion** — the HTTP collectors label by `method` and `status` only and never
  by `path`; `MetricBase` rejects label values whose names were not declared in the metric config, so
  an accidental ad-hoc label cannot silently widen the series space.
- **Summary quantile drift / memory** — the sliding window is bounded (`maxSamples`, default 512) and
  the approximation trade-off is documented (§3.5); a streaming algorithm is a deliberate future
  change, not an in-milestone refactor.
- **Concurrent observation** — JavaScript is single-threaded on the event loop, so the `Map`-backed
  registry has no shared-mutable race; the design avoids `async` on the record path (`inc`/`set`/`observe`
  are synchronous), keeping hot-path recording allocation-light.
- **Get-or-create surprise** — repeat `counter('x')` returns the same handle by design; a conflicting
  re-registration (same name, different `type`) throws loudly at creation, which is unit-tested.
- **Scope reduction (memory / cpu deferred)** — the deferral is explicit (C4 / §3.7) and owned by a
  named future milestone; ROADMAP is edited in the same PR so the gap is visible, not silent.
- **Drain ordering** — `METRIC_REGISTRATION` is drained at `onInit` (after every plugin registers),
  so a contributor that registers during its own `register()` is always observed regardless of plugin
  order.

## 9. Out of scope

- **Process resource collectors** (`memory-collector.ts`, `cpu-collector.ts`) — deferred to a future
  runtime-resource-stats milestone that first adds a resource seam to `IRuntimeServices`
  (`runtime.ts:106-196`) and the Node / Deno / Bun adapters; AI_GUIDELINES §4
  (`AI_GUIDELINES.md:221-222`) forbids reading `process` / `Deno` / `Bun` resource APIs in a plugin.
- **OpenMetrics / protobuf exposition** — ARCHITECTURE states "Prometheus format only; OpenMetrics
  support in future"; only Prometheus text 0.0.4 ships here.
- **Histogram exemplars, native histograms, and a push gateway / multi-process aggregation** — not
  needed for a single-process pull model.
- **`@Metric` decorator integration** — decorator-plugin surface, a later milestone (mirrors how M18
  deferred `@Cron` / `@Every` / `@Delay`).
- **Per-instance / multi-tenant metric namespacing** (queue/scheduler-style `<token>.<name>`) and
  route-template label cardinality controls — future enhancements.
