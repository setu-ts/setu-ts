# Milestone 22 — Kernel Routing on Hono (`@hono-enterprise/kernel`)

> **Status:** Planning. Branch: `feat/22-kernel-hono-routing`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

This milestone replaces the kernel's hand-rolled route matcher with **Hono** as the internal routing
engine, behind the existing `@hono-enterprise/common` contracts, so the framework is genuinely built
on Hono as ARCHITECTURE.md §1 "Why It Uses Hono" has always claimed. Today the kernel uses a
from-scratch matcher (`packages/kernel/src/router/route-matcher.ts`) and imports no Hono at all. M22
makes that section true: a `new Hono()` instance is built internally, every `IRouterApi` route is
registered on it, and matching is delegated to Hono — while the custom `(ctx, next)` middleware
pipeline is **kept and run inside the Hono dispatch**, so priority ordering and short-circuit
semantics are identical and no plugin middleware changes. This is the highest-priority foundational
work: it lands before all remaining plugins (telemetry onward) so every later milestone targets the
Hono-based kernel.

- **In scope:**
  - `packages/kernel` — delegate route matching to `jsr:@hono/hono`; build a `new Hono()` internally
    and register each `IRouterApi` route on it, preserving static-over-param precedence and `:param`
    extraction; map Hono's matched result back to the `{ definition, params }` shape the pipeline
    terminal expects; back `inject()` while preserving the `InjectRequest`/`InjectResponse` shape;
    preserve `IResponse.snapshot()` fidelity.
  - `packages/kernel/deno.json` — add `jsr:@hono/hono` to `imports`.
  - Keep the custom middleware pipeline (`MiddlewarePipeline` + `executeChain`) UNCHANGED and run it
    inside the Hono dispatch — middleware is NOT converted to Hono middleware.
  - Preserve every `common` contract exactly: `IRequestContext`, `IResponse` (incl. `snapshot()`),
    `IRouterApi`, `MiddlewareFunction`/`IMiddleware`, `InjectRequest`/`InjectResponse`. No `common`
    change, no new capability token, no public-API change.
  - `ARCHITECTURE.md` §1 "Why It Uses Hono" corrected to describe the real (now-true) design.
  - `PUBLIC_API.md` kernel section updated to note Hono is the routing engine (no surface change).
  - `ROADMAP.md` progress-tracking row flip to `✅` and CLAUDE.md "Current status" update.
  - Re-verify all ~20 plugin suites stay green against the Hono kernel (no plugin code changes).
