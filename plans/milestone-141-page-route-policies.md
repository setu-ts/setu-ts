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
- **Also in scope (§3.11, added at the maintainer's request):** `setu add` on a full-stack project
  inserts value-free and generated-seam starter arms itself and words opt-in and always-on arms
  differently.
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
| React Router mutation methods                    | `react-router@8.5.1` `dist/production/lib/router/router.js:19-24,2962`                                                                                                                                                                                                      | `validMutationMethodsArr = ['POST','PUT','PATCH','DELETE']`; `isMutationMethod` upper-cases the method — the set `on: 'action'` selects                                                                                                     |
| React Router's ranked matcher                    | `react-router@8.5.1` `dist/production/lib/router/matcher.js:13-31`; `lib/router/utils.js:237-262`                                                                                                                                                                           | public `matchRoutes` calls `flattenAndRankRoutes` on every call; the precomputed `V6RegExMatcher` is internal and not exported — the cost §3.10 avoids                                                                                      |
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
  2. if `build.routeDiscovery?.mode === 'lazy'` and the pathname equals React Router's
     `getManifestPath` (`fog-of-war.js:120-123`): `manifestPath || '/__manifest'` as-is when
     `build.basename == null`, else `joinPaths([build.basename, manifestPath || '/__manifest'])`,
     returns `[]` (the 2026-11-17 audit's F3: joining `basename ?? '/'` diverged for a build without
     a basename and a slash-less `manifestPath`);
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
  `PagePolicy = { readonly middleware: readonly MiddlewareFunction[]; readonly on?: 'action' | 'all' }`.
  `on` names what React Router runs, not an HTTP verb list: `'action'` selects the policy for every
  request React Router treats as a mutation — `POST`, `PUT`, `PATCH`, `DELETE`, the set of
  `isMutationMethod` (`router.js:19-24,2962`), on every URL shape — and `'all'` (the default) for
  every request that reaches the route. There is no loader-only value: a mutation document request
  runs the action and then the loaders, so a guard on loader data must run on every method.
  **Superseded:** the first implementation took `methods?: readonly HttpMethod[]`; the 2026-11-17
  committed-tree audit (F1, High) showed it fails open — `methods: ['POST']` let `PUT`/`PATCH`/
  `DELETE` run the action unguarded, and `methods: ['GET']` let a `POST` document request run the
  loaders. `on` cannot name a partial verb set. When `pagePolicies` is absent or `{}`, the catch-all
  is registered exactly as today (no `middlewareGroups`, no per-request matching). Otherwise each
  catch-all verb registers `{ handler, middlewareGroups: { groups, select } }` with one group per
  route id; `select(ctx)` returns, root first, the matched ids (§3.4, §3.10) whose policy applies to
  the request (`'all'`, or `'action'` on a mutation method). A policy on a layout or on `root`
  therefore applies to every page beneath it, and both the layout's and the page's policies run,
  outer first. Static `publicFiles` GETs keep their current order: a public file is served before
  SSR, so page policies do not run for `/robots.txt`. Today the public-file lookup lives inside the
  GET handler, which runs AFTER route middleware (`react-router-plugin.ts:191`), so a root policy
  would refuse `/robots.txt` (measured: 200 → 429). When policies are installed and public files are
  enabled, the GET route therefore carries the lookup as its static `middleware` stage — it answers
  a hit (or the `400` for an undecodable path) and ends the response, else calls `next()` — and its
  handler is `renderRoute`; static middleware runs before the groups (§3.2). With no policies the
  GET route is registered exactly as today.
- **Validation at registration** (all reported in one internal `PagePolicyConfigurationError`, NOT
  exported — nothing outside the plugin branches on it, so tests match its message): a key naming no
  route id in the build (the message lists the unknown ids and up to ten known ones), an empty
  `middleware` array, a non-function middleware, an `on` value other than `'action'` or `'all'`.
- **Why:** route ids are React Router's stable identity for a route (the same ids its own
  `middleware` export is attached to); `on: 'action'` is what lets a sign-in page rate-limit its
  submissions without limiting page views.
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
  beside `createRequestHandler`). The recognition fixtures record what earlier versions rendered and
  do not change: `workspace adopt` must still recognise a `dev.ts` written by develop before this
  milestone, so the develop variant is derived from the current entry with `pageRoutes` and the
  `matchRoutes` import stripped, as the `0.12.0` variant already is (code review 2026-11-17).
- **Why:** without it, an application that adds `pagePolicies` fails to start under `npm run dev`
  (§3.6) — correct, but a scaffold should not need a hand-edit to use a documented option.
