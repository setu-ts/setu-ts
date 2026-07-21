# Milestone 24b — Telemetry Plugin Auto-Instrumentation (`@hono-enterprise/telemetry-plugin`)

> **Status:** Planning. Branch: `feat/24-b-auto-instrumentation`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Extend the M24 `@hono-enterprise/telemetry-plugin` with **automatic instrumentation** —
runtime-gated OTel instrumentation packages for HTTP clients, fetch, Redis, AMQP, and Kafka — plus a
configurable span-processor choice. This milestone ships three things and nothing else:

1. A **public `instrumentations` option** on `TelemetryPluginOptions`. M24 deliberately shipped NO
   placeholder for it
   ([`interfaces/index.ts`](packages/telemetry-plugin/src/interfaces/index.ts:72), verified: the
   type has no `instrumentations` field), so 24b defines the shape fresh with no published-shape
   back-compat constraint. It is a **per-instrumentation configuration object, NOT a bare
   `string[]`** — OTel instrumentations take options (ignore-path lists, db-statement flags, …) that
   a name-list cannot express.
2. **Auto-instrumentation packages** — `@opentelemetry/instrumentation-http`, fetch (via undici),
   ioredis, amqplib, kafkajs — loaded behind the same inject-or-lazy `TracerHost` seam M24
   established ([`tracer.ts`](packages/telemetry-plugin/src/tracing/tracer.ts:204),
   [`telemetry-plugin.ts`](packages/telemetry-plugin/src/plugin/telemetry-plugin.ts:74)). **Runtime
   gating is mandatory:** an instrumentation whose target is unavailable on the running runtime (all
   five target Node internals) degrades to a **documented no-op, never a throw**.
3. **`BatchSpanProcessor`** as a `TelemetryPluginOptions.spanProcessor` choice alongside M24's
   `SimpleSpanProcessor`. Both classes are exported by the already-pinned
   `npm:@opentelemetry/sdk-trace-base@^2.9.0`
   ([`tracer.ts`](packages/telemetry-plugin/src/tracing/tracer.ts:379)), so this adds **zero new
   dependencies** for the processor.

- **In scope:**
  - NEW `instrumentations?: InstrumentationsConfig` field on `TelemetryPluginOptions` with a
    per-instrumentation shape (`http` / `fetch` / `ioredis` / `amqplib` / `kafkajs`), defined in
    [`packages/telemetry-plugin/src/interfaces/index.ts`](packages/telemetry-plugin/src/interfaces/index.ts).
  - NEW `spanProcessor?: 'simple' | 'batch'` field on `TelemetryPluginOptions` (default `'simple'`,
    preserving M24 behavior exactly).
  - NEW optional `TracerHost.otelProvider` accessor so the instrumentation registry can attach
    instrumentations to the underlying OTel provider (backward-compatible — see §3.3).
  - NEW `src/instrumentation/instrumentation-registry.ts` + the three per-domain loader files +
    `src/services/span-processor-factory.ts`, all under `packages/telemetry-plugin/`.
  - Modifications to `src/tracing/tracer.ts` (route the processor through the factory; add
    `BatchSpanProcessor` to the `OtelSdkModule` type; expose `otelProvider`),
    `src/plugin/telemetry-plugin.ts` (wire instrumentations + processor into `register()`),
    `src/interfaces/index.ts`, and `src/index.ts`.
  - `PUBLIC_API.md` (Telemetry section: replace the M24b deferral note with the real surface),
    `ARCHITECTURE.md` (telemetry-plugin row: note auto-instrumentation + processor choice),
    `ROADMAP.md` (M24b file/test lists corrected per §2; deliverables checked).
- **NOT this milestone:**
  - **Cross-package context propagation over the message broker / queue** (editing
    `messaging-plugin` / `queue-plugin` to inject/extract `traceparent` on the wire). ROADMAP.md
    §Milestone 24b "NOT in M24b" owns this for a later cross-cutting milestone.
  - **Metrics/Logs signals** — owned by `metrics-plugin` (Prometheus) and `logger-plugin`.
  - **An OTel `ContextManager` / `AsyncLocalStorageContextManager`** — still out of scope for the
    same reason as M24 (it pulls `node:async_hooks` and violates runtime independence, AI_GUIDELINES
    §4). Auto-instrumentations create their own spans against the provider but do not establish
    implicit parent/child linking across `await` (see M24 §3 note). The `spanProcessor` +
    instrumentation surface landed here must be treated as a **stable public contract** because the
    M35 SDK / M36 microservice-starter `telemetry:` config block maps onto it (ROADMAP §Milestone
    24b).

## 1. Contracts verified from SOURCE (not names)

