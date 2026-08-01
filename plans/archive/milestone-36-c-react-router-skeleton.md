# Milestone 36c — React Router app skeleton + config-driven composition (`@hono-enterprise/cli`, `full-stack-starter`, `config-plugin`)

> **Status:** Implemented. Branch: `feat/m36c-react-router-skeleton`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

> **Base-branch note (resolved).** This branch was originally cut from
> `feat/m36b-starter-integration` so §1 could verify M36b's `TemplateDefinition.files` /
> `Wiring.args` seam and the `realtime`/`di` arms from source while they were unmerged. **PR #107
> has since merged** (merge commit `732d03c`), and this branch is now rebased directly onto `main`,
> so every §1 row cites code that is on `main`. No further rebase is owed.

## 0. Objective & scope

M44 shipped a deliberately convention-agnostic `react-router-plugin`: it mounts the RR handler,
bridges DI through `loadContext`, and serves assets. Nothing in the repo tells an author **how to
lay out the app** — so the full-stack story ends at "a plugin exists". This milestone ships the
missing app-side structure as a scaffoldable skeleton (`honoe new --template full-stack`), adapted
from the B2BAdmin reference, with its cross-cutting `lib/` **rewired onto the shipped plugins**
rather than reimplemented. It also closes the config-ordering gap M36 and M36b both deferred, by
making config resolvable **before** plugin construction instead of inventing per-option
`urlFromConfig` magic.

- **In scope:**
  1. A `full-stack` CLI template emitting a React Router 8 framework-mode skeleton: the
     `feature → service → lib → model` layering, `flatRoutes` `_app`/`_auth` layout groups, the
     `~/*` alias, `.server.ts` convention, and the Vite/npm build files (§3.1–§3.4).
  2. Rewiring the six B2BAdmin cross-cutting concerns that have plugin targets, plus session and
     form-CSRF onto M48, through one `populateLoadContext` hook and app-declared context keys
     (§3.5–§3.6).
  3. `TemplateDefinition.appFactory` — the template-contract field that lets a template compose via
     a starter instead of inlining 22 plugin wirings (§3.3). This is the first template to import a
     starter, reversing M36 C2 with cause (C2 below).
  4. Config-driven composition: a standalone `loadConfig()` exported from `config-plugin`, a
     `ConfigPluginOptions.instance` arm so one snapshot serves both paths, and
     `createFullStackAppFromConfig()` (§3.7–§3.9). Per-option `urlFromConfig` is **rejected** with
     cause (C3).
- **NOT this milestone:** migrating B2BAdmin itself off `@react-router/serve` (validation exercise,
  §9); example applications under `apps/*` — Milestone 37; a general `honoe new --starter` flag for
  the `rest`/`microservice`/`nest` templates (§9 — those stay inline; only `full-stack` composes via
  a starter, and only because inlining 22 wirings is illegible); secrets resolved before startup
  (§9, C3 — structurally impossible pre-`start()`).

## 1. Contracts verified from SOURCE (not names)