- **Test home:** `packages/cli/test/unit/templates/project-files.test.ts` (fixture);
  `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` (the full-stack scaffold boots and serves its
  pages with the changed entry).

### 3.10 Selecting without matching the whole tree on every request

- **Measured problem (2026-11-17, cores 8–15):** React Router's public `matchRoutes` flattens and
  ranks the tree it is given on every call; its own handler ranks once in the internal, unexported
  `V6RegExMatcher` (`lib/router/matcher.js`). The first `select` therefore cost 30 µs per request at
  12 routes, 250 µs at 102 and 1,284 µs at 502 — more than React Router's whole handler (29, 61, 209
  µs on a fixed-string page), on every catch-all request, and an attacker-triggerable CPU cost.
- **Decision:** `select` runs four steps, all prepared once per build object (WeakMap, as §3.4):
  1. **Method exit.** The policies that apply to this request's method are the `'all'` policies,
     plus the `'action'` ones on a mutation method. If none exist, return `[]` without parsing the
     URL. (A sign-in throttle with `on: 'action'` costs nothing on a page view: 0.05 µs measured.)
  2. **Root always applies.** A policy on the build's root route (the route with no `parentId`) that
     applies to the method is selected on every request without matching — React Router's root
     matches every request the catch-all serves, and running it on an unmatched path too errs closed
     — and is left OUT of the policied set the prefilter's reduced tree is built from (root stays in
     it only as an ancestor). If root's is the only applicable policy, return `[root]`. (Re-audit
     A2: with root in the policied set, root's descendants are every route, the reduced tree became
     the whole tree, and a request ranked it twice — 2,475 µs at 502 routes.)
  3. **Prefilter.** When the reduced tree holds every route (a policy on a top-level layout that
     wraps the app), skip this step — it could only repeat step 4. Otherwise match against a reduced
     tree (built with the same rules as §3.4 step 1) holding only the routes that have an applicable
     policy, their ancestors and their descendants — one reduced tree per method class
     (`'all'`-only, and all policies). An empty result returns `[]`. **Exactness:** React Router
     returns the highest-ranked branch that matches. If that branch in the full tree contains a
     policied route, the same branch is in the reduced tree and still outranks every other reduced
     branch, so a non-empty full answer is never missed; an empty reduced answer therefore proves no
     policy applies. (Measured: a post to an unguarded page, 3.9 µs at every size.)
  4. **Full match.** Otherwise match the full tree (§3.4) and filter to applicable ids — the reduced
     match may differ from React Router's (a policied splat beside an unpolicied static sibling), so
     it is never returned itself. The result is cached in a per-build LRU keyed by method class and
     normalized pathname: at most 1,000 entries, and only pathnames of at most 512 bytes are cached,
     so the cache holds at most ~0.5 MB however the keys are chosen; a longer path is matched
     uncached. **At most one whole-tree ranking per request, plus a prefilter over fewer than half
     the routes**, whatever the policies.
  5. **Fail closed on a build the selector cannot mirror.** A build with
     `future.unstable_routePatternMatching` truthy is refused at registration
     (`PagePolicyConfigurationError`) and answers `500` per request (a development build may
     change): React Router then ranks with its route-pattern matcher (`router.js:66-72`), which
     orders routes differently from `matchRoutes` (re-audit A1: `a/:x/b/c` vs `a/b/:y/:z`). A
     per-request build that no longer contains a policied route id (a development rebuild renamed or
     removed the page) also answers `500`, naming the id, instead of silently not applying it
     (re-audit A3).
- **Why:** steps 1–3 remove the cost from requests that cannot reach a policy, which is most
  traffic; step 4 keeps the answer exactly React Router's for those that can. Mirroring React
  Router's flatten-and-rank to precompute branches was rejected: it is ~80 more lines of internals
  for the conformance test to police.
- **Test home:** `test/unit/page-policies.test.ts` (each step; the cache bound and eviction; a
  512-byte and a 513-byte path); `test/integration/page-policies-conformance.test.ts` (the shape
  table also run with policies on SUBSETS of the routes — each single route, a layout only, root
  only, a splat beside a static sibling — not only on every route, so the prefilter and the shortcut
  are exercised against the real handler).
