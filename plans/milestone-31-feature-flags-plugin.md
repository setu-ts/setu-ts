# Milestone 31 — Feature Flags Plugin (`@hono-enterprise/feature-flags-plugin`)

> **Status:** Planning. Branch: `feat/31-feature-flags-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch and merges via a single PR.

## 0. Objective & scope

Provide feature flag capability as a plugin. `FeatureFlagsPlugin(options)` registers the committed
`IFeatureFlags` contract under `CAPABILITIES.FEATURE_FLAGS`. The committed contract is
**synchronous** (`isEnabled(flag, context?): boolean`, unknown flags → `false`, see §1), so the
design is built around one rule stated on the contract itself: _"providers refresh their state out
of band."_ A thin `FeatureFlagService implements IFeatureFlags` delegates to a `FlagProvider` port
whose implementations own a cached snapshot and an async `start()`/`stop()` lifecycle that the
plugin orchestrates from `register()` (async) and `onClose`. Three providers ship — `ConfigProvider`
(static inline flags, the `'config'` default), `MemoryProvider` (mutable in-process store for tests
and dynamic toggles), and `DatabaseProvider` (polls an injected `IFlagStore` on a runtime timer into
a snapshot) — plus a `'custom'` arm that accepts any `FlagProvider` instance (ARCHITECTURE's "Custom
flag provider" extension point). **LaunchDarkly is deferred** and is not in this milestone: its Node
server SDK has no synchronous evaluation API, so it cannot satisfy the committed contract without
widening `common` (verified from source in §1, resolved as conflict C2). All three shipped providers
share one pure `evaluateFlag` seam (allowlist → enabled → deterministic percentage bucket). A
free-function route guard `createFlagGuard(flag, options)` short-circuits to a redirect or `404`
when a flag is off (the committed `IFeatureFlags` has no `middleware` method, so the
ROADMAP/PUBLIC_API `flags.middleware(...)` example is a doc conflict resolved in §2-C1).

- **In scope:** the `IFeatureFlags` implementation (`FeatureFlagService`), the three providers plus
  the `'custom'` injection arm, the `FlagProvider` port, the pure `evaluateFlag`/`bucket` seam, the
  `createFlagGuard` middleware factory, the `FeatureFlagsPlugin` factory with `createProvider`, a
  `feature-flags` health indicator that reports `'degraded'` when a provider's refresh is failing,
  an `onClose` that stops timers, and full per-file test coverage (≥90% branch/function/line)
  including a mandatory short-circuit test for the guard.
- **NOT this milestone:** the `LaunchDarklyProvider` (§2-C2 — deferred to a milestone that resolves
  the sync/async contract mismatch); server-side flag admin/mutation endpoints and an audit trail of
  flag changes (app concern; compose `audit-plugin` M26); a generic rule/segment engine beyond the
  built-in `users`/`enabled`/`percentage` targeting; live flag-change push from the
  `DatabaseProvider` (it polls on a timer; push would need a runtime watch/stream seam that does not
  exist); multi-tenancy-aware flag overrides (M32 owns tenancy).

## 1. Contracts verified from SOURCE (not names)

| Reference                                               | Source (file:line)                                                                                                                       | Verified surface / fact                                                                                                                                                                                                                                                                                                                                   |
| ------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IFeatureFlags`                                         | `packages/common/src/services/feature-flags.ts:33,42`                                                                                    | `isEnabled(flag: string, context?: FlagContext): boolean` — **synchronous**; "unknown flags evaluate to `false`" (line 39-41). The ONLY method: no `middleware`, no `isEnabledAsync`, no `getFlag`.                                                                                                                                                       |
| `FlagContext`                                           | `packages/common/src/services/feature-flags.ts:13`                                                                                       | `{ readonly userId?: string; readonly attributes?: Readonly<Record<string, string \| number \| boolean>> }`. `attributes` is "Additional targeting attributes" — accepted by this package's evaluator but deliberately NOT consumed by the built-in providers (§3.2); the `'custom'` arm is its extension point.                                          |
| common barrel re-export                                 | `packages/common/src/index.ts:169`                                                                                                       | `export type { FlagContext, IFeatureFlags } from './services/feature-flags.ts';` — both already public from `common`; this package re-exports them for consumer convenience (M29/M30 precedent).                                                                                                                                                          |
| `CAPABILITIES.FEATURE_FLAGS`                            | `packages/common/src/tokens.ts:85`                                                                                                       | `FEATURE_FLAGS: 'feature-flags'` — lowercase kebab, already committed (no new token, no `common` change).                                                                                                                                                                                                                                                 |
| `CAPABILITIES.HEALTH_INDICATOR`                         | `packages/common/src/tokens.ts:107`                                                                                                      | `HEALTH_INDICATOR: 'health-indicator'` — the token `ctx.health.register` feeds (`packages/kernel/src/application/application.ts:168`), and the token the integration test reads the indicator back from.                                                                                                                                                  |
| `IPlugin`                                               | `packages/common/src/plugin.ts:470`                                                                                                      | `name`, `version`, `provides`, `optionalDependencies`, `priority`, `register(ctx): void \| Promise<void>` — `register` MAY return a Promise, which the DB provider needs for async init.                                                                                                                                                                  |
| kernel awaits `register`                                | `packages/kernel/src/application/application.ts:277`                                                                                     | `await plugin.register(ctx);` — an async `register` is genuinely awaited before the app is ready, so a provider that finishes loading inside `register` is loaded before the first request (the premise of §3.1).                                                                                                                                         |
| `IPluginContext`                                        | `packages/common/src/plugin.ts:409`                                                                                                      | `runtime` is non-optional (line 435); `logger?` is directly on the context (line 439); `health` (line 419); `lifecycle` (line 429). No need to resolve `CAPABILITIES.LOGGER` through the registry to log.                                                                                                                                                 |
| `IHealthApi.register`                                   | `packages/common/src/plugin.ts:187`                                                                                                      | `register(name: string, indicator: HealthIndicatorFn): void`.                                                                                                                                                                                                                                                                                             |
| `HealthIndicatorFn` / `HealthCheckResult`               | `packages/common/src/services/health.ts:26,13`                                                                                           | `() => Promise<HealthCheckResult>`; result `{ status: HealthStatus; data?: Readonly<Record<string, unknown>> }`; `HealthStatus = 'up' \| 'down' \| 'degraded'` (`types.ts:60`).                                                                                                                                                                           |
| `optionalDependencies` ordering                         | `packages/kernel/src/registry/plugin-resolver.ts:49`                                                                                     | An edge is added only when the provider is present (lines 49-54); absent ⇒ no edge and no throw. So `optionalDependencies: [CAPABILITIES.LOGGER]` orders LoggerPlugin before this plugin WHEN present, letting the DB provider read `ctx.logger` safely; when absent it is tolerated.                                                                     |
| duplicate-name / duplicate-provider throw               | `packages/kernel/src/registry/plugin-resolver.ts:107,124`                                                                                | `assertUniqueNames` throws on a reused plugin name; `buildProviderIndex` throws on two plugins providing the same capability. The plugin name is the fixed `feature-flags-plugin` and it is the sole provider of `feature-flags`, so no multi-instance concern.                                                                                           |
| `IRuntimeServices.setInterval` / `clearInterval`        | `packages/common/src/runtime.ts:247,253`                                                                                                 | `setInterval(fn: () => void, ms: number): TimerHandle` and `clearInterval(handle: TimerHandle): void`; `TimerHandle = unknown` (line 17). The DB provider polls via these, never the global `setInterval` (AI_GUIDELINES §4.2). `now()`/`hrtime()` at lines 218/225 (monotonic).                                                                          |
| `MiddlewareFunction` / `IRequestContext` / `IResponse`  | `packages/common/src/http.ts:248,201,151,101`                                                                                            | Middleware is `(ctx: IRequestContext, next: NextFunction) => void \| HandlerResult \| Promise<...>`; short-circuit by returning a response without calling `next()`. `ctx.services` (line 201) resolves the flag service per request; `redirect(url, status?)` (line 151, defaults to 302) and `status(code)` (line 101) build the fallback response.     |
| `IRequest.user`                                         | `packages/common/src/http.ts:47`                                                                                                         | `user?: IPrincipal` — optional, populated by auth middleware; the guard reads `ctx.request.user?.id`.                                                                                                                                                                                                                                                     |
| `IPrincipal.id`                                         | `packages/common/src/services/auth.ts:16,18`                                                                                             | `id: string` is the stable subject identifier → maps to `FlagContext.userId`.                                                                                                                                                                                                                                                                             |
| `PLUGIN_PRIORITY.NORMAL`                                | `packages/common/src/types.ts:84`                                                                                                        | `500` (default band for capability plugins).                                                                                                                                                                                                                                                                                                              |
| health-indicator read-back precedent                    | `packages/notification-plugin/test/integration/notification-integration.test.ts:139-145`                                                 | `app.services.getAll<IHealthIndicator>(CAPABILITIES.HEALTH_INDICATOR)`, `.find((i) => i.name === '…')`, then `await indicator.check()` — the exact shape the §6 integration test uses.                                                                                                                                                                    |
| LaunchDarkly Node SDK evaluation is **async**           | `@launchdarkly/js-server-sdk-common@2.19.5` `dist/api/LDClient.d.ts:96,306,325` (installed under `@launchdarkly/node-server-sdk@9.12.3`) | `variation(key, context, defaultValue, callback?): Promise<LDFlagValue>` — **returns a Promise**, no synchronous variant. `allFlagsState(context, options?, callback?): Promise<LDFlagsState>` is async AND per-context. `close(): void` (not a Promise). `initialized(): boolean` is the only sync evaluator-adjacent call. This is the evidence for C2. |
| LaunchDarkly `waitForInitialization` does not fail fast | same package, `dist/api/LDClient.d.ts:81`, `dist/LDClientImpl.js:331-345`                                                                | `waitForInitialization(options?: LDWaitForInitializationOptions): Promise<LDClient>`; the option field is `timeout` (seconds), and calling with no options logs "called without a timeout specified" and waits **indefinitely**. A no-arg call therefore hangs `app.start()` rather than failing fast. Second piece of evidence for C2.                   |
| ROADMAP M31 scope                                       | `ROADMAP.md:3152`                                                                                                                        | file list at lines 3195-3203; providers bullet list at 3188-3193 (names `Config`/`Database`/`LaunchDarkly`/`Memory`); config example 3160-3169 (`'beta-features': { enabled: false, users: [...] }`, the flag whose semantics C5 resolves); `flags.middleware(...)` example at 3183.                                                                      |
| PUBLIC_API Feature Flags                                | `PUBLIC_API.md:3071`                                                                                                                     | registration 3080 (same `enabled: false` + `users` flag at 3084), usage + `flags.middleware(...)` 3095-3111, contract summary row 4534 (`IFeatureFlags`, `FlagContext`). Lacks the Options/Exports/Notes subsections every sibling section carries.                                                                                                       |
| ARCHITECTURE feature-flags                              | `ARCHITECTURE.md:1398-1406`                                                                                                              | Public API `FeatureFlagsPlugin()`; `IFeatureFlags`; Extension Points "Custom flag provider"; Rules "Config provider for simple cases; LaunchDarkly for enterprise" (line 1406 — the row C2 corrects).                                                                                                                                                     |
| Package scaffold precedent (no npm dep)                 | `packages/notification-plugin/deno.json`                                                                                                 | A plugin with zero `npm:` imports carries no `test.permissions` block. With LaunchDarkly deferred this package has no external dependency, so its `deno.json` matches this shape (not mail-plugin's permissioned one).                                                                                                                                    |
| Progress tracking                                       | `ROADMAP.md:4223`                                                                                                                        | `\| 31 \| ⬜ \| feature-flags-plugin \|` — must flip to ✅ in the milestone PR (CLAUDE.md "Before reporting a task done").                                                                                                                                                                                                                                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                 | Doc deliverable (same PR)                                                                                                                                                                                                                                  |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md:3183` and `PUBLIC_API.md:3108` call `flags.middleware('beta-features', { fallback })` as if it were a method on `IFeatureFlags`, but the committed `IFeatureFlags` (`feature-flags.ts:33`) has ONLY `isEnabled`. Adding a `middleware` method would widen a committed `common` contract (a major, flagged change) for sugar that is better as a free function — exactly how M16's guards are free middleware factories, not methods on `IAuthService`.                                                                                                                                                                                                                                                                                             | Honor the committed contract: ship a free-function guard `createFlagGuard(flag, options?)` exported from the plugin (§3.4). No method is added to `IFeatureFlags`; no `common` change.                                                                                                                                                                                                                                   | Correct the ROADMAP M31 and PUBLIC_API Feature Flags examples to `middleware: [createFlagGuard('beta-features', { fallback: '/not-found' })]`.                                                                                                             |
| C2 | ARCHITECTURE (`:1406`), ROADMAP (`:3192`) and PUBLIC_API name **LaunchDarkly** as a shipped provider. Verified from the installed SDK (§1): `LDClient.variation` returns `Promise<LDFlagValue>` and `allFlagsState` is async and per-context — the Node server SDK exposes **no** synchronous evaluation API (unlike the Java/Go/.NET SDKs). A `LaunchDarklyProvider` therefore cannot honor the synchronous committed `isEnabled` unless `IFeatureFlags` first gains an async method (a major `common` change); the only way to keep it synchronous is to return a wrong answer for every context not yet cached, which is not acceptable. Additionally, `waitForInitialization()` with no timeout hangs instead of failing fast (`LDClientImpl.js:331-345`). | **Defer LaunchDarkly out of M31.** Ship Config/Memory/Database plus the `'custom'` arm, which already satisfies ARCHITECTURE's "Custom flag provider" extension point and lets an application bridge LaunchDarkly itself. A first-party provider returns in a milestone that first decides whether `IFeatureFlags` gains an async method. Nothing in this milestone imports an npm package.                              | Correct the ROADMAP M31 provider list and ARCHITECTURE's feature-flags **Rules** row (`:1406`) to drop LaunchDarkly from M31's shipped set, and add a PUBLIC_API Feature Flags **Notes** subsection recording the sync-contract mismatch and the deferral. |
| C3 | `PUBLIC_API.md:3071` Feature Flags section ships only Registration + Usage. Every sibling section (Notifications, Mail, Storage, …) also carries Options / Exports / Notes subsections; the new `src/index.ts` surface would otherwise be undocumented (the exact gap M30 closed for Notifications).                                                                                                                                                                                                                                                                                                                                                                                                                                                           | Add the missing Feature Flags Options / Exports / Notes subsections to PUBLIC_API.md, listing every §4 symbol with one-line JSDoc-grade descriptions.                                                                                                                                                                                                                                                                    | PUBLIC_API.md Feature Flags Options/Exports/Notes subsections (new).                                                                                                                                                                                       |
| C4 | `ROADMAP.md:3193` names `MemoryProvider` in the Providers bullet list, but the M31 "Implementation Files" list (`ROADMAP.md:3195-3203`) omits `src/providers/memory-provider.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | Ship `src/providers/memory-provider.ts`; this plan's §5 adds it, plus the `evaluation/` and `interfaces/` modules the design needs (the same "add the shared modules the design needs" approach M30 took for `interfaces/` and `http/`).                                                                                                                                                                                 | Correct the ROADMAP M31 implementation-files list to include `src/providers/memory-provider.ts` (and note the added `evaluation/flag-evaluator.ts`, `interfaces/index.ts`; `launchdarkly-provider.ts` is removed per C2).                                  |
| C5 | Both committed examples (`ROADMAP.md:3164`, `PUBLIC_API.md:3084`) document `'beta-features': { enabled: false, users: ['user1', 'user2'] }`. Under a naive precedence that tests `enabled` first, `user1`/`user2` evaluate to `false` and the `users` allowlist does nothing at all — it would only ever matter alongside an explicit `percentage`, making the one documented usage of the field dead. The docs plainly intend "off by default, on for these users".                                                                                                                                                                                                                                                                                           | **The allowlist wins over `enabled: false`.** `evaluateFlag` tests `users` BEFORE `enabled` (§3.2 precedence), so the committed examples are correct as written and `users` has a real effect in the documented shape. No doc correction is needed for this row; the semantics are stated explicitly in the new PUBLIC_API Options subsection (C3) and asserted by the §6 "user targeting" test against that exact flag. | PUBLIC_API Feature Flags Options subsection states the precedence (`users` allowlist overrides `enabled: false`) — carried by the C3 deliverable, no separate edit.                                                                                        |

## 3. Design decisions

### 3.1 Synchronous contract → provider port with an async lifecycle

- **Decision:** define a `FlagProvider` port — `readonly type: FlagProviderType`,
  `isEnabled(flag: string, context?: FlagContext): boolean` (synchronous, mirrors the committed
  contract), `start(): Promise<void>` (pull initial state into the cache), `stop(): Promise<void>`
  (release timers/connections), and an optional `status?(): FlagProviderStatus` (§3.5).
  `FeatureFlagService implements IFeatureFlags` holds one `FlagProvider`, delegates `isEnabled` to
  it, and exposes `start`/`stop`/`status` for the plugin to call. The plugin's `register()` is
  **async**: it constructs the provider via `createProvider`, constructs
  `FeatureFlagService(provider)`, `await service.start()` (DB does the initial `loadFlags` and arms
  the poll timer; config/memory no-op), then registers the service under
  `CAPABILITIES.FEATURE_FLAGS`.
- **Why:** the committed contract is synchronous and states providers refresh out of band; the only
  way an async provider (DB) honors a sync `isEnabled` is to have completed its async load BEFORE
  the first evaluation. Running that load inside async `register()` — which `IPlugin` permits and
  the kernel genuinely awaits (`application.ts:277`, verified in §1) — guarantees the snapshot is
  ready before the app serves, and surfaces init failure at startup rather than at first request.
  This mirrors how M29's `register` resolves its provider and how M25's providers own their cache.
- **Test home:** `feature-flags-service.test.ts` (delegation + `start`/`stop`/`status` drive a fake
  provider's lifecycle) and `feature-flags-plugin.test.ts` (`register` awaits `start`; the
  registered service evaluates; `onClose` calls `stop`).

### 3.2 Flag evaluation — one pure seam, allowlist-first, deterministic rollout

- **Decision:** a pure internal
  `evaluateFlag(flag: string, def: FlagDefinition | undefined, context: FlagContext | undefined): boolean`
  (in `src/evaluation/flag-evaluator.ts`, NOT re-exported from the barrel — consumed by all three
  providers, tested directly). Precedence, in order:
  1. `def === undefined` → `false` (the committed "unknown flag → `false`").
  2. `def.users` is present and `context?.userId` is a member → `true` — the explicit allowlist,
     which **overrides `enabled: false`** so the committed `{ enabled: false, users: [...] }`
     example behaves as its docs intend (§2-C5).
  3. `def.enabled === false` → `false`.
  4. `def.percentage` is present → `percentage >= 100` → `true`; `percentage <= 0` → `false`; with
     no `context.userId` → `false` (a stable bucket needs a stable key); otherwise
     `bucket(flag, context.userId) < percentage`.
  5. otherwise → `true`.

  `FlagDefinition` is exactly the ROADMAP shape —
  `{ enabled: boolean; percentage?: number; users?: readonly string[] }` — no invented fields.
  `bucket(flag: string, userId: string): number` is fixed as: FNV-1a 32-bit hash over the single
  string `` `${flag}:${userId}` ``, reduced `% 100`. That is the one and only derivation; no XOR
  variant, no alternate key. `FlagContext.attributes` is accepted and deliberately ignored by this
  evaluator (see below).
- **Why:** the percentage deliverable ("Percentage rollout") needs determinism to be testable
  without flakiness; hashing flag+userId gives stable per-user buckets (the same user always sees
  the same verdict) while distributing users independently across flags. Allowlist-first is what
  makes `users` a live field rather than dead surface in the only shape the committed docs
  demonstrate (§2-C5). Keeping evaluation in one pure function lets the per-file coverage bar be met
  by direct unit tests instead of through a provider, and avoids duplicating the precedence across
  config/memory/database (the DRY rule and the "duplicated logic → route through a shared helper"
  technique in CLAUDE.md's self-review). `attributes` is not consumed because the built-in targeting
  the ROADMAP specifies is `enabled`/`users`/`percentage`; inventing a second rule engine here would
  be dead surface no design decision needs. It is a committed `common` field this package does not
  declare, so leaving it unconsumed is not the dead-surface defect — but the omission is stated in
  JSDoc and in the new PUBLIC_API Notes so no reader assumes attribute targeting works, and the
  `'custom'` provider arm is named as its extension point.
- **Test home:** `flag-evaluator.test.ts` — unknown flag → `false`; `enabled:false` → `false`;
  **`{ enabled: false, users: ['user1'] }` with `userId: 'user1'` → `true`** (the C5 semantics,
  driven on the exact committed example flag) and with `userId: 'other'` → `false`; allowlist hit
  with a percentage set bypasses the bucket; `percentage >= 100` → `true`, `<= 0` → `false`; a
  userId whose bucket is below the threshold → `true` and one above → `false` (both arms driven with
  known pairs asserted against `bucket(flag, userId)`); the same `(flag, userId)` always yields the
  same verdict across calls; no-userId partial rollout → `false`; `enabled:true` with no
  `percentage`/`users` → `true`; a context carrying `attributes` changes nothing (documents the
  non-consumption).

### 3.3 Three providers + a `'custom'` arm; the DB provider polls

- **Decision:** `createProvider(options, ctx)` returns a `FlagProvider`, dispatched on a
  discriminated `FeatureFlagsPluginOptions` union (§4.1) so a missing credential is a compile error
  (M30 pattern):
  - `ConfigProvider(flags)` — `type: 'config'`; immutable flags set at construction; `start`/`stop`
    no-op; `isEnabled` calls `evaluateFlag`; no `status()` (the health indicator's absent-arm).
  - `MemoryProvider(flags?)` — `type: 'memory'`; holds a mutable `Map`; `isEnabled` calls
    `evaluateFlag`; exposes `setFlag(name, def)`, `removeFlag(name)`, and `replaceFlags(flags)` as
    the in-process/test mutation seam (consumed by `memory-provider.test.ts` and by apps that toggle
    flags at runtime); `start`/`stop` no-op; no `status()`.
  - `DatabaseProvider({ store, refreshIntervalMs? }, runtime, logger?)` — `type: 'database'`;
    `store: IFlagStore` is an injected structural facade
    `{ loadFlags(): Promise<Readonly<Record<string, FlagDefinition>>> }` (never the `database`
    token, mirroring M26's `IAuditDbClient`). `start()` does
    `this.snapshot = await store.loadFlags()` then
    `runtime.setInterval(poll, refreshIntervalMs ?? 30000)`; the poll re-runs `loadFlags()` and on
    rejection logs via `logger?.warn(...)` (never swallows — AI_GUIDELINES §11.7), records the
    failure for `status()` (§3.5), and keeps the last good snapshot; a later successful poll clears
    the recorded failure. `stop()` calls `runtime.clearInterval`. `isEnabled` evaluates the snapshot
    via `evaluateFlag`. Portable to any runtime whose injected `IFlagStore` is portable.
  - `'custom'` arm — `{ provider: 'custom'; instance: FlagProvider }` returns `instance` unchanged,
    satisfying ARCHITECTURE's "Custom flag provider" extension point, giving `FlagProvider` a
    consumer beyond the three built-ins, and serving as the documented bridge for LaunchDarkly and
    any other external service until a first-party provider ships (§2-C2).
- **Why:** the synchronous contract forces the DB provider to pre-load and refresh out of band;
  polling is the established model and needs no seam that `IRuntimeServices` lacks. The injected
  `IFlagStore` follows the M26 structural-facade precedent, keeping this package free of any `npm:`
  dependency now that LaunchDarkly is deferred. The discriminated union prevents the "documented
  example missing a required credential" defect M30 hit.
- **Test home:** `config-provider.test.ts`, `memory-provider.test.ts` (mutation read-back),
  `database-provider.test.ts` (recording `IFlagStore` + a fake `IRuntimeServices` whose
  `setInterval` captures the callback so the poll is driven synchronously; assert initial load, poll
  refresh swaps the snapshot, poll rejection logs and keeps the old snapshot and flips `status()`, a
  subsequent success clears it, `stop` clears the timer).

### 3.4 `createFlagGuard` — free-function route guard, short-circuiting

- **Decision:** export
  `createFlagGuard(flag: string, options?: FlagGuardOptions): MiddlewareFunction` where
  `FlagGuardOptions = { fallback?: string; statusCode?: number; context?: FlagContext }`. At request
  time it resolves `ctx.services.get<IFeatureFlags>(CAPABILITIES.FEATURE_FLAGS)`, builds the context
  as `options.context ?? { userId: ctx.request.user?.id }` (built by omitting `userId` when absent,
  per `exactOptionalPropertyTypes`), and evaluates `isEnabled(flag, context)`. When on, it
  `return next()`. When off and `fallback` is set, it `return ctx.response.redirect(fallback)` (302)
  WITHOUT calling `next()`. When off and no `fallback`, it sets
  `ctx.response.status(options.statusCode ?? 404)` and `return ctx.response.text('Not Found')`
  WITHOUT calling `next()`. **When the capability is absent**, the registry's `get` error propagates
  unchanged: the guard does not catch it. Documented as `@throws` on the factory.
- **Why:** the committed `IFeatureFlags` has no `middleware` method (§2-C1), so the guard is a free
  factory — the same shape as M16's `requireAuth`/`requireRole` guards, which keeps it composable in
  a route's `middleware: [...]` array and avoids widening `common`. Resolving the service per
  request (rather than capturing it at factory-call time) means the factory can be declared before
  the registry is populated and stays decoupled from the plugin instance. Letting the resolution
  error propagate is the deliberate choice over the two alternatives: failing open would silently
  expose the very route the guard exists to gate, and failing closed would turn a
  plugin-registration mistake into a permanent silent 404. A propagating error surfaces the
  misconfiguration, consistent with M30's email fail-fast. The two short-circuit arms are mandatory
  to test (CLAUDE.md "Short-circuit tests are mandatory").
- **Test home:** `feature-flag-middleware.test.ts` — flag on ⇒ `next()` called and the guard does
  not set a response; flag off + `fallback` ⇒ `ctx.response.redirect` called with the URL, status
  302, and `next()` NOT called; flag off + no `fallback` ⇒ status `404`, body `'Not Found'`,
  `next()` NOT called; custom `statusCode` honored; context built from `ctx.request.user.id` when
  `options.context` is absent (and `userId` omitted entirely when there is no user) and from the
  override when present; an unset capability ⇒ the guard rejects with the registry's error and
  `next()` is NOT called.

### 3.5 Plugin wiring, health, lifecycle, optional logger

- **Decision:** `FeatureFlagsPlugin` returns an `IPlugin` with `name: 'feature-flags-plugin'`,
  `provides: [CAPABILITIES.FEATURE_FLAGS]`, `priority: PLUGIN_PRIORITY.NORMAL`,
  `optionalDependencies: [CAPABILITIES.LOGGER]`. `register(ctx)` builds the provider via
  `createProvider(options, ctx)` (the DB arm receives `ctx.runtime` and `ctx.logger`), constructs
  `FeatureFlagService(provider)`, `await service.start()`, registers the service under
  `CAPABILITIES.FEATURE_FLAGS`, registers a `feature-flags` health indicator, and registers
  `ctx.lifecycle.onClose(() => service.stop())`.

  The health indicator reads the provider's optional `status?(): FlagProviderStatus` where
  `FlagProviderStatus = { readonly healthy: boolean; readonly detail?: string }`:
  - `status` absent, or `status().healthy === true` → `{ status: 'up', data: { provider: type } }`.
  - `status().healthy === false` → `{ status: 'degraded', data: { provider: type, detail } }` —
    `'degraded'` rather than `'down'` because the provider keeps serving its last good snapshot.

  `FlagProvider.type` is what supplies `data.provider`, so the reported value comes from the
  provider itself rather than from a re-read of the options.
- **Why:** the exact SecretsPlugin/M29/M30 wiring precedent, plus `onClose` (unlike stateless M30)
  because this plugin owns a poll timer that must be released (AI_GUIDELINES §14.5 "all timers
  cleared on shutdown"). Making `status()` optional keeps custom-provider authors unburdened while
  giving the indicator two real, testable branches — without it the indicator could only ever return
  a constant `'up'`, which is a health check in name only and would hide exactly the failure mode
  the DB provider is designed to survive (a persistently failing poll silently serving stale flags).
  `optionalDependencies: [CAPABILITIES.LOGGER]` is wired to a real reader — the DB provider's
  poll-catch logs via `ctx.logger` — so it is not a dead dependency edge. No global middleware is
  added; the guard is per-route.
- **Test home:** `feature-flags-plugin.test.ts` (`createProvider` returns the right class per arm,
  unknown arm ⇒ throws, `'custom'` returns the instance, `provides`/`priority`/`name`, `onClose`
  calls `stop`, health indicator `'up'` for a provider with no `status()`, `'up'` for a healthy one,
  and `'degraded'` with `detail` for an unhealthy one) and the integration test (real kernel app:
  capability resolves, evaluation read-back through the public surface, guard short-circuit through
  a real route via `app.inject()`, health indicator resolves from `CAPABILITIES.HEALTH_INDICATOR`).

## 4. Exported surface — every symbol names its consumer

| Exported symbol                | Kind                         | Consumer / real code path that READS it                                                                                                                          |
| ------------------------------ | ---------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `FeatureFlagsPlugin`           | fn (factory)                 | app code `app.register(FeatureFlagsPlugin({...}))`; integration test.                                                                                            |
| `FeatureFlagService`           | class                        | `FeatureFlagsPlugin.register` constructs it; registered under `CAPABILITIES.FEATURE_FLAGS`; `feature-flags-service.test.ts`.                                     |
| `createProvider`               | fn                           | `FeatureFlagsPlugin.register` dispatches on the options union; `feature-flags-plugin.test.ts` (exported per the M30 `createProvider` precedent).                 |
| `createFlagGuard`              | fn                           | route `middleware: [createFlagGuard(...)]`; `feature-flag-middleware.test.ts`; integration test.                                                                 |
| `ConfigProvider`               | class                        | `createProvider('config')`; `config-provider.test.ts`.                                                                                                           |
| `MemoryProvider`               | class                        | `createProvider('memory')`; `memory-provider.test.ts`.                                                                                                           |
| `DatabaseProvider`             | class                        | `createProvider('database')`; `database-provider.test.ts`.                                                                                                       |
| `FlagProvider`                 | interface                    | the `'custom'` options arm (`instance: FlagProvider`) and custom-provider authors; the three built-in providers `implements` it; `FeatureFlagService` holds one. |
| `FlagProviderStatus`           | type                         | `FlagProvider.status?()` return; read by the plugin's health indicator (§3.5); asserted in `feature-flags-plugin.test.ts` and `database-provider.test.ts`.       |
| `FlagProviderType`             | type                         | the `provider` discriminant on `FeatureFlagsPluginOptions`; `FlagProvider.type`; the health indicator's `data.provider`.                                         |
| `FlagDefinition`               | type                         | `ConfigProviderOptions.flags` / `MemoryProviderOptions.flags` value type; `IFlagStore.loadFlags` value; `evaluateFlag` parameter; consumer-defined flag maps.    |
| `ConfigProviderOptions`        | type                         | the `'config'` arm of `FeatureFlagsPluginOptions`.                                                                                                               |
| `MemoryProviderOptions`        | type                         | the `'memory'` arm.                                                                                                                                              |
| `DatabaseProviderOptions`      | type                         | the `'database'` arm; carries `store: IFlagStore`.                                                                                                               |
| `CustomProviderOptions`        | type                         | the `'custom'` arm; carries `instance: FlagProvider`.                                                                                                            |
| `FeatureFlagsPluginOptions`    | type (discriminated union)   | `FeatureFlagsPlugin` parameter; `createProvider` switch.                                                                                                         |
| `FlagGuardOptions`             | type                         | `createFlagGuard` parameter.                                                                                                                                     |
| `IFlagStore`                   | interface                    | `DatabaseProviderOptions.store`; injected by the app; `fake-flag-store.ts` fixture implements it.                                                                |
| `IFeatureFlags`, `FlagContext` | type (re-export from common) | consumers resolving the capability and building a context.                                                                                                       |

> Internal (NOT exported from `src/index.ts`): `evaluateFlag` and `bucket` in
> `src/evaluation/flag-evaluator.ts` — consumed by the three providers and tested by importing the
> module directly, mirroring how other packages keep pure helpers internal.

### 4.1 Options — every option names its consumer

| Option                                      | Consumer                              | Behavior (per implementation)                                                                                                                         |
| ------------------------------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `provider`                                  | `FeatureFlagsPlugin`/`createProvider` | `'config' \| 'memory' \| 'database' \| 'custom'`; selects the provider.                                                                               |
| `options.flags` (`'config'`, `'memory'`)    | `ConfigProvider`/`MemoryProvider`     | `Readonly<Record<string, FlagDefinition>>`; the static flag set. Required for `'config'`, optional for `'memory'` (starts empty, mutated at runtime). |
| `options.store` (`'database'`)              | `DatabaseProvider`                    | `IFlagStore`; required; the app's read view of its flag table.                                                                                        |
| `options.refreshIntervalMs` (`'database'`)  | `DatabaseProvider`                    | poll cadence; defaults to `30000`. Both the default and an explicit value are driven in tests.                                                        |
| `options.instance` (`'custom'`)             | `createProvider`                      | a `FlagProvider`; returned as-is.                                                                                                                     |
| `createFlagGuard(flag, options.fallback)`   | `createFlagGuard`                     | redirect target when the flag is off; absent ⇒ the `statusCode` response.                                                                             |
| `createFlagGuard(flag, options.statusCode)` | `createFlagGuard`                     | status returned when off with no `fallback`; defaults to `404`.                                                                                       |
| `createFlagGuard(flag, options.context)`    | `createFlagGuard`                     | static context override; default `{ userId: ctx.request.user?.id }` with `userId` omitted when there is no user.                                      |

## 5. Implementation files

| File                                        | Purpose                                                                                                                                                                                                                                                                                                                                                                                                         |
| ------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                              | barrel exports (every symbol in §4), documented in PUBLIC_API.md; overwrites the existing M0 stub.                                                                                                                                                                                                                                                                                                              |
| `src/interfaces/index.ts`                   | the `FlagProvider` port (`type`/`isEnabled`/`start`/`stop`/`status?`) — **exported from the barrel**, since the `'custom'` arm and custom-provider authors implement it — plus `FlagDefinition`, `FlagProviderType`, `FlagProviderStatus`, `ConfigProviderOptions`, `MemoryProviderOptions`, `DatabaseProviderOptions`, `CustomProviderOptions`, `FeatureFlagsPluginOptions`, `FlagGuardOptions`, `IFlagStore`. |
| `src/evaluation/flag-evaluator.ts`          | pure `evaluateFlag(flag, def, context)` + `bucket(flag, userId)` (FNV-1a 32-bit over `` `${flag}:${userId}` ``, `% 100`); NOT re-exported from the barrel.                                                                                                                                                                                                                                                      |
| `src/services/feature-flags-service.ts`     | `FeatureFlagService implements IFeatureFlags` — holds one `FlagProvider`, delegates `isEnabled`, exposes `start`/`stop`/`status`.                                                                                                                                                                                                                                                                               |
| `src/providers/config-provider.ts`          | `ConfigProvider implements FlagProvider` — immutable flags, `evaluateFlag`.                                                                                                                                                                                                                                                                                                                                     |
| `src/providers/memory-provider.ts`          | `MemoryProvider implements FlagProvider` — mutable map, `evaluateFlag`, `setFlag`/`removeFlag`/`replaceFlags`.                                                                                                                                                                                                                                                                                                  |
| `src/providers/database-provider.ts`        | `DatabaseProvider implements FlagProvider` — injected `IFlagStore`, `runtime.setInterval` poll, snapshot eval, failure tracking for `status()`, `runtime.clearInterval` on stop.                                                                                                                                                                                                                                |
| `src/middleware/feature-flag-middleware.ts` | `createFlagGuard(flag, options?)` — resolves the service per request, evaluates, short-circuits to `redirect`/`404` or calls `next()`.                                                                                                                                                                                                                                                                          |
| `src/plugin/feature-flags-plugin.ts`        | `FeatureFlagsPlugin` factory + `createProvider(options, ctx)` (one arm per provider type) + the health indicator.                                                                                                                                                                                                                                                                                               |
| `deno.json`                                 | package scaffold: name `@hono-enterprise/feature-flags-plugin`, `version: 0.1.0`, `exports: ./src/index.ts`. **No `test.permissions` block** — with LaunchDarkly deferred (§2-C2) this package has no `npm:` import and no external dependency, matching `packages/notification-plugin/deno.json`. The workspace member `./packages/feature-flags-plugin` is already listed at root `deno.json:31`.             |

> The existing `packages/feature-flags-plugin/` stub (`deno.json` + `src/index.ts`) is overwritten
> by the Code-mode implementation; this plan does not edit it. ROADMAP M31's file list omits
> `memory-provider.ts`, `evaluation/flag-evaluator.ts`, and `interfaces/index.ts`, and lists
> `launchdarkly-provider.ts` which C2 defers; §2-C4 records both corrections.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                            | src covered                              | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ---------------------------------------------------- | ---------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/flag-evaluator.test.ts`                   | `evaluation/flag-evaluator.ts`           | `evaluateFlag(name, def, ctx)`: unknown (`def === undefined`) → `false`; `enabled:false` alone → `false`; **`{ enabled:false, users:['user1'] }` with `userId:'user1'` → `true`** and with `userId:'other'` → `false` (the §2-C5 semantics on the committed example flag); an allowlist hit bypasses a set `percentage`; `percentage >= 100` → `true`, `<= 0` → `false`; a userId hashing below the threshold → `true`, above → `false` (both arms driven with known pairs asserted against `bucket(flag, userId)`); the same `(flag, userId)` is stable across calls; no-userId partial rollout → `false`; `enabled:true` with no `percentage`/`users` → `true`; a context carrying `attributes` does not change the verdict.                                                                                                        |
| `test/unit/feature-flags-service.test.ts`            | `services/feature-flags-service.ts`      | `FeatureFlagService(provider).isEnabled(...)` delegates to the provider (fake records the call and the passed `FlagContext`); `await service.start()` calls `provider.start()`; `await service.stop()` calls `provider.stop()`; `service.status()` forwards the provider's `status()` and returns `undefined` when the provider has none. Type-checks against `IFeatureFlags.isEnabled`.                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `test/unit/config-provider.test.ts`                  | `providers/config-provider.ts`           | `type === 'config'`; `isEnabled` reflects the inline map; unknown flag → `false`; `start`/`stop` resolve without effect; no `status()`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `test/unit/memory-provider.test.ts`                  | `providers/memory-provider.ts`           | `type === 'memory'`; empty start; `setFlag`/`removeFlag`/`replaceFlags` mutate the store and the next `isEnabled` reflects the change (write → read-back); `evaluateFlag` path covered through a representative flag; `start`/`stop` no-op.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/unit/database-provider.test.ts`                | `providers/database-provider.ts`         | `type === 'database'`; fake `IFlagStore` (recording `loadFlags`); `start()` loads the initial snapshot and arms a timer captured by a fake `IRuntimeServices.setInterval`; `isEnabled` reads the snapshot; driving the captured poll callback swaps the snapshot when `loadFlags` resolves new data; a rejecting `loadFlags` on poll logs via the injected `logger`, KEEPS the previous snapshot, and flips `status()` to `{ healthy:false, detail }`; a later successful poll clears it back to `{ healthy:true }`; `stop()` calls `clearInterval` with the handle `setInterval` returned. Drives the `refreshIntervalMs ?? 30000` default and an explicit value, asserting the `ms` argument each time.                                                                                                                             |
| `test/unit/feature-flag-middleware.test.ts`          | `middleware/feature-flag-middleware.ts`  | fake `IRequestContext` + a service registry whose `get(CAPABILITIES.FEATURE_FLAGS)` returns a controllable `IFeatureFlags`; flag on ⇒ `next()` invoked, no response set; flag off + `fallback` ⇒ `response.redirect(fallback)` called, status 302, `next()` NOT called (short-circuit); flag off + no `fallback` ⇒ `response.status(404)` + `text('Not Found')`, `next()` NOT called; custom `statusCode` honored; context derived from `ctx.request.user.id`, `userId` omitted when there is no user, and overridden by `options.context`; an unregistered capability ⇒ the registry error propagates and `next()` is NOT called.                                                                                                                                                                                                    |
| `test/unit/feature-flags-plugin.test.ts`             | `plugin/feature-flags-plugin.ts`         | `createProvider` returns the right class for each arm; `'custom'` returns the supplied instance; unknown arm ⇒ throws; plugin `name`/`provides`/`priority`/`optionalDependencies`; `register` awaits `service.start()` (fake provider records start) and registers under `CAPABILITIES.FEATURE_FLAGS`; the `feature-flags` health indicator returns `{ status:'up', data:{ provider } }` for a provider with no `status()`, `'up'` for one reporting healthy, and `{ status:'degraded', data:{ provider, detail } }` for one reporting unhealthy; `onClose` hook calls `service.stop()`.                                                                                                                                                                                                                                              |
| `test/unit/barrel-exports.test.ts`                   | `index.ts` (+ `interfaces/index.ts`)     | every §4 symbol is defined/exported; `IFeatureFlags`/`FlagContext` re-export identically to `common`. `interfaces/index.ts` and `evaluation/flag-evaluator.ts` are exercised transitively by the provider/service tests that implement/consume them.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `test/integration/feature-flags-integration.test.ts` | plugin + service + middleware end-to-end | real kernel app `createApplication({ plugins: [RuntimePlugin(), FeatureFlagsPlugin({ provider:'config', options:{ flags:{ 'new-dashboard': { enabled:true, percentage:50 }, 'beta-features': { enabled:false, users:['user1'] } } } })] })`; resolve `IFeatureFlags` via `CAPABILITIES.FEATURE_FLAGS`; `isEnabled` read-back for an on flag, an off flag, and the allowlisted user on the off flag (C5 through the public surface); a route guarded by `createFlagGuard('beta-features', { fallback:'/old' })` returns a 302 to `/old` via `app.inject()` while the handler does NOT run; the `feature-flags` health indicator resolves via `app.services.getAll<IHealthIndicator>(CAPABILITIES.HEALTH_INDICATOR)`, is found by `name === 'feature-flags'`, and `await check()` reports `'up'`; `app.stop()` runs the `onClose` hook. |
| `test/fixtures/fake-context.ts`                      | fixture (excluded from coverage)         | fake `IPluginContext` for the `register`/`createProvider` unit tests; `services.get` throws for an absent token and `register` rejects a duplicate, mirroring the kernel's real `ServiceRegistry` so a missing fail-fast guard cannot hide (M30 precedent).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/fixtures/fake-flag-store.ts`                   | fixture (excluded from coverage)         | recording `IFlagStore` with a scriptable `loadFlags` (resolve/reject on demand).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/fixtures/fake-runtime.ts`                      | fixture (excluded from coverage)         | fake `IRuntimeServices` whose `setInterval` captures the callback and the `ms` argument and returns a handle `clearInterval` records (so the DB poll is driven synchronously in tests).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `test/fixtures/fake-flag-provider.ts`                | fixture (excluded from coverage)         | recording `FlagProvider` with a settable `isEnabled` verdict, `start`/`stop` call counters, and a scriptable `status()` (present-healthy, present-unhealthy, absent) so all three health-indicator branches are drivable.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |

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

- `exactOptionalPropertyTypes` is on: optional fields (`FlagGuardOptions.context`, the guard's
  derived `{ userId }`, `FlagProviderStatus.detail`, the health indicator's `data`) are built by
  omitting the property when absent, never by assigning `undefined` (the middleware and plugin tests
  assert the omitted shape).
- A synchronous contract plus an async provider risks serving before state is loaded ⇒ mitigated by
  running `await service.start()` inside async `register()`, which the kernel genuinely awaits
  (`application.ts:277`), so the app is not ready until the snapshot is initialized; init failure
  fails `app.start()` rather than silently evaluating every flag to `false`.
- A DB poll failure could silently stall the snapshot ⇒ mitigated by logging the rejection via
  `ctx.logger` (the consumer that justifies `optionalDependencies: [CAPABILITIES.LOGGER]`),
  retaining the last good snapshot rather than clearing it, and surfacing the condition as
  `'degraded'` through the health indicator so it is externally observable rather than invisible.
- Percentage rollout determinism depends on the hash staying stable ⇒ `bucket` is pure, has exactly
  one specified derivation (§3.2), and is unit-tested against fixed expected values; changing it
  would be a breaking change to rollout assignment and must be called out in the PR.
- The allowlist-over-`enabled` precedence (§2-C5) is a deliberate semantic choice that a future
  maintainer could reverse while "simplifying" the evaluator ⇒ mitigated by testing it directly on
  the committed example flag in both the unit and integration suites, and by stating it in the
  PUBLIC_API Options subsection.
- Deferring LaunchDarkly leaves committed docs naming a provider this milestone does not ship ⇒
  mitigated by the C2 doc deliverables (ROADMAP, ARCHITECTURE Rules row, PUBLIC_API Notes) landing
  in the same PR, so no committed document claims a provider that does not exist.

## 9. Out of scope

- `LaunchDarklyProvider` (§2-C2): the Node server SDK's `variation`/`allFlagsState` are async, so it
  cannot satisfy the synchronous committed `IFeatureFlags`. A first-party provider waits on a
  milestone that decides whether `IFeatureFlags` gains an async method; until then the `'custom'`
  arm is the documented bridge.
- A flag admin/mutation HTTP surface and a flag-change audit trail (app concern; compose
  `audit-plugin` M26 and guard the routes with M16 auth).
- A segment/rule engine beyond `users`/`enabled`/`percentage`, and attribute-based targeting over
  `FlagContext.attributes` — a second rule engine here would be dead surface; the `'custom'`
  provider arm is the extension point for it.
- Push-based flag updates from `DatabaseProvider` (it polls; push needs a runtime watch/stream seam
  that does not exist in `IRuntimeServices`).
- Multi-tenancy-aware flag overrides and per-tenant targeting (M32 owns tenancy).
- Additional providers (Unleash, ConfigCat, Flagsmith, Split, GrowthBook) beyond
  Config/Memory/Database plus the `'custom'` injection seam (the exported `FlagProvider` port lets a
  consumer add these without a core change; first-party integrations are a future milestone).