| Reference                            | Source (file:line)                                                           | Verified surface / fact                                                                                                                                                                                                                                                                                                                                             |
| ------------------------------------ | ---------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `PopulateLoadContext`                | `packages/react-router-plugin/src/interfaces/index.ts:97-100`                | `(ctx: IRequestContext, context: RouterLoadContext) => void`. Receives the **full kernel request context**, and is called AFTER the plugin sets its own keys, so it augments rather than replaces. This is the seam the whole session/CSRF rewiring depends on.                                                                                                     |
| `ReactRouterPluginOptions`           | `packages/react-router-plugin/src/interfaces/index.ts:107-171`               | `serverBuildPath` (**required**), `loadRequestHandler?`, `assetsDir?`, `assetUrlPrefix?` (default `/assets/`), `basename?` (default `/`, MUST match the app's `basename`), `populateLoadContext?`, `mode?`. No `getLoadContext` — it was removed in 0.2.0.                                                                                                          |
| `servicesContext` / `userContext`    | `packages/react-router-plugin/src/handler/context-keys.ts:38-53`             | Exported keys typed `RouterContextKey<IServiceRegistry \| null>` and `RouterContextKey<IPrincipal \| null>`, both defaulting to `null`. Read in a loader as `context.get(servicesContext)?.get<T>(CAPABILITIES.X)`.                                                                                                                                                 |
| `RouterContextKey<T>`                | `packages/react-router-plugin/src/interfaces/index.ts:33-36`, `src/index.ts` | `{ readonly defaultValue?: T }`, used **by identity**, and structurally interchangeable with RR's own `createContext<T>()`. **Exported from the barrel**, so the skeleton can declare its own keys without importing `react-router` in server code.                                                                                                                 |
| `applyDefaultLoadContext`            | `packages/react-router-plugin/src/handler/load-context.ts:23-32`             | Sets `servicesContext` always; sets `userContext` only when `ctx.request.user != null`. NOT barrel-exported — the skeleton uses the keys, never this function.                                                                                                                                                                                                      |
| Static-asset behaviour without `fs`  | `packages/react-router-plugin/src/assets/static-assets.ts:48`                | Returns **`404` when `fs` is absent** — a graceful miss, NOT a throw. So the skeleton is viable on Cloudflare Workers with `assetsDir` omitted and the platform serving assets; no runtime needs refusing (§3.4).                                                                                                                                                   |
| Asset route gating                   | `packages/react-router-plugin/src/plugin/react-router-plugin.ts:141-142`     | The asset route is registered only when `options.assetsDir != null`, so omitting it registers no route at all.                                                                                                                                                                                                                                                      |
| M48 session surface                  | `packages/session-plugin/src/index.ts:36-67`                                 | Exports `SessionPlugin`, `getSession`, `csrfFormMiddleware`, `getCsrfToken`, `verifyCsrfToken`, `CSRF_SESSION_KEY`, `sessionMiddleware`, `MemorySessionStore`, `CacheSessionStore`, and the option types. **`getSession` takes an `IRequestContext`**, not an RR context.                                                                                           |
| `config-plugin` barrel               | `packages/config-plugin/src/index.ts:15-19`                                  | Exports **only** `ConfigPlugin`, `ConfigPluginOptions`, `StructuralSchema`. `ConfigService`, `loadEnv`, `expandVariables`, `validateConfig` all exist but are NOT reachable from outside the package — which is exactly why config cannot currently be resolved pre-`start()`.                                                                                      |
| `ConfigPlugin.register` body         | `packages/config-plugin/src/plugin/config-plugin.ts:94-113`                  | Resolves `CAPABILITIES.RUNTIME`, then `await loadEnv(runtime, …)` → `expandConfigVariables` → `validateConfig` → `new ConfigService(data)` → registers under `CAPABILITIES.CONFIG`. Priority `HIGH`. So building an `IConfig` needs an `IRuntimeServices` and one `await`.                                                                                          |
| `loadEnv`                            | `packages/config-plugin/src/services/env-loader.ts:28-38`                    | `(runtime: IRuntimeServices, options?: EnvLoaderOptions) => Promise<Record<string, string>>`. Throws only when `envFilePath` is set AND `runtime.fs` is absent — so with no `envFilePath` it works on every runtime including Workers.                                                                                                                              |
| `ConfigService`                      | `packages/config-plugin/src/services/config-service.ts:20-30`                | `implements IConfig`; constructor takes `Readonly<Record<string, unknown>>` and shallow-copies it. Immutable startup snapshot — no reload API, which is why sharing ONE instance between the two paths is safe (§3.8).                                                                                                                                              |
| `IConfig`                            | `packages/common/src/services/config.ts:20-37`                               | `get<T>(key)`, `get<T>(key, { default })`, `getOrThrow<T>`, `has`. Read-only; no `set`.                                                                                                                                                                                                                                                                             |
| M36b template seam                   | `packages/cli/src/templates/registry.ts` (M36b), `src/commands/new.ts:101`   | `Wiring.args?: string` rendered as `${symbol}(${args ?? ''})`; `TemplateDefinition.localImports?` and `files?: readonly GeneratedFile[]`; `projectFiles(name, runtime, plugins, middleware, localImports, extras)`. **This is the mechanism the skeleton's ~24 files ride on.**                                                                                     |
| M36b starter arms                    | `packages/starters/rest-starter/src/options.ts` (M36b)                       | `realtime?: RealtimeArm` (`websocket`/`sse`/`backplane`) and `di?: DiPluginOptions`, inherited by the full-stack tier. The skeleton needs `realtime.sse` for its SSE feature, so it consumes an M36b arm rather than registering the plugin itself.                                                                                                                 |
| `full-stack-starter` reactRouter arm | `packages/starters/full-stack-starter/src/options.ts`, `src/app.ts:49`       | `reactRouter?: ReactRouterPluginOptions`, gated: `...(options.reactRouter ? [ReactRouterPlugin(options.reactRouter)] : [])`. Passed through unchanged, so `populateLoadContext` reaches the plugin with no starter change.                                                                                                                                          |
| Vite/npm boundary                    | `AI_GUIDELINES.md:694-700` (§12.2)                                           | "**Build-time app tooling is NOT a §12.2 dependency.**" A frontend build tool lives in the consuming application's `devDependencies` and is never imported by a plugin. So the skeleton's `package.json` carrying `vite` + `@react-router/dev` is explicitly sanctioned.                                                                                            |
| `packages/runtime` barrel            | `packages/runtime/src/index.ts:11-30`                                        | Exports `RuntimePlugin`, `detectRuntime`, and the FOUR per-platform factories (`createDenoRuntimeServices` etc.) — but **no detected-platform factory**. `RuntimeAdapterFactories` is declared in `runtime-plugin.ts` and NOT barrel-exported. So nothing outside the package can build an `IRuntimeServices` without re-deriving the platform→factory map (§3.10). |
| `RuntimePlugin.register`             | `packages/runtime/src/plugin/runtime-plugin.ts:77-131`                       | The platform→factory map (`defaultRuntimeAdapters`) is a module-private const; `register()` resolves `options.platform ?? detectRuntime()`, indexes the map, throws `No runtime adapter factory for platform: <p>` on a miss, and only then registers. This whole path is reachable **only from inside `register()`** — the gap §3.10 closes.                       |
| `full-stack-starter` manifest        | `packages/starters/full-stack-starter/deno.json:8`                           | Already maps `@hono-enterprise/runtime`, so §3.10's new export is reachable from the starter with **no manifest change** and no new dependency edge.                                                                                                                                                                                                                |
| `RestStarterOptions.config`          | `packages/starters/rest-starter/src/options.ts:77`                           | `config?: ConfigPluginOptions`, threaded to `ConfigPlugin(options.config)` at `src/app.ts:38` and inherited by the full-stack tier through the `extends` chain. This is the arm §3.7 sets `instance` on — it needs no starter option change.                                                                                                                        |
| B2BAdmin routing convention          | `/home/dkpaul91/Projects/B2BAdmin/app/routes.ts:1-14`                        | `layout('./components/layouts/LoginLayout.tsx', [...await flatRoutes({ rootDirectory: 'routes/_auth' })])`, same for `_app` (nested inside an `AppOutletBoundary`), then root-level `flatRoutes({ rootDirectory: 'routes' })`. Imports `@react-router/dev/routes` + `fs-routes`.                                                                                    |
| B2BAdmin `~/*` alias                 | `/home/dkpaul91/Projects/B2BAdmin/tsconfig.json:12`                          | `"~/*": ["./app/*"]` under `compilerOptions.paths`.                                                                                                                                                                                                                                                                                                                 |
| B2BAdmin cross-cutting `lib/`        | `/home/dkpaul91/Projects/B2BAdmin/app/lib/` (listing)                        | 14 modules. Eight are cross-cutting: `session.server.ts`, `csrf.server.ts`, `cookie-attrs.server.ts`, `sse.server.ts`, `kv.server.ts`, `http/xior.server.ts`, `appinsights-bootstrap.server.ts`, `service-logger.server.ts`. `route-guards.server.ts` is a ninth (auth).                                                                                            |
| B2BAdmin service locator             | `/home/dkpaul91/Projects/B2BAdmin/app/config/services.server.ts:1-40`        | Caches per-service base URLs from `getSetting()` (Key Vault) in a module-level `Map`, and caches one `xior` client per service. This is the module the `loadContext` bridge replaces — the cache becomes the kernel registry.                                                                                                                                       |
| B2BAdmin feature shape               | `/home/dkpaul91/Projects/B2BAdmin/app/features/products/`                    | One `<name>.server.ts` per feature, with matching `app/services/<name>.server.ts` and `app/models/`. Confirms the layering is per-feature server modules, not per-feature directories of many files.                                                                                                                                                                |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                        | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                                                                       | Doc deliverable (same PR)                                                                                                                                                              |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | `ROADMAP.md:3766-3781` says the app structure is "owned by THIS milestone's Full-Stack Starter, NOT by the plugin". But a starter is a JSR **library**: it cannot deliver `app/routes.ts` into a user's project. Only the CLI can write files.  | **Split ownership explicitly.** The `full-stack-starter` package owns the **plugin composition**; the `full-stack` CLI template owns the **file layout**, and its generated `honoe.config.ts` calls `createFullStackApp`. ROADMAP's intent (not the plugin) is honoured; its implied mechanism (a library shipping app files) is impossible and is corrected.                                                                                                                  | Rewrite the `ROADMAP.md:3766` note to name the CLI template as the delivery mechanism and the starter as the composition it wires.                                                     |
| C2 | M36 §9 and M36b C2 both state templates emit **inline wiring, never starter imports**, and defer `honoe new --starter`. This milestone's `full-stack` template imports `createFullStackApp`.                                                    | **Reversed for this one template, with cause.** Inlining the full-stack set is ~22 plugin wirings plus their imports in a file a human is meant to read and edit; the starter exists precisely to name that composition once. `rest`/`microservice`/`nest` stay inline and unchanged, so the rule holds everywhere its rationale holds.                                                                                                                                        | Update the M36 §9 / M36b C2 statements (both in `plans/archive/`) with an M36c note, and the `PUBLIC_API.md` "Not in this release" bullet that defers starter-backed scaffolding.      |
| C3 | `PUBLIC_API.md` and `ROADMAP.md` examples show `urlFromConfig` / `secretFromConfig` / `endpointFromConfig` option shorthands. No plugin option type carries those fields (M36 §2 C2 recorded this and deferred it twice).                       | **Rejected, not implemented.** A per-option config key needs the value at plugin-construction time, which is before `ConfigPlugin` has registered; the alternatives are an async starter (breaking) or plugin-contributes-plugin (a kernel change). §3.7's `createFullStackAppFromConfig` delivers the same capability uniformly for **every** option with neither. `secretFromConfig` is worse: secrets come from a plugin, so nothing can resolve them pre-`start()` at all. | Delete every `urlFromConfig`/`secretFromConfig`/`endpointFromConfig` occurrence from `PUBLIC_API.md` and `ROADMAP.md`, replacing them with the `createFullStackAppFromConfig` pattern. |
| C4 | `ROADMAP.md:3732` heading `## Milestone 36: Starters` carries **no `✅ COMPLETE` marker** and all five of its deliverable checkboxes are `[ ]`, while the Progress table row reads `36 \| ✅` and `CLAUDE.md` records it complete with PR #106. | **The Progress table is right; the section was never flipped.** M36 shipped. Tick the four boxes M36 delivered and mark the heading complete; the fifth box (the React Router app structure) is **this** milestone's, so it moves to the M36c section rather than being ticked under M36.                                                                                                                                                                                      | Mark the M36 heading `✅ COMPLETE`, tick its four delivered boxes, and move the app-structure box into the new M36c section.                                                           |
| C5 | `CLAUDE.md`'s M36 status entry and `ROADMAP.md:3787` both describe the app-structure deliverable as belonging to M36, which shipped without it.                                                                                                 | **Record it as deferred, not delivered.** M36's PR did not ship an app skeleton; saying otherwise is the "checked a box that is a behavioural claim" failure. Its status entry gains an explicit "app structure deferred to M36c" clause.                                                                                                                                                                                                                                      | Amend the `CLAUDE.md` M36 entry, and add the M36c entry + ROADMAP section and Progress row (`36c`).                                                                                    |

## 3. Design decisions

### 3.1 The skeleton ships as a CLI template, emitted through M36b's `files` seam

- **Decision:** a `full-stack` entry in `TEMPLATES`, backed by
  `packages/cli/src/templates/full-stack.ts`, whose `files` array carries the whole `app/` tree plus
  the Vite build files as string constants. Emission reuses M36b's `TemplateDefinition.files` with
  no new mechanism.
- **Why:** the CLI is the only component that writes files into a user's project (C1), and M36b
  already added exactly this seam and a drift gate that type-checks generated output. Building a
  second delivery mechanism (a `copy-skeleton` command, a tarball) would duplicate `projectFiles`'s
  overwrite check, which is the one place that check may live.
- **Test home:** `test/unit/templates.test.ts` asserts the emitted path set; the §6 e2e gate
  scaffolds and type-checks it.

### 3.2 The emitted layering is B2BAdmin's, minus what plugins already own

- **Decision:** emit `app/{routes.ts,root.tsx,entry.client.tsx,entry.server.tsx,app.css}`,
  `app/routes/_app/`, `app/routes/_auth/`, `app/components/layouts/`,
  `app/features/<name>/<name>.server.ts`, `app/services/<name>.server.ts`, `app/models/`,
  `app/lib/`, and `app/config/services.server.ts` — one worked example feature (`products`) rather
  than an empty tree, so the layering is legible. `app/lib/` ships **only** app-specific glue
  (`utils.ts`, `nav-utils.ts`); the eight cross-cutting modules are NOT reimplemented (§3.5).
- **Why:** the layering is the deliverable and it is verified from the reference (§1). One real
  feature is what makes a convention followable; an empty `features/` directory teaches nothing. The
  omission of the eight modules is the ROADMAP's "critical rule when adapting" applied literally.
- **Test home:** `test/unit/full-stack-template.test.ts` asserts the path set includes the layering
  directories and **excludes** a `session.server.ts` / `csrf.server.ts` / `sse.server.ts` under
  `app/lib/` — a regression guard against reintroducing what the plugins own.

### 3.3 `TemplateDefinition.appFactory` — composing via a starter

- **Decision:** one new optional field, `appFactory?: AppFactoryWiring`. When present,
  `configModule` emits `const app = await <symbol>(<args(runtime) ?? ''>);` and imports `<symbol>`
  from `@hono-enterprise/<pkg>`, instead of `createApplication({ plugins: [...] })`; `plugins` is
  then required to be empty and `middleware` still applies. When absent, rendering is byte-identical
  to today.
- **Amended during implementation (deviation from `appFactory?: Wiring`, flagged):** the field takes
  its OWN type rather than reusing `Wiring`, because `Wiring.args` is a fixed `string` and §3.4
  requires the argument list to differ by runtime target — a fixed string structurally cannot
  express "omit `assetsDir` on Workers". `AppFactoryWiring.args` is therefore
  `(runtime: TargetRuntime) => string`. The rendered call is always `await`ed and the generated
  factory is `async`, which needed no seam change: `app-loader.ts:122` already does
  `await (factory as () => unknown)()`, verified in source before relying on it.
- **Also amended:** the `appFactory` branch emits **no** `app.router.get('/')` hello-world route.
  The kernel prefers a static route over a wildcard, so an exact `/` handler would take precedence
  over the SSR catch-all and shadow the application's own index route — the generated project would
  serve `{"message":"Hello, World!"}` at `/` forever.
- **Why:** C2. Expressing "compose via `createFullStackApp`" through `plugins: Wiring[]` is
  impossible — a starter factory returns an application, not an `IPlugin`. A fourth optional field
  is the smallest change that keeps templates DATA behind the one renderer.
- **Test home:** `test/unit/templates.test.ts` asserts an `appFactory`-less template still renders
  `createApplication`, and that the `full-stack` template renders the starter call and imports the
  starter package; `test/unit/new-command.test.ts` asserts the manifest pins the starter package.

### 3.4 Every runtime target is supported; Workers omits `assetsDir`

- **Decision:** `unsupported: {}`. For `--runtime cloudflare-workers` the generated
  `honoe.config.ts` omits `assetsDir` and a README note directs the reader to Workers' own
  static-asset binding; every other target sets `assetsDir: './build/client/assets'`.
- **Why:** verified in §1 — a missing `fs` makes the asset handler return `404` rather than throw,
  and the asset route is not registered at all when `assetsDir` is omitted. So Workers is genuinely
  viable, and refusing it would be a false refusal. The runtime-conditional value is the only
  runtime-dependent part of this template.
- **Test home:** `test/unit/full-stack-template.test.ts` asserts `assetsDir` is present for `deno`
  and absent for `cloudflare-workers`; the e2e gate scaffolds all four targets.

### 3.5 The cross-cutting rewiring: eight modules, seven plugin targets, one hook

- **Decision:** replace each B2BAdmin cross-cutting module with a plugin read through
  `context.get(servicesContext)`, per this fixed mapping:

  | B2BAdmin module                       | Replaced by                                                         |
  | ------------------------------------- | ------------------------------------------------------------------- |
  | `lib/session.server.ts`               | M48 `getSession(ctx)` via `sessionContext` (§3.6)                   |
  | `lib/cookie-attrs.server.ts`          | M48 `SessionCookieOptions` — the plugin owns cookie attributes      |
  | `lib/csrf.server.ts`                  | M48 `csrfFormMiddleware` + `verifyCsrfToken`                        |
  | `lib/sse.server.ts`                   | `CAPABILITIES.SSE` (M43), reached via the M36b `realtime.sse` arm   |
  | `lib/kv.server.ts`                    | `CAPABILITIES.SECRETS` (M25 Azure Key Vault provider)               |
  | `lib/http/xior.server.ts`             | `@hono-enterprise/sdk` (M35) `createClient`                         |
  | `lib/appinsights-bootstrap.server.ts` | `CAPABILITIES.TELEMETRY` (M24) — exporter config, not app bootstrap |
  | `lib/service-logger.server.ts`        | `CAPABILITIES.LOGGER`                                               |
  | `lib/route-guards.server.ts`          | `auth-plugin` guard factories + `userContext`                       |
  | `config/services.server.ts`           | the kernel registry itself — its two module-level caches disappear  |

- **Why:** this is the ROADMAP's "critical rule when adapting", made concrete and per-module rather
  than left as an instruction. `config/services.server.ts`'s caches are the clearest case: it exists
  to memoise secret lookups and HTTP clients per process, which is what the service registry already
  is, so keeping it would be a second DI container.
- **Test home:** `test/unit/full-stack-template.test.ts` asserts the emitted
  `app/config/services.server.ts` reads `servicesContext` and contains no module-level `Map` cache;
  §3.2's exclusion test covers the rest.
- **Amended during implementation — the starters had no `session` arm.** The mapping above assumes
  the application can register `SessionPlugin`, but M48 shipped AFTER M36, so no starter tier
  exposed one and `createFullStackAppFromConfig({ session: … })` would not have type-checked. Added
  `session?: SessionPluginOptions` to `RestStarterOptions` (inherited by both other tiers through
  the existing `extends` chain, exactly as M36b's `realtime`/`di` arms are), **gated**: the plugin
  throws during `register()` without an adequate secret, so an always-on arm would stop every
  starter application from booting. This makes `packages/starters/rest-starter` a fifth package in
  the milestone; recorded in §8. Test home: `rest-starter/test/unit/app.test.ts` drives a real
  request that writes and reads a session back, so the arm is proven wired rather than merely
  listed.

### 3.6 Session reaches loaders through an app-declared context key, never a plugin-to-plugin import

- **Decision:** the skeleton declares its own key in `app/lib/context-keys.ts`
  (`export const sessionContext: RouterContextKey<ISession | null> = { defaultValue: null }`) and
  the generated `honoe.config.ts` wires it:
  `populateLoadContext: (ctx, context) => { context.set(sessionContext, getSession(ctx)); }`.
- **Why:** `getSession` takes an `IRequestContext`, which a loader never sees, while
  `populateLoadContext` receives exactly that (§1). Doing this in **app** code is what keeps
  `react-router-plugin` ignorant of `session-plugin`: AI_GUIDELINES §2.2/§3.3 forbid a plugin
  importing another, and adding a session key to the plugin would violate it. `RouterContextKey` is
  barrel-exported precisely so an app can declare keys without importing `react-router` server-side.
- **Amended during implementation — the original design does not work, and fails SILENTLY.** Running
  the scaffolded application proved it: `/products` returned 500 (`No logger on this
  request`) and
  `/login` returned 200 with `<input name="_csrf" value="">` — an empty CSRF token. Cause: a key is
  matched by **identity**, and `app/lib/context-keys.ts` exists twice at runtime — Vite INLINES it
  into `build/server/index.js`, while Deno loads `honoe.config.ts` (and through it the same file)
  from source. The two `{ defaultValue: null }` objects look identical and match nothing, so every
  read returns the default. **No gate could see this**: `deno check` passed, all 806 suites passed,
  and every changed file was ≥97% covered. Only running the built app found it.
  - **Fix (maintainer-chosen, option 1 of three):** the SSR plugin gains
    `contextKeyFor(name, defaultValue)`, memoised per name in module scope, and the skeleton builds
    every key through it. Both copies of the app module then resolve the same object.
  - That requires the plugin to be ONE module instance, so the emitted `vite.config.ts` marks
    `@hono-enterprise/*` external under `environments.ssr.build.rollupOptions.external` —
    established against the real toolchain, not assumed: a top-level `ssr.external` and
    `environments.ssr.resolve.external` were both tried first and are NOT applied to the build React
    Router runs.
  - Consequent file split: `app/lib/context-keys.server.ts` (value-imports the plugin, server-only)
    and `app/lib/load-context.ts` (the `AppLoadContext` type alone, safe for client code). A route
    component may no longer read a key directly — it calls an accessor in
    `app/config/services.server.ts` — because the client bundle inlines what it imports and cannot
    resolve a JSR specifier at all.
  - The login loader no longer defaults its token to `''`: an absent token now throws, so the same
    class of failure cannot be silent again.
- **Test home:** `test/integration/full-stack-skeleton.test.ts` boots a kernel app with
  `SessionPlugin` + a fake SSR runtime, and asserts a loader reads a session written by a prior
  request. The fake runtime honours the real `SsrRuntime` contract (`handler` +
  `createLoadContext`).

### 3.7 Config-driven composition is a factory that takes a resolver, not per-option key fields

- **Decision:** add
  `createFullStackAppFromConfig(build: (config: IConfig) => FullStackStarterOptions, configOptions?: ConfigPluginOptions): Promise<IKernelApplication>`.
  It loads config once via §3.8's `loadConfig`, calls `build(config)`, and passes the resulting
  options to the existing synchronous `createFullStackApp`, with `config: { instance }` set so the
  app registers that same snapshot.
- **Why:** C3. This delivers config-driven composition for **every** option uniformly —
  `(config) => ({ database: { url: config.getOrThrow('DATABASE_URL') } })` — with no kernel change,
  no per-option magic field, and no breaking change to the published synchronous factories. The
  existing `createFullStackApp` signature is untouched.
- **Test home:** `packages/starters/full-stack-starter/test/integration/from-config.test.ts` asserts
  a value from an injected env reaches a plugin arm, and that
  `app.services.get(CAPABILITIES.CONFIG)` is the **same object** the resolver saw.

### 3.8 `loadConfig` is one implementation with two entry points

- **Decision:** extract `ConfigPlugin.register`'s body into an exported
  `loadConfig(runtime: IRuntimeServices, options?: ConfigPluginOptions): Promise<IConfig>`, and have
  `ConfigPlugin.register` call it. Both are then the same code path.
- **Why:** the repo's "one capability, one implementation — every entry point honours the same
  config" rule. A second copy of load → expand → validate in the starter would drift from the
  plugin's, and `expandVariables`/`validationSchema` would silently stop applying on the new path —
  the exact split that shipped green once before.
- **Test home:** `packages/config-plugin/test/unit/load-config.test.ts` drives **both** entry points
  under a NON-default configuration (`expandVariables: false` plus a `validationSchema`) and asserts
  identical output.

### 3.9 `ConfigPluginOptions.instance` guarantees a single snapshot

- **Decision:** add `instance?: IConfig`. When present, `register()` registers it verbatim and skips
  loading entirely.
- **Why:** without it, `createFullStackAppFromConfig` loads config once and then `ConfigPlugin`
  loads it **again** at `register()`, so the app can hold two snapshots built from environments read
  at different moments — and the one the resolver branched on would not be the one handlers read.
  That is a silent divergence that a test exercising one path in isolation cannot catch.
  `ConfigService` is an immutable snapshot (§1), so sharing one instance is safe.
- **Test home:** `packages/config-plugin/test/unit/load-config.test.ts` asserts an injected
  `instance` is the exact object registered under `CAPABILITIES.CONFIG` and that no env read occurs
  (a runtime fake whose `env` getter throws if touched).

### 3.10 `createRuntimeServices` — the pre-`start()` runtime seam §3.7 needs

- **Decision:** export
  `createRuntimeServices(options?: { platform?: RuntimePlatform; adapters?: RuntimeAdapterFactories }): IRuntimeServices`
  from `packages/runtime`, extracted from `RuntimePlugin.register`'s runtime branch — which then
  **calls it**, so the platform resolution, the factory lookup and the "no adapter for platform"
  throw exist once. `RuntimeAdapterFactories` is added to the barrel because it now appears in a
  public signature. `createFullStackAppFromConfig` (§3.7) calls it to obtain the `IRuntimeServices`
  that `loadConfig` (§3.8) requires.
- **Why:** §3.7 was under-specified — it said "loads config once via `loadConfig`" without naming
  where its first argument comes from, and `loadConfig(runtime, …)` cannot be called before an
  application exists. Verified in §1: the barrel exports `detectRuntime` and four per-platform
  factories but no factory for the _detected_ platform, and the map that joins them is private to
  `register()`. The alternatives were both worse: re-deriving the map inside the starter is a second
  copy that silently stops matching when a platform is added (the duplicate-implementation defect
  §3.8 exists to prevent), and making the caller pass a per-platform factory would force a four-way
  platform switch into the generated `honoe.config.ts`, which is exactly the runtime-specific app
  code the framework exists to remove.
- **Consequence recorded, not hidden:** the app then holds **two** `IRuntimeServices` instances —
  the one this function builds for config loading and the one `RuntimePlugin` builds at
  `register()`. That is sound because the adapters are stateless facades over platform globals
  (`env`, `now`, `hrtime`, `fs`, `subtle`), holding no connection, no cache and no handle registry;
  nothing reads identity. Passing the instance into `RuntimePlugin` instead would mean routing it
  through the `adapters` option, which is `@internal` and platform-keyed — abusing a test seam to
  avoid an allocation. A test asserts both instances read the same env.
- **Test home:** `packages/runtime/test/unit/create-runtime-services.test.ts` drives the function
  directly (injected `adapters` per platform, the unknown-platform throw) and asserts **both entry
  points** — the function and `RuntimePlugin.register` — produce services from the same injected
  factory, so the delegation is proven rather than assumed.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                                       | Kind     | Consumer / real code path that READS it                                                                             |
| ----------------------------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------- |
| `createRuntimeServices` (`runtime`)                   | function | `RuntimePlugin.register` (§3.10) and `createFullStackAppFromConfig` (§3.7). Two real callers, one implementation.   |
| `RuntimeAdapterFactories` (`runtime`)                 | type     | The `adapters` parameter of `createRuntimeServices` — a public signature cannot name an unexported type (§3.10).    |
| `loadConfig` (`config-plugin`)                        | function | `ConfigPlugin.register` (§3.8) and `createFullStackAppFromConfig` (§3.7). Two real callers, one implementation.     |
| `ConfigPluginOptions.instance` (`config-plugin`)      | option   | `ConfigPlugin.register`'s skip-loading branch (§3.9); set by `createFullStackAppFromConfig`.                        |
| `createFullStackAppFromConfig` (`full-stack-starter`) | function | The `full-stack` template's generated `honoe.config.ts` (§3.3) — so the CLI drift gate type-checks and executes it. |
| `FULL_STACK_TEMPLATE` (`cli`, internal)               | const    | `TEMPLATE_REGISTRY` in `templates/registry.ts`. Not barrel-exported, like the other three templates.                |
| `TemplateDefinition.appFactory` (`cli`, internal)     | field    | `configModule` in `commands/new.ts` (§3.3). Internal to the package — `TemplateDefinition` is not barrel-exported.  |

`createRuntimeServices` is a fourth package (`packages/runtime`) touched by this milestone; §8
records that against the one-package-per-milestone rule. No new symbol is added to
`packages/common`, and no new capability token is invented — every capability the skeleton consumes
(`SSE`, `SECRETS`, `TELEMETRY`, `LOGGER`, `SESSION`, `SSR`) was committed by an earlier milestone.
`sessionContext` is emitted **into the scaffolded project**, not exported from any package, so it is
app code and carries no public-API obligation.

### 4.1 Options — every option names its consumer

| Option                          | Consumer                       | Behavior (per implementation)                                                                                                                                                                         |
| ------------------------------- | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `platform` (§3.10)              | `createRuntimeServices`        | Present → that platform's factory is used. Absent → `detectRuntime()`. Read on a real path: `RuntimePlugin` passes its own resolved platform.                                                         |
| `adapters` (§3.10)              | `createRuntimeServices`        | Present → looked up instead of the default map, so an unsupported platform still throws by name. Absent → the built-in four. `RuntimePlugin` passes its resolved map, so both are read outside tests. |
| `ConfigPluginOptions.instance`  | `ConfigPlugin.register`        | Present → registered verbatim, **no** env read, `envFilePath`/`expandVariables`/`validationSchema` ignored (documented). Absent → today's load path.                                                  |
| `configOptions` (2nd arg, §3.7) | `createFullStackAppFromConfig` | Forwarded to `loadConfig`, then re-used as the app's `config` arm alongside `instance`, so one options object governs both.                                                                           |
| `appFactory` (§3.3)             | `configModule`                 | Present → renders `const app = symbol(args)` and requires empty `plugins`. Absent → renders `createApplication({ plugins })`, unchanged.                                                              |

## 5. Implementation files

| File                                                               | Purpose                                                                                                       |
| ------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/src/adapters/shared/runtime-services-factory.ts` | `createRuntimeServices(options)` — the extracted platform→factory resolution (§3.10).                         |
| `packages/runtime/src/plugin/runtime-plugin.ts`                    | `register` delegates its runtime branch to `createRuntimeServices` (§3.10).                                   |
| `packages/runtime/src/index.ts`                                    | Export `createRuntimeServices` + the `RuntimeAdapterFactories` type.                                          |
| `packages/config-plugin/src/services/load-config.ts`               | `loadConfig(runtime, options)` — the extracted single implementation (§3.8).                                  |
| `packages/config-plugin/src/plugin/config-plugin.ts`               | `register` delegates to `loadConfig`; add the `instance` short-circuit (§3.9).                                |
| `packages/config-plugin/src/index.ts`                              | Export `loadConfig`.                                                                                          |
| `packages/starters/full-stack-starter/src/from-config.ts`          | `createFullStackAppFromConfig` (§3.7).                                                                        |
| `packages/starters/full-stack-starter/src/index.ts`                | Export it.                                                                                                    |
| `packages/cli/src/constants.ts`                                    | Add `'full-stack'` to `TEMPLATES`.                                                                            |
| `packages/cli/src/templates/registry.ts`                           | Add `appFactory?: Wiring`; register `FULL_STACK_TEMPLATE`.                                                    |
| `packages/cli/src/commands/new.ts`                                 | Render `appFactory`; make `assetsDir` runtime-conditional (§3.4); pin the starter package in the manifest.    |
| `packages/cli/src/templates/full-stack.ts`                         | The template definition: `appFactory`, `middleware`, `unsupported: {}`, and the skeleton `files` (§3.1).      |
| `packages/cli/src/templates/full-stack-app-files.ts`               | The ~24 emitted app-source string constants, split out so `full-stack.ts` stays readable.                     |
| `packages/cli/src/templates/full-stack-build-files.ts`             | `package.json`, `vite.config.ts`, `react-router.config.ts`, `tsconfig.json` (with the `~/*` alias) constants. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                          | src covered                                                                       | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/test/unit/create-runtime-services.test.ts`                       | `adapters/shared/runtime-services-factory.ts`                                     | An injected per-platform factory is used for that platform; an explicit `platform` beats detection; an unsupported platform throws by name; and `RuntimePlugin.register` registers the services the SAME injected factory produced, so the delegation (§3.10) is proven at both entry points. |
| `packages/config-plugin/test/unit/load-config.test.ts`                             | `services/load-config.ts`                                                         | `loadConfig(runtime)` returns an `IConfig` over injected env; `expandVariables: false` leaves `${…}` literal; a `validationSchema` coerces. Type-checks against `(runtime: IRuntimeServices, options?: ConfigPluginOptions) => Promise<IConfig>`.                                             |
| `packages/config-plugin/test/unit/load-config.test.ts` (same file)                 | `plugin/config-plugin.ts`                                                         | **Both entry points under a non-default config produce identical output** (§3.8); an injected `instance` is registered verbatim with **no** env read (runtime fake whose `env` throws); absent `instance` keeps today's behaviour.                                                            |
| `packages/starters/full-stack-starter/test/integration/from-config.test.ts`        | `src/from-config.ts`                                                              | A value from injected env reaches a plugin arm; `app.services.get(CAPABILITIES.CONFIG)` **is the same object** the resolver received (§3.9); a resolver that throws rejects without leaving a half-started app.                                                                               |
| `packages/starters/full-stack-starter/test/unit/barrel-exports.test.ts` (existing) | `src/index.ts`                                                                    | The new factory is exported.                                                                                                                                                                                                                                                                  |
| `packages/cli/test/unit/full-stack-template.test.ts`                               | `templates/full-stack.ts`, `full-stack-app-files.ts`, `full-stack-build-files.ts` | Emitted path set matches §3.2 and **excludes** `app/lib/{session,csrf,sse,kv,service-logger}.server.ts` (§3.5 regression guard); `routes.ts` contains both `flatRoutes` layout groups; `tsconfig.json` carries `"~/*"`; `package.json` devDeps carry `vite` + `@react-router/dev`.            |
| `packages/cli/test/unit/templates.test.ts` (existing)                              | `templates/registry.ts`                                                           | `getTemplate('full-stack')` resolves; `listTemplates()` still equals `TEMPLATES`; an `appFactory`-less template is unaffected.                                                                                                                                                                |
| `packages/cli/test/unit/new-command.test.ts` (existing)                            | `commands/new.ts`                                                                 | `appFactory` renders `const app = createFullStackApp(...)` and no `createApplication`; the manifest pins `@hono-enterprise/full-stack-starter`; `assetsDir` present for `deno`, absent for `cloudflare-workers` (§3.4).                                                                       |
| `packages/cli/test/e2e/template-e2e.test.ts` (existing drift gate)                 | `templates/full-stack.ts` + `commands/new.ts`                                     | Scaffolds `--template full-stack` for all four runtimes; repoints imports at this workspace; `deno check`s `honoe.config.ts` + `main.ts` + every emitted `.server.ts`. **The `.tsx`/Vite files are NOT `deno check`ed** — see §8.                                                             |
| `packages/react-router-plugin/test/unit/context-key-for.test.ts`                   | `handler/context-keys.ts`                                                         | `contextKeyFor` returns the SAME object per name, keeps the first default, and — the case it exists for — a value set through one module copy is readable through another, with a negative test pinning that two hand-written literals are NOT interoperable.                                 |
| `packages/cli/test/integration/full-stack-skeleton.test.ts`                        | `templates/full-stack-app-files.ts`                                               | Boots a real kernel app with `SessionPlugin` + `ReactRouterPlugin` over a fake `SsrRuntime`, and asserts a loader reading `sessionContext` sees a session written by a prior request (§3.6). The fake honours the real `SsrRuntime` contract.                                                 |

Every `src/` file in §5 has a named test file. No new npm dependency enters any published package
(the Vite toolchain is emitted into the scaffolded project's `devDependencies` only, per §1), so no
guarded real-import test is required; the import-shaped risk is the generated project's own imports,
covered by the drift gate.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m36c-react-router-skeleton, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

## 8. Risks & mitigations

- **The emitted `.tsx` and Vite files cannot be `deno check`ed**, so the drift gate proves less for
  this template than for `nest`: React/JSX source needs the npm toolchain the scaffolded project
  installs, which CI does not run. Mitigation: the gate checks every `.server.ts` and the two entry
  files (which are plain TS and where all framework coupling lives), and §6's integration test
  exercises the `loadContext` wiring for real against a kernel app. The `.tsx` files are
  deliberately thin — layout and markup only, no framework calls — so the untested surface carries
  no plugin coupling. State this limitation in the template's README rather than implying full
  coverage.
- **The milestone spans six packages** (`runtime`, `config-plugin`, `full-stack-starter`,
  `rest-starter`, `react-router-plugin`, `cli`), against CLAUDE.md's one-package-per-milestone rule
  — the same risk M36b carried, plus the `runtime` extraction §3.10 added after the plan's first
  draft under-specified §3.7. The `runtime` change is deliberately the smallest possible: one
  extracted function, one delegating caller, two barrel lines, and no behaviour change to
  `RuntimePlugin` (a test pins that both entry points build from the same factory). Mitigation:
  §3.7–§3.10 (config) are written as a self-contained design with their own contract rows and test
  files, and are **separable**: they can ship as a first PR before the skeleton if review grows
  unwieldy. Recommended if the diff exceeds ~1500 lines.
- **~24 emitted files is a large string-constant surface** that could rot silently against React
  Router releases. Mitigation: the version is pinned in the emitted `package.json`, the layering is
  asserted by path set, and the `.server.ts` files are type-checked against HEAD by the gate.
- **`ConfigPluginOptions.instance` makes three sibling options dead when set.** Mitigation: §4.1
  documents the precedence explicitly and a test asserts no env read occurs, so the ignoring is
  observable behaviour rather than a silent surprise.
- **B2BAdmin is a moving external reference** outside this workspace. Mitigation: every claim drawn
  from it is cited to a file:line in §1 and was read this session; the skeleton is an adaptation, so
  later reference drift does not invalidate the plan.

## 9. Out of scope

- **Migrating B2BAdmin itself off `@react-router/serve`** onto the M44 plugin — ROADMAP names it "a
  worthwhile validation", and it is: but it edits a project outside this repo, cannot be gated by
  CI, and would make this milestone's completion depend on an external codebase. Deferred as a
  manual validation exercise to run after merge.
- **Example applications under `apps/*`** — Milestone 37, unchanged. The scaffolded project is this
  milestone's runnable surface, as it was for `nest` in M36b.
- **A general `honoe new --starter` flag** for `rest`/`microservice`/`nest` — still deferred. Only
  `full-stack` composes via a starter, and only for the legibility reason in C2; the other three
  templates' inline wiring is unchanged.
- **Secrets resolved before startup** (`secretFromConfig`) — **rejected, not deferred**. Secrets are
  served by `secrets-plugin` under `CAPABILITIES.SECRETS`, which exists only after `register()`, so
  no pre-`start()` resolver can reach one. A plugin needing a secret resolves it lazily at use time,
  which is that plugin's own concern (C3).
- **Per-feature route co-location** (`app/features/<name>/routes/`) — B2BAdmin keeps routes under
  `app/routes/_app` and features hold only server modules (§1). The skeleton follows the reference
  rather than inventing a variant.
- **A dev-server integration** (`vite.ssrLoadModule` HMR) — `loadRequestHandler` is already the
  documented seam for it (§1) and needs no framework change; the skeleton ships the production
  wiring and documents the dev hook.
