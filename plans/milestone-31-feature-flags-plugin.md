# Milestone 31 — Feature Flags Plugin (`@hono-enterprise/feature-flags-plugin`)

> **Status:** Planning. Branch: `feat/31-feature-flags-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch and merges via a single PR.

## 0. Objective & scope

Provide feature flag capability as a plugin. `FeatureFlagsPlugin(options)` registers the committed
`IFeatureFlags` contract under `CAPABILITIES.FEATURE_FLAGS`. The committed contract is **synchronous**
(`isEnabled(flag, context?): boolean`, unknown flags → `false`, see §1), so the design is built around
one rule stated on the contract itself: *"providers refresh their state out of band."* A thin
`FeatureFlagService implements IFeatureFlags` delegates to an internal `FlagProvider` port whose
implementations own a cached snapshot and an async `start()`/`stop()` lifecycle that the plugin
orchestrates from `register()` (async) and `onClose`. Four providers ship — `ConfigProvider` (static
inline flags, the `'config'` default), `MemoryProvider` (mutable in-process store for tests and dynamic
toggles), `DatabaseProvider` (polls an injected `IFlagStore` on a runtime timer into a snapshot), and
`LaunchDarklyProvider` (lazily imports the modern `npm:@launchdarkly/node-server-sdk@^9.12.3`, awaits
`waitForInitialization`, then evaluates synchronously via the LD client's in-memory store) — plus a
`'custom'` arm that accepts any `FlagProvider` instance (ARCHITECTURE's "Custom flag provider"
extension point). A free-function route guard `createFlagGuard(flag, options)` short-circuits to a
redirect or `404` when a flag is off (the committed `IFeatureFlags` has no `middleware` method, so the
ROADMAP/PUBLIC_API `flags.middleware(...)` example is a doc conflict resolved in §2-C1). Static
providers share one pure `evaluateFlag` seam (enabled → user allowlist → deterministic percentage
bucket); the LaunchDarkly provider delegates targeting to LaunchDarkly's own engine and forwards
`FlagContext.attributes` into the LD context, which is the real consumer of that committed field.

- **In scope:** the `IFeatureFlags` implementation (`FeatureFlagService`), the four providers plus the
  `'custom'` injection arm, the shared `FlagProvider` port, the pure `evaluateFlag`/`bucket` seam, the
  `createFlagGuard` middleware factory, the `FeatureFlagsPlugin` factory with `createProvider`, a
  `feature-flags` health indicator, an `onClose` that stops timers and closes the LD client, and full
  per-file test coverage (≥90% branch/function/line) including a guarded real-import test for the LD
  module and a mandatory short-circuit test for the guard.
- **NOT this milestone:** server-side flag admin/mutation endpoints and an audit trail of flag changes
  (app concern; compose `audit-plugin` M26); LaunchDarkly edge/client SDKs and the deprecated
  `launchdarkly-node-server-sdk` package (superseded — §2-C2); a generic rule/segment engine beyond the
  built-in `enabled`/`users`/`percentage` targeting (LaunchDarkly owns enterprise targeting, and
  inventing a second rule engine here would be dead surface); live flag-change push from the
  `DatabaseProvider` (it polls on a timer; push would need a runtime watch/stream seam that does not
  exist); multi-tenancy-aware flag overrides (M32 owns tenancy).

## 1. Contracts verified from SOURCE (not names)

| Reference                                | Source (file:line)                                    | Verified surface / fact                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------- | ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IFeatureFlags`                          | `packages/common/src/services/feature-flags.ts:33`    | `isEnabled(flag: string, context?: FlagContext): boolean` — **synchronous**; "unknown flags evaluate to `false`". The ONLY method: no `middleware`, no `isEnabledAsync`, no `getFlag`.                                                                                                                                                              |
| `FlagContext`                            | `packages/common/src/services/feature-flags.ts:13`    | `{ readonly userId?: string; readonly attributes?: Readonly<Record<string, string \| number \| boolean>> }`. `attributes` is "Additional targeting attributes" — an extension point with no built-in consumer, which the LD provider consumes by forwarding it into the LD context.                                                                   |
| common barrel re-export                  | `packages/common/src/index.ts:169`                    | `export type { FlagContext, IFeatureFlags } from './services/feature-flags.ts';` — both already public from `common`; this package re-exports them for consumer convenience (M29/M30 precedent).                                                                                                                                                     |
| `CAPABILITIES.FEATURE_FLAGS`             | `packages/common/src/tokens.ts:85`                    | `FEATURE_FLAGS: 'feature-flags'` — lowercase kebab, already committed (no new token, no `common` change).                                                                                                                                                                                                                                            |
| `IPlugin`                                | `packages/common/src/plugin.ts:470`                   | `name`, `version`, `provides`, `optionalDependencies`, `priority`, `register(ctx): void \| Promise<void>` — `register` MAY return a Promise, which the LD/DB providers need for async init.                                                                                                                                                         |
| `IPluginContext`                         | `packages/common/src/plugin.ts:409`                   | `runtime` is non-optional (line 435); `logger?` is directly on the context (line 439); `health.register` (line 419); `lifecycle.onClose` (line 429). No need to resolve `CAPABILITIES.LOGGER` through the registry to log.                                                                                                                           |
| `IHealthApi.register`                    | `packages/common/src/plugin.ts:187`                   | `register(name: string, indicator: HealthIndicatorFn): void`.                                                                                                                                                                                                                                                                                       |
| `HealthIndicatorFn` / `HealthCheckResult`| `packages/common/src/services/health.ts:26,13`        | `() => Promise<HealthCheckResult>`; result `{ status: HealthStatus; data?: Readonly<Record<string, unknown>> }`; `HealthStatus = 'up' \| 'down' \| 'degraded'` (`types.ts:60`).                                                                                                                                                                     |
| `optionalDependencies` ordering          | `packages/kernel/src/registry/plugin-resolver.ts:49`  | An edge is added only when the provider is present (lines 49-54); absent ⇒ no edge and no throw. So `optionalDependencies: [CAPABILITIES.LOGGER]` orders LoggerPlugin before this plugin WHEN present, letting the DB provider read `ctx.logger` safely; when absent it is tolerated.                                                               |
| duplicate-name / duplicate-provider throw | `packages/kernel/src/registry/plugin-resolver.ts:107,124` | `assertUniqueNames` throws on a reused plugin name; `buildProviderIndex` throws on two plugins providing the same capability. The plugin name is the fixed `feature-flags-plugin` and it is the sole provider of `feature-flags`, so no multi-instance concern.                                                                                      |
| `IRuntimeServices.setInterval` / `clearInterval` | `packages/common/src/runtime.ts:247,253`       | `setInterval(fn: () => void, ms: number): TimerHandle` and `clearInterval(handle: TimerHandle): void` — the DB provider polls via these, never the global `setInterval` (AI_GUIDELINES §4.2). `now()`/`hrtime()` at lines 218/225 (monotonic).                                                                                                       |
| `MiddlewareFunction` / `IRequestContext` / `IResponse.redirect` | `packages/common/src/http.ts:248,193,151` | Middleware is `(ctx: IRequestContext, next: NextFunction) => void \| HandlerResult \| Promise<...>`; short-circuit by returning a response without calling `next()`. `ctx.services` (line 201) resolves the flag service per request; `ctx.request.user` (line 47) builds the context; `redirect(url, status?)` (line 151) builds the fallback response. |
| `IPrincipal.id`                          | `packages/common/src/services/auth.ts:16,18`          | `id: string` is the stable subject identifier → maps to `FlagContext.userId`.                                                                                                                                                                                                                                                                        |
| `PLUGIN_PRIORITY.NORMAL`                 | `packages/common/src/types.ts:84`                     | `500` (default band for capability plugins).                                                                                                                                                                                                                                                                                                         |
| ROADMAP M31 scope                        | `ROADMAP.md:3152`                                     | file list at lines 3197-3203; providers bullet list at 3188-3193 (names `Config`/`Database`/`LaunchDarkly`/`Memory`); config example 3160-3169; `flags.middleware(...)` example at 3183.                                                                                                                                                            |
| PUBLIC_API Feature Flags                 | `PUBLIC_API.md:3071`                                  | registration 3080, usage + `flags.middleware(...)` 3095-3111, contract summary row 4534 (`IFeatureFlags`, `FlagContext`). Lacks the Options/Exports/Notes subsections every sibling section carries.                                                                                                                                                 |
| ARCHITECTURE feature-flags               | `ARCHITECTURE.md:1397`                                | Public API `FeatureFlagsPlugin()`; `IFeatureFlags`; Extension Points "Custom flag provider"; Rules "Config provider for simple cases; LaunchDarkly for enterprise".                                                                                                                                                                                  |
| Progress tracking                        | `ROADMAP.md:4223`                                     | `| 31 | ⬜ | feature-flags-plugin |` — must flip to ✅ in the milestone PR (CLAUDE.md "Before reporting a task done").                                                                                                                                                                                                                                  |
| LaunchDarkly package reality             | npm registry                                          | `launchdarkly-node-server-sdk@7.0.4` is **deprecated** ("replaced by @launchdarkly/node-server-sdk"); the current non-deprecated server SDK is `@launchdarkly/node-server-sdk@9.12.3` (CommonJS, `engines.node >=12`, exports `init`; client exposes `waitForInitialization`, `variation`, `close`). Plan pins `npm:@launchdarkly/node-server-sdk@^9.12.3`. |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                     | Resolution (picked side)                                                                                                                                                                                                                                                                                                   | Doc deliverable (same PR)                                                                                                                                                                                                              |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md:3183` and `PUBLIC_API.md:3108` call `flags.middleware('beta-features', { fallback })` as if it were a method on `IFeatureFlags`, but the committed `IFeatureFlags` (`feature-flags.ts:33`) has ONLY `isEnabled`. Adding a `middleware` method would widen a committed `common` contract (a major, flagged change) for sugar that is better as a free function — exactly how M16's guards are free middleware factories, not methods on `IAuthService`. | Honor the committed contract: ship a free-function guard `createFlagGuard(flag, options?)` exported from the plugin (§3.4). No method is added to `IFeatureFlags`; no `common` change.                                                                                                                                      | Correct the ROADMAP M31 and PUBLIC_API Feature Flags examples to `middleware: [createFlagGuard('beta-features', { fallback: '/not-found' })]`.                                                                                         |
| C2 | Committed docs say "LaunchDarkly" (`ARCHITECTURE.md:1406`, ROADMAP/PUBLIC_API provider list) but pin no npm specifier. The name a reader would reach for — `launchdarkly-node-server-sdk` — is **deprecated upstream** (registry marks 7.0.4 deprecated, replaced by the scoped `@launchdarkly/node-server-sdk`). | Pin the real, non-deprecated package: `npm:@launchdarkly/node-server-sdk@^9.12.3`, loaded behind an injectable `loadLaunchDarklyModule` seam + `ILaunchDarklyClient` facade (§3.3).                                                                                                                                                              | Add a Feature Flags **Notes** subsection to PUBLIC_API.md stating the specifier and that the unscoped `launchdarkly-node-server-sdk` is deprecated and intentionally not used.                                                          |
| C3 | `PUBLIC_API.md:3071` Feature Flags section ships only Registration + Usage. Every sibling section (Notifications, Mail, Storage, …) also carries Options / Exports / Notes subsections; the new `src/index.ts` surface would otherwise be undocumented (the exact gap M30 closed for Notifications, §C4 there). | Add the missing Feature Flags Options / Exports / Notes subsections to PUBLIC_API.md, listing every §4 symbol with one-line JSDoc-grade descriptions.                                                                                                                                                                      | PUBLIC_API.md Feature Flags Options/Exports/Notes subsections (new).                                                                                                                                                                  |
| C4 | `ROADMAP.md:3193` names `MemoryProvider` in the Providers bullet list, but the M31 "Implementation Files" list (`ROADMAP.md:3195-3203`) omits `src/providers/memory-provider.ts`.                                                                                                                            | Ship `src/providers/memory-provider.ts` (the four providers in the bullet list are all in scope); this plan's §5 adds it, plus the `evaluation/` and `interfaces/` modules the design needs (same "add the shared modules the design needs" approach M30 took for `interfaces/` and `http/`). | Correct the ROADMAP M31 implementation-files list to include `src/providers/memory-provider.ts` (and note the added `evaluation/flag-evaluator.ts`, `interfaces/index.ts`).                                                            |

## 3. Design decisions

### 3.1 Synchronous contract → provider port with an async lifecycle

- **Decision:** define an internal `FlagProvider` port — `isEnabled(flag: string, context?: FlagContext): boolean`
  (synchronous, mirrors the committed contract), `start(): Promise<void>` (pull/stream initial state into
  the cache), `stop(): Promise<void>` (release timers/connections). `FeatureFlagService implements
  IFeatureFlags` holds one `FlagProvider`, delegates `isEnabled` to it, and exposes `start`/`stop` for the
  plugin to call. The plugin's `register()` is **async**: it constructs the provider via `createProvider`,
  constructs `FeatureFlagService(provider)`, `await service.start()` (LD awaits
  `waitForInitialization`; DB does the initial `loadFlags` and arms the poll timer; config/memory no-op),
  then registers the service under `CAPABILITIES.FEATURE_FLAGS`.
- **Why:** the committed contract is synchronous and states providers refresh out of band; the only way
  async providers (DB, LD) honor a sync `isEnabled` is to have completed their async load BEFORE the first
  evaluation. Running that load inside async `register()` (which the `IPlugin` contract permits) guarantees
  the snapshot/client is ready before the app serves, and surfaces init failure at startup rather than at
  first request. This mirrors how M29's `register` resolves its provider and how M25's providers own their
  cache.
- **Test home:** `feature-flags-service.test.ts` (delegation + `start`/`stop` drive a fake provider's
  lifecycle) and `feature-flags-plugin.test.ts` (`register` awaits `start`; the registered service
  evaluates; `onClose` calls `stop`).

### 3.2 Static flag evaluation — one pure seam, deterministic rollout

- **Decision:** a pure internal `evaluateFlag(flag: string, def: FlagDefinition | undefined, context:
  FlagContext | undefined): boolean` (in `src/evaluation/flag-evaluator.ts`, NOT re-exported from the
  barrel — consumed by the three static providers, tested directly). Precedence: (1) `def === undefined`
  → `false` (the committed "unknown flag → false"); (2) `def.enabled === false` → `false`; (3) `def.users`
  present and `context?.userId` is a member → `true` (explicit allowlist); (4) `def.percentage` present →
  `bucket(flag, userId) < percentage` (see below); (5) otherwise `true`. `FlagDefinition` is exactly the
  ROADMAP shape — `{ enabled: boolean; percentage?: number; users?: readonly string[] }` — no invented
  fields. `bucket(key)` is a zero-dependency FNV-1a 32-bit hash of `${flag}:${userId}` reduced modulo 100,
  computed over `hash(flag) XOR hash(userId)` so two flags roll users out independently. Percentage
  semantics: `>= 100` → on, `<= 0` → off, and with no `userId` a partial rollout (`0 < p < 100`) evaluates
  `false` (a stable bucket needs a stable key; documented and asserted).
- **Why:** the percentage test in the ROADMAP deliverables ("Percentage rollout") needs determinism to be
  testable without flakiness; a hash keyed on flag+userId gives stable per-user buckets (the same user
  always sees the same verdict) while distributing users across flags. Keeping evaluation in one pure
  function lets the per-file coverage bar be met by direct unit tests instead of through a provider, and
  avoids duplicating the precedence across config/memory/database (the DRY rule and the "duplicated logic
  → route through a shared helper" technique in CLAUDE.md's self-review). The committed `FlagContext.attributes`
  is deliberately NOT consumed here — LaunchDarkly owns attribute targeting; building a second rule engine
  in the static providers would be dead surface no design decision needs.
- **Test home:** `flag-evaluator.test.ts` — unknown flag → `false`; `enabled:false` → `false`; allowlist
  hit → `true`, miss → falls through; `percentage:100` → `true`, `percentage:0` → `false`; a userId whose
  bucket is below the threshold → `true` and one above → `false` (drive both arms with known
  flag/userId pairs asserted against `bucket(...)`); same `(flag, userId)` always yields the same verdict
  across calls; no-userId partial rollout → `false`.

### 3.3 Four providers + a `'custom'` arm; DB polls, LD lazy-imports

- **Decision:** `createProvider(options, ctx)` returns a `FlagProvider`, dispatched on a discriminated
  `FeatureFlagsPluginOptions` union (§4.1) so a missing credential is a compile error (M30 §10.1 pattern):
  - `ConfigProvider(flags)` — immutable flags set at construction; `start`/`stop` no-op; `isEnabled` calls
    `evaluateFlag`.
  - `MemoryProvider(flags?)` — holds a mutable `Map`; `isEnabled` calls `evaluateFlag`; exposes
    `setFlag(name, def)`, `removeFlag(name)`, and `replaceFlags(flags)` as the in-process/test mutation
    seam (consumed by `memory-provider.test.ts` and by apps that toggle flags at runtime); `start`/`stop`
    no-op.
  - `DatabaseProvider({ store, refreshIntervalMs? }, runtime, logger?)` — `store: IFlagStore` is an
    injected structural facade `{ loadFlags(): Promise<Readonly<Record<string, FlagDefinition>>> }` (never
    the `database` token, mirroring M26's `IAuditDbClient`). `start()` does `this.snapshot = await
    store.loadFlags()` then `runtime.setInterval(poll, refreshIntervalMs ?? 30000)`; the poll re-runs
    `loadFlags()` and on rejection logs via `logger?.warn(...)` (never swallows — AI_GUIDELINES §11.7) and
    keeps the last good snapshot. `stop()` calls `runtime.clearInterval`. `isEnabled` evaluates the
    snapshot. Portable to any runtime whose injected `IFlagStore` is portable.
  - `LaunchDarklyProvider({ sdkKey, initOptions?, client?, loadModule? })` — lazily imports the module via
    `loadModule ?? defaultLoadLaunchDarkly`, where the default is `() => import('npm:@launchdarkly/node-server-sdk@^9.12.3')`;
    constructs `client ?? mod.init({ sdkKey, ...initOptions })`; `start()` awaits
    `client.waitForInitialization()` (fail-fast: a rejection is rethrown from `register`, so a bad SDK key
    fails `app.start()`). `isEnabled` maps `FlagContext` → `{ kind: 'user', key: context?.userId ??
    'anonymous', ...(context?.attributes ?? {}) }` and returns `Boolean(client.variation(flag, ldContext,
    false))` — forwarding `attributes` (the field's real consumer). `stop()` awaits `client.close()`.
    The provider touches LD only through the exported `ILaunchDarklyClient`/`LaunchDarklyModule` facades,
    so it is unit-tested with a recording fake and never needs a network in unit tests.
  - `'custom'` arm — `{ provider: 'custom'; instance: FlagProvider }` returns `instance` unchanged,
    satisfying ARCHITECTURE's "Custom flag provider" extension point and giving `FlagProvider` a consumer
    beyond the four built-ins.
- **Why:** the synchronous contract forces DB and LD to pre-load; polling + `waitForInitialization` are
  the established out-of-band refresh models. The injectable `IFlagStore`/`ILaunchDarklyClient`/`loadModule`
  seams follow the M25/M28/M29 inject-or-lazy precedent (a real `npm:` import behind a seam, with a guarded
  real-import test, plus a recording fake for the branching logic). The discriminated union prevents the
  "documented example missing a required credential" defect M30 hit (§C4 there).
- **Test home:** `config-provider.test.ts`, `memory-provider.test.ts` (mutation read-back),
  `database-provider.test.ts` (recording `IFlagStore` + a fake `IRuntimeServices` whose `setInterval`
  captures the callback so the poll is driven synchronously; assert initial load, poll refresh swaps the
  snapshot, poll rejection logs and keeps the old snapshot, `stop` clears the timer),
  `launchdarkly-provider.test.ts` (recording `ILaunchDarklyClient`/`loadModule`: `start` awaits
  `waitForInitialization`, `isEnabled` calls `variation` with the mapped context and coerces to boolean,
  `stop` calls `close`, missing `sdkKey` throws at construction), and the integration
  `launchdarkly-real-import.test.ts` (guarded `import('npm:@launchdarkly/node-server-sdk@^9.12.3')` — skip
  on failure — asserting the module exports `init`).

### 3.4 `createFlagGuard` — free-function route guard, short-circuiting

- **Decision:** export `createFlagGuard(flag: string, options?: FlagGuardOptions): MiddlewareFunction`
  where `FlagGuardOptions = { fallback?: string; statusCode?: number; context?: FlagContext }`. At request
  time it resolves `ctx.services.get<IFeatureFlags>(CAPABILITIES.FEATURE_FLAGS)`, builds the context as
  `options.context ?? { userId: ctx.request.user?.id }`, and evaluates `isEnabled(flag, context)`. When on,
  it `return next()`. When off and `fallback` is set, it `return ctx.response.redirect(fallback)` (302)
  WITHOUT calling `next()`. When off and no `fallback`, it sets `ctx.response.status(options.statusCode ??
  404)` and `return ctx.response.text('Not Found')` WITHOUT calling `next()`.
- **Why:** the committed `IFeatureFlags` has no `middleware` method (§2-C1), so the guard is a free
  factory — the same shape as M16's `requireAuth`/`requireRole` guards, which keeps it composable in a
  route's `middleware: [...]` array and avoids widening `common`. Resolving the service per request (rather
  than capturing it at factory-call time) means the factory can be declared before the registry is
  populated and stays decoupled from the plugin instance. The two short-circuit arms are mandatory to test
  (CLAUDE.md "Short-circuit tests are mandatory").
- **Test home:** `feature-flag-middleware.test.ts` — flag on ⇒ `next()` called and the guard does not set
  a response; flag off + `fallback` ⇒ `ctx.response.redirect` called with the URL, status 302, and `next()`
  NOT called; flag off + no fallback ⇒ status `404`, body `'Not Found'`, `next()` NOT called; custom
  `statusCode` honored; context built from `ctx.request.user.id` when `options.context` absent and from the
  override when present.

### 3.5 Plugin wiring, health, lifecycle, optional logger

- **Decision:** `FeatureFlagsPlugin` returns an `IPlugin` with `name: 'feature-flags-plugin'`, `provides:
  [CAPABILITIES.FEATURE_FLAGS]`, `priority: PLUGIN_PRIORITY.NORMAL`, `optionalDependencies:
  [CAPABILITIES.LOGGER]`. `register(ctx)` builds the provider via `createProvider(options, ctx)` (the DB
  arm receives `ctx.runtime` and `ctx.logger`), constructs `FeatureFlagService(provider)`, `await
  service.start()`, registers the service under `CAPABILITIES.FEATURE_FLAGS`, registers a `feature-flags`
  health indicator returning `{ status: 'up', data: { provider: <provider-type> } }`, and registers
  `ctx.lifecycle.onClose(() => service.stop())`. The LD arm makes `register` async; config/memory arms are
  async too (uniform `await service.start()`), which is harmless. No global middleware is added — the guard
  is per-route.
- **Why:** the exact SecretsPlugin/M29/M30 wiring precedent, plus `onClose` (unlike stateless M30) because
  this plugin owns a poll timer (DB) and an LD client connection that must be released (AI_GUIDELINES §14.5
  "all timers cleared on shutdown"). `optionalDependencies: [CAPABILITIES.LOGGER]` is wired to a real
  reader — the DB provider's poll-catch logs via `ctx.logger` — so it is not a dead dependency edge (the M30
  §10.3 trap, where a declared LOGGER edge was dropped because nothing read it). A successfully registered
  plugin has already awaited provider init, so the health indicator honestly reports `'up'`.
- **Test home:** `feature-flags-plugin.test.ts` (`createProvider` returns the right class per arm, unknown
  arm ⇒ throws, `'custom'` returns the instance, `provides`/`priority`/`name`, `onClose` calls `stop`,
  health indicator shape) and the integration test (real kernel app: capability resolves, evaluation
  read-back through the public surface, guard short-circuit through a real route via `app.inject()`, health
  indicator resolves from `CAPABILITIES.HEALTH_INDICATOR`).

## 4. Exported surface — every symbol names its consumer

| Exported symbol                            | Kind                        | Consumer / real code path that READS it                                                                                                                                |
| ------------------------------------------ | --------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FeatureFlagsPlugin`                       | fn (factory)                | app code `app.register(FeatureFlagsPlugin({...}))`; integration test.                                                                                                  |
| `FeatureFlagService`                       | class                       | `FeatureFlagsPlugin.register` constructs it; registered under `CAPABILITIES.FEATURE_FLAGS`; `feature-flags-service.test.ts`.                                            |
| `createProvider`                           | fn                          | `FeatureFlagsPlugin.register` dispatches on the options union; `feature-flags-plugin.test.ts`.                                                                         |
| `createFlagGuard`                          | fn                          | route `middleware: [createFlagGuard(...)]`; `feature-flag-middleware.test.ts`; integration test.                                                                       |
| `ConfigProvider`                           | class                       | `createProvider('config')`; `config-provider.test.ts`.                                                                                                                 |
| `MemoryProvider`                           | class                       | `createProvider('memory')`; `memory-provider.test.ts`.                                                                                                                 |
| `DatabaseProvider`                         | class                       | `createProvider('database')`; `database-provider.test.ts`.                                                                                                             |
| `LaunchDarklyProvider`                     | class                       | `createProvider('launchdarkly')`; `launchdarkly-provider.test.ts`.                                                                                                     |
| `FlagProvider`                             | interface                   | the `'custom'` options arm (`instance: FlagProvider`) and custom-provider authors; the four providers `implements` it.                                                 |
| `FlagProviderType`                         | type                        | the `provider` discriminant on `FeatureFlagsPluginOptions`.                                                                                                            |
| `FlagDefinition`                           | type                        | `ConfigProviderOptions.flags` / `MemoryProviderOptions.flags` value type; `IFlagStore.loadFlags` value; `evaluateFlag` parameter; consumer-defined flag maps.          |
| `ConfigProviderOptions`                    | type                        | the `'config'` arm of `FeatureFlagsPluginOptions`.                                                                                                                     |
| `MemoryProviderOptions`                    | type                        | the `'memory'` arm.                                                                                                                                                     |
| `DatabaseProviderOptions`                  | type                        | the `'database'` arm; carries `store: IFlagStore`.                                                                                                                     |
| `LaunchDarklyProviderOptions`              | type                        | the `'launchdarkly'` arm; carries `sdkKey` + optional `client`/`loadModule`/`initOptions`.                                                                            |
| `FeatureFlagsPluginOptions`                | type (discriminated union)  | `FeatureFlagsPlugin` parameter; `createProvider` switch.                                                                                                               |
| `FlagGuardOptions`                         | type                        | `createFlagGuard` parameter.                                                                                                                                           |
| `IFlagStore`                               | interface                   | `DatabaseProviderOptions.store`; injected by the app; `fake-flag-store.ts` fixture implements it.                                                                      |
| `ILaunchDarklyClient`, `LaunchDarklyModule`| interface                   | `LaunchDarklyProviderOptions.client`/`loadModule` return; `fake-launchdarkly-client.ts` implements it; the real-import test asserts the module matches `LaunchDarklyModule`. |
| `IFeatureFlags`, `FlagContext`             | type (re-export from common)| consumers resolving the capability and building a context.                                                                                                             |

