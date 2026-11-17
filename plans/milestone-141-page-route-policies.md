# Milestone 141 — Page route policies (`@setu-ts/react-router-plugin`, `@setu-ts/kernel`, `@setu-ts/common`)

> **Status:** Planning. Branch: `feat/m141-page-route-policies`. `main` and `develop` are protected
> — all work (implementation + fixes) stays on this one branch until it merges via a single PR into
> `develop`.

## 0. Objective & scope

`ReactRouterPlugin` serves every page through one kernel catch-all route, so a React Router action
passes through the global pipeline but never through route-level middleware: `rateLimitMiddleware`,
`createUploadMiddleware`, `requireScopes`, `requirePolicy`, `idempotent()` and a quota's `429`
cannot reach it. This milestone lets an application attach ordinary Setu middleware to a page by its
React Router **route id**, matched by React Router's own rules on every URL shape the route answers
(`/x`, `/x.data`, `/x/_.data`, `?index`), and run by the kernel with the same chain semantics as any
route's middleware. The boundary: the kernel gains a general per-request route-middleware seam; the
plugin owns matching; nothing runs inside React Router's own middleware.

- **In scope:** `RouteDefinition.middlewareGroups` and its dispatch in the kernel;
  `routeMiddlewareOf()` in `common` and its use by `AuthPlugin`'s `requirePolicy` startup scan;
  `pagePolicies` on `ReactRouterPlugin`, the route-id matcher, the `pageRoutes` field of
  `SsrRuntime` and the default loader supplying it; the development entry (CLI template and
  `apps/full-stack/dev.ts`) supplying it; README, AGENT_CARD, PUBLIC_API, ARCHITECTURE, CHANGELOG
  and `docs/react-router-dev.md`.
- **NOT this milestone:** a sign-in throttle in the generated full-stack template (the template
  carries no rate limiter package today; adding `auth-plugin` to it is a template decision for a
  later CLI milestone, see §9); OpenAPI or MCP discovery of page policies (§9); running Setu
  middleware inside React Router's `middleware` export (rejected, §3.1).

## 1. Contracts verified from SOURCE (not names)

