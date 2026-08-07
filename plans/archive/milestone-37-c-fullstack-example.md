# Milestone 37c — Full-stack example (`apps/full-stack`)

> **Status:** Planning. Branch: `feat/m37c-fullstack-example`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

The framework's full-stack story ships in three places and has nothing a reader can run:
`packages/react-router-plugin` (M44) embeds React Router 8 framework mode over a kernel catch-all,
`packages/starters/full-stack-starter` (M36/M36c) composes it as `createFullStackApp` /
`createFullStackAppFromConfig`, and `honoe new --template full-stack` (M36c) scaffolds the
`routes → features → services → models` skeleton. `grep -rl "react-router" apps/*/` returns nothing
across the 13 existing examples. This milestone adds `apps/full-stack`: one runnable React Router 8
application served by the kernel through the SSR plugin, composed through the starter, whose `smoke`
task builds the frontend for real and asserts that an SSR-rendered route returns HTML carrying a row
written through the **database capability** — proving the `populateLoadContext` bridge rather than
that a server started. It also closes the toolchain question the milestone was opened on (§3.1): the
build runs for real, under Deno's own npm support, so CI needs no second toolchain and `ALLOW_SKIP`
is not extended.

- **In scope:** `apps/full-stack` (app tree, `honoe.config.ts`, `main.ts`, `smoke.ts`, its own
  `deno.json`/`package.json`/`vite.config.ts`/`react-router.config.ts`); the build step inside its
  `smoke` task; the removal-claim test; `.gitignore` + root `deno.json` exclusions for the generated
  build; `apps/README.md`, `CHANGELOG.md`, ROADMAP row, CLAUDE.md status, plan archival.
- **NOT this milestone:** a second full-stack example per runtime (one application; the Workers
  caveat is documented, per M36c which already omits `assetsDir` there). Making `apps/cloudflare`
  stop skipping — it skips for Wrangler, not for Node, and §3.1's decision does not touch it.
  Docker/k8s manifests for the example — **M39**. Adding `apps/*` to the coverage gate —
  deliberately never (M37). Changing any `packages/` source: this milestone consumes the published
  surface and changes none of it; a defect found in a package is repaired here only if it blocks the
  example, and is called out as such.

## 1. Contracts verified from SOURCE (not names)