- **Conformance rule (what the table asserts per row):** the selected ids are always a SUPERSET of
  React Router's recorded middleware ids restricted to routes with an applicable policy — never
  fewer — and EQUAL to that set except in exactly two documented over-application cases, each
  asserted by name: (a) `OPTIONS` with an `'all'` policy, which React Router answers `405` before
  any route middleware runs; (b) a root policy on a path React Router matches nothing for (it
  answers `404` with no route middleware), with or without other policies. In both, nothing guarded
  runs, so the extra policy run errs closed and is documented in the README.

### 3.11 `setu add` finishes full-stack wiring it can do safely (maintainer request, 2026-11-17)

- **Found by the M141 full-stack smoke:** on a full-stack project `setu add` edited `setu.config.ts`
  for 1 of 9 plugins and printed "createFullStackAppFromConfig owns this plugin; configure its X
  arm" for the rest — the same line for an opt-in arm that does nothing until set
  (`GATED_STARTER_ARMS`, `packages/cli/src/utils/starter-arms.ts`) and an always-on arm the starter
  already registers with defaults. `withStarterOption`
  (`packages/cli/src/commands/starter-options.ts`, M121) can insert an arm but is used only for
  `messaging`/`queue`. The maintainer asked for this on the M141 branch.
- **Decision — one rule, derived from data the CLI already has, never a hand list:**
  1. **Opt-in arm with no developer values** — a gated arm whose plugin `setu add` registers with NO
     arguments on an inline plugin list (its `ZERO_CONFIG_WIRINGS` entry renders `<Symbol>()`):
     insert the arm with `{}` (a dotted arm such as `realtime.sse` becomes `realtime: { sse: {} }`)
     through `withStarterOption`.
  2. **Arm with a generated seam** (`metrics`, `health`, and any arm whose wiring has a `seam`):
     insert `<arm>: <seam.args>` and the seam's imports, whether the arm is gated or always-on — the
     generated files are otherwise read by nothing.
  3. **Always-on arm without a seam:** no edit; print "`<symbol>` already registers this plugin with
     its defaults; set its `<arm>` arm in setu.config.ts only to configure it."
  4. **Opt-in arm that needs developer values** (e.g. `auth`): no edit; print "`<symbol>` registers
     this plugin only once its `<arm>` arm is set in setu.config.ts." followed by the existing hint.
     The CLI never writes a credential check or a secret.
- **An arm that already exists (code review 2026-11-17).** Rules 1–4 apply only to an ABSENT arm.
  When the arm is present: a generated-seam arm whose value already references the seam's symbol
  (e.g. `EVENT_HANDLERS`) prints "already sets its X arm; it was left as it is."; one that does not
  keeps the pre-milestone behaviour unchanged — the existing `STARTER_SEAMS` merge into `events`/
  `cqrs`/`queue`, otherwise the "Pass the generated artifacts through it" and import lines. Every
  other present arm prints that it is already set, never the opt-in or defaults note. `messaging`
  and `queue` without a transport flag keep their pre-milestone notes (`starterOptionValue`), so a
  `--broker redis` scaffold is never told it runs "with its defaults".