| Reference                                        | Source (file:line)                                                                                                                                                                                                                                                          | Verified surface / fact                                                                                                                                                                                                                     |
| ------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RouteDefinition`                                | `packages/common/src/http.ts:1141`                                                                                                                                                                                                                                          | `{ handler: RouteHandler; middleware?: readonly MiddlewareFunction[]; schema?: RouteSchema }` — no per-request seam today                                                                                                                   |
| `MiddlewareFunction`                             | `packages/common/src/http.ts:465`                                                                                                                                                                                                                                           | `(ctx: IRequestContext, next: NextFunction) => void \| HandlerResult \| Promise<void \| HandlerResult>`                                                                                                                                     |
| `HttpMethod`                                     | `packages/common/src/types.ts:15`                                                                                                                                                                                                                                           | `'GET' \| 'HEAD' \| 'POST' \| 'PUT' \| 'PATCH' \| 'DELETE' \| 'OPTIONS'`                                                                                                                                                                    |
| Kernel route-middleware dispatch                 | `packages/kernel/src/application/application.ts:1500-1526`                                                                                                                                                                                                                  | runs `definition.middleware` through `executeChain(routeMiddleware, ctx, terminal, undefined, observer)`; an empty chain takes the M87 bypass (checks `ended`, then invokes the handler)                                                    |
| `executeChain`                                   | `packages/kernel/src/pipeline/execute-chain.ts:80`                                                                                                                                                                                                                          | the one chain executor (double-`next` guard, `ended` defense in depth); NOT exported from the kernel barrel                                                                                                                                 |
| Route middleware readers                         | `packages/auth-plugin/src/policies/startup-scan.ts:39`; `packages/openapi-plugin/src/generators/error-responses.ts:59`, `openapi-generator.ts:987`; `packages/mcp-plugin/src/compile/discovery.ts:16,30`, `compile-tools.ts:59`; `packages/kernel/src/router/router.ts:412` | each reads `route.definition.middleware ?? []` only; the auth scan runs from `onBootstrap` (`packages/auth-plugin/src/plugin/auth-plugin.ts:625-631`) over `ctx.router.listRoutes()`                                                        |
| No plugin depends on the kernel at runtime       | every `packages/*/package.json`                                                                                                                                                                                                                                             | `@setu-ts/kernel` is a dev/peer dependency of every plugin; only the starters and `testing` depend on it — so the plugin cannot import `executeChain`                                                                                       |
| Catch-all registration                           | `packages/react-router-plugin/src/plugin/react-router-plugin.ts:149-213`                                                                                                                                                                                                    | `renderRoute = (ctx) => ssrService.render(ctx)` registered for all seven verbs on `joinWildcard(basename)`; GET wraps the public-file handler                                                                                               |
| `SsrRuntime`                                     | `packages/react-router-plugin/src/interfaces/index.ts:77`                                                                                                                                                                                                                   | `{ handler: SsrRequestHandler; createLoadContext: () => RouterLoadContext }`                                                                                                                                                                |
| `ReactRouterCommonOptions`                       | `packages/react-router-plugin/src/interfaces/index.ts:101-180`                                                                                                                                                                                                              | `loadRequestHandler`, `assetsDir`, `assetUrlPrefix`, `publicFiles`, `basename`, `populateLoadContext`, `mode`; the union `ReactRouterPluginOptions` is path arm or module arm                                                               |
| Default loader                                   | `packages/react-router-plugin/src/handler/server-build.ts:142-202`                                                                                                                                                                                                          | imports the build (or takes the module), unwraps `default`, imports `react-router`, returns `{ handler, createLoadContext }`; the build object is in scope                                                                                  |
| Request bridge body                              | `packages/react-router-plugin/src/handler/request-bridge.ts:47`                                                                                                                                                                                                             | the web `Request` handed to React Router is built from `await ctx.request.bytes()`                                                                                                                                                          |
| Body memoization                                 | `packages/runtime/src/adapters/shared/fetch-mapping.ts:209-265`; `packages/kernel/src/application/dispatched-request.ts:45-60`; `packages/kernel/src/application/inject-body.ts:213-225`                                                                                    | served, dispatched and injected requests cache the first body read; `formData()` derives from `bytes()`, so a middleware reading the form does not consume the bytes the bridge reads                                                       |
| `matchRoutes`                                    | `react-router@8.5.1` `dist/production/index.d.ts:45` (public export)                                                                                                                                                                                                        | `matchRoutes(routes, location, basename?)`, the same matcher React Router's static handler uses                                                                                                                                             |
| React Router URL normalization                   | `react-router@8.5.1` `dist/production/lib/server-runtime/urls.js:12-26`                                                                                                                                                                                                     | `getNormalizedPath`: strip a trailing `/_.data` to `/`, else a trailing `.data`; drop `_routes`. Internal, not exported                                                                                                                     |
| React Router route tree from the manifest        | `react-router@8.5.1` `dist/production/lib/server-runtime/routes.js:17-69`                                                                                                                                                                                                   | groups `build.routes` by `parentId`; an `index` route becomes `{ index: true }`, others carry `path`, `caseSensitive`, `children`; route middleware comes from `route.module.middleware`                                                    |
| Manifest request                                 | `react-router@8.5.1` `server.js:94-95`; `lib/dom/ssr/fog-of-war.js:120-123`                                                                                                                                                                                                 | when `build.routeDiscovery.mode === 'lazy'`, a request whose pathname equals `getManifestPath(manifestPath, basename)` (`joinPaths([basename, manifestPath \|\| '/__manifest'])`) is answered before matching, and no route middleware runs |
| Dev loader seam                                  | `apps/full-stack/dev.ts:79-87`; `packages/cli/src/templates/full-stack-build-files.ts:434`                                                                                                                                                                                  | returns `{ handler: createRequestHandler(loadServerBuild, mode), createLoadContext }`; `loadServerBuild` re-reads `virtual:react-router/server-build` per request                                                                           |
| Starter pass-through                             | `packages/starters/full-stack-starter/src/app.ts:139`                                                                                                                                                                                                                       | `ReactRouterPlugin(options.reactRouter)` — a new plugin option reaches the starter with no starter change                                                                                                                                   |
| Template login route id                          | `packages/cli/src/templates/full-stack-app-files.ts` (`app/routes.ts`: `flatRoutes({ rootDirectory: 'routes/_auth' })`)                                                                                                                                                     | the login file is `app/routes/_auth/login.tsx`; its id is expected to be `routes/_auth/login` — **verified by the conformance and scaffold tests, not assumed** (§6)                                                                        |
| `idempotent()` reads the response after `next()` | `packages/idempotency-plugin/src/middleware/http-middleware.ts:250-255`                                                                                                                                                                                                     | `await next()`, then `ctx.response.snapshot()` decides store or release — so it needs the rendered response on `ctx.response` when `next()` resolves                                                                                        |
| Agent card size cap                              | `test/agent-card-gate.test.ts:151`                                                                                                                                                                                                                                          | every `AGENT_CARD.md` is at most 2,560 bytes; the react-router card is 2,393 today, so the addition must stay under 167 bytes or trim                                                                                                       |

**Probe (2026-11-17, plan time).** A fixture `ServerBuild` with seven routes (root, a plain route, a
layout with an index child and a param child, a root index, a splat) ran through the real
`createRequestHandler` of `react-router@8.5.1`, each route module's `middleware` recording its id.
For 22 URL shapes — `/login`, `/login.data`, `/login/`, `/login/_.data`, `/`, `/_.data`,
`/_.data?index`, `/app`, `/app?index`, `/app.data?index`, `/app.data`, `?_routes=`, a param, an
encoded `%2F`, `/LOGIN.data`, an unmatched deep path, the manifest path, `/login.data.data`,
`//login.data`, `/login%2Edata` — on basenames `/`, `/shop/` and `/shop`, the mirror (normalize as
`urls.js`, then `matchRoutes` over the grouped tree with `build.basename`) produced exactly React
Router's middleware set in 21 of 22; the one difference was the manifest path, which §3.4 mirrors.
Two facts it fixed: a POST to `/app` with no `?index` runs the index child's middleware too, and
`/LOGIN.data` matches `/login` (case-insensitive by default).

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                           | Resolution (picked side)                                                        | Doc deliverable (same PR)                                              |
| --- | ---------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| C1  | `ARCHITECTURE.md` §10 describes route middleware as the static `middleware` array only; it will be wrong once groups exist         | the code: §10 gains the per-request groups                                      | `ARCHITECTURE.md` §10 subsection "Route middleware chosen per request" |
| C2  | `docs/react-router-dev.md` and the react-router README describe the loader seam as returning `{ handler, createLoadContext }` only | the code: the seam may return `pageRoutes`, and must when `pagePolicies` is set | both pages show `pageRoutes: { build: loadServerBuild, matchRoutes }`  |

No other conflict found (checked ROADMAP M141, PUBLIC_API react-router-plugin and common sections,
ARCHITECTURE §10 and the plugin table row at line 1649).

## 3. Design decisions

### 3.1 Where policies run: in the kernel, chosen per request

- **Decision:** policies run as kernel route middleware on the catch-all route, chosen per request
  by `RouteDefinition.middlewareGroups`. They never run inside React Router's `middleware` export.
- **Why:** inside React Router, Setu middleware would need the kernel context the bridge withholds
  by design (`get-service.ts` header comment), a Setu-to-`Response` translation, and would lose
  after-`next()` semantics (`idempotent()` snapshots the response after `next()`, but the bridge
  writes React Router's response onto `ctx.response` only after the handler returns). In the kernel,
  the terminal is `ssrService.render(ctx)`, so every existing Setu middleware keeps its exact
  semantics.
- **Test home:** `packages/react-router-plugin/test/integration/page-policies-kernel.test.ts` (an
  after-`next()` middleware sees the rendered status).

### 3.2 The kernel seam: `RouteDefinition.middlewareGroups`

- **Decision:** `RouteDefinition` gains `middlewareGroups?: RouteMiddlewareGroups`, where
  `RouteMiddlewareGroups = { readonly groups: Readonly<Record<string, readonly MiddlewareFunction[]>>; readonly select: (ctx: IRequestContext) => readonly string[] | Promise<readonly string[]> }`.
  The kernel dispatch (`application.ts:1500`) runs the static `middleware` first; its terminal (or
  the bypass, when the static chain is empty) calls `select(ctx)`, concatenates the named groups in
  the order returned, and runs them through the same `executeChain` with the handler as terminal. An
  empty selection takes the existing bypass (the `ended` check, then the handler). A selected key
  absent from `groups` throws `Error("route middleware group '<key>' is not declared")` before any
  selected stage runs, which the error handler turns into a `500`; the handler does not run. A
  `select` that throws or rejects is the same: `500`, handler not run.
- **Why:** the plugin cannot reach `executeChain` (§1: no plugin depends on the kernel at runtime),
  and a second executor would be the duplicated implementation AI_GUIDELINES §11.1 forbids. Groups
  are static data, so every startup scan can still see every middleware (§3.3); only the choice is
  per request. Arrays are built at registration (§14); `select` returns keys, never builds chains.
- **Diagnostics:** the chain observer keeps kind `route`; group stages continue the static stages'
  positions (`n, n+1, …`). `router.ts:412` `middlewareCount` stays the static count, documented.
- **Test home:** `packages/kernel/test/integration/route-middleware-groups.test.ts`.

### 3.3 One reader of a route's whole middleware set: `routeMiddlewareOf()`

- **Decision:** `common` exports
  `routeMiddlewareOf(definition: RouteDefinition): readonly MiddlewareFunction[]` — the static
  `middleware`, then every group's middleware in `groups` key order. `AuthPlugin`'s
  `scanPolicyGuards` (`startup-scan.ts:39`) iterates it instead of `definition.middleware`, so a
  `requirePolicy` naming an unregistered policy inside a page policy fails `start()` exactly as one
  on a kernel route does. The OpenAPI and MCP readers keep reading the static array (§9).
- **Why:** a guard placed in a page policy must not escape the scan that catches a misspelled policy
  everywhere else; one helper keeps "the route's middleware" defined once.
- **Test home:** `packages/common/test/unit/route-middleware.test.ts`;
  `packages/auth-plugin/test/unit/policies/startup-scan.test.ts` (new case).

### 3.4 Matching a request to route ids

- **Decision:** an internal matcher (`src/policies/page-route-matcher.ts`, not exported) takes the
  server build and React Router's `matchRoutes`:
  1. builds the route tree from `build.routes` exactly as `routes.js:17-69` groups it (by
     `parentId`; `index` → `{ id, path, index: true }` — React Router keeps an index route's `path`,
     which a flat route such as `app.settings._index` with no parent layout carries; else
     `{ id, path, caseSensitive, children }`), cached per build object in a `WeakMap`, so a
     development build re-read per request rebuilds only when Vite hands back a new object;
  2. if `build.routeDiscovery?.mode === 'lazy'` and the pathname equals
     `joinPaths([build.basename, build.routeDiscovery.manifestPath || '/__manifest'])`, returns
     `[]`;
  3. normalizes the pathname as `urls.js:12-26` (`/_.data` → `/`, else strip `.data`);
  4. returns `matchRoutes(tree, pathname, build.basename)` mapped to ids, root first, or `[]`. The
     pathname is `new URL(ctx.request.url).pathname`, undecoded, as React Router receives it.
- **Why:** the probe (§1) showed this reproduces React Router's middleware set on every URL shape;
  `matchRoutes` is public and comes from the same module as the handler, so decoding, case and
  ranking are React Router's. The two mirrored rules (normalization, manifest path) are fifteen
  lines of React Router internals — the conformance test (§6) is what keeps them honest across
  upgrades.
- **Test home:** `test/unit/page-route-matcher.test.ts` (rules in isolation);
  `test/integration/page-policies-conformance.test.ts` (against the real handler).

### 3.5 `pagePolicies`, `PagePolicy` and what each request selects

- **Decision:** `ReactRouterCommonOptions.pagePolicies?: Readonly<Record<string, PagePolicy>>`,
  keyed by route id;
  `PagePolicy = { readonly middleware: readonly MiddlewareFunction[]; readonly methods?: readonly HttpMethod[] }`.
  Omitted `methods` means every method. A listed `GET` also selects `HEAD`: React Router answers a
  `HEAD` request by running the same loaders as `GET`, so a `GET`-only guard that skipped `HEAD`
  would let a loader run unguarded (fail closed). When `pagePolicies` is absent or `{}`, the
  catch-all is registered exactly as today (no `middlewareGroups`, no per-request matching).
  Otherwise each catch-all verb registers `{ handler, middlewareGroups: { groups, select } }` with
  one group per route id; `select(ctx)` matches (§3.4) and returns, root first, the ids that have a
  policy whose `methods` include `ctx.request.method`. A policy on a layout or on `root` therefore
  applies to every page beneath it, and both the layout's and the page's policies run, outer first.
  Static `publicFiles` GETs keep their current order: a public file is served before SSR, so page
  policies do not run for `/robots.txt`. Today the public-file lookup lives inside the GET handler,
  which runs AFTER route middleware (`react-router-plugin.ts:191`), so a root policy would refuse
  `/robots.txt` (measured: 200 → 429). When policies are installed and public files are enabled, the
  GET route therefore carries the lookup as its static `middleware` stage — it answers a hit (or the
  `400` for an undecodable path) and ends the response, else calls `next()` — and its handler is
  `renderRoute`; static middleware runs before the groups (§3.2). With no policies the GET route is
  registered exactly as today.
- **Validation at registration** (all reported in one internal `PagePolicyConfigurationError`, NOT
  exported — nothing outside the plugin branches on it, so tests match its message): a key naming no
  route id in the build (the message lists the unknown ids and up to ten known ones), an empty
  `middleware` array, an empty `methods` array, a non-function middleware.
- **Why:** route ids are React Router's stable identity for a route (the same ids its own
  `middleware` export is attached to); a method filter is what lets a sign-in page rate-limit its
  `POST` without limiting page views.
- **Test home:** `test/unit/page-policies.test.ts`; `test/integration/page-policies-kernel.test.ts`.

### 3.6 Where the build comes from: `SsrRuntime.pageRoutes`

- **Decision:** `SsrRuntime` gains optional `pageRoutes?: PageRouteSource`,
  `PageRouteSource = { readonly build: () => unknown | Promise<unknown>; matchRoutes(routes: readonly unknown[], location: string, basename?: string): readonly { readonly route: { readonly id?: string } }[] | null }`.
  `matchRoutes` is declared with METHOD syntax on purpose: React Router declares its parameter as a
  mutable `RouteObjectType[]` (`lib/router/utils.d.ts:678`), so a function-typed property with a
  `readonly unknown[]` parameter rejects `rr.matchRoutes` under `strictFunctionTypes` (TS2322,
  measured); method parameters are checked bivariantly, so the dev entry's plain
  `{ build, matchRoutes }` type-checks with no cast. The returned `route.id` is optional for the
  same reason (React Router's `AgnosticRouteObject.id?: string`, `utils.d.ts:497`); every route the
  matcher builds carries an id, so a match without one is impossible in practice, and the matcher
  throws on it (fail closed: `500`, page not rendered) rather than skip a policy. The default loader
  (`server-build.ts`) always supplies it — `build: () => build` and `matchRoutes: rr.matchRoutes` —
  and throws a plain `Error` naming the missing export when `rr.matchRoutes` is not a function, the
  same form it throws for a missing `createRequestHandler` (`server-build.ts:189-194`). A custom
  `loadRequestHandler` (the development entry) supplies its own. `register()` refuses with
  `PagePolicyConfigurationError` when `pagePolicies` is non-empty and the runtime has no
  `pageRoutes`, naming `docs/react-router-dev.md`. Route ids are validated against `await build()`
  once at registration; per request, `select` awaits `build()` (a development build may change).
- **Why:** the plugin must match against the same build React Router serves; a seam that cannot say
  which build that is must not let policies silently never apply (fail closed).
- **Test home:** `test/unit/server-build.test.ts` (default loader supplies it);
  `test/unit/page-policies.test.ts` (refusal without it).

### 3.7 Request bodies read twice

- **Decision:** no new mechanism. A policy middleware may read `ctx.request.formData()` / `bytes()`;
  the bridge's later `ctx.request.bytes()` gets the cached bytes (§1 body memoization), so the
  action's `request.formData()` sees the same body.
- **Why:** the three request implementations already memoize; the test proves the composition.
- **Test home:** `test/integration/page-policies-kernel.test.ts` (a middleware reads a multipart
  field, the action reads the same field and its file bytes).

### 3.8 Short-circuit and fail-closed behaviour

- **Decision:** a policy that responds without `next()` ends the request; `ssrService.render` does
  not run, on every URL shape of the route. Matching errors, a rejected `build()`, or a thrown
  `select` answer `500` and never render the page (§3.2).
- **Test home:** `test/integration/page-policies-kernel.test.ts` (fake handler counts renders) and
  `test/integration/page-policies-conformance.test.ts` (real handler: the action's side effect did
  not happen on `/x`, `/x.data`, `/x/_.data`, `?index`).

### 3.9 The development entry supplies `pageRoutes`

- **Decision:** the CLI's generated full-stack dev entry and `apps/full-stack/dev.ts` return
  `pageRoutes: { build: loadServerBuild, matchRoutes }` (`matchRoutes` imported from `react-router`
  beside `createRequestHandler`). The `develop` dev-entry fixtures change; the `0.12.0` fixtures do
  not (they record the published output).
- **Why:** without it, an application that adds `pagePolicies` fails to start under `npm run dev`
  (§3.6) — correct, but a scaffold should not need a hand-edit to use a documented option.
- **Test home:** `packages/cli/test/unit/templates/project-files.test.ts` (fixture);
  `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` (the full-stack scaffold boots and serves its
  pages with the changed entry).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none for callers. An implementor that dispatches `RouteDefinition`
itself must also run `middlewareGroups`, or it fails open; the kernel is the only dispatcher in the
repository (checked: §1 readers). Ships in minor 0.13.0, recorded under CHANGELOG "Added".

| Exported symbol                             | Kind      | Consumer / real code path that READS it                                                                |
| ------------------------------------------- | --------- | ------------------------------------------------------------------------------------------------------ |
| `RouteMiddlewareGroups` (common)            | interface | `RouteDefinition.middlewareGroups`; built by `ReactRouterPlugin.register`; read by the kernel dispatch |
| `RouteDefinition.middlewareGroups` (common) | field     | kernel `application.ts` dispatch; `routeMiddlewareOf`                                                  |
| `routeMiddlewareOf` (common)                | function  | `packages/auth-plugin/src/policies/startup-scan.ts` `scanPolicyGuards`                                 |
| `PagePolicy` (react-router-plugin)          | type      | `ReactRouterCommonOptions.pagePolicies` values, read by `src/policies/page-policies.ts`                |
| `PageRouteSource` (react-router-plugin)     | type      | `SsrRuntime.pageRoutes`; produced by the default loader and the dev entry, read by `page-policies.ts`  |
| `SsrRuntime.pageRoutes`                     | field     | `ReactRouterPlugin.register` → `page-policies.ts`                                                      |
| `ReactRouterCommonOptions.pagePolicies`     | option    | `ReactRouterPlugin.register` → `page-policies.ts`                                                      |

### 4.1 Options — every option names its consumer

| Option                        | Consumer                                        | Behavior (per implementation)                                                                                                 |
| ----------------------------- | ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `pagePolicies`                | `page-policies.ts` via `register()`             | absent or `{}`: catch-all unchanged; else groups + `select` installed on all seven verbs; refused per §3.5/§3.6               |
| `PagePolicy.middleware`       | the group for that route id                     | run in order through `executeChain`, after the catch-all's static middleware (none today) and after ancestor routes' policies |
| `PagePolicy.methods`          | `select`                                        | omitted: every method; listed: the group is selected only when `ctx.request.method` is listed; `[]` refused                   |
| `PageRouteSource.build`       | registration (id validation) and every `select` | awaited; a rejection at registration fails `register()`, per request answers `500`                                            |
| `PageRouteSource.matchRoutes` | `page-route-matcher.ts`                         | called with the cached tree, the normalized pathname and `build.basename`                                                     |

## 5. Implementation files

| File                                                                                                                                                                                            | Purpose                                                                                           |
| ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `packages/common/src/http.ts`                                                                                                                                                                   | `RouteMiddlewareGroups`; `RouteDefinition.middlewareGroups`                                       |
| `packages/common/src/route-middleware.ts`                                                                                                                                                       | `routeMiddlewareOf()`                                                                             |
| `packages/common/src/index.ts`                                                                                                                                                                  | barrel exports for the two above                                                                  |
| `packages/kernel/src/application/application.ts`                                                                                                                                                | dispatch: static chain → `select` → groups → handler; unknown key error; observer positions       |
| `packages/auth-plugin/src/policies/startup-scan.ts`                                                                                                                                             | iterate `routeMiddlewareOf(route.definition)`                                                     |
| `packages/react-router-plugin/src/interfaces/index.ts`                                                                                                                                          | `PagePolicy`, `PageRouteSource`, `SsrRuntime.pageRoutes`, `ReactRouterCommonOptions.pagePolicies` |
| `packages/react-router-plugin/src/policies/page-route-matcher.ts`                                                                                                                               | internal: tree, manifest skip, normalization, match → ids                                         |
| `packages/react-router-plugin/src/policies/page-policies.ts`                                                                                                                                    | internal: validation, groups, `select`; the internal `PagePolicyConfigurationError`               |
| `packages/react-router-plugin/src/handler/server-build.ts`                                                                                                                                      | default loader returns `pageRoutes`                                                               |
| `packages/react-router-plugin/src/plugin/react-router-plugin.ts`                                                                                                                                | install `middlewareGroups` on the catch-all when `pagePolicies` is non-empty                      |
| `packages/react-router-plugin/src/index.ts`                                                                                                                                                     | barrel: `PagePolicy`, `PageRouteSource`                                                           |
| `packages/cli/src/templates/full-stack-build-files.ts`                                                                                                                                          | dev entry returns `pageRoutes`                                                                    |
| `apps/full-stack/dev.ts`                                                                                                                                                                        | the same, in the example                                                                          |
| Docs: `packages/react-router-plugin/README.md` ("Protecting page actions"), `AGENT_CARD.md` (≤ 2,560 bytes), `PUBLIC_API.md`, `ARCHITECTURE.md` §10, `CHANGELOG.md`, `docs/react-router-dev.md` | C1, C2 and the new surface                                                                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                              | src covered                                                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/route-middleware.test.ts`                                                                   | `route-middleware.ts`                                        | `routeMiddlewareOf({ handler })` → `[]`; static only; groups only; static then groups in key order (`routeMiddlewareOf(definition: RouteDefinition)`)                                                                                                                                                                                                                                                                        |
| `packages/kernel/test/integration/route-middleware-groups.test.ts`                                                     | `application.ts` dispatch                                    | groups run after static middleware in `select` order; empty selection runs the handler (bypass); a group that responds without `next()` stops later groups AND the handler (short-circuit, mandatory); an undeclared key → `500`, handler not run; `select` throwing / rejecting → `500`; static stage short-circuit means `select` is never called; diagnostics positions continue `n…`                                     |
| `packages/auth-plugin/test/unit/policies/startup-scan.test.ts` (new cases)                                             | `startup-scan.ts`                                            | a `requirePolicy` naming an unregistered ability inside `middlewareGroups` is refused; a registered one passes                                                                                                                                                                                                                                                                                                               |
| `packages/react-router-plugin/test/unit/page-route-matcher.test.ts`                                                    | `page-route-matcher.ts`                                      | tree shape from a manifest (index, `caseSensitive`, nesting); `.data` / `_.data` normalization; manifest path skipped only in `lazy` mode, with and without basename; no match → `[]`; `WeakMap` reuse for the same build object, rebuild for a new one                                                                                                                                                                      |
| `packages/react-router-plugin/test/unit/page-policies.test.ts`                                                         | `page-policies.ts`                                           | every refusal of §3.5 and §3.6 in ONE error listing all problems; `select` method filter (omitted = all, listed, other method excluded); layout + page both selected, root first; `pagePolicies: {}` installs nothing                                                                                                                                                                                                        |
| `packages/react-router-plugin/test/unit/server-build.test.ts` (new cases)                                              | `server-build.ts`                                            | default loader returns `pageRoutes.build()` === the unwrapped build and `pageRoutes.matchRoutes` === the module's; a module without `matchRoutes` → the named load error                                                                                                                                                                                                                                                     |
| `packages/react-router-plugin/test/unit/react-router-plugin.test.ts` (new cases)                                       | `react-router-plugin.ts`                                     | with no policies the seven routes carry no `middlewareGroups` (unchanged); with policies all seven carry them; refusal propagates from `register()`                                                                                                                                                                                                                                                                          |
| `packages/react-router-plugin/test/integration/page-policies-conformance.test.ts`                                      | matcher + plugin, real `react-router`                        | the §1 probe as a table: a fixture build whose route modules record their middleware ids, every URL shape on basenames `/`, `/shop/`; the plugin's `select` ids (with a policy on every route) equal React Router's recorded set, manifest path included; a refusing policy on `routes/login` stops the action (its side effect absent) on `/login`, `/login.data`, `/login/_.data`, and on `/app?index` for the index route |
| `packages/react-router-plugin/test/integration/page-policies-kernel.test.ts`                                           | plugin through a kernel app (`createApplication` + `inject`) | a `rateLimitMiddleware`-shaped refusing policy answers `429` and the fake handler did not render; an after-`next()` middleware reads the rendered status; a middleware reads a multipart field and the action receives the same field and file bytes; the dev-style seam (`build` returning a new object) is honoured; `build()` rejecting per request → `500`                                                               |
| `packages/react-router-plugin/test/unit/barrel-exports.test.ts` and the common barrel test (existing, extended)        | both `src/index.ts` barrels                                  | `PagePolicy` / `PageRouteSource` are type exports only; `routeMiddlewareOf` is exported from `@setu-ts/common`; `PagePolicyConfigurationError` is NOT exported                                                                                                                                                                                                                                                               |
| `packages/cli/test/unit/templates/project-files.test.ts` + `test/fixtures/full-stack-dev-entry-develop-{node,bun}.txt` | `full-stack-build-files.ts`                                  | the dev entry returns `pageRoutes: { build: loadServerBuild, matchRoutes }` and imports `matchRoutes`                                                                                                                                                                                                                                                                                                                        |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` (existing)                                                           | generated full-stack project                                 | the full-stack scaffold installs, type-checks and boots with the changed entry, and its advertised pages answer; the implementer also prints the built manifest's ids once and confirms `routes/_auth/login` (the id the README example uses)                                                                                                                                                                                |

External dependency: `react-router` is the only one, already a devDependency of the plugin; the
conformance test is the guarded REAL-import test, and the matcher's branching is unit-tested with a
fake `matchRoutes` through the `PageRouteSource` seam.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m141-page-route-policies
pnpm run check:plan        # this plan lints clean
pnpm run fmt:check
pnpm run lint
pnpm run check
pnpm run test:tooling
pnpm test:coverage common kernel auth-plugin react-router-plugin cli   # ANSI-stripped per-file table; ≥90% every changed src file
pnpm run ci:local          # on the final commit
pnpm run test:deno-lane
pnpm run check:apps        # apps/full-stack with the changed dev entry
pnpm run release:publish --dry-run
pnpm run release:verify 0.13.0
```

The full-stack scaffold boot (§3.9) is the generated-output gate. A committed-tree security audit
runs before the PR (this change decides whether a guard runs on network input): a fresh agent,
following `.roo/skills/security-audit/SKILL.md`, probes every URL shape for a bypass with a refusing
policy as the positive control.

## 8. Risks & mitigations

- **React Router changes its URL normalization or manifest rule in a later version** → a policy is
  silently skipped on the new shape. Mitigation: the conformance test runs against the installed
  `react-router` on every CI run and fails on any difference; the README states the supported
  `react-router` range is the plugin's peer range (`^8`).
- **Over-application:** a POST to a layout's path with no `?index` also selects the index child's
  policy (React Router runs that child's middleware too, §1 probe). This matches React Router and
  errs closed; documented in the README.
- **Per-request cost:** matching runs on every page request once `pagePolicies` is set. Mitigation:
  the tree is cached per build object, `select` returns precomputed keys, and nothing is installed
  when no policy is configured.
- **A custom `IRouterApi` dispatcher ignoring `middlewareGroups` fails open.** Mitigation: none
  exists in the repository; the `RouteDefinition` JSDoc and CHANGELOG state the obligation.
- **Route ids differ from what a developer guesses** (`routes/_auth/login` vs `_auth/login`).
  Mitigation: an unknown id refuses startup and lists known ids.

## 9. Out of scope

- A default sign-in rate limit in the generated full-stack template — the template has no rate
  limiter package; a later CLI milestone decides whether it adds `auth-plugin`.
- OpenAPI derived responses and MCP tool discovery from page policies. The catch-all is not an API
  operation: the full-stack starter adds it to its OpenAPI exclusions
  (`full-stack-starter/src/app.ts:57`, `FULL_STACK_EXCLUDED_PATHS`), and a page is not an MCP tool.
  Both readers keep the static array; a later milestone that documents pages would switch them to
  `routeMiddlewareOf`.
- Adopting page policies in any application outside this repository.