| Reference                                       | Source (file:line)                                                               | Verified surface / fact                                                                                                                                                                                                                                                 |
| ----------------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ReactRouterPluginOptions.serverBuildPath`      | `packages/react-router-plugin/src/interfaces/index.ts:120`                       | `readonly serverBuildPath: string` — **required**, and documented as needing to be ABSOLUTE (a `file:` URL), because the default loader does `await import(serverBuildPath)`.                                                                                           |
| `ReactRouterPluginOptions.assetsDir`            | `packages/react-router-plugin/src/interfaces/index.ts:144`                       | Optional. Omitted → no asset route registered at all (not a 404 route).                                                                                                                                                                                                 |
| `ReactRouterPluginOptions.populateLoadContext`  | `packages/react-router-plugin/src/interfaces/index.ts:172`                       | `(ctx: IRequestContext, context: RouterLoadContext) => void` — MUTATES the provider, returns nothing. It augments; the plugin has already set `servicesContext` and `userContext`.                                                                                      |
| `contextKeyFor`                                 | `packages/react-router-plugin/src/handler/context-keys.ts:96`                    | `contextKeyFor<T>(name: string, defaultValue: T): RouterContextKey<T>`, memoised by NAME — first call wins. This is what makes the key identical across the two copies of the module (Vite inlines one into the server build; the runtime loads the other from source). |
| `getSession`                                    | `packages/session-plugin/src/services/get-session.ts:40`                         | `getSession(ctx: IRequestContext): ISession` — takes the KERNEL context, which a React Router loader never sees. This is why the bridge must live in app code.                                                                                                          |
| `getCsrfToken`                                  | `packages/session-plugin/src/csrf/token.ts:57`                                   | `getCsrfToken(ctx: IRequestContext): string` — mints on first read from the session, so it needs no separate cookie or secret.                                                                                                                                          |
| `createFullStackAppFromConfig`                  | `packages/starters/full-stack-starter/src/from-config.ts:153`                    | Its final statement is `return createFullStackApp({...})` — so the config-driven entry point EXERCISES the plain factory. Using it satisfies the deliverable's "composed via `createFullStackApp`" rather than bypassing it.                                            |
| `reactRouter` starter arm                       | `packages/starters/full-stack-starter/src/app.ts:49`                             | GATED: `...(options.reactRouter ? [ReactRouterPlugin(options.reactRouter)] : [])`. The SSR plugin is not in the default set — the example must pass the arm.                                                                                                            |
| `session` starter arm                           | `packages/starters/rest-starter/src/app.ts:58`                                   | GATED on `options.session`, inherited by the full-stack tier. Needs a secret nobody can default.                                                                                                                                                                        |
| `database` starter arm                          | `packages/starters/rest-starter/src/app.ts:56`                                   | GATED on `options.database`. `DatabasePlugin({ type: 'memory' })` is the zero-dependency arm (`apps/database/src/app.ts:17` uses exactly this).                                                                                                                         |
| `IDatabaseService` / `IRepository`              | `packages/database-plugin/src/index.ts:24-25`                                    | Exported from `database-plugin`, NOT from the `common` barrel — the example imports them from the plugin package.                                                                                                                                                       |
| `check:apps` entry points                       | `scripts/check-apps.ts:104`                                                      | `deno check main.ts smoke.ts` (+ `worker.ts` when present) — a FIXED list. `.tsx` route modules are NOT reachable from it, which §3.6 addresses rather than assumes away.                                                                                               |
| `check:apps` mandatory tasks                    | `scripts/check-apps.ts:96`                                                       | Every app must declare BOTH `start` and `smoke` tasks or the gate fails it. An optional `test` task is also run (`:133`).                                                                                                                                               |
| `ALLOW_SKIP` enforcement                        | `scripts/check-apps.ts:148` + `.github/workflows/ci.yml:46`                      | Exit 77 = skip; a skip not in `ALLOW_SKIP` FAILS the gate. CI currently sets `ALLOW_SKIP: cloudflare`. §3.1's decision means `full-stack` is NOT added.                                                                                                                 |
| CLI skeleton emits `config/services.server.ts`  | `packages/cli/src/templates/full-stack-app-files.ts:576`                         | The scaffolded skeleton **does** emit `app/config/services.server.ts`. The ROADMAP's removal list names it as a file that must not exist — conflict C1.                                                                                                                 |
| Vite externals must be declared per-environment | `PUBLIC_API.md:2238` + `packages/cli/src/templates/full-stack-build-files.ts:88` | Under `environments.ssr.build.rollupOptions.external`; neither a top-level `ssr.external` nor `environments.ssr.resolve.external` reaches the React Router build.                                                                                                       |
| React Router 8 / Vite 8 exist as pinned         | npm registry, probed 2026-08-06                                                  | `react-router@8.3.0`, `@react-router/dev@8.3.0`, `vite@8.2.0` — the `^8.0.0` pins in `full-stack-build-files.ts` resolve.                                                                                                                                               |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                        | Resolution (picked side)                                                                                                                                                                                                                                                                                                                                                                                                                                                      | Doc deliverable (same PR)                                                                                                                                                                                    |
| -- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| C1 | The M37c deliverable says a test must pin that **`config/services.server.ts`** does not exist in the example, "because capabilities replace them". But `packages/cli/src/templates/full-stack-app-files.ts:576` **emits that exact path**, and its JSDoc (`:244-262`) says the removal is the module-level CACHE, not the file. | Side taken: **the CLI template is right, the ROADMAP sentence is wrong.** The file is a stateless typed accessor over the request context; what a conventional app puts there — a module-level `Map` of memoised clients — is what the kernel registry replaces. The test therefore pins (a) the five `lib/*.server.ts` modules are ABSENT, and (b) `config/services.server.ts` holds no module-level mutable state, asserted by reading the file rather than by its absence. | Rewrite the M37c "test pinning the removal claim" bullet in `ROADMAP.md` to name the five `lib/` modules and to state the `config/services.server.ts` rule as "no module-level cache", not "does not exist". |
| C2 | The ROADMAP frames the toolchain as a **two-way** choice: commit a pre-built `ServerBuild` fixture, or add Node/npm to CI. Both assume the real build requires the Node toolchain, which `AI_GUIDELINES §12.2` and `CLAUDE.md`'s preamble also imply by calling the frontend build "the Node/npm toolchain".                    | Side taken: **a third option, measured** (§3.1). Deno's own npm support runs the identical Vite build with no Node toolchain present. The guidelines' point survives untouched — the build is still an app-level, build-time concern that never enters a published package graph — but "npm toolchain" describes the package ECOSYSTEM, not a required Node binary.                                                                                                           | Add the measured third option and the decision to the M37c ROADMAP section, replacing the two-option framing. Note in `apps/README.md` that this example builds its frontend as part of its smoke.           |
| C3 | `apps/README.md`'s closing paragraph documents `ALLOW_SKIP` as the mechanism for "a newly added example whose backend CI does not provide". A reader adding this example would reasonably reach for it.                                                                                                                         | Side taken: **no exemption**. The example's only prerequisite is the npm registry, which CI already reaches for JSR and for `deno install`. Recording it in `ALLOW_SKIP` would ship an example whose proof never runs — the pattern M53 exists to end.                                                                                                                                                                                                                        | State explicitly in the M37c ROADMAP section and in the example's README that `full-stack` is deliberately NOT in `ALLOW_SKIP`.                                                                              |

## 3. Design decisions

### 3.1 Toolchain — how the frontend build is produced, and what CI proves

- **Decision:** the smoke task performs the **real** React Router / Vite build, driven by **Deno's
  own npm support** (`deno install --allow-scripts`, then the `@react-router/dev` CLI), inside
  `apps/full-stack`. No `setup-node` step is added to CI, no `ServerBuild` fixture is committed, and
  `full-stack` is **not** added to `ALLOW_SKIP`. CI therefore proves the whole path: install → Vite
  build → kernel serves the compiled build → SSR HTML carries capability data.
- **Why:** measured on 2026-08-06 against a project scaffolded by `honoe new --template full-stack`
  and repointed at this workspace. `deno install --allow-scripts` took **4 s** and the build **0.6
  s** (client 89 modules + ssr 17 modules → `build/server/index.js`, 18.51 kB); the app then served
  `GET /products` with **200** and SSR HTML, and a CSRF-protected `POST /login` returned **302** to
  `/products`. The npm-driven path (`npm install` 14 s, `npm run build` 0.6 s) works identically, so
  the Node toolchain is a redundancy rather than a requirement. Against the two ROADMAP options: a
  committed fixture proves the bridge but not the build and drifts from app source with nothing to
  catch it — the failure mode this repo has been bitten by repeatedly; adding Node to CI costs a
  second toolchain to prove something Deno already proves. The measured cost of the chosen option is
  roughly 5 s of build on a warm cache, which is not a reason to weaken the proof.
- **Test home:** `apps/full-stack/smoke.ts` cannot run at all unless the build ran, since the plugin
  `await import`s `build/server/index.js`; plus `test/apps-gate.test.ts` pins that `full-stack` is
  absent from CI's `ALLOW_SKIP` (§6), so the exemption cannot be added silently later.

### 3.2 What the example composes through

- **Decision:** `honoe.config.ts` exports `createApp()` built with
  **`createFullStackAppFromConfig`**, with `reactRouter`, `session`, and `database` arms supplied.
- **Why:** `from-config.ts:153` returns `createFullStackApp(...)`, so this exercises the plain
  factory the deliverable names AND the config-driven path M36c added, in one application; and it is
  the shape `honoe new --template full-stack` emits, so the example a reader runs matches the
  project the CLI hands them. The three arms are all GATED (§1) — a default-options full-stack app
  registers neither the SSR plugin nor a session nor a database, so an example that omitted them
  would prove nothing about any of the three.
- **Test home:** the smoke's SSR assertion (§3.4) fails outright if the `reactRouter` arm is absent
  (no catch-all route → 404) or the `session` arm is absent (the bridge throws resolving `SESSION`).

### 3.3 Where the load-context bridge lives, and what it carries

- **Decision:** `honoe.config.ts` supplies `populateLoadContext`, which sets four keys created by
  `contextKeyFor` in `app/lib/context-keys.server.ts`: `sessionContext`, `csrfContext`,
  `loggerContext`, and — the addition this example makes over the M36c skeleton — `databaseContext`,
  carrying the `IDatabaseService` resolved from `CAPABILITIES.DATABASE`.
- **Why:** `getSession` takes an `IRequestContext` a loader never sees while `populateLoadContext`
  receives exactly that (§1), so the bridge belongs in app code and `react-router-plugin` stays
  ignorant of `session-plugin`. `databaseContext` is what turns the skeleton's hard-coded product
  array into capability-produced data, which is the deliverable's actual bar. Keys come from
  `contextKeyFor` and never from a `{ defaultValue }` literal, because the module exists TWICE at
  runtime (Vite inlines a copy into the server build; the kernel loads the other from source) and
  two hand-written key objects would match nothing while type-checking cleanly — every context read
  would silently fall back to its default.
- **Test home:** `smoke.ts` asserts the SSR HTML contains a product name written through the
  repository at startup; that value can only arrive through `databaseContext`. A negative control is
  recorded in §6.

### 3.4 What the smoke asserts

- **Decision:** one end-to-end behaviour, in this order: (1) write a product through
  `IRepository.create` at startup, through the same `IDatabaseService` a loader reads; (2)
  `app.fetch(new Request('http://local.test/products'))` returns **200** whose HTML contains that
  product's name AND its formatted price; (3) `GET /login` yields HTML carrying a CSRF token minted
  from the session, and `POST /login` echoing that token plus the session cookie returns **302** to
  `/products`. Failure throws; nothing exits 77.
- **Why:** (2) is the ROADMAP's stated bar — data produced by a capability, not a hard-coded string
  — and it obeys the repo's read-it-back rule: the value is WRITTEN through the public surface and
  read back through a different one (SSR). (3) is the removal claim made executable: session and
  form CSRF are the two concerns a conventional React Router app hand-rolls in
  `lib/session.server.ts` and `lib/csrf.server.ts`, and a 302 proves the synchronizer token
  round-tripped through the plugin's middleware rather than through app code.
- **Test home:** `apps/full-stack/smoke.ts` (this IS the test — examples are not coverage-measured,
  per M37).

### 3.5 How the smoke drives the application

- **Decision:** `app.fetch(new Request(...))` in-process, with `await app.start()` and no port; the
  separate `main.ts` binds a port for a human running `deno task start`.
- **Why:** the SSR response body is a `ReadableStream` (the app's `entry.server.tsx` returns
  `renderToReadableStream` output through `IResponse.stream()`), and `app.inject()` both buffers and
  exposes no response headers — the M51 `Allow`-header and M52b Cache-API precedents, where an
  `inject`-based test would have passed regardless of the fix. `app.fetch` returns a real web
  `Response`, so `Set-Cookie` is readable, which step (3) requires. It also needs no port
  allocation, so the smoke cannot flake on a busy port the way `apps/compiled-binary` did.
- **Test home:** step (3) reads `Set-Cookie` off the `Response`; it is unwritable via `inject`.

### 3.6 Type-checking reach — what `check:apps` does and does not see

- **Decision:** `main.ts` and `smoke.ts` are the gate's entry points (fixed at
  `scripts/check-apps.ts:104`), and every server-side module with framework coupling
  (`honoe.config.ts`, `app/lib/context-keys.server.ts`, `app/lib/load-context.ts`,
  `app/config/services.server.ts`, `app/models/product.ts`, `app/services/products.server.ts`,
  `app/features/products/products.server.ts`) is made reachable from `smoke.ts` by import, so
  `deno check smoke.ts` covers them. The `.tsx` route/component modules are checked by the
  **frontend build's own** TypeScript pass during `vite build`, not by `deno check` — Deno has no
  React types installed and `tsconfig.json` (not `deno.json`) governs them.
- **Why:** the CLI's own e2e makes the same split for the same reason
  (`packages/cli/test/e2e/template-e2e.test.ts:282-284`), and the split is honest: a broken `.tsx`
  fails the build step of the smoke, which fails the gate — it is covered, just by a different
  checker. Pretending otherwise would mean shipping React types into a Deno app manifest to satisfy
  a checker that is not the authority for those files.
- **Test home:** the gate itself. A deliberate type error in `app/services/products.server.ts` fails
  `deno check`; a deliberate one in `app/routes/_app/products._index.tsx` fails `vite build`. Both
  are exercised as negative controls during verification (§6).

### 3.7 Generated output must not dirty the tree

- **Decision:** `apps/full-stack/build/`, `apps/full-stack/deno.lock`, and
  `apps/full-stack/.react-router/` are gitignored (`node_modules/` already is, globally);
  `apps/full-stack/build` is added to the root `deno.json` `exclude` so `fmt`, `lint`, and `check`
  never walk the bundled output.
- **Why:** the exact M37b lesson — `check:apps` left an untracked `apps/cloudflare/.wrangler/` and a
  following `deno task publish:check` aborted on the dirty tree. Running the build produces ~12
  files of minified JS and a CSS bundle; without the fmt/lint exclusion `deno task fmt:check` fails
  on build output that no human wrote.
- **Test home:** verification runs `deno task check:apps` followed by `git status --porcelain` and
  requires empty output, then `deno task publish:check` on the committed tree.

### 3.8 The removal claim, made checkable

- **Decision:** `apps/full-stack` declares a `test` task (run by `check:apps` at
  `scripts/check-apps.ts:133`) whose single test asserts: none of `app/lib/session.server.ts`,
  `app/lib/csrf.server.ts`, `app/lib/sse.server.ts`, `app/lib/kv.server.ts`,
  `app/lib/service-logger.server.ts` exists; and `app/config/services.server.ts` contains no
  module-level mutable state (no top-level `new Map`, `new Set`, `let`, or `var`).
- **Why:** C1 — the file the ROADMAP wanted absent is present by design in the M36c skeleton, and
  the claim that actually distinguishes this framework is that it holds no cache. Asserting absence
  of a file the CLI emits would have made the test and the scaffolder permanently contradict each
  other. Written as a real assertion over the file's text rather than a comment, because a claim
  nothing executes is the thing this repo keeps getting burned by.
- **Test home:** `apps/full-stack/test/removal.test.ts`, `describe`/`it` + `expect`.

### 3.9 Runtime target and the Workers caveat

- **Decision:** the example targets **Deno** and documents the Workers difference in its README
  rather than shipping a second application. On Workers `assetsDir` is omitted (no `fs` → the asset
  handler registers no route and the platform's static-asset binding serves them instead), which is
  M36c's committed behaviour and is asserted by the CLI's own e2e already.
- **Why:** the ROADMAP puts a per-runtime second example explicitly out of scope, and `check:apps`
  runs Deno. Duplicating the app to demonstrate one omitted option is cost with no proof attached.
- **Test home:** none in this milestone — the behaviour is already pinned by
  `packages/cli/test/e2e/template-e2e.test.ts` ("serves static assets everywhere but Cloudflare
  Workers"). Recorded here so a reviewer does not read the absence as an oversight.

## 4. Exported surface — every symbol names its consumer

This milestone adds **no package** and therefore **no `src/index.ts` and no public API surface**.
`apps/*` is outside the Deno workspace and outside both release lists by design (M37), so
`release:verify`'s workspace-coverage check is unaffected. The table below is the equivalent for an
example: every module the example ships and the real path that reads it.

| Exported symbol                                                                                     | Kind         | Consumer / real code path that READS it                                                                                                                               |
| --------------------------------------------------------------------------------------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createApp` (`honoe.config.ts`)                                                                     | async fn     | `main.ts` (binds a port) and `smoke.ts` (drives `app.fetch`). Also the shape `honoe` imports for CLI command discovery.                                               |
| `seedProducts` (`app/services/products.server.ts`)                                                  | async fn     | `main.ts` and `smoke.ts` call it after `start()`; it is what makes the SSR data capability-produced.                                                                  |
| `listProducts` (`app/services/products.server.ts`)                                                  | async fn     | `app/features/products/products.server.ts` — the service layer read the feature layer composes.                                                                       |
| `buildProductsView` (`app/features/products/…`)                                                     | async fn     | `app/routes/_app/products._index.tsx` loader.                                                                                                                         |
| `sessionContext`/`csrfContext`/`loggerContext`/`databaseContext` (`app/lib/context-keys.server.ts`) | context keys | SET by `populateLoadContext` in `honoe.config.ts`; READ by `app/config/services.server.ts` accessors. Both sides required — a key set and never read is dead surface. |
| `getLogger`/`getSession`/`getCsrfToken`/`getDatabase` (`app/config/services.server.ts`)             | fns          | `app/services/products.server.ts` (`getLogger`, `getDatabase`) and `app/routes/_auth/login.tsx` (`getSession`, `getCsrfToken`).                                       |
| `Product`/`formatPrice` (`app/models/product.ts`)                                                   | type + fn    | The service layer and the products route component; `formatPrice` output is asserted by the smoke.                                                                    |
| `AppLoadContext` (`app/lib/load-context.ts`)                                                        | interface    | Every server module's parameter type, and the route loaders'.                                                                                                         |

### 4.1 Options — every option names its consumer

The example passes starter options rather than declaring any of its own.

| Option                            | Consumer                                        | Behavior (per implementation)                                                                                                    |
| --------------------------------- | ----------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `reactRouter.serverBuildPath`     | `ReactRouterPlugin` default loader              | Absolute `file:` URL via `new URL('./build/server/index.js', import.meta.url).href`; a relative one resolves against the PLUGIN. |
| `reactRouter.assetsDir`           | `createStaticAssetHandler`                      | `./build/client/assets` — present because the example targets Deno (§3.9).                                                       |
| `reactRouter.populateLoadContext` | The plugin, per request, after its own two keys | Sets the four app keys (§3.3).                                                                                                   |
| `session.secret`                  | `SessionPlugin`                                 | Read from config (`SESSION_SECRET`), with a documented dev default in `.env.example` so the example runs out of the box.         |
| `session.csrf`                    | `SessionPlugin`                                 | `{}` — enables the synchronizer-token form middleware the login POST depends on.                                                 |
| `database.type: 'memory'`         | `DatabasePlugin`                                | Zero-dependency arm; the repository the seed writes to and the loader reads from.                                                |

## 5. Implementation files

| File                                                                                                                       | Purpose                                                                                         |
| -------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| `apps/full-stack/deno.json`                                                                                                | `start`/`smoke`/`test`/`build` tasks, `@hono-enterprise/*` → workspace `src/`, `~/` → `./app/`. |
| `apps/full-stack/package.json`                                                                                             | The frontend build's npm deps (React Router 8, React 19, Vite 8) and its `build` script.        |
| `apps/full-stack/tsconfig.json`                                                                                            | `jsx`, DOM libs, `~/*` paths — governs the `.tsx` modules the Vite build type-checks.           |
| `apps/full-stack/react-router.config.ts`                                                                                   | `appDirectory: 'app'`, `ssr: true`.                                                             |
| `apps/full-stack/vite.config.ts`                                                                                           | `reactRouter()` plugin; framework packages external under `environments.ssr.build` (§1).        |
| `apps/full-stack/honoe.config.ts`                                                                                          | `createApp()` via `createFullStackAppFromConfig`; the `populateLoadContext` bridge.             |
| `apps/full-stack/main.ts`                                                                                                  | Starts on a port; seeds; for a human.                                                           |
| `apps/full-stack/smoke.ts`                                                                                                 | The three assertions of §3.4.                                                                   |
| `apps/full-stack/test/removal.test.ts`                                                                                     | §3.8.                                                                                           |
| `apps/full-stack/app/routes.ts`                                                                                            | `flatRoutes` over `_auth`/`_app` groups, each in its own `layout()`.                            |
| `apps/full-stack/app/root.tsx`                                                                                             | Document shell + error boundary.                                                                |
| `apps/full-stack/app/entry.server.tsx`                                                                                     | `renderToReadableStream` → the stream the kernel passes through.                                |
| `apps/full-stack/app/entry.client.tsx`                                                                                     | Hydration.                                                                                      |
| `apps/full-stack/app/app.css`                                                                                              | Minimal styling (also proves the CSS asset path).                                               |
| `apps/full-stack/app/lib/load-context.ts`                                                                                  | `AppLoadContext` — type-only, client-safe.                                                      |
| `apps/full-stack/app/lib/context-keys.server.ts`                                                                           | The four `contextKeyFor` keys (§3.3).                                                           |
| `apps/full-stack/app/config/services.server.ts`                                                                            | Stateless typed accessors — the file C1 is about.                                               |
| `apps/full-stack/app/models/product.ts`                                                                                    | `Product`, `formatPrice`.                                                                       |
| `apps/full-stack/app/services/products.server.ts`                                                                          | `seedProducts` + `listProducts` over the repository.                                            |
| `apps/full-stack/app/features/products/products.server.ts`                                                                 | `buildProductsView`.                                                                            |
| `apps/full-stack/app/components/layouts/{AppLayout,LoginLayout}.tsx`                                                       | Group chrome.                                                                                   |
| `apps/full-stack/app/routes/_app/products._index.tsx`                                                                      | The SSR route the smoke asserts.                                                                |
| `apps/full-stack/app/routes/_auth/login.tsx`                                                                               | The session + CSRF route.                                                                       |
| `apps/full-stack/README.md`, `.env.example`, `.gitignore`                                                                  | How to run it; the dev secret; local ignores.                                                   |
| `apps/README.md`, `CHANGELOG.md`, `ROADMAP.md`, `CLAUDE.md`, root `deno.json`, root `.gitignore`, `test/apps-gate.test.ts` | Index row, changelog, C1–C3 doc deliverables, status flip, build exclusions, gate pin.          |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

Examples are **deliberately not coverage-measured** (M37: the 90% bar is a library standard and
applying it to demo code produces tests written to satisfy a number). `apps/` is excluded from
`deno task test:coverage`, so the per-file bar does not apply here and no `src/` file is added. What
replaces it is that every claim the example makes is executed.

| Test file                              | src covered                                                                                            | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                             |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apps/full-stack/smoke.ts`             | `honoe.config.ts`, `app/{lib,config,models,services,features}/**`, and the whole SSR path incl. `.tsx` | (1) `seedProducts(app)` writes via `IRepository<Product>.create(entity: Product): Promise<Product>`; (2) `await app.fetch(new Request(url))` → `Response`, `status === 200`, `await res.text()` contains the seeded name AND `formatPrice` output; (3) `GET /login` HTML yields a `_csrf` value, `POST` with it + the `Set-Cookie` returns `302` with `location: /products`. |
| `apps/full-stack/test/removal.test.ts` | The claim, not a module                                                                                | Five `lib/*.server.ts` paths absent (`Deno.stat` rejects `NotFound`); `app/config/services.server.ts` text has no top-level `new Map`/`new Set`/`let`/`var`.                                                                                                                                                                                                                 |
| `test/apps-gate.test.ts` (existing)    | The gate's own wiring                                                                                  | CI's `ALLOW_SKIP` does NOT list `full-stack` (§3.1 / C3), so the exemption cannot be added without a failing test. Same file already pins the Redis service, port mapping, and scoped grant (M53).                                                                                                                                                                           |

**Negative controls run during verification** (each must be observed failing, then reverted — the
repo's rule that a gate is only a gate once it has been seen to discriminate):

1. Remove `databaseContext` from `populateLoadContext` → the products loader throws and the smoke
   fails. Proves the SSR assertion reads capability data rather than anything hard-coded.
2. Replace `contextKeyFor('app.database', null)` with a `{ defaultValue: null }` literal → the key
   stops matching across the two module copies and the smoke fails, with no type error. Proves
   §3.3's reasoning is load-bearing and not folklore.
3. Introduce a type error in `app/services/products.server.ts` → `deno check` fails; introduce one
   in `app/routes/_app/products._index.tsx` → `vite build` fails. Proves §3.6's split is coverage,
   not a hole.
4. Drop the `_csrf` field from the login form → the POST returns 403 instead of 302. Proves step (3)
   exercises the plugin's middleware rather than passing vacuously.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m37c-fullstack-example, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task check:apps        # includes the new example: build + smoke + removal test
git status --porcelain      # MUST be empty after check:apps (§3.7)
deno task test:coverage     # unchanged by this milestone; apps/ is not measured
deno task publish:check     # on the COMMITTED tree
deno task release:verify 0.1.0-alpha.4
```

`test:coverage` and both publish gates are run even though no package changes, because the claim "no
package changed" is itself worth verifying — a stray edit under `packages/` would show up there and
nowhere else.

## 8. Risks & mitigations

- **`deno install` resolves a different Vite patch than npm would** (observed: 8.1.5 under Deno vs
  8.2.0 under npm, both satisfying `^8.0.0`) → the build is exercised on whatever the range resolves
  to, which is what a user gets too; the lockfile is gitignored so CI resolves fresh and a range
  that stops working fails loudly rather than being pinned around.
- **`deno install --allow-scripts` runs npm lifecycle scripts** → scoped to this example's own
  directory, which contains only the React Router/Vite toolchain; no framework package is installed
  from npm here (they resolve to workspace source through the import map).
- **npm registry unreachable in CI** → the gate fails rather than skips, by design (C3). A registry
  outage failing CI is the same exposure `deno task check` already carries for JSR.
- **The build adds ~5 s (warm) / ~20 s (cold) to `check:apps`** → accepted; measured in §3.1 and
  small beside the existing suite.
- **The two copies of `context-keys.server.ts` drift** (one inlined by Vite, one loaded from source)
  → `contextKeyFor` memoises by name, so both resolve to one object; negative control 2 proves the
  failure mode is real and detected.
- **A future `WebSocketPlugin`/`SsePlugin` arm added to the starter changes the default set** → the
  example passes explicit arms and asserts behaviour, not plugin counts, so it does not encode the
  starter's internal list.

## 9. Out of scope

- A **development-server** loop with HMR (`loadRequestHandler` over a Vite build thunk). The recipe
  is documented at `docs/react-router-dev.md`; the example ships the production path because that is
  what the gate can assert. Named here so its absence is not read as a gap.
- A per-runtime second example (Node/Bun/Workers) — §3.9; the ROADMAP puts it out of scope.
- Making `apps/cloudflare` stop skipping — it skips on Wrangler availability, which §3.1 does not
  touch.
- Docker/Kubernetes manifests for the example — **M39**.
- Adding `apps/*` to the coverage gate — deliberately never (M37).
- Any change to `packages/react-router-plugin`, the starters, or the CLI template. If the example
  surfaces a defect in one of them, it is repaired on this branch and called out explicitly rather
  than folded in silently — the M37b precedent, where building an example found the ioredis
  eager-connect defect.