> Internal (NOT exported from `src/index.ts`): `evaluateFlag` and `bucket` in
> `src/evaluation/flag-evaluator.ts` — consumed by the three static providers and tested by importing the
> module directly, mirroring how other packages keep pure helpers internal.

### 4.1 Options — every option names its consumer

| Option                                        | Consumer                       | Behavior (per implementation)                                                                                                                                                                                                                |
| --------------------------------------------- | ------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`                                    | `FeatureFlagsPlugin`/`createProvider` | `'config' \| 'memory' \| 'database' \| 'launchdarkly' \| 'custom'`; selects the provider.                                                                                                                                                |
| `options.flags` (`'config'`, `'memory'`)      | `ConfigProvider`/`MemoryProvider` | `Readonly<Record<string, FlagDefinition>>`; the static flag set. Required for `'config'`, optional for `'memory'` (starts empty, mutated at runtime).                                                                                       |
| `options.store` (`'database'`)                | `DatabaseProvider`             | `IFlagStore`; required; the app's read view of its flag table.                                                                                                                                                                               |
| `options.refreshIntervalMs` (`'database'`)    | `DatabaseProvider`             | poll cadence; defaults to `30000`.                                                                                                                                                                                                           |
| `options.sdkKey` (`'launchdarkly'`)           | `LaunchDarklyProvider`         | LD SDK key; required — construction throws if missing.                                                                                                                                                                                       |
| `options.initOptions` (`'launchdarkly'`)      | `LaunchDarklyProvider`         | extra `init` config (e.g. `offline`, `streamUri`); forwarded as `...initOptions`.                                                                                                                                                            |
| `options.client` (`'launchdarkly'`)           | `LaunchDarklyProvider`         | inject an `ILaunchDarklyClient` (tests / a pre-built client); default `undefined` ⇒ built from the loaded module.                                                                                                                            |
| `options.loadModule` (`'launchdarkly'`)       | `LaunchDarklyProvider`         | inject the module loader (tests); default lazily imports `npm:@launchdarkly/node-server-sdk@^9.12.3`.                                                                                                                                        |
| `options.instance` (`'custom'`)               | `createProvider`               | a `FlagProvider`; returned as-is.                                                                                                                                                                                                             |
| `createFlagGuard(flag, options.fallback)`     | `createFlagGuard`              | redirect target when the flag is off; absent ⇒ the `statusCode` response.                                                                                                                                                                    |
| `createFlagGuard(flag, options.statusCode)`   | `createFlagGuard`              | status returned when off with no `fallback`; defaults to `404`.                                                                                                                                                                              |
| `createFlagGuard(flag, options.context)`      | `createFlagGuard`              | static context override; default `{ userId: ctx.request.user?.id }`.                                                                                                                                                                         |

## 5. Implementation files

| File                                       | Purpose                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                             | barrel exports (every symbol in §4), documented in PUBLIC_API.md; overwrites the existing M0 stub.                                                                                                                                                                                                                                                              |
| `src/interfaces/index.ts`                  | internal `FlagProvider` port (`isEnabled`/`start`/`stop`); exported option/provider types — `FlagDefinition`, `FlagProviderType`, `FlagProvider`, `ConfigProviderOptions`, `MemoryProviderOptions`, `DatabaseProviderOptions`, `LaunchDarklyProviderOptions`, `FeatureFlagsPluginOptions`, `FlagGuardOptions`, `IFlagStore`, `ILaunchDarklyClient`, `LaunchDarklyModule`. |
| `src/evaluation/flag-evaluator.ts`         | pure `evaluateFlag(flag, def, context)` + `bucket(key)` (FNV-1a mod 100); NOT re-exported from the barrel.                                                                                                                                                                                                                                                       |
| `src/services/feature-flags-service.ts`    | `FeatureFlagService implements IFeatureFlags` — holds one `FlagProvider`, delegates `isEnabled`, exposes `start`/`stop`.                                                                                                                                                                                                                                         |
| `src/providers/config-provider.ts`         | `ConfigProvider implements FlagProvider` — immutable flags, `evaluateFlag`.                                                                                                                                                                                                                                                                                     |
| `src/providers/memory-provider.ts`         | `MemoryProvider implements FlagProvider` — mutable map, `evaluateFlag`, `setFlag`/`removeFlag`/`replaceFlags`.                                                                                                                                                                                                                                                  |
| `src/providers/database-provider.ts`        | `DatabaseProvider implements FlagProvider` — injected `IFlagStore`, `runtime.setInterval` poll, snapshot eval, `runtime.clearInterval` on stop.                                                                                                                                                                                                                 |
| `src/providers/launchdarkly-provider.ts`   | `LaunchDarklyProvider implements FlagProvider` — lazy `npm:@launchdarkly/node-server-sdk@^9.12.3` via `loadModule`, `init` + `waitForInitialization`, `variation` mapped from `FlagContext`, `close` on stop.                                                                                                                                                   |
| `src/middleware/feature-flag-middleware.ts` | `createFlagGuard(flag, options?)` — resolves the service per request, evaluates, short-circuits to `redirect`/`404` or calls `next()`.                                                                                                                                                                                                                          |
| `src/plugin/feature-flags-plugin.ts`       | `FeatureFlagsPlugin` factory + `createProvider(options, ctx)` (one arm per provider type).                                                                                                                                                                                                                                                                      |
| `deno.json`                                | package scaffold: name `@hono-enterprise/feature-flags-plugin`, `version: 0.1.0`, `exports: ./src/index.ts`, and a `test.permissions` block mirroring `packages/mail-plugin/deno.json` (`read`/`import`/`env`/`sys:[hostname]`) so the guarded LD real-import test runs under the root test task's flags. The workspace member `./packages/feature-flags-plugin` is already listed at root `deno.json:31`. No `net` permission: tests inject fakes; the LD real-import test only loads the module (no network) and skips on failure. |

> The existing `packages/feature-flags-plugin/` stub (`deno.json` + `src/index.ts`) is overwritten by the
> Code-mode implementation; this plan does not edit it. ROADMAP M31's file list omits `memory-provider.ts`,
> `evaluation/flag-evaluator.ts`, and `interfaces/index.ts`; §2-C4 records that addition as a doc fix.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                | src covered                          | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| -------------------------------------------------------- | ------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/flag-evaluator.test.ts`                       | `evaluation/flag-evaluator.ts`       | `evaluateFlag(name, def, ctx)`: unknown (`def === undefined`) → `false`; `enabled:false` → `false`; `users` contains `ctx.userId` → `true`, misses → falls through to percentage; `percentage >= 100` → `true`, `<= 0` → `false`; a userId hashing below the threshold → `true`, above → `false` (both arms driven with known pairs asserted against `bucket(flag, userId)`); same `(flag, userId)` is stable across calls; no-userId partial rollout → `false`; no `percentage`/`users` and `enabled:true` → `true`.                                                                                       |
| `test/unit/feature-flags-service.test.ts`                | `services/feature-flags-service.ts`  | `FeatureFlagService(provider).isEnabled(...)` delegates to the provider (fake records the call and the passed `FlagContext`); `await service.start()` calls `provider.start()`; `await service.stop()` calls `provider.stop()`. Type-checks against `IFeatureFlags.isEnabled`.                                                                                                                                                                                                                                                                                                                                  |
| `test/unit/config-provider.test.ts`                      | `providers/config-provider.ts`       | `isEnabled` reflects the inline map; unknown flag → `false`; `start`/`stop` resolve without effect.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `test/unit/memory-provider.test.ts`                      | `providers/memory-provider.ts`       | empty start; `setFlag`/`removeFlag`/`replaceFlags` mutate the store and the next `isEnabled` reflects the change; `evaluateFlag` path covered through a representative flag; `start`/`stop` no-op.                                                                                                                                                                                                                                                                                                                                                                                                             |
| `test/unit/database-provider.test.ts`                    | `providers/database-provider.ts`     | fake `IFlagStore` (recording `loadFlags`); `start()` loads the initial snapshot and arms a timer captured by a fake `IRuntimeServices.setInterval`; `isEnabled` reads the snapshot; driving the captured poll callback swaps the snapshot when `loadFlags` resolves new data; a rejecting `loadFlags` on poll logs via the injected `logger` and KEEPS the previous snapshot (no throw, no stale clear); `stop()` calls `clearInterval`. Drives the `refreshIntervalMs ?? 30000` default and an explicit value.                                                                                              |
| `test/unit/launchdarkly-provider.test.ts`                | `providers/launchdarkly-provider.ts` | recording `loadModule` returning a stub `LaunchDarklyModule` whose `init` returns a recording `ILaunchDarklyClient`; `start()` calls `init({ sdkKey, ...initOptions })` then awaits `waitForInitialization`; `isEnabled(flag, { userId, attributes })` calls `variation(flag, { kind:'user', key:userId ?? 'anonymous', ...attributes }, false)` and returns the boolean; `stop()` awaits `close`; missing `sdkKey` ⇒ construction throws; an injected `client` short-circuits `loadModule`/`init`.                                                                                                         |
| `test/integration/launchdarkly-real-import.test.ts`      | `providers/launchdarkly-provider.ts` | guarded `await import('npm:@launchdarkly/node-server-sdk@^9.12.3')` (skip the file when the import fails — no network in CI); assert `typeof mod.init === 'function'`. Establishes the lazy import is real, not a global-hook shim (CLAUDE.md "A lazily-loaded optional dep must ACTUALLY load").                                                                                                                                                                                                                                                                                                                |
| `test/unit/feature-flag-middleware.test.ts`              | `middleware/feature-flag-middleware.ts` | fake `IRequestContext` + a service registry whose `get(CAPABILITIES.FEATURE_FLAGS)` returns a controllable `IFeatureFlags`; flag on ⇒ `next()` invoked, no response set; flag off + `fallback` ⇒ `response.redirect(fallback)` called, status 302, `next()` NOT called (short-circuit); flag off + no `fallback` ⇒ `response.status(404)` + `text('Not Found')`, `next()` NOT called; custom `statusCode` honored; context derived from `ctx.request.user.id` and overridden by `options.context`.                                                                                                              |
| `test/unit/feature-flags-plugin.test.ts`                 | `plugin/feature-flags-plugin.ts`     | `createProvider` returns the right class for each arm; `'custom'` returns the supplied instance; unknown arm ⇒ throws; `LaunchDarklyProviderOptions` without `sdkKey` ⇒ throws; plugin `name`/`provides`/`priority`; `register` awaits `service.start()` (fake provider records start) and registers under `CAPABILITIES.FEATURE_FLAGS`; the registered `feature-flags` health indicator returns `{ status:'up', data:{ provider } }`; `onClose` hook calls `service.stop()`.                                                                                                                                |
| `test/unit/barrel-exports.test.ts`                       | `index.ts` (+ `interfaces/index.ts`) | every §4 symbol is defined/exported; `IFeatureFlags`/`FlagContext` re-export identically to `common`. `interfaces/index.ts` and `evaluation/flag-evaluator.ts` are exercised transitively by the provider/service tests that implement/consume them.                                                                                                                                                                                                                                                                                                                                                            |
| `test/integration/feature-flags-integration.test.ts`    | plugin + service + middleware end-to-end | real kernel app `createApplication({ plugins: [RuntimePlugin(), FeatureFlagsPlugin({ provider:'config', options:{ flags:{ 'new-dashboard': { enabled:true, percentage:50 }, 'beta': { enabled:false } } } })] })`; resolve `IFeatureFlags` via `CAPABILITIES.FEATURE_FLAGS`; `isEnabled` read-back for an on flag and an off flag; a route guarded by `createFlagGuard('beta', { fallback:'/old' })` returns a 302 to `/old` via `app.inject()` while the handler does NOT run; the `feature-flags` health indicator resolves from `CAPABILITIES.HEALTH_INDICATOR` and reports `'up'` (one capability, one implementation). |
| `test/fixtures/fake-context.ts`                          | fixture (excluded from coverage)     | fake `IPluginContext` for the `register`/`createProvider` unit tests; `services.get` throws for an absent token and `register` rejects a duplicate, mirroring the kernel's real `ServiceRegistry` so a missing fail-fast guard cannot hide (M30 precedent).                                                                                                                                                                                                                                                                                                                                                    |
| `test/fixtures/fake-flag-store.ts`                       | fixture (excluded from coverage)     | recording `IFlagStore` with a scriptable `loadFlags` (resolve/reject on demand).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `test/fixtures/fake-launchdarkly-client.ts`              | fixture (excluded from coverage)     | recording `ILaunchDarklyClient` + a `loadModule` returning a stub `LaunchDarklyModule`, capturing `variation` calls and the mapped context.                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/fixtures/fake-runtime.ts`                          | fixture (excluded from coverage)     | fake `IRuntimeServices` whose `setInterval` captures the callback and returns a handle `clearInterval` records (so the DB poll is driven synchronously in tests).                                                                                                                                                                                                                                                                                                                                                                                                                                               |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/31-feature-flags-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

## 8. Risks & mitigations

- `exactOptionalPropertyTypes` is on: optional fields (`LaunchDarklyProviderOptions.initOptions`,
  `FlagGuardOptions.context`, the mapped LD context `attributes`) are built by omitting the property when
  absent, never by assigning `undefined` (the middleware and LD-provider tests assert the omitted shape).
- A synchronous contract plus async providers risks serving before state is loaded ⇒ mitigated by running
  `await service.start()` inside async `register()`, so the app is not "ready" until the snapshot/client is
  initialized; init failure fails `app.start()` rather than silently evaluating unknown flags to `false`.
- LaunchDarkly's `variation` is synchronous only after `waitForInitialization` resolves ⇒ mitigated by
  awaiting it in `start()`; if a caller registers the plugin and serves before `start()` returns, the kernel
  has not finished booting, so the path is unreachable by construction (asserted indirectly by the plugin
  test that `register` awaits `start`).
- A DB poll failure could silently stall the snapshot ⇒ mitigated by logging the rejection via
  `ctx.logger` (the consumer that justifies `optionalDependencies: [CAPABILITIES.LOGGER]`) and retaining the
  last good snapshot rather than clearing it.
- The deprecated `launchdarkly-node-server-sdk` name is a trap a future maintainer could re-introduce ⇒
  mitigated by pinning `npm:@launchdarkly/node-server-sdk@^9.12.3` and documenting the deprecation in the
  PUBLIC_API Notes (§2-C2).
- Percentage rollout determinism depends on the hash staying stable ⇒ the `bucket` helper is pure and
  unit-tested against fixed expected values; changing it would be a breaking change to rollout assignment
  and must be called out in the PR.

## 9. Out of scope

- A flag admin/mutation HTTP surface and a flag-change audit trail (app concern; compose `audit-plugin`
  M26 and guard the routes with M16 auth).
- LaunchDarkly edge/browser SDKs, and the deprecated `launchdarkly-node-server-sdk` package (§2-C2).
- A segment/rule engine beyond `enabled`/`users`/`percentage` for the static providers — LaunchDarkly owns
  enterprise targeting; a second engine here would be dead surface.
- Push-based flag updates from `DatabaseProvider` (it polls; push needs a runtime watch/stream seam that
  does not exist in `IRuntimeServices`).
- Multi-tenancy-aware flag overrides and per-tenant targeting (M32 owns tenancy).
- Additional providers (Unleash, ConfigCat, Flagsmith, Split, GrowthBook) beyond Config/Memory/Database/
  LaunchDarkly plus the `'custom'` injection seam (the exported `FlagProvider` port lets a consumer add
  these without a core change; a first-party integration is a future milestone).