- **NOT this milestone:**
  - Runtime serve on Hono + Cloudflare Workers — owned by **M23** (replaces the M41 socket adapters
    with Hono's serve layer; changes `IHttpAdapter` to a web-`fetch` entry). M22 keeps the existing
    `IHttpAdapter` (`createServer((IRequest) => IResponse)`) and the M41 socket adapters untouched.
  - Converting framework middleware to Hono middleware — explicitly out of scope (the custom
    pipeline is preserved; see §3.2).
  - Exposing Hono directly to application developers — ARCHITECTURE.md §1 already states the
    framework wraps Hono; M22 keeps Hono internal to the kernel.
  - New routing features (wildcards, regex routes, sub-applications) — only parity with the existing
    matcher is in scope; Hono features beyond `:param` extraction and static-over-param precedence
    are not surfaced.

## 1. Contracts verified from SOURCE (not names)

| Reference                                       | Source (file:line)                                                                                         | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IRouterApi`                                    | `packages/common/src/plugin.ts:74`                                                                         | `get/post/put/patch/delete/head/options(path, route)`, `group(prefix, configure)`, `listRoutes(): readonly RouteInfo[]`. The kernel `Router` implements this; M22 keeps the interface and every method signature unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `RouteDefinition`                               | `packages/common/src/http.ts:267`                                                                          | `{ handler: RouteHandler, middleware?: readonly MiddlewareFunction[], schema?: RouteSchema }`. The pipeline terminal needs `definition` + `params`; M22 maps Hono's match to this shape.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `RouteHandler`                                  | `packages/common/src/http.ts:235`                                                                          | `(ctx: IRequestContext) => HandlerResult \| Promise<HandlerResult>`. Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `IRequestContext`                               | `packages/common/src/http.ts:162`                                                                          | `id`, `request`, `response`, `services`, `params` (readonly), `query`, `state`, `startTime`. The kernel's `createRequestContext` builds this; M22 keeps it and still installs matched `params` via `RequestContextHandle.setParams`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `IResponse`                                     | `packages/common/src/http.ts:83`                                                                           | `status`, `header`, `appendHeader`, `json`, `text`, `send`, `redirect`, `snapshot()`. `snapshot()` returns `{ status, headers, body }` — used by cache + metrics plugins; M22 preserves `ResponseBuilder.snapshot()` exactly.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `MiddlewareFunction`                            | `packages/common/src/http.ts:205`                                                                          | `(ctx, next) => void \| HandlerResult \| Promise<...>`. The custom pipeline stays; M22 does NOT convert these to Hono middleware.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `IRequest`                                      | `packages/common/src/http.ts:32`                                                                           | `method`, `url`, `path`, `headers`, `ip?`, `user?`, `json<T>()`, `text()`, `bytes()`. The kernel builds this from the runtime adapter (and synthesizes it in `inject()`); M22 keeps building it the same way.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `IHttpAdapter`                                  | `packages/common/src/runtime.ts:204`                                                                       | `createServer(handler: (req: IRequest) => Promise<IResponse>)`, `listen`, `close`. UNCHANGED in M22 — the M41 socket adapters keep working; M23 is the milestone that changes this to a `fetch` entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `InjectRequest` / `InjectResponse`              | `packages/kernel/src/application/application.ts:52` / `:68`                                                | `InjectRequest = { method, url, headers?, body? }`; `InjectResponse = { statusCode, headers, body, json<T>() }`. M22 preserves both shapes exactly so all 13 inject-based suites stay green.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Router.match()`                                | `packages/kernel/src/router/router.ts:95`                                                                  | `match(method, path): { definition, params } \| null` — the choke point the application's `#handleRequest` calls (`packages/kernel/src/application/application.ts:446`). M22 re-implements this method's body to delegate to Hono; its return shape is the contract the pipeline terminal depends on.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `Router.getAll()` / `listRoutes()`              | `packages/kernel/src/router/router.ts:129` / `:134`                                                        | Internal `getAll(): readonly RouteEntry[]` (used by the OpenAPI plugin via the public `listRoutes()`). M22 keeps both returning the registered routes in registration order with `method`/`pattern`/`definition`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `Application.#handleRequest`                    | `packages/kernel/src/application/application.ts:407`                                                       | The single request seam: builds the context, runs `onRequest` hooks, executes the pipeline with a terminal that calls `this.#router.match(method, pathname)` and then `executeChain(definition.middleware, ctx, () => definition.handler(ctx))`. M22 keeps this structure; only the `match()` internals change.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `Application.inject()`                          | `packages/kernel/src/application/application.ts:354`                                                       | Synthesizes an `IRequest`, calls `#handleRequest`, reads `response.snapshot()`. M22 keeps this path (the ROADMAP "back `inject()` with Hono's `app.request()` or keep the pipeline path" is resolved in §3.4 to KEEP the pipeline path — no `IRequest`→Hono-`Request` round-trip).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `executeChain`                                  | `packages/kernel/src/pipeline/execute-chain.ts:35`                                                         | The shared next()-chaining executor with double-`next` guard and `ResponseBuilder.ended` defense-in-depth. UNCHANGED — route middleware + handler still run through it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `MiddlewarePipeline`                            | `packages/kernel/src/pipeline/middleware-pipeline.ts`                                                      | Global pipeline; `compile()` + `execute(ctx, terminal)`. UNCHANGED.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `ResponseBuilder`                               | `packages/kernel/src/context/response.ts:16`                                                               | Implements `IResponse`; `snapshot()` at `:73`; `ended` getter at `:82`. UNCHANGED — Hono does not produce the response; `ResponseBuilder` still does, so `snapshot()` fidelity is automatic.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `createRequestContext`                          | `packages/kernel/src/context/request-context.ts:41`                                                        | Builds `IRequestContext` from `IRequest` + registry + runtime; returns `{ ctx, setParams }`. UNCHANGED.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `isPathDecodable`                               | `packages/kernel/src/router/route-matcher.ts:107`                                                          | `isPathDecodable(path): boolean` — used by `#handleRequest` (`application.ts:431`) to reject malformed percent-escapes as 400 BEFORE routing. M22 keeps this guard (Hono's matcher would otherwise surface a malformed path as a 404 or 500); the function stays in `route-matcher.ts`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `parsePattern` / `staticSegmentCount` / `match` | `packages/kernel/src/router/route-matcher.ts:26` / `:122` / `:59`                                          | The from-scratch matcher M22 replaces for the `match()` path. `parsePattern`/`staticSegmentCount` are kept ONLY if needed for `listRoutes()`/`getAll()` introspection shape; `match` is retired (see §3.1).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Hono specifier                                  | `deno.lock` (to be added)                                                                                  | `jsr:@hono/hono` — the JSR-published Hono package. The exact version is resolved by `deno add` during implementation and pinned in `packages/kernel/deno.json` `imports` with `^` (AI_GUIDELINES §12.4). The plan does not hardcode a version string; the implementation pins the resolved version.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| Plugin coupling audit                           | ROADMAP M22 §"Why this is a ~2-package change"; verified against `packages/*/src` + `packages/*/deno.json` | No plugin touches kernel **internals** (`ResponseBuilder`/`route-matcher`/`createRequestContext`) or `IHttpAdapter`. One plugin — `openapi-plugin` — declares a `@hono-enterprise/kernel` dep (`packages/openapi-plugin/deno.json:10`) but consumes only `app.router.listRoutes()` (`openapi-service.ts:113`), which returns `RouteInfo` (a `common` shape); M22 preserves `listRoutes()`/`RouteInfo` unchanged, so it is unaffected. The only other coupling past `json`/`text` is `IResponse.snapshot()` (a `common` contract method) used by cache + metrics — preserving it keeps them unchanged. (The ROADMAP's blanket "0 of ~20 plugins import `@hono-enterprise/kernel`" is imprecise — `openapi-plugin` does — but the substance holds: no plugin reads a kernel internal M22 changes.) |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                       | Resolution (picked side)                                                                                                                                                                                                                             | Doc deliverable (same PR)                                                                                                                                                                               |
| -- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | ARCHITECTURE.md §1 "Why It Uses Hono" (`ARCHITECTURE.md:118`) describes Hono as the routing engine and says "Hono Enterprise does not expose Hono directly… it wraps Hono in a runtime adapter" — but the kernel today uses a from-scratch matcher and imports no Hono. The section is aspirational, not true. | Make it true: M22 delegates matching to `jsr:@hono/hono` inside the kernel. The "wraps Hono in a runtime adapter" phrasing is corrected to "wraps Hono in the kernel router; the runtime adapter (M41 today, M23 next) handles only socket serving." | `ARCHITECTURE.md` §1 "Why It Uses Hono" rewritten to describe the real design (Hono is the internal router; the custom middleware pipeline runs inside the Hono dispatch; runtime serving is separate). |
| C2 | ROADMAP M22 task 3 says "Back `inject()` with Hono's `app.request()` (or keep the pipeline path)" — an undecided alternative.                                                                                                                                                                                  | Pick the pipeline path: `inject()` keeps calling `#handleRequest` (which runs the custom pipeline + the Hono-backed `match()`). Rationale in §3.4. The "or" alternative is removed.                                                                  | `ROADMAP.md` M22 task 3 updated to state the chosen path (no "or").                                                                                                                                     |
| C3 | PUBLIC_API.md kernel section (`PUBLIC_API.md:3648`) says "Implemented in Milestone 2" and does not mention Hono.                                                                                                                                                                                               | Add a note that M22 delegated routing to Hono behind the unchanged contracts (no public-surface change).                                                                                                                                             | `PUBLIC_API.md` kernel section: add a one-line note that routing is delegated to Hono as of M22, contracts unchanged.                                                                                   |

## 3. Design decisions

### 3.1 Hono as the internal matcher (replacing `Router.match` internals)

- **Decision:** The kernel `Router` (`packages/kernel/src/router/router.ts`) keeps its public
  surface (`get/post/.../group/listRoutes` and the internal `getAll`/`match`) but, on each
  `#register`, also registers the route on an internal `Hono` instance
  (`new Hono({ strict: false })` — see §3.9 — constructed once per `Router`). `match(method, path)`
  delegates to Hono: it calls the Hono app's router to find the registered route+params for the
  method+path, then returns the corresponding `{ definition, params }` (looked up from a
  `Map<HonoRouteId, RouteEntry>` the kernel maintains), or `null` when Hono reports no match. The
  from-scratch `match`/`parsePattern`/`staticSegmentCount` logic in `route-matcher.ts` is retired
  for the matching path; `isPathDecodable` is kept (§1). `RouteEntry` keeps its shape so
  `getAll()`/`listRoutes()` introspection is unchanged.
- **Why:** ROADMAP M22 task 1+2 mandates delegating matching to Hono while preserving
  static-over-param precedence and `:param` extraction. Hono's `RegExpRouter`/`SmartRouter` already
  implement both. Keeping the kernel's `RouteEntry` map and returning `{ definition, params }` from
  `match()` means the application's `#handleRequest` terminal is unchanged — only the matcher's
  internals move. This is the minimal blast-radius change: one file's internals (`router.ts`) plus
  the `deno.json` import.
- **Test home:** `packages/kernel/test/unit/router.test.ts` (extended) asserts every existing parity
  case (static-over-param, multi-param, trailing-slash, method-not-found, group prefix composition,
  tie-break by registration order) still passes against the Hono-backed `match()`. A new
  `test/unit/hono-router-bridge.test.ts` asserts the `Router`→Hono→`{definition, params}` mapping
  directly (register a route, call `match`, assert the returned `definition` is the same object and
  `params` matches Hono's extraction).

### 3.2 Custom middleware pipeline preserved (NOT converted to Hono middleware)

- **Decision:** The `(ctx, next)` middleware pipeline (`MiddlewarePipeline` + `executeChain`) is
  kept and run INSIDE the Hono dispatch. Concretely: the kernel does NOT register framework
  middleware as Hono middleware. The Hono app is used purely as a matcher. The application's
  `#handleRequest` continues to build the `IRequestContext`, run `onRequest` hooks, call
  `this.#pipeline.execute(ctx,
  terminal)` where `terminal` calls `this.#router.match(...)` then
  `executeChain(definition.middleware,
  ctx, () => definition.handler(ctx))`. Hono's own middleware
  system is not used for framework middleware.
- **Why:** ROADMAP M22 "De-risking constraint" explicitly requires the custom pipeline be kept and
  run inside the Hono dispatch so priority ordering (metrics outermost at priority 20) and
  short-circuit semantics are identical and no plugin middleware changes. Converting ~20 plugins'
  middleware to Hono middleware would be a cross-cutting rewrite with no behavioral benefit and
  would break the `IMiddleware`/`MiddlewareFunction` contract. The pipeline is the framework's
  documented execution model (ARCHITECTURE.md §10).
- **Test home:** `packages/kernel/test/unit/middleware-pipeline.test.ts` and
  `test/unit/execute-chain.test.ts` stay green unchanged (they don't touch the router). The
  `test/integration/application.test.ts` short-circuit test (a middleware responds without `next()`
  → handler not run, downstream not run) stays green and is re-asserted. A new
  `test/integration/hono-dispatch-parity.test.ts` asserts that a global middleware at priority 20
  still wraps a priority-300 middleware (outermost-first inbound, outermost-last outbound) and that
  a short-circuiting route middleware stops the handler.

### 3.3 `IResponse.snapshot()` fidelity

- **Decision:** `ResponseBuilder` (kernel) remains the sole `IResponse` implementation and the sole
  producer of the response body. Hono does not produce the response — the framework handler calls
  `ctx.response.json(...)` etc. on the `ResponseBuilder` exactly as today. `snapshot()` therefore
  returns the same `{ status, headers, body }` it always has; no adapter translation is needed.
- **Why:** ROADMAP M22 task 4 requires `IResponse.snapshot()` fidelity so cache + metrics plugins
  are unaffected. Because Hono is used only as a matcher (§3.1) and the custom pipeline +
  `ResponseBuilder` produce the response (§3.2), `snapshot()` is automatically faithful — there is
  no Hono response object to translate from. This is the cleanest resolution: the design avoids the
  fidelity problem rather than solving it.
- **Test home:** `packages/kernel/test/unit/response.test.ts` stays green unchanged. The
  cache-plugin and metrics-plugin suites (which call `snapshot()`) stay green unchanged —
  re-verified in §6. A new assertion in `test/integration/hono-dispatch-parity.test.ts` round-trips
  a request through the Hono-backed kernel and asserts `inject()` returns the exact
  `snapshot()`-derived `{ statusCode, headers, body }`.

### 3.4 `inject()` keeps the pipeline path (not Hono's `app.request()`)

- **Decision:** `Application.inject()` (`application.ts:354`) is unchanged: it synthesizes an
  `IRequest` and calls `#handleRequest`, which runs the custom pipeline + Hono-backed `match()`. It
  does NOT convert the `InjectRequest` to a web-standard `Request` and call Hono's `app.request()`.
- **Why:** ROADMAP M22 task 3 left this as an undecided alternative; this plan picks the pipeline
  path. Rationale: (1) `inject()` and the live server already share `#handleRequest` — routing both
  through it keeps one request path (CLAUDE.md one-implementation rule); (2) converting to a Hono
  `Request` would require an `IRequest`→`Request` adapter AND a `Response`→`InjectResponse` adapter,
  adding two translation layers with no benefit, since the pipeline path already works and preserves
  the `InjectRequest`/`InjectResponse` shapes exactly; (3) the M23 milestone is where the
  web-`fetch` entry lands — M22 does not pre-empt it. Keeping the pipeline path means all 13
  inject-based suites stay green with zero changes.
- **Test home:** All 13 `inject()`-based plugin/kernel suites stay green unchanged (re-verified in
  §6). `test/integration/hono-dispatch-parity.test.ts` asserts `inject()` round-trips a GET and a
  POST with a JSON body through the Hono-backed kernel and returns the expected `InjectResponse`.

### 3.5 Hono route registration and the `:param` syntax

- **Decision:** The kernel registers each route on its internal `Hono` instance using Hono's
  `app.get(path, handler)` / `app.post(...)` / etc. methods, passing the SAME `:param` path string
  the application supplied (Hono uses `:param` syntax natively, matching the framework's
  `IRouterApi` convention). The Hono handler is a thin stub that does NOT execute the framework
  handler — it exists only so Hono's matcher records the route and extracts params. The kernel's
  `match()` reads the matched route id + params from Hono's result and looks up the `RouteEntry` to
  return `{ definition, params }`. Route groups compose prefixes exactly as today (the `GroupRouter`
  resolves the full path before calling `#register`, unchanged).
- **Why:** Hono's path syntax matches the framework's, so no path translation is needed at
  registration. Using a stub handler (not the real framework handler) keeps Hono as a pure matcher —
  the framework handler runs through the custom pipeline + `executeChain` (§3.2), not through Hono's
  dispatch. This preserves the "Hono is the router, the kernel owns the pipeline" boundary.
- **Test home:** `test/unit/hono-router-bridge.test.ts` asserts that registering `/users/:id` on the
  kernel `Router` and calling `match('GET', '/users/123')` returns `params: { id: '123' }` and the
  correct `definition`; multi-param (`/users/:userId/posts/:postId`) extracts both; a static route
  (`/users/me`) is preferred over the param route (`/users/:id`) for `/users/me`.

### 3.6 Static-over-param precedence and tie-breaking

- **Decision:** The kernel relies on Hono's matcher for static-over-param precedence (a static
  segment beats a `:param` segment at the same position). For the registration-order tie-break
  between two equally-specific param routes (e.g. `/a/:x` vs `/a/:y` registered in that order, both
  matching `/a/123`), the kernel preserves its current "earliest registration wins" semantics: if
  Hono's match is ambiguous between two routes of identical specificity, the kernel returns the one
  with the lower `RouteEntry.index`. This is implemented by having `match()` consult the kernel's
  `RouteEntry[]` (kept in registration order) when Hono reports a match, and applying the same
  statics-count + index tie-break the current `match()` uses, using the `statics` field already
  hoisted on `RouteEntry` (`router.ts:26`).
- **Why:** The existing `router.test.ts` "should break ties with earliest registration" case asserts
  `/a/:x` (registered first) wins over `/a/:y` for `/a/123`. Hono's own tie-break may differ; to
  guarantee byte-identical parity (ROADMAP M22 "Route-precedence parity… asserted identical to
  pre-migration behavior"), the kernel applies its own deterministic tie-break on top of Hono's
  match. Keeping the `statics` field on `RouteEntry` (already there) makes this a local comparison,
  not a re-parse.
- **Test home:** `test/unit/router.test.ts` "should break ties with earliest registration" and
  "should prefer route with more static segments" stay green unchanged. A new case in
  `hono-router-bridge.test.ts` asserts the tie-break is deterministic regardless of Hono's internal
  ordering.

### 3.7 `isPathDecodable` 400 guard kept before routing

- **Decision:** `Application.#handleRequest` keeps calling
  `isPathDecodable(handle.ctx.request.path)` (`application.ts:431`) BEFORE routing, returning a 400
  for a malformed percent-escape. The function stays in `route-matcher.ts`. Hono's matcher is
  reached only for decodable paths.
- **Why:** A malformed percent-escape (e.g. `%zz`) would otherwise surface from Hono as a 404 (no
  route matches a path Hono cannot decode) or, depending on Hono's internals, a 500. The kernel's
  documented behavior (PUBLIC_API.md kernel section: "malformed percent-escape in the path → 400")
  must not change. Keeping the guard is a one-line invariant and removes a class of
  Hono-version-dependent behavior.
- **Test home:** `test/integration/application.test.ts` malformed-path 400 case stays green
  unchanged. A new case in `hono-dispatch-parity.test.ts` asserts `%zz` still returns 400 (not 404
  or 500) through the Hono-backed kernel.

### 3.8 Hono dependency: import strategy and version pinning

- **Decision:** Add `jsr:@hono/hono` to `packages/kernel/deno.json` `imports` as
  `"@hono/hono": "jsr:@hono/hono@^<resolved>"` where `<resolved>` is the version `deno add` pins
  during implementation (AI_GUIDELINES §12.4 — caret-pinned, lockfile committed). The kernel imports
  `Hono` from `@hono/hono` via a static `import { Hono } from '@hono/hono'` (NOT a lazy `import()` —
  Hono is the routing engine, always needed, and is a JSR-published first-party-grade dependency,
  not a heavy optional driver; the §12.2 inject-or-lazy rule applies to optional heavy drivers like
  Prisma/Redis, not to the kernel's core router). `common` stays dep-free (no Hono import there).
- **Why:** Hono is a runtime dependency of the kernel, not an optional adapter. A static import is
  correct and matches how the kernel already statically imports `@hono-enterprise/common`. JSR
  resolution keeps it cross-runtime (Node/Deno/Bun) without a build step. Pinning the version in
  `deno.json` + committing `deno.lock` makes the dependency reproducible.
- **Test home:** `deno task check` confirms the import resolves; `deno task audit` confirms no
  high-severity vulnerabilities. The `test/unit/hono-router-bridge.test.ts` exercises the real Hono
  import (no mock) so the dependency is on a real code path, not just a type import.

### 3.9 Trailing-slash parity — Hono constructed with `{ strict: false }`

- **Decision:** The internal Hono instance is constructed as `new Hono({ strict: false })` — NOT the
  bare `new Hono()`. Hono's default is `strict: true`, under which `/users` and `/users/` are
  distinct routes; the kernel's current matcher normalizes trailing slashes so `/users/` matches a
  `/users` route. `strict: false` restores that parity. (Belt-and-suspenders: the guard is Hono's
  own trailing-slash handling; the kernel does not additionally re-normalize the path before handing
  it to Hono, so there is exactly one normalization site.)
- **Why:** This is a REQUIRED parity case, not an edge case. The committed test
  `packages/kernel/test/unit/route-matcher.test.ts:70` asserts
  `match(parsePattern('/users'),
  '/users/')` returns `{}` (a match), and ROADMAP M22
  (`ROADMAP.md:2420`) lists **trailing-slash** explicitly among the route-precedence parity
  requirements ("asserted identical to pre-migration behavior"). Constructing `new Hono()` with
  default `strict: true` would make `/users/` 404 against a `/users` route, breaking both. The
  one-flag fix must be a plan decision (not improvised at implementation), and §4.1's construction
  line is corrected to match.
- **Edge note:** the current matcher collapses _multiple_ trailing slashes (`replace(/\/+$/, '')`);
  Hono `strict: false` normalizes a single trailing slash. No committed test exercises `//`, so this
  is not a parity requirement; if the tie-break/parity suite reveals a `//` case, normalize the path
  before Hono rather than reintroducing the retired `match`. (Called out so it is a decision, not a
  surprise.)
- **Test home:** `test/unit/hono-router-bridge.test.ts` adds a case asserting `/users/` matches a
  `/users` route (and `/users/123/` matches `/users/:id`) through the Hono-backed `match()`; the
  existing `route-matcher.test.ts:70` normalization case stays green for `isPathDecodable`'s file
  even after `match` is retired (kept only if `match` survives for another consumer — see §5).

## 4. Exported surface — every symbol names its consumer

| Exported symbol      | Kind     | Consumer / real code path that READS it                                       |
| -------------------- | -------- | ----------------------------------------------------------------------------- |
| `createApplication`  | function | The application: `createApplication({ plugins })`. Unchanged in M22.          |
| `ApplicationOptions` | type     | Consumers typing `createApplication`. Unchanged.                              |
| `IKernelApplication` | type     | Consumers typing the app (extends `IApplication` with `inject()`). Unchanged. |
| `InjectRequest`      | type     | Consumers calling `app.inject(...)`. Unchanged.                               |
| `InjectResponse`     | type     | Consumers reading `app.inject(...)` results. Unchanged.                       |

> **No new exports.** M22 changes no public surface — it re-implements `Router.match()` internals
> and adds a private Hono instance. The kernel's `src/index.ts` is unchanged. This is a deliberate
> property of the design: the migration is invisible to every consumer and every plugin.

### 4.1 Options — every option names its consumer

| Option | Consumer | Behavior (per implementation)                                                                                                                                                                                                                                                                                                                                    |
| ------ | -------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| (none) | —        | M22 adds no options. `createApplication` and `Router` take no new configuration. The Hono instance is constructed as `new Hono({ strict: false })` for trailing-slash parity (§3.9) — NOT bare `new Hono()`, whose default `strict: true` would break `/users/`↔`/users` matching. No Hono router type selection is exposed (the default `SmartRouter` is used). |

## 5. Implementation files

| File                                                  | Purpose                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/kernel/deno.json`                           | Add `"@hono/hono": "jsr:@hono/hono@^<resolved>"` to `imports`.                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `packages/kernel/src/router/router.ts`                | Construct a `new Hono({ strict: false })` instance per `Router` (§3.9); in `#register`, register the route on the Hono app (stub handler) AND push the `RouteEntry` (kept for `getAll`/`listRoutes`/tie-break). Re-implement `match(method, path)` to delegate to Hono's matcher, map the result to `{ definition, params }` via the `RouteEntry` map, apply the §3.6 tie-break, and return `null` on no match. `GroupRouter` unchanged (it resolves prefixes before `#register`). |
| `packages/kernel/src/router/route-matcher.ts`         | Retire `match`/`parsePattern`/`staticSegmentCount` from the matching path (no longer called by `Router.match`). KEEP `isPathDecodable` (used by `#handleRequest`). If `parsePattern`/`staticSegmentCount` are still needed for the `RouteEntry.statics` field used in §3.6 tie-break, keep them; otherwise drop them and compute `statics` inline. (Final keep/drop decided during implementation against the tie-break test.)                                                     |
| `packages/kernel/src/application/application.ts`      | NO structural change. `#handleRequest` keeps calling `this.#router.match(method, pathname)` and `executeChain(...)`. The only touch is a comment update noting `match()` is now Hono-backed. `inject()` unchanged (§3.4).                                                                                                                                                                                                                                                          |
| `packages/kernel/src/context/request-context.ts`      | Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/kernel/src/context/response.ts`             | Unchanged (`ResponseBuilder` + `snapshot()`).                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/kernel/src/pipeline/middleware-pipeline.ts` | Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/kernel/src/pipeline/execute-chain.ts`       | Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `packages/kernel/src/index.ts`                        | Unchanged (no new exports).                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `ARCHITECTURE.md`                                     | §1 "Why It Uses Hono" rewritten to describe the real design (§2 C1).                                                                                                                                                                                                                                                                                                                                                                                                               |
| `PUBLIC_API.md`                                       | Kernel section: one-line note that routing is delegated to Hono as of M22, contracts unchanged (§2 C3).                                                                                                                                                                                                                                                                                                                                                                            |
| `ROADMAP.md`                                          | M22 task 3 "or" removed (§2 C2); progress-tracking row flipped to `✅` on completion.                                                                                                                                                                                                                                                                                                                                                                                              |
| `CLAUDE.md`                                           | "Current status" — M22 marked complete with its PR number; "Next milestone" pointed at M23.                                                                                                                                                                                                                                                                                                                                                                                        |

**Token grammar:** No new capability tokens. No `common` change. The kernel does not register a
capability for Hono — Hono is an internal implementation detail of the `Router`, not a service.

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                      | src covered                                                                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/kernel/test/unit/router.test.ts` (extended)                          | `src/router/router.ts`                                                       | Every existing case stays green: register+match GET; extract `:id`; null for unmatched; null for wrong method; all 7 verbs; static-over-param (`/users/me` beats `/users/:id`); tie-break by earliest registration (`/a/:x` beats `/a/:y`); groups with prefix; nested groups; bare handler; route definition with middleware; `getAll` introspection; group with root path; nested group with root path; multi-param (`/users/:userId/posts/:postId`); more-static-segments wins; `GroupRouter` every verb; nested groups every verb; group `/` resolves to bare prefix; `getAll` returns every route with method+pattern. New cases: `listRoutes()` returns routes in registration order with composed group paths; a route registered after a group still appears in `getAll`. Calls `router.match('GET', '/users/123')` → `{ definition, params } \| null`. |
| `packages/kernel/test/unit/hono-router-bridge.test.ts` (new)                   | `src/router/router.ts` (Hono bridge)                                         | The `Router` constructs an internal `Hono` and registers each route on it; `match()` returns the SAME `definition` object the caller registered (identity) and `params` extracted by Hono (`/users/:id` → `{ id: '123' }`); multi-param extraction; static-over-param preference is Hono's; no-match returns `null`; the §3.6 tie-break is deterministic when two param routes of equal specificity match (earliest `RouteEntry.index` wins, asserted by registering `/a/:x` then `/a/:y` and matching `/a/123` → `{ x: '123' }`). Exercises the real `@hono/hono` import (no mock).                                                                                                                                                                                                                                                                            |
| `packages/kernel/test/unit/route-matcher.test.ts` (existing, trimmed)          | `src/router/route-matcher.ts`                                                | `isPathDecodable` cases kept (clean path → true; `%zz` → false; truncated `%2` → false; bare `%` → false). If `parsePattern`/`staticSegmentCount` are retired, their cases are removed; if kept for the tie-break, their cases stay.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/kernel/test/unit/middleware-pipeline.test.ts` (existing)             | `src/pipeline/middleware-pipeline.ts`                                        | Unchanged — green as-is (pipeline not touched).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `packages/kernel/test/unit/execute-chain.test.ts` (existing)                   | `src/pipeline/execute-chain.ts`                                              | Unchanged — green as-is. Short-circuit (no `next()` → terminal not run) and double-`next` guard stay asserted.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `packages/kernel/test/unit/response.test.ts` (existing)                        | `src/context/response.ts`                                                    | Unchanged — `snapshot()` fidelity, terminal methods, `ended` getter.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `packages/kernel/test/unit/lifecycle-manager.test.ts` (existing)               | `src/lifecycle/lifecycle-manager.ts`                                         | Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/kernel/test/unit/plugin-resolver.test.ts` (existing)                 | `src/registry/plugin-resolver.ts`                                            | Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/kernel/test/unit/service-registry.test.ts` (existing)                | `src/registry/service-registry.ts`                                           | Unchanged.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/kernel/test/integration/application.test.ts` (existing, re-verified) | `src/application/application.ts` end-to-end                                  | All existing cases stay green: plugin registration + start; `inject()` GET/POST round-trip; 404 for unmatched; 400 for malformed path (`isPathDecodable` guard, §3.7); 500 on handler throw; short-circuit middleware (responds without `next()` → handler not run, response preserved); lifecycle hooks fire. Re-verified, not rewritten.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `packages/kernel/test/integration/hono-dispatch-parity.test.ts` (new)          | `src/application/application.ts` + `src/router/router.ts` + `src/pipeline/*` | One real kernel-app round-trip through the Hono engine: build `createApplication({ plugins: [RuntimePlugin()] })`, register a GET and a POST with a JSON body + route middleware, `inject()` both and assert the `InjectResponse` (`statusCode`, `headers`, `body`, `json<T>()`) matches a non-Hono baseline; assert a global middleware at priority 20 wraps a priority-300 middleware (inbound order + outbound order); assert a short-circuiting route middleware stops the handler; assert `%zz` path → 400 (not 404/500); assert `snapshot()`-derived `InjectResponse` is exact.                                                                                                                                                                                                                                                                           |
| `packages/kernel/test/fixtures/fake-runtime.ts` (existing)                     | (fixture)                                                                    | Unchanged — used by integration tests.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Plugin suites (re-verified, NOT modified)                                      | all ~20 plugin `test/` trees                                                 | Every plugin's existing suite stays green unchanged against the Hono-backed kernel. Specifically the `snapshot()` consumers — `packages/cache-plugin/test/unit/cache-middleware.test.ts` and `packages/metrics-plugin/test/unit/*` — and the `inject()`-based suites across cache/config/validation/cqrs/events/di/auth/http-security/scheduler/metrics/health/openapi. A re-verification pass runs `deno task test` and confirms zero failures; no plugin code changes.                                                                                                                                                                                                                                                                                                                                                                                        |

Per-file 90% bar: every file under `packages/kernel/src/` must reach ≥90% on branch, function, AND
line (read ANSI-stripped per-file table from `deno task test:coverage`). The touched files are
`router.ts` and `route-matcher.ts`; the rest are unchanged and already at bar. The new test files
cover the new Hono-bridge branches in `router.ts` (registration on Hono, match delegation,
tie-break, no-match). `application.ts` has no new branches (only a comment), so its coverage is
unchanged.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/22-kernel-hono-routing, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
deno task audit             # jsr:@hono/hono must introduce zero high-severity vulnerabilities
```

## 8. Risks & mitigations

- **Hono route-precedence parity is the core risk.** Hono's `SmartRouter`/`RegExpRouter` may order
  ambiguous matches differently from the kernel's statics-count + registration-index tie-break.
  Mitigation: §3.6 applies the kernel's own deterministic tie-break on top of Hono's match, using
  the already-hoisted `RouteEntry.statics` + `index`, so the existing `router.test.ts` precedence
  cases stay green. ROADMAP's recommended 1–2 day router-on-Hono spike (before implementation)
  de-risks this further by converting the precedence unknowns into facts.
- **The tie-break depends on Hono surfacing ALL candidate matches, not just its own best.** §3.6
  re-sorts Hono's matches by the kernel's `statics`+`index`; this only works if Hono's router
  returns every overlapping route (with params) for a path, not a single pre-selected winner. Hono's
  router `match()` returns `[[handler, params], …]` for all matched handlers, so the
  stub-handler-carries- `index` approach (§3.5) can recover each `RouteEntry`. Mitigation: this is
  the single assumption that makes M22 real rather than a no-op (if the kernel instead re-ran its
  own `matchPath`, Hono would be dead surface — forbidden by the "every symbol read on a real path"
  rule). The recommended spike MUST confirm `SmartRouter`/`RegExpRouter` returns overlapping
  candidates as expected before implementation commits to it; if Hono returns only one match, the
  tie-break moves to registering routes such that Hono's own precedence already equals the kernel's,
  and the spike records that.
- **Trailing-slash parity is Hono-config-dependent.** `new Hono()` defaults to `strict: true`, which
  breaks `/users/`↔`/users`. Mitigation: §3.9 pins `new Hono({ strict: false })` and adds a parity
  test; a Hono major that changes the `strict` semantics is caught by the caret pin + that test.
- **Hono's matcher may throw or 404 on a malformed path.** A malformed percent-escape (`%zz`) could
  surface from Hono as a 404 or 500 instead of the kernel's documented 400. Mitigation: §3.7 keeps
  `isPathDecodable` as a pre-routing 400 guard, so Hono is never reached for a malformed path.
- **Hono version coupling.** A future Hono minor release could change the matcher's API or
  precedence. Mitigation: pin `jsr:@hono/hono@^<resolved>` in `deno.json` and commit `deno.lock`;
  the §3.6 tie-break is the kernel's own logic, not Hono's, so a Hono precedence change is
  contained. `deno task audit` gates high-severity vulnerabilities.
- **`inject()` parity across 13 suites.** Any drift in the `InjectRequest`→`IRequest` synthesis or
  the `snapshot()`→`InjectResponse` mapping would break plugin suites. Mitigation: §3.4 keeps the
  pipeline path unchanged; `inject()` and `#handleRequest` are not restructured. The 13 suites are
  re-verified green with no changes.
- **Plugin re-verification surface.** ~20 plugin suites must stay green; a subtle pipeline or
  context change could regress one. Mitigation: §3.2 keeps the pipeline and context unchanged; the
  only behavioral change is inside `Router.match()`. The re-verification pass in §6 runs the full
  `deno task test` and treats any plugin failure as a blocker.
- **Hono import on the kernel's dependency graph.** Adding a runtime dep to the kernel is a
  dependency-graph change (AI_GUIDELINES §16.2 — architecture change requires approval). Mitigation:
  this plan IS the approval artifact; the dependency is justified (Hono is the routing engine the
  framework has always claimed to use), JSR-published, cross-runtime, and not a heavy optional
  driver. `common` stays dep-free; no plugin gains a Hono dependency.

## 9. Out of scope

- **Runtime serve on Hono + Cloudflare Workers** — owned by **M23** (changes `IHttpAdapter` to a
  web-`fetch` entry; replaces the M41 socket adapters with Hono serve; adds the CF Workers adapter).
  M22 keeps `IHttpAdapter` and the M41 adapters untouched.
- **Converting framework middleware to Hono middleware** — explicitly out of scope (§3.2); the
  custom `(ctx, next)` pipeline is preserved.
- **Exposing Hono directly to application developers** — ARCHITECTURE.md §1 already says the
  framework wraps Hono; M22 keeps Hono internal to the kernel `Router`.
- **New routing features (wildcards, regex routes, Hono sub-applications, `app.route()`)** — only
  parity with the existing `:param` matcher is in scope; Hono features beyond `:param` extraction
  and static-over-param precedence are not surfaced in M22.
- **Changing `IHttpAdapter` or the runtime adapters** — M23's scope.
- **A `common` contract change** — none; M22 preserves every `common` interface exactly.