| Reference                                                  | Source (file:line)                                                                                                                                                                                                                                                   | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TelemetryPluginOptions` (M24)                             | [`packages/telemetry-plugin/src/interfaces/index.ts:72`](packages/telemetry-plugin/src/interfaces/index.ts:72)                                                                                                                                                       | Fields: `serviceName`, `serviceVersion`, `exporter`, `endpoint`, `headers`, `sampling`, `tracerProviderFactory`, `middleware`. **Verified: NO `instrumentations` field and NO `spanProcessor` field exist** — 24b adds both as new optional fields (additive, non-breaking per AI_GUIDELINES §9).                                                                                                                                                                                                                                                                   |
| `TracerHost` seam (M24)                                    | [`packages/telemetry-plugin/src/interfaces/index.ts:47`](packages/telemetry-plugin/src/interfaces/index.ts:47)                                                                                                                                                       | `{ startSpan(name, opts?): unknown; extractContext(headers): TelemetryContext; injectContext(ctx): Record<string,string>; shutdown(): Promise<void>; forceFlush(): Promise<void> }`. 24b adds an OPTIONAL `readonly otelProvider?: unknown` (§3.3) — additive; existing hosts/tests that omit it are unaffected (`exactOptionalPropertyTypes` permits absence).                                                                                                                                                                                                     |
| `BasicTracerProvider` 2.x constructor                      | [`packages/telemetry-plugin/src/tracing/tracer.ts:282`](packages/telemetry-plugin/src/tracing/tracer.ts:282)                                                                                                                                                         | Processors/sampler/resource are constructor config: `new BasicTracerProvider({ resource, spanProcessors: [...], sampler })`. `addSpanProcessor()` does NOT exist on the 2.x line (M24 §1 verified). 24b's `span-processor-factory` produces the single-element `spanProcessors` array.                                                                                                                                                                                                                                                                              |
| `OtelSdkModule` type                                       | [`packages/telemetry-plugin/src/tracing/tracer.ts:120`](packages/telemetry-plugin/src/tracing/tracer.ts:120)                                                                                                                                                         | Declares `BasicTracerProvider`, `SimpleSpanProcessor`, `TraceIdRatioBasedSampler`, `AlwaysOnSampler`. 24b ADDS `BatchSpanProcessor: new (exporter: unknown, config?: ...) => unknown` to this type.                                                                                                                                                                                                                                                                                                                                                                 |
| `BatchSpanProcessor` exists on the pinned line             | M24 archived plan §1 (verified via real import probe 2026-07-20) + `sdk-trace-base@^2.9.0` actual exports                                                                                                                                                            | Verified exports list includes `BatchSpanProcessor` alongside `SimpleSpanProcessor`, `BasicTracerProvider`, `ConsoleSpanExporter`, `InMemorySpanExporter`. **No new dependency** — same `npm:@opentelemetry/sdk-trace-base@^2.9.0` specifier already used at [`tracer.ts:379`](packages/telemetry-plugin/src/tracing/tracer.ts:379).                                                                                                                                                                                                                                |
| `loadOtelTracerProvider` lazy path                         | [`packages/telemetry-plugin/src/tracing/tracer.ts:363`](packages/telemetry-plugin/src/tracing/tracer.ts:363)                                                                                                                                                         | Validates options, then `await import('npm:@opentelemetry/sdk-trace-base@^2.9.0')`, `npm:@opentelemetry/resources@^2.9.0`, `npm:@opentelemetry/api@^1.9.0`, loads the exporter ctor, and calls `buildTracerHost({ sdkMod, resourcesMod, pluginOptions, validated: true })`. 24b passes `pluginOptions.spanProcessor` through to `buildTracerHost`, which selects the processor.                                                                                                                                                                                     |
| `TelemetryPlugin.register()` async wiring                  | [`packages/telemetry-plugin/src/plugin/telemetry-plugin.ts:74`](packages/telemetry-plugin/src/plugin/telemetry-plugin.ts:74)                                                                                                                                         | When `options.exporter` set: obtains `tracerHost` via `options.tracerProviderFactory()` (inject) ELSE `loadOtelTracerProvider(options)` (lazy); constructs `TelemetryService(tracerHost)`; registers `ctx.lifecycle.onShutdown(() => tracerHost.shutdown())`. 24b inserts the instrumentation-enable step after the host exists and extends the shutdown hook to disable instrumentations first. `register()` returning a `Promise` is already sanctioned (M24).                                                                                                    |
| `RuntimePlatform` union                                    | [`packages/common/src/types.ts:31`](packages/common/src/types.ts:31)                                                                                                                                                                                                 | `'node' \| 'deno' \| 'bun' \| 'cloudflare-workers'`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `IRuntimeServices.platform()`                              | [`packages/common/src/runtime.ts:112`](packages/common/src/runtime.ts:112)                                                                                                                                                                                           | `platform(): RuntimePlatform` — the runtime gate input. `ctx.runtime` is non-optional (ROADMAP bootstrap rule), so the registry always receives a real platform.                                                                                                                                                                                                                                                                                                                                                                                                    |
| `ctx.lifecycle.onShutdown`                                 | `packages/common/src` (LifecycleApi; M24 uses it at [`telemetry-plugin.ts:88`](packages/telemetry-plugin/src/plugin/telemetry-plugin.ts:88))                                                                                                                         | Registers an async shutdown hook. 24b chains `instrumentationHandle.shutdown()` then `tracerHost.shutdown()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Inject-or-lazy precedent (intra-package)                   | [`packages/auth-plugin/src/stores/redis-rate-limit-store.ts`](packages/auth-plugin/src/stores/redis-rate-limit-store.ts) (M16b) + [`packages/telemetry-plugin/src/tracing/tracer.ts`](packages/telemetry-plugin/src/tracing/tracer.ts) (M24 `tracerProviderFactory`) | `client`/factory injected via options → bypass lazy import; else `await import('npm:<pkg>@<pin>')` with a clear error/no-op. 24b mirrors this exactly for instrumentation instances (`InstrumentationConfig.instrumentation` inject) vs lazy npm load.                                                                                                                                                                                                                                                                                                              |
| `@opentelemetry/instrumentation-http`                      | npm registry (dist-tags read 2026-07-21)                                                                                                                                                                                                                             | `latest` = `0.220.0` (core experimental line, aligned with `exporter-trace-otlp-http@^0.220.0`). Patches `node:http`/`node:https`. 24b lazy-loads `npm:@opentelemetry/instrumentation-http@^0.220.0`. Export: `HttpInstrumentation`.                                                                                                                                                                                                                                                                                                                                |
| `@opentelemetry/instrumentation-undici` (the `fetch` kind) | npm registry 2026-07-21                                                                                                                                                                                                                                              | `latest` = `0.30.0` (contrib repo; keywords: `opentelemetry, fetch, undici, nodejs`). Instruments Node's undici-based `fetch`. **`@opentelemetry/instrumentation-fetch` (`0.220.0`) is browser-only** (keywords include `browser`; patches `window.fetch`) and is NOT used — the framework is a server-side backend. 24b lazy-loads `npm:@opentelemetry/instrumentation-undici@^0.30.0` for the `fetch` kind. Export: `UndiciInstrumentation`.                                                                                                                      |
| `@opentelemetry/instrumentation-ioredis`                   | npm registry 2026-07-21                                                                                                                                                                                                                                              | `latest` = `0.68.0` (contrib). Export: `IORedisInstrumentation`. 24b lazy-loads `npm:@opentelemetry/instrumentation-ioredis@^0.68.0`.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `@opentelemetry/instrumentation-amqplib`                   | npm registry 2026-07-21                                                                                                                                                                                                                                              | `latest` = `0.67.0` (contrib). Export: `AmqplibInstrumentation`. 24b lazy-loads `npm:@opentelemetry/instrumentation-amqplib@^0.67.0`.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `@opentelemetry/instrumentation-kafkajs`                   | npm registry 2026-07-21                                                                                                                                                                                                                                              | `latest` = `0.29.0` (contrib). Export: `KafkaJsInstrumentation`. 24b lazy-loads `npm:@opentelemetry/instrumentation-kafkajs@^0.29.0`.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| OTel `Instrumentation` duck-type                           | npm `@opentelemetry/instrumentation` (transitive of every instrumentation pkg)                                                                                                                                                                                       | The base interface every instrumentation satisfies: `setTracerProvider?(provider): void`, `setMeterProvider?(meter): void`, `enable?(): void`, `disable?(): unknown`, `setConfig?(config): void`. 24b duck-types this as a local structural interface — it does NOT add `@opentelemetry/instrumentation` as a separate specifier (it is transitive). `instrumentation.setTracerProvider(provider)` is used per-instance to avoid the global-side-effect path (`trace.setGlobalTracerProvider` is a process-wide singleton — AI_GUIDELINES §11.4 No Hidden Globals). |
| Guarded real-import precedent                              | [`packages/telemetry-plugin/test/integration/otlp-real-import.test.ts:13`](packages/telemetry-plugin/test/integration/otlp-real-import.test.ts:13)                                                                                                                   | `canImportNpm()` probes `Deno.permissions.querySync({ name: 'import' }).state === 'granted'`; the test uses `it({ name, ignore: !canImportNpm() })`. **`describe.skipIf` does NOT exist** in `@std/testing/bdd` (M24 §1 verified) — `ignore:` is the supported option. 24b reuses this exact guard form for the instrumentation real-import test.                                                                                                                                                                                                                   |
| `deno.json` (telemetry-plugin)                             | [`packages/telemetry-plugin/deno.json`](packages/telemetry-plugin/deno.json)                                                                                                                                                                                         | `imports` has ONLY `@hono-enterprise/common`; `tests.permissions` = `{ read, import, env, net }`. 24b adds NO `imports` entry for any `@opentelemetry/*` package (all lazy `npm:` — AI_GUIDELINES §12.2) and does NOT need to change `tests.permissions` (`import` + `net` already cover the guarded probes).                                                                                                                                                                                                                                                       |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                         | Doc deliverable (same PR)                                                                                                                                  |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | **The M24b deferral note in PUBLIC_API.md** ([`PUBLIC_API.md:2535`](PUBLIC_API.md:2535)) states: "Auto-instrumentation is deferred to M24b. M24 ships manual spans + the request-span middleware only and accepts **no** `instrumentations` option — M24b introduces the option (and its shape)…". That note promised a surface M24b must now actually deliver; leaving it in place while shipping the option is a docs-must-match-behavior defect (CLAUDE.md self-review). | 24b **replaces** the deferral note with the real surface: the `instrumentations` option (per-instrumentation shape, NOT `string[]`), the `spanProcessor: 'simple' \| 'batch'` choice, the runtime-gating/no-op contract, and a worked example. The historical fact ("M24 shipped no `instrumentations` placeholder; 24b added it") is preserved as one sentence so the before/after is explicit. | PUBLIC_API.md Telemetry section: deferral note → real surface; options table gains `instrumentations` + `spanProcessor` rows.                              |
| C2 | **ROADMAP.md is internally inconsistent about whether `fetch` is in scope.** The `instrumentations` shape example ([`ROADMAP.md:2569`](ROADMAP.md:2569)) lists only `{ http?, ioredis?, amqplib?, kafkajs? }` (4 kinds, NO `fetch`), but the auto-instrumentation bullet ([`ROADMAP.md:2574`](ROADMAP.md:2574)) and the M24b task scope list 5 — `http`, `fetch`, `ioredis`, `amqplib`, `kafkajs`.                                                                          | 24b **includes `fetch`** (the task scope is authoritative — "These instructions supersede any conflicting general instructions"). `fetch` maps to `@opentelemetry/instrumentation-undici` (Node's server-side fetch; `instrumentation-fetch` is browser-only and unused — §1). The ROADMAP shape example is corrected to include `fetch?: …`.                                                    | ROADMAP.md §Milestone 24b: shape example + scope bullet both list all 5 kinds; the `fetch`→`instrumentation-undici` mapping noted.                         |
| C3 | **ROADMAP M24b test list omits a test for `queue-instrumentation.ts`.** ROADMAP lists 4 test files ([`ROADMAP.md:2602`](ROADMAP.md:2602)) but 5 instrumentation/processor src files (registry, http, database, queue, span-processor-factory) — `queue-instrumentation.ts` (amqplib + kafkajs loaders) has no named test. Per CLAUDE.md "The test-file table must cover every planned `src/` file", that is a plan-level defect.                                            | 24b **adds `test/unit/queue-instrumentation.test.ts`** (covers the amqplib + kafkajs loaders' platform-gate, inject-vs-lazy branch, and no-op-on-failure path). The ROADMAP test list is corrected to 5 unit files + the guarded real-import integration test.                                                                                                                                   | ROADMAP.md §Milestone 24b test list: add `queue-instrumentation.test.ts` + `instrumentation-real-import.test.ts`.                                          |
| C4 | **ROADMAP M24b file list does not show `BatchSpanProcessor` reaching the provider**, and lists `src/services/span-processor-factory.ts` without stating it modifies `buildTracerHost` in `tracer.ts`. A reader would assume the factory is standalone.                                                                                                                                                                                                                      | 24b documents that `span-processor-factory.ts` is consumed BY `buildTracerHost` ([`tracer.ts:282`](packages/telemetry-plugin/src/tracing/tracer.ts:282)), which is MODIFIED to call it (replacing the inline `new SimpleSpanProcessor(exporter)`), and that `OtelSdkModule` ([`tracer.ts:120`](packages/telemetry-plugin/src/tracing/tracer.ts:120)) is extended with `BatchSpanProcessor`.      | ROADMAP.md §Milestone 24b file list: note `tracer.ts` modification + factory consumption; ARCHITECTURE.md telemetry-plugin row notes the processor choice. |

## 3. Design decisions

### 3.1 `instrumentations` option shape — per-instrumentation config object, not `string[]`

- **Decision:** A NEW optional `instrumentations?: InstrumentationsConfig` field on
  `TelemetryPluginOptions`
  ([`interfaces/index.ts`](packages/telemetry-plugin/src/interfaces/index.ts:72)).
  `InstrumentationsConfig` has exactly five optional keys — `http`, `fetch`, `ioredis`, `amqplib`,
  `kafkajs`. Each key's value is `true | InstrumentationConfig`:

  ```ts
  /** Per-instrumentation entry. Presence of the parent key enables; this configures or injects. */
  export interface InstrumentationConfig {
    /**
     * An already-constructed OTel `Instrumentation` instance — the INJECT half of the
     * inject-or-lazy seam (mirrors M24's `tracerProviderFactory` / auth-plugin's injected `client`).
     * When set, the registry skips the lazy `npm:` import and uses this instance directly.
     */
    readonly instrumentation?: unknown;
    /**
     * Opaque config object forwarded VERBATIM to the OTel instrumentation constructor's `config`
     * argument (the LAZY half). Framework-owned and untyped on purpose: OTel instrumentation config
     * surfaces evolve independently and re-typing them here would fabricate field names and drift.
     * Consumers pass whatever the target `@opentelemetry/instrumentation-*` package accepts.
     */
    readonly config?: Readonly<Record<string, unknown>>;
  }

  export interface InstrumentationsConfig {
    /** node:http/https via @opentelemetry/instrumentation-http. Node-only; no-op elsewhere. */
    readonly http?: true | InstrumentationConfig;
    /** Node undici/fetch via @opentelemetry/instrumentation-undici. Node-only; no-op elsewhere. */
    readonly fetch?: true | InstrumentationConfig;
    /** ioredis via @opentelemetry/instrumentation-ioredis. Node-only; no-op elsewhere. */
    readonly ioredis?: true | InstrumentationConfig;
    /** amqplib via @opentelemetry/instrumentation-amqplib. Node-only; no-op elsewhere. */
    readonly amqplib?: true | InstrumentationConfig;
    /** kafkajs via @opentelemetry/instrumentation-kafkajs. Node-only; no-op elsewhere. */
    readonly kafkajs?: true | InstrumentationConfig;
  }
  ```

  `true` = enable on supported runtimes with OTel defaults. An `InstrumentationConfig` object =
  enable with an injected instance or a forwarded config. Omitting a key = that instrumentation is
  off.
- **Why:** ROADMAP §Milestone 24b mandates "per-instrumentation configuration, not a bare
  `string[]`" because OTel instrumentations take options a name-list cannot express.
  `true | InstrumentationConfig` covers enable-with-defaults, enable-with-config, and
  inject-a-prebuilt-instance in one honest shape, with zero fabricated OTel field names (the opaque
  `config` pass-through avoids the M10-style "option no implementation can honestly consume" trap).
  The five keys are exactly the five instrumentations in scope (§2 C2 resolves the `fetch`
  omission).
- **Test home:** `test/unit/instrumentation-registry.test.ts` — asserts each present key routes to
  its loader with the right OTel package specifier; `true` and `InstrumentationConfig` both enable;
  `config` is forwarded verbatim to the constructor; `instrumentation` (injected) bypasses the
  `npm:` import. Calls type-check against `InstrumentationsConfig` / `InstrumentationConfig`.

### 3.2 Runtime gating — pure predicate + documented no-op, never a throw

- **Decision:** All five instrumentations target Node internals (`node:http`, undici, ioredis,
  amqplib, kafkajs all patch Node module loading). The registry calls a PURE, unit-tested predicate
  `isInstrumentationSupported(kind: InstrumentationKind, platform: RuntimePlatform): boolean` that
  returns `true` ONLY when `platform === 'node'` (and `kind` is one of the five). When `false`, the
  instrumentation is a **documented no-op** (recorded in the registry outcome, never imported, never
  throws). When `true`, the loader attempts the lazy `npm:` import; if that import fails (package
  not installed) or `instrumentation.enable()` throws, the loader ALSO degrades to a documented
  no-op and records a single outcome entry — **it never throws**, because instrumentations are
  purely additive on top of an already-working provider + exporter + manual-span path. The decidable
  logic (`isInstrumentationSupported`, option→loader wiring, inject-vs-lazy branch, failure→no-op
  branch) lives in internal seams unit-tested with fake loaders; only the single
  `await import('npm:…')` line per loader is unreachable in unit tests and is exercised by the
  guarded real-import integration test (§6), matching the M24 precedent and CLAUDE.md self-review
  ("extract the decidable logic into an INTERNAL seam … rather than leaving the branch behind a test
  that skips").
- **Why:** ROADMAP §Milestone 24b makes runtime gating MANDATORY ("an unsupported target must
  degrade to a documented no-op, NEVER a throw"). Extending no-op semantics to package-missing is
  the honest choice for OPTIONAL add-ons: failing the entire telemetry plugin because one optional
  instrumentation's npm package is absent would be hostile and contradicts the spirit of the mandate
  (M24's core SDK lazy import DOES throw on absent — but that path is load-bearing; instrumentations
  are not). The pure predicate keeps the gate branch fully coverable without touching the network.
- **Test home:** `test/unit/instrumentation-registry.test.ts` —
  `isInstrumentationSupported('http','node')` === `true`,
  `isInstrumentationSupported('http','deno'|'bun'|'cloudflare-workers')` === `false` for every kind;
  a loader whose fake rejects resolves to a no-op outcome (no throw); a loader whose fake `enable()`
  throws resolves to a no-op outcome (no throw).

### 3.3 Reusing the inject-or-lazy `TracerHost` seam — optional `otelProvider` accessor

- **Decision:** The instrumentation registry needs the underlying OTel `TracerProvider` to call
  `instrumentation.setTracerProvider(provider)` per instance. To reach it without breaking the M24
  `TracerHost` interface or relying on the global singleton, 24b adds ONE optional,
  backward-compatible field to `TracerHost`:

  ```ts
  export interface TracerHost {
    startSpan(name, options?): unknown;
    extractContext(headers: Headers): TelemetryContext;
    injectContext(context: TelemetryContext): Record<string, string>;
    shutdown(): Promise<void>;
    forceFlush(): Promise<void>;
    /** The underlying OTel TracerProvider; undefined for noop/custom hosts (instrumentations then no-op). @since 0.24.1 */
    readonly otelProvider?: unknown;
  }
  ```

  The real host built by `buildTracerHost`
  ([`tracer.ts:282`](packages/telemetry-plugin/src/tracing/tracer.ts:282)) sets `otelProvider` to
  the constructed `BasicTracerProvider`. The noop host
  ([`telemetry-plugin.ts:124`](packages/telemetry-plugin/src/plugin/telemetry-plugin.ts:124)) and
  any custom `tracerProviderFactory` host leave it `undefined`. In `TelemetryPlugin.register()`,
  AFTER the host is obtained (factory or lazy — both paths converge here, so the inject seam is
  honored), the registry is built ONLY when `options.instrumentations` is set AND
  `tracerHost.otelProvider` is defined AND `options.exporter` is set (real mode). Otherwise
  instrumentations are a documented no-op (noop mode has no provider to attach to). Each enabled
  instrumentation receives `setTracerProvider(provider)` (per-instance — NOT
  `trace.setGlobalTracerProvider`, avoiding a process-wide singleton side effect per AI_GUIDELINES
  §11.4) then `enable()`. The registry returns a handle whose `shutdown()` awaits
  `instrumentation.disable()` on each before the provider flush.
- **Why:** This is the minimal change that lets instrumentations reuse the established
  inject-or-lazy seam (inject a host via `tracerProviderFactory`, or lazy-build one) while keeping
  the interface backward-compatible (optional field; AI_GUIDELINES §9.1). Converging factory + lazy
  paths in `register()` means the `instrumentations` option works identically whether the consumer
  injected a host or not — the only requirement is the host exposes `otelProvider`, which a custom
  factory can do if it wants instrumentations (and which the framework's own lazy host always does).
  Using `unknown` for `otelProvider` honors AI_GUIDELINES §5.2 (no `any`); the registry narrows it
  to a local structural `{ setTracerProvider?(p: unknown): void }`-shaped target.
- **Test home:** `test/unit/instrumentation-registry.test.ts` — `otelProvider` undefined → registry
  is a no-op (zero loaders called); `otelProvider` present → each enabled instrumentation's fake
  receives `setTracerProvider(theProvider)` then `enable()`. `test/unit/telemetry-plugin.test.ts` —
  `instrumentations` in noop mode (no `exporter`) is a documented no-op; in real mode with a fake
  factory exposing `otelProvider`, the registry runs against it.

### 3.4 `spanProcessor` choice — `'simple' | 'batch'`, default `'simple'`

- **Decision:** A NEW optional `spanProcessor?: SpanProcessorKind` field on
  `TelemetryPluginOptions`, where `export type SpanProcessorKind = 'simple' | 'batch';`. Default is
  `'simple'` (preserves M24 behavior byte-for-byte — `buildTracerHost` currently hardcodes
  `spanProcessors: [new SimpleSpanProcessor(exporter)]` at
  [`tracer.ts:282`](packages/telemetry-plugin/src/tracing/tracer.ts:282)). A NEW
  `src/services/span-processor-factory.ts` exports `createSpanProcessor(kind, exporter, sdkMod)`
  returning `new SimpleSpanProcessor(exporter)` for `'simple'` and
  `new BatchSpanProcessor(exporter)` for `'batch'` — BOTH constructors come from the same pinned
  `sdkMod` (`npm:@opentelemetry/sdk-trace-base@^2.9.0`, §1). `buildTracerHost` is MODIFIED to call
  this factory with `pluginOptions.spanProcessor ?? 'simple'` instead of the inline
  `new SimpleSpanProcessor(...)`; the `OtelSdkModule` type
  ([`tracer.ts:120`](packages/telemetry-plugin/src/tracing/tracer.ts:120)) is extended to declare
  `BatchSpanProcessor`. `BatchSpanProcessor` uses its OTel defaults
  (`maxQueueSize`/`scheduledDelayMillis`/…); no separate config object is exposed (avoiding
  speculative, unverified option surface — §3.1 rationale).
- **Why:** ROADMAP §Milestone 24b deliverable "`BatchSpanProcessor` as configurable alternative to
  `SimpleSpanProcessor`" + "Both processors are exported from the pinned `sdk-trace-base@^2.9.0`, so
  this adds no new dependency." Defaulting to `'simple'` means existing `TelemetryPlugin({...})`
  registrations are unchanged (no behavior drift). Routing through a factory keeps the processor
  selection a pure, fully-coverable unit (no `npm:` import inside the factory — the loaded `sdkMod`
  is passed in).
- **Test home:** `test/unit/span-processor-factory.test.ts` — `'simple'` calls
  `SimpleSpanProcessor`, `'batch'` calls `BatchSpanProcessor`, both off the same fake `sdkMod`;
  default (`undefined`) maps to `'simple'`. `test/unit/tracer.test.ts` (EXTEND) — `buildTracerHost`
  passes `pluginOptions.spanProcessor` to the factory and the provider config's `spanProcessors[0]`
  is the chosen processor.

### 3.5 Shutdown ordering — disable instrumentations before provider flush

- **Decision:** When a real provider exists AND instrumentations were enabled, the plugin's
  `onShutdown` hook (already present at
  [`telemetry-plugin.ts:88`](packages/telemetry-plugin/src/plugin/telemetry-plugin.ts:88)) first
  `await instrumentationHandle?.shutdown()` (which `disable()`s each instrumentation, stopping new
  spans), THEN `await tracerHost.shutdown()` (which flushes + closes the provider/exporter). The
  instrumentation handle is `null` in noop mode or when no instrumentation enabled.
- **Why:** Disabling instrumentations first prevents a race where a patched module emits a span
  after the provider has begun shutting down (a real `BatchSpanProcessor` flush concern). Ordering
  the two shutdowns deterministically makes the behavior testable and matches AI_GUIDELINES §14.5
  (graceful shutdown, no leaked spans).
- **Test home:** `test/unit/telemetry-plugin.test.ts` — `onShutdown` calls
  `instrumentationHandle.shutdown()` then `tracerHost.shutdown()` (fakes record call order); noop
  mode registers no instrumentation handle and only the (absent) provider shutdown.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                                                                           | Kind                 | Consumer / real code path that READS it                                                                                                                                                                                                       |
| --------------------------------------------------------------------------------------------------------- | -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TelemetryPlugin`                                                                                         | function (MODIFIED)  | Application authors (`app.register(TelemetryPlugin({ ..., instrumentations, spanProcessor }))`); `telemetry-plugin.test.ts`. Now reads the two new options in `register()`.                                                                   |
| `TelemetryPluginOptions`                                                                                  | type (MODIFIED)      | Application authors; the factory. Gains `instrumentations?: InstrumentationsConfig` + `spanProcessor?: SpanProcessorKind`.                                                                                                                    |
| `InstrumentationsConfig`                                                                                  | interface (NEW)      | `TelemetryPluginOptions.instrumentations`; the `instrumentation-registry` reads its keys.                                                                                                                                                     |
| `InstrumentationConfig`                                                                                   | interface (NEW)      | The value type of each `InstrumentationsConfig` key; the per-domain loaders read `.instrumentation` (inject) and `.config` (lazy forward).                                                                                                    |
| `InstrumentationKind`                                                                                     | type union (NEW)     | `'http' \| 'fetch' \| 'ioredis' \| 'amqplib' \| 'kafkajs'` — the registry's `isInstrumentationSupported(kind, platform)` argument and the loader-dispatch key. Exported so consumers typing a custom registry/introspection can name the set. |
| `SpanProcessorKind`                                                                                       | type union (NEW)     | `TelemetryPluginOptions.spanProcessor` (`'simple' \| 'batch'`); consumed by `span-processor-factory`.                                                                                                                                         |
| `TracerHost`                                                                                              | interface (MODIFIED) | `tracerProviderFactory` returns it; `TelemetryService` consumes it; the instrumentation registry reads the new optional `otelProvider`.                                                                                                       |
| `telemetryMiddleware`, `TELEMETRY_SPAN_KEY`, `NoopTelemetryService`, `SpanExporterKind`, `SamplingConfig` | (unchanged)          | Re-exported as in M24.                                                                                                                                                                                                                        |

> The per-domain loader modules (`instrumentation-registry.ts`, `http-instrumentation.ts`,
> `database-instrumentation.ts`, `queue-instrumentation.ts`) and `span-processor-factory.ts` are
> INTERNAL — NOT exported from `src/index.ts` (they are reached through the public `TelemetryPlugin`
> factory, exactly as M24 keeps `loadOtelTracerProvider`/`TelemetryService` internal). They are
> tested via their file paths.
> `InstrumentationKind`/`InstrumentationConfig`/`InstrumentationsConfig`/ `SpanProcessorKind` ARE
> exported (they are the public option surface consumers type against).

### 4.1 Options — every option names its consumer

| Option                                          | Consumer                                                           | Behavior (per implementation)                                                                                                                                                                                                                          |
| ----------------------------------------------- | ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `TelemetryPluginOptions.instrumentations` (NEW) | `TelemetryPlugin.register` → `buildInstrumentationRegistry`        | Per-instrumentation config (NOT `string[]`). Only effective in real mode (`exporter` set) with a host exposing `otelProvider`; otherwise documented no-op. Each present key enables one instrumentation on supported runtimes (Node), no-op elsewhere. |
| `TelemetryPluginOptions.spanProcessor` (NEW)    | `loadOtelTracerProvider`/`buildTracerHost` → `createSpanProcessor` | `'simple'` (default — M24 behavior) or `'batch'`. Selects `SimpleSpanProcessor` vs `BatchSpanProcessor`, both from `npm:@opentelemetry/sdk-trace-base@^2.9.0`.                                                                                         |
| `InstrumentationConfig.instrumentation` (NEW)   | the per-domain loader                                              | INJECT half: a pre-built OTel `Instrumentation` instance; skips the lazy `npm:` import.                                                                                                                                                                |
| `InstrumentationConfig.config` (NEW)            | the per-domain loader → OTel constructor                           | LAZY half: opaque record forwarded verbatim to the instrumentation constructor's `config` arg.                                                                                                                                                         |
| (existing M24 options)                          | (unchanged)                                                        | `serviceName`/`serviceVersion`/`exporter`/`endpoint`/`headers`/`sampling`/`tracerProviderFactory`/`middleware` — unchanged behavior; `tracerProviderFactory` hosts now MAY expose `otelProvider` to opt into instrumentations.                         |

## 5. Implementation files

| File                                                                              | Purpose                                                                                                                                                                                                                                                                                                                                                 |
| --------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/telemetry-plugin/src/interfaces/index.ts` (MODIFY)                      | Add `SpanProcessorKind`, `InstrumentationKind`, `InstrumentationConfig`, `InstrumentationsConfig`; add `instrumentations?` + `spanProcessor?` to `TelemetryPluginOptions`; add optional `readonly otelProvider?: unknown` to `TracerHost`.                                                                                                              |
| `packages/telemetry-plugin/src/instrumentation/instrumentation-registry.ts` (NEW) | `buildInstrumentationRegistry({ config, runtime, provider })` → iterates the 5 kinds, calls `isInstrumentationSupported(kind, platform)` (pure), dispatches to the per-domain loader, attaches via `setTracerProvider` + `enable()`, degrades any failure to a documented no-op (never throws), returns a handle with `shutdown()` + an outcome record. |
| `packages/telemetry-plugin/src/instrumentation/http-instrumentation.ts` (NEW)     | Loaders for the `http` kind (`npm:@opentelemetry/instrumentation-http@^0.220.0` → `HttpInstrumentation`) and the `fetch` kind (`npm:@opentelemetry/instrumentation-undici@^0.30.0` → `UndiciInstrumentation`). Honors inject (`InstrumentationConfig.instrumentation`) vs lazy; forwards `.config`.                                                     |
| `packages/telemetry-plugin/src/instrumentation/database-instrumentation.ts` (NEW) | Loader for the `ioredis` kind (`npm:@opentelemetry/instrumentation-ioredis@^0.68.0` → `IORedisInstrumentation`). Same inject/lazy + config-forward contract.                                                                                                                                                                                            |
| `packages/telemetry-plugin/src/instrumentation/queue-instrumentation.ts` (NEW)    | Loaders for the `amqplib` kind (`npm:@opentelemetry/instrumentation-amqplib@^0.67.0` → `AmqplibInstrumentation`) and `kafkajs` kind (`npm:@opentelemetry/instrumentation-kafkajs@^0.29.0` → `KafkaJsInstrumentation`). Same contract.                                                                                                                   |
| `packages/telemetry-plugin/src/services/span-processor-factory.ts` (NEW)          | `createSpanProcessor(kind: SpanProcessorKind, exporter, sdkMod)` → `SimpleSpanProcessor` or `BatchSpanProcessor` from the passed-in `sdkMod` (no `npm:` import inside the factory).                                                                                                                                                                     |
| `packages/telemetry-plugin/src/tracing/tracer.ts` (MODIFY)                        | Add `BatchSpanProcessor` to `OtelSdkModule`; in `buildTracerHost` replace the inline `new SimpleSpanProcessor(exporter)` with `createSpanProcessor(pluginOptions.spanProcessor ?? 'simple', exporter, sdkMod)`; set `otelProvider: provider` on the returned `TracerHost`.                                                                              |
| `packages/telemetry-plugin/src/plugin/telemetry-plugin.ts` (MODIFY)               | In `register()`, after obtaining `tracerHost`, build the instrumentation registry when `options.instrumentations` + real mode + `tracerHost.otelProvider` all hold; extend `onShutdown` to `await handle?.shutdown()` then `await tracerHost.shutdown()`.                                                                                               |
| `packages/telemetry-plugin/src/index.ts` (MODIFY)                                 | Export the new public types: `InstrumentationsConfig`, `InstrumentationConfig`, `InstrumentationKind`, `SpanProcessorKind` (value/`export type` as appropriate).                                                                                                                                                                                        |
| `packages/telemetry-plugin/deno.json`                                             | UNCHANGED. No new `imports` entry (all OTel pkgs are lazy `npm:`); `tests.permissions` already grants `import` + `net` for the guarded probes. (Listed here so reviewers confirm it is intentionally untouched — §1.)                                                                                                                                   |
| `PUBLIC_API.md`                                                                   | Telemetry section: replace the M24b deferral note (§2 C1) with the real surface; options table gains `instrumentations` + `spanProcessor`; worked example showing `instrumentations: { http: true, ioredis: { config: {...} } }` + `spanProcessor: 'batch'`.                                                                                            |
| `ARCHITECTURE.md`                                                                 | Telemetry-plugin row: note auto-instrumentation (runtime-gated, Node-only kinds) + `spanProcessor: 'simple'\|'batch'` + the `otelProvider` accessor; §10 middleware table unchanged (priority 30 untouched).                                                                                                                                            |
| `ROADMAP.md`                                                                      | M24b file/test lists corrected per §2 C2–C4 (add `fetch`, add `queue-instrumentation.test.ts`, note `tracer.ts` modification); flip the `24b` progress row `⬜` → `✅`; check the four M24b deliverables; the M24 deferral note ([`ROADMAP.md:2506`](ROADMAP.md:2506)) gets a one-line "delivered by M24b" pointer (kept as history).                   |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                       | src covered                                                                        | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ----------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/telemetry-plugin/test/unit/instrumentation-registry.test.ts` (NEW)                    | `src/instrumentation/instrumentation-registry.ts`                                  | `isInstrumentationSupported(kind,'node')`===true and ===false for `'deno'\|'bun'\|'cloudflare-workers'` for ALL five kinds; each present `InstrumentationsConfig` key routes to its loader with the exact OTel specifier; `true` enables with defaults; `InstrumentationConfig.config` forwarded verbatim to the constructor; `InstrumentationConfig.instrumentation` (injected) bypasses the `npm:` import; `otelProvider` undefined → registry is a no-op (zero loaders); a loader fake that rejects or whose `enable()` throws → no-op outcome (NO throw, never); each enabled fake receives `setTracerProvider(provider)` then `enable()`; `handle.shutdown()` calls `disable()` on each enabled fake. Calls type-check against `buildInstrumentationRegistry({ config: InstrumentationsConfig, runtime: IRuntimeServices, provider: unknown })`. |
| `packages/telemetry-plugin/test/unit/http-instrumentation.test.ts` (NEW)                        | `src/instrumentation/http-instrumentation.ts`                                      | `http` loader lazy-imports `npm:@opentelemetry/instrumentation-http@^0.220.0` and constructs `HttpInstrumentation` (fake dynamic-import seam records specifier + ctor args); `fetch` loader lazy-imports `npm:@opentelemetry/instrumentation-undici@^0.30.0` and constructs `UndiciInstrumentation`; injected `instrumentation` short-circuits the import; `config` reaches the ctor's config arg; a rejecting import resolves to a no-op outcome (no throw).                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/telemetry-plugin/test/unit/database-instrumentation.test.ts` (NEW)                    | `src/instrumentation/database-instrumentation.ts`                                  | `ioredis` loader lazy-imports `npm:@opentelemetry/instrumentation-ioredis@^0.68.0` → `IORedisInstrumentation`; inject path; config-forward; no-op-on-import-failure.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/telemetry-plugin/test/unit/queue-instrumentation.test.ts` (NEW — §2 C3)               | `src/instrumentation/queue-instrumentation.ts`                                     | `amqplib` loader → `npm:@opentelemetry/instrumentation-amqplib@^0.67.0`/`AmqplibInstrumentation`; `kafkajs` loader → `npm:@opentelemetry/instrumentation-kafkajs@^0.29.0`/`KafkaJsInstrumentation`; inject path; config-forward; no-op-on-import-failure for each.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `packages/telemetry-plugin/test/unit/span-processor-factory.test.ts` (NEW)                      | `src/services/span-processor-factory.ts`                                           | `createSpanProcessor('simple', exp, fakeSdk)` returns a `SimpleSpanProcessor` instance off `fakeSdk`; `('batch', …)` returns `BatchSpanProcessor` off the SAME `fakeSdk` (asserts both ctors come from one module); `(undefined→'default', …)` maps to `'simple'`. No `npm:` import inside the factory (fake `sdkMod` passed in → fully covered).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/telemetry-plugin/test/unit/tracer.test.ts` (EXTEND)                                   | `src/tracing/tracer.ts` (modified)                                                 | `buildTracerHost` calls `createSpanProcessor(pluginOptions.spanProcessor ?? 'simple', exporter, sdkMod)` and the provider's `spanProcessors[0]` is the chosen processor (`'batch'` → BatchSpanProcessor, default → SimpleSpanProcessor); the returned `TracerHost` exposes `otelProvider === provider`; the lazy `npm:@opentelemetry/sdk-trace-base@^2.9.0` specifier is unchanged (existing assertion still pins it).                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/telemetry-plugin/test/unit/telemetry-plugin.test.ts` (EXTEND)                         | `src/plugin/telemetry-plugin.ts` (modified)                                        | `instrumentations` in noop mode (no `exporter`) is a documented no-op (registry not built, no throw); real mode (`exporter:'console'`) + `instrumentations:{http:true}` + a fake `tracerProviderFactory` exposing `otelProvider` builds the registry and the fake instrumentation is enabled; `spanProcessor:'batch'` is forwarded (fake factory records it); `onShutdown` calls `handle.shutdown()` THEN `tracerHost.shutdown()` (ordered); noop mode registers no instrumentation handle.                                                                                                                                                                                                                                                                                                                                                           |
| `packages/telemetry-plugin/test/unit/barrel-exports.test.ts` (EXTEND)                           | `src/index.ts` (modified)                                                          | Asserts the new type exports (`InstrumentationsConfig`, `InstrumentationConfig`, `InstrumentationKind`, `SpanProcessorKind`) are present (compile-time re-export check matching the existing M24 barrel-test style).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/telemetry-plugin/test/integration/instrumentation-real-import.test.ts` (NEW, guarded) | `src/instrumentation/*.ts` + `src/services/span-processor-factory.ts` (real paths) | Guarded REAL `await import('npm:@opentelemetry/instrumentation-http@^0.220.0')`, `…-undici@^0.30.0`, `…-ioredis@^0.68.0`, `…-amqplib@^0.67.0`, `…-kafkajs@^0.29.0` — one `it({ name, ignore: !canImportNpm() })` per package (reusing [`otlp-real-import.test.ts:13`](packages/telemetry-plugin/test/integration/otlp-real-import.test.ts:13)). When it runs: constructs each instrumentation, asserts `setTracerProvider`/`enable`/`disable` are functions (proves the specifier + export name resolve), and constructs a real `BatchSpanProcessor` + `SimpleSpanProcessor` off `npm:@opentelemetry/sdk-trace-base@^2.9.0` to prove the processor choice resolves. No network, no real module patching side effects asserted beyond construction.                                                                                                    |
| `packages/telemetry-plugin/test/fixtures/fake-instrumentation.ts` (NEW)                         | (fixture)                                                                          | A fake OTel `Instrumentation` (records `setTracerProvider`/`enable`/`disable`/`setConfig` calls) + a fake dynamic-import map keyed by specifier, so the unit tests drive the inject/lazy/no-op branches without the network.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

> Per-file 90% bar: every NEW `src/` file clears 90% branch/function/line. The only lines behind a
> guarded skip are the five `await import('npm:@opentelemetry/instrumentation-*)` statements + the
> single `BatchSpanProcessor`/`SimpleSpanProcessor` real construction — exactly mirroring M24's
> treatment of its OTel lazy imports. Every decidable branch around them (platform gate,
> inject-vs-lazy, config-forward, failure→no-op, processor selection) is unit-tested via the fake
> loader / fake `sdkMod` seams, never left behind a skip.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/24-b-auto-instrumentation, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
deno task audit             # no new high-severity vulnerabilities (no hard deps added; lazy npm: only)
```

After implementation, grep for forbidden constructs in the touched package:

```bash
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__\|setGlobalTracerProvider" packages/telemetry-plugin/src
#   → must be empty (comments excepted). setGlobalTracerProvider is explicitly AVOIDED (§3.3).
```

Two specifier-integrity greps specific to this milestone's verified pins (§1):

```bash
# Instrumentation specifiers must read the verified versions (no fabricated names):
grep -rn "instrumentation-http@\|instrumentation-undici@\|instrumentation-fetch@\|instrumentation-ioredis@\|instrumentation-amqplib@\|instrumentation-kafkajs@" packages/telemetry-plugin/src
#   → http @^0.220.0 ; undici @^0.30.0 ; ioredis @^0.68.0 ; amqplib @^0.67.0 ; kafkajs @^0.29.0
#   → instrumentation-fetch MUST NOT appear (browser-only; fetch uses instrumentation-undici)
# BatchSpanProcessor must come from the pinned sdk-trace-base (no new dep):
grep -rn "BatchSpanProcessor" packages/telemetry-plugin/src
#   → only via the OtelSdkModule type + createSpanProcessor, no separate npm: specifier
```

## 8. Risks & mitigations

- **OTel instrumentation module-patching timing.** Instrumentations patch Node module loading in
  `enable()`; they only catch imports that happen AFTER enable. If another plugin
  (messaging/queue/cache) eagerly imports ioredis/amqplib/kafkajs at its own `register()` before the
  telemetry plugin enables instrumentations, those modules may already be loaded and unpatched.
  **Mitigation:** the telemetry plugin keeps its existing priority (30); the instrumentation-enable
  step runs synchronously inside `register()` before it resolves, so any plugin registering AFTER
  telemetry (lower-priority-number plugins register earlier — telemetry at 30 registers before most
  domain plugins) gets patched imports. Documented limitation: a higher-priority plugin that already
  imported the target is not retro-patched (an inherent OTel constraint, out of scope to solve). The
  `instrumentation` inject seam lets advanced users enable instrumentations even earlier if they
  construct the plugin graph to guarantee ordering.
- **Two independent OTel version lines (the M24 trap, revisited).** The core experimental
  instrumentation packages (`instrumentation-http`, `instrumentation`) are on `0.220.0`, while the
  contrib packages (`undici@0.30.0`, `ioredis@0.68.0`, `amqplib@0.67.0`, `kafkajs@0.29.0`) version
  independently, and the stable SDK is on `2.9.0`. **Mitigation:** §1 records each
  `dist-tags.latest` from the real registry (read 2026-07-21); the §7 greps re-pin the exact
  specifiers; the guarded integration test executes each real import once so a wrong/renamed package
  fails the suite, not a production runtime.
- **`BatchSpanProcessor` buffers spans — shutdown must flush.** A batch processor holds spans until
  its queue fills or its timer fires; an unflushed shutdown drops them. **Mitigation:** §3.5 orders
  shutdown (disable instrumentations → `tracerHost.shutdown()` which calls `provider.shutdown()` →
  flushes the batch). The `onShutdown` hook is already registered in M24; 24b only extends it.
- **No implicit parent/child linking across `await` (carried from M24).** The framework registers no
  OTel `ContextManager` (the runtime-agnostic option pulls `node:async_hooks`, violating §4). Spans
  created by auto-instrumentations therefore parent off whatever context the instrumentation's own
  patching establishes, NOT off the request-span middleware's server span. **Mitigation:**
  documented limitation (M24 §3 note); `setTracerProvider` is used per-instance so the
  instrumentations at least report to the configured provider/exporter. Cross-cutting context
  propagation is explicitly NOT in M24b (§0).

## 9. Out of scope

- **Cross-package `traceparent` propagation over the message broker / queue** (editing
  `messaging-plugin` / `queue-plugin` to inject/extract trace context on the wire) — a later
  cross-cutting milestone (ROADMAP §Milestone 24b "NOT in M24b").
- **Browser-targeted `fetch` instrumentation** (`@opentelemetry/instrumentation-fetch`) — the
  framework is a server-side backend; `fetch` maps to `instrumentation-undici` (Node). §1.
- **Per-instrumentation typed config interfaces** (re-typing OTel's evolving config fields like
  `ignoreIncomingRequestHook`/`dbStatementSerializer`) — avoided as fabrication risk; the opaque
  `config` pass-through (§3.1) forwards whatever the consumer supplies. A later milestone may add
  framework-owned typed wrappers once the OTel config surface is verified from source.
- **Metrics/Logs signals, an OTel `ContextManager`, and the M35 SDK / M36 starter `telemetry:`
  config block** — owned by their respective milestones. The `instrumentations`/`spanProcessor`
  shape landed here is the stable contract those will map onto (§0).