- **Refusals (→ the printed line, nothing written), as M121's rule "write only what is absent":**
  the returned object already has the top-level key (for a dotted arm, the parent key such as
  `realtime` — never merge into a user's object); the `(config): FullStackStarterOptions =>`
  callback is absent, repeated or unclassifiable; the seam's import binding already exists with
  another source. The same `setu add` run twice writes once (idempotent).
- **Scope:** the generated full-stack factory only. REST (inline plugin list) and hand-written
  `createRestApp`/`createMicroserviceApp` configs keep today's behaviour.
- **Test home:** `packages/cli/test/unit/commands/add.test.ts` (or the existing full-stack add test
  file): a table over every full-stack arm asserting which of rules 1–4 applies, derived from
  `GATED_STARTER_ARMS` and the wirings, so a new arm cannot fall through; each refusal; idempotence;
  the inserted source type-checks against `FullStackStarterOptions` (the existing compiler-API check
  M121 uses for broker arms). `packages/cli/test/e2e/full-stack-wiring-e2e.test.ts` (or a sibling):
  a full-stack scaffold with `setu add sse metrics health` boots, `/metrics` serves a generated
  custom metric's name and the SSE plugin is registered, with no hand edit.

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
| `PagePolicy.on`               | `select`                                        | `'all'` (default): every request; `'action'`: `POST`/`PUT`/`PATCH`/`DELETE` only; any other value refused                     |
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
| `packages/cli/src/commands/add.ts`, `packages/cli/src/commands/starter-options.ts`, `packages/cli/src/utils/starter-arms.ts`                                                                    | §3.11: classify the arm (rules 1–4), insert through `withStarterOption`, the new notes            |
| `apps/full-stack/dev.ts`                                                                                                                                                                        | the same, in the example                                                                          |
| Docs: `packages/react-router-plugin/README.md` ("Protecting page actions"), `AGENT_CARD.md` (≤ 2,560 bytes), `PUBLIC_API.md`, `ARCHITECTURE.md` §10, `CHANGELOG.md`, `docs/react-router-dev.md` | C1, C2 and the new surface                                                                        |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                              | src covered                                                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ---------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/route-middleware.test.ts`                                                                   | `route-middleware.ts`                                        | `routeMiddlewareOf({ handler })` → `[]`; static only; groups only; static then groups in key order (`routeMiddlewareOf(definition: RouteDefinition)`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/kernel/test/integration/route-middleware-groups.test.ts`                                                     | `application.ts` dispatch                                    | groups run after static middleware in `select` order; empty selection runs the handler (bypass); a group that responds without `next()` stops later groups AND the handler (short-circuit, mandatory); an undeclared key → `500`, handler not run; `select` throwing / rejecting → `500`; static stage short-circuit means `select` is never called; diagnostics positions continue `n…`                                                                                                                                                                                                                                                                                                                                      |
| `packages/auth-plugin/test/unit/policies/startup-scan.test.ts` (new cases)                                             | `startup-scan.ts`                                            | a `requirePolicy` naming an unregistered ability inside `middlewareGroups` is refused; a registered one passes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/react-router-plugin/test/unit/page-route-matcher.test.ts`                                                    | `page-route-matcher.ts`                                      | tree shape from a manifest (index, `caseSensitive`, nesting); `.data` / `_.data` normalization; manifest path skipped only in `lazy` mode, with and without basename; no match → `[]`; `WeakMap` reuse for the same build object, rebuild for a new one                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `packages/react-router-plugin/test/unit/page-policies.test.ts`                                                         | `page-policies.ts`                                           | every refusal of §3.5 and §3.6 in ONE error listing all problems (an unknown `on` included); `on` selection (`'all'` on every method, `'action'` on `POST`/`PUT`/`PATCH`/`DELETE` and never on `GET`/`HEAD`/`OPTIONS`); layout + page both selected, root first; §3.10 steps — method exit with no URL parse, root shortcut, prefilter empty → `[]`, full match filtered, cache hit, eviction at 1,000, a 512-byte path cached and a 513-byte one not; `pagePolicies: {}` installs nothing                                                                                                                                                                                                                                    |
| `packages/react-router-plugin/test/unit/server-build.test.ts` (new cases)                                              | `server-build.ts`                                            | default loader returns `pageRoutes.build()` === the unwrapped build and `pageRoutes.matchRoutes` === the module's; a module without `matchRoutes` → the named load error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/react-router-plugin/test/unit/react-router-plugin.test.ts` (new cases)                                       | `react-router-plugin.ts`                                     | with no policies the seven routes carry no `middlewareGroups` (unchanged); with policies all seven carry them; refusal propagates from `register()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/react-router-plugin/test/integration/page-policies-conformance.test.ts`                                      | matcher + plugin, real `react-router`                        | the §1 probe as a table: a fixture build whose route modules record their middleware ids, every URL shape on basenames `/`, `/shop/`; the plugin's `select` ids (with a policy on every route) equal React Router's recorded set, manifest path included; a refusing policy on `routes/login` stops the action (its side effect absent) on `/login`, `/login.data`, `/login/_.data`, and on `/app?index` for the index route; the same table with policies on subsets (§3.10 test home); every shape on all seven methods with `on: 'action'` and `'all'`, the action/loader side effect absent wherever the policy applies (the audit's F1 reproduction: `PUT`/`PATCH`/`DELETE` to `/login` with `on: 'action'` are refused) |
| `packages/react-router-plugin/test/integration/page-policies-kernel.test.ts`                                           | plugin through a kernel app (`createApplication` + `inject`) | a `rateLimitMiddleware`-shaped refusing policy answers `429` and the fake handler did not render; an after-`next()` middleware reads the rendered status; a middleware reads a multipart field and the action receives the same field and file bytes; the dev-style seam (`build` returning a new object) is honoured; `build()` rejecting per request → `500`                                                                                                                                                                                                                                                                                                                                                                |
| `packages/react-router-plugin/test/unit/barrel-exports.test.ts` and the common barrel test (existing, extended)        | both `src/index.ts` barrels                                  | `PagePolicy` / `PageRouteSource` are type exports only; `routeMiddlewareOf` is exported from `@setu-ts/common`; `PagePolicyConfigurationError` is NOT exported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `packages/cli/test/unit/templates/project-files.test.ts` + `test/fixtures/full-stack-dev-entry-develop-{node,bun}.txt` | `full-stack-build-files.ts`                                  | the dev entry returns `pageRoutes: { build: loadServerBuild, matchRoutes }` and imports `matchRoutes`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/cli/test/e2e/scaffold-runs-e2e.test.ts` (existing)                                                           | generated full-stack project                                 | the full-stack scaffold installs, type-checks and boots with the changed entry, and its advertised pages answer; the implementer also prints the built manifest's ids once and confirms `routes/_auth/login` (the id the README example uses)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |

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

## 7a. Design security review

Completed 2026-11-17, after the first committed-tree audit failed it for lacking one (F0); the
design changes it records (§3.5 `on`, §3.10) are reviewed here before they are implemented.

- **Reviewed flows:**
  - F1 a page request on the SSR catch-all, through the global pipeline, the public-file stage, the
    selected groups and the render;
  - F2 `select`: method exit, root shortcut, prefilter, full match and its cache;
  - F3 registration: route-id validation against `await build()`, refusal without `pageRoutes`;
  - F4 a development build re-read per request (a new build object per Vite update);
  - F5 the `requirePolicy` startup scan over `routeMiddlewareOf`.
- **Assets:** the guarded action or loader not running when its policy refuses (rate-limit budgets,
  authorization, idempotency, upload limits); the server's CPU and memory under hostile URLs.
- **Attackers:** an unauthenticated client choosing the method, the path (encodings, `.data`,
  `/_.data`, `?index`, `?_routes`, case, dot segments, double slashes, manifest paths), headers and
  body; a client sending many distinct paths to churn the cache or cost CPU.
- **Obligations the audit probes** (each with a positive control: the side effect happens when the
  policy is removed):
  - **O1** For every URL shape and all seven methods, with `on: 'action'` and with `'all'`: wherever
    React Router runs the route's action (or, for `'all'`, its action or loader), the refusing
    policy ran and the side effect did not happen — against the real `react-router` handler, with
    policies on every route AND on subsets (§3.10).
  - **O2** No path the prefilter answers `[]` reaches a policied route's action or loader.
  - **O3** Fail closed: `select` throwing, `build()` rejecting or not a build, a match without an
    id, an undeclared group key — `500`, nothing rendered, no error text in the body.
  - **O4** Inherited names (`constructor`, `__proto__`, `toString`) as route ids, group keys and
    cache keys neither bypass nor crash.
  - **O5** The cache holds at most 1,000 entries and no key over 512 bytes; 10,000 distinct
    policied-subtree paths leave the process's selector cache at that bound.
  - **O6** A public file never stands in for a page that has a policy unless a file with that exact
    path exists in the client build root (the operator's own build output).
  - **O7** The body a policy reads is the body the action receives.
- **Accepted residual:** a request that can reach a policied route with a parameterised path pays
  one full `matchRoutes` (~1.2 ms at 502 routes, §3.10), never two; the prefilter confines it to
  requests that can reach a policy (with a policy on a top-level layout, that is every request).
- **Re-audit 3 (2026-11-17, b60f0a748):** A1, A3, the kernel tracking fix and A2's root half hold;
  A4 (a layout wrapping most routes still ranked the tree twice) is fixed by §3.10 step 3's
  half-tree threshold.
- **Re-audit (2026-11-17, c24ccdced):** F0/F1/F3 closed; A1 (route-pattern matching), A2 (double
  ranking with a root policy) and A3 (dev rebuild dropping a policied id) are fixed by §3.10 steps
  2, 3 and 5.

## 8. Risks & mitigations

- **React Router changes its URL normalization or manifest rule in a later version** → a policy is
  silently skipped on the new shape. Mitigation: the conformance test runs against the installed
  `react-router` on every CI run and fails on any difference; the README states the supported
  `react-router` range is the plugin's peer range (`^8`).
- **Over-application:** a POST to a layout's path with no `?index` also selects the index child's
  policy (React Router runs that child's middleware too, §1 probe). This matches React Router and
  errs closed; documented in the README.
- **Per-request cost:** §3.10 — the method exit, root shortcut and prefilter, with a byte-bounded
  cache for the full match; nothing is installed when no policy is configured. A request that does
  reach a policied route with a parameterised path still pays one full match (~1.3 ms at 502
  routes); a later React Router export of its ranked matcher would remove it.
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
