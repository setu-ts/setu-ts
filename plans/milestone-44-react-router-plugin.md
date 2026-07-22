# Milestone 44 — React Router Plugin (`@hono-enterprise/react-router-plugin`)

> **Status:** Planning. Branch: `feat/44-react-router-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Embed **React Router v7 framework mode** (the Remix successor) as a first-party plugin so a Hono
Enterprise application can serve a React frontend with SSR and file-based routing. React Router's
framework mode is bring-your-own-server: its server contract is the web-standard
`createRequestHandler(build, mode)` → `(request: Request, loadContext) => Promise<Response>`, which
maps cleanly onto a **kernel catch-all route**. The plugin owns exactly three things — (1) mounting
React Router's request handler behind a catch-all, (2) bridging kernel DI into React Router loaders
and actions via `loadContext`, and (3) serving the built client assets. React Router itself owns
SSR, file-based routing, loaders/actions, client hydration, and code splitting via its Vite build —
the plugin reimplements none of that. The SSR write-back streams through the Milestone 42
`IResponse.stream()` primitive so Suspense / deferred data flushes progressively.

- **In scope:**
  - New `CAPABILITIES.SSR = 'ssr'` token + `ISsrService` contract in `@hono-enterprise/common`
    (PUBLIC_API.md updated in the same PR).
  - `ReactRouterPlugin` with an **async `register()`** that lazily imports the app-provided RR
    server build and the core `react-router` package, then mounts a catch-all route that delegates
    to RR.
  - `IRequestContext` ↔ web `Request` / `Response` bridge with streaming write-back and abort
    wiring.
  - `loadContext` DI bridge (default exposes `ctx.services` + `ctx.request.user`; app-overridable).
  - Static asset serving for the built client bundle over `runtime.fs?.readFile` + content-type.
  - Inject-or-lazy seam for the RR handler so the bridge / load-context / assets are unit-tested at
    90%+ WITHOUT the real dep, plus one guarded REAL `await import()` test.

- **NOT this milestone:**
  - Vite / HMR dev integration — the consuming app runs `react-router dev` as a separate process and
    feeds this plugin the production build (`build/server`, `build/client`). A build tool is an
    app-level, build-time concern (AI_GUIDELINES §12.2), never imported by the plugin.
  - Browser-side OpenTelemetry / hydration tracing — needs a separate browser OTel setup.
  - Multi-backend trace fan-out — owned by M24c (OTel Collector) / deploy config.
  - File-based route discovery — React Router owns this entirely; the plugin never scans routes.
  - Extracting static-asset serving into a shared static middleware — flagged future (this is the
    only static handler in the tree); see §9.

## 1. Contracts verified from SOURCE (not names)

| Reference                          | Source (file:line)                                                              | Verified surface / fact                                                                                                                                                                                                                                                                                                                                             |
| ---------------------------------- | ------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IResponse.stream`                 | `packages/common/src/http.ts:169`                                               | `stream(body: ReadableStream<Uint8Array>): HandlerResult` — streaming write-back (M42).                                                                                                                                                                                                                                                                             |
| `IResponse.snapshot`               | `packages/common/src/http.ts:184`                                               | Discriminated union keyed on `streaming` (`false`→buffered `Uint8Array\|string\|null`; `true`→live `ReadableStream<Uint8Array>`).                                                                                                                                                                                                                                   |
| `IResponse` config setters         | `packages/common/src/http.ts:101,109,121`                                       | `status(code)` chains; `header(name,value)` **replaces**; `appendHeader(name,value)` **adds** (multi-value e.g. `Set-Cookie`). Both chain `this`.                                                                                                                                                                                                                   |
| `IRequest`                         | `packages/common/src/http.ts:32-79`                                             | `method`, `url`, `path`, web `headers` (`Headers`), `user?` (writable `IPrincipal`), `signal?: AbortSignal`, `json<T>()`, `text()`, `bytes(): Promise<Uint8Array>`.                                                                                                                                                                                                 |
| `IRequestContext`                  | `packages/common/src/http.ts:193-222`                                           | `request`, `response`, `services`, `state`, and `signal: AbortSignal` (REQUIRED, always live — M42).                                                                                                                                                                                                                                                                |
| `HandlerResult`                    | `packages/common/src/http.ts:22`                                                | Opaque brand only the kernel creates; handlers obtain it from `IResponse` terminal methods (`json`/`text`/`send`/`redirect`/`stream`) and return it.                                                                                                                                                                                                                |
| `RouteHandler` / `RouteDefinition` | `packages/common/src/http.ts:278,310`                                           | `(ctx: IRequestContext) => HandlerResult \| Promise<HandlerResult>`; object form `{ handler, middleware?, schema? }`.                                                                                                                                                                                                                                               |
| `IRouterApi`                       | `packages/common/src/plugin.ts:74-141`                                          | Per-verb `get/post/put/patch/delete/head/options` + `group` + `listRoutes`. **There is NO `all()` method** — a catch-all is registered per-verb.                                                                                                                                                                                                                    |
| Router wildcard match              | `packages/kernel/src/router/router.ts:40-41,90,148-161`                         | Matching is delegated to Hono's `LinearRouter` (`Hono.on(method, path, …)`); `*` wildcards ARE supported; `match()` returns `null` when nothing matches.                                                                                                                                                                                                            |
| Router tie-break                   | `packages/kernel/src/router/router.ts:208-220`                                  | More static segments win, then earliest registration order.                                                                                                                                                                                                                                                                                                         |
| `parsePattern` (wildcard counting) | `packages/kernel/src/router/route-matcher.ts:46-51,61-69`                       | A `*` segment has no `:` prefix → classified as **static**. So `/assets/*` = 2 statics, `/*` = 1 static; an asset route therefore beats the catch-all.                                                                                                                                                                                                              |
| `IPlugin.register`                 | `packages/common/src/plugin.ts:498`                                             | `register(ctx): void \| Promise<void>` — an **async** register is legal; the kernel awaits it.                                                                                                                                                                                                                                                                      |
| Single-provider registry           | `packages/sse-plugin/src/plugin/sse-plugin.ts:26-27,52` + `service-registry.ts` | `ctx.services.register(token, svc)` with one provider; a duplicate capability throws at startup (precedent: `SsePlugin`).                                                                                                                                                                                                                                           |
| `PLUGIN_PRIORITY`                  | `packages/common/src/index.ts:17`, used `sse-plugin.ts:44`                      | Priority const imported from `@hono-enterprise/common`.                                                                                                                                                                                                                                                                                                             |
| `IRuntimeServices.fs`              | `packages/common/src/runtime.ts:195`                                            | `fs?: IFileSystem` — **optional** (absent on edge). There is **no** `runtime.readFile`.                                                                                                                                                                                                                                                                             |
| `IFileSystem.readFile`             | `packages/common/src/runtime.ts:56`                                             | `readFile(path): Promise<Uint8Array>` — the actual static-asset read surface (reached as `runtime.fs?.readFile`).                                                                                                                                                                                                                                                   |
| `CAPABILITIES` token grammar       | `packages/common/src/tokens.ts:141-151`                                         | `createCapabilityToken` regex `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*(\.…)*$`; `'ssr'` is valid (precedent `SSE: 'sse'` at `tokens.ts:101`). New `SSR: 'ssr'` is added alongside it.                                                                                                                                                                                        |
| Sibling service template           | `packages/common/src/services/sse.ts:126-148`                                   | `ISseService` is the structural model for `ISsrService`: a contract module under `common/src/services/` exported from `common/src/index.ts`.                                                                                                                                                                                                                        |
| React Router v7 core export        | api.reactrouter.com/v7 `createRequestHandler`                                   | Core `react-router` package exports `createRequestHandler(build: ServerBuild, mode?: string): RequestHandler` where `RequestHandler = (request: Request, loadContext: unknown) => Promise<Response>`. Latest v7 = **7.18.1**. The adapter packages (`@react-router/node` etc.) take an options object; the **core** signature `(build, mode)` is the one used here. |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                  | Resolution (picked side)                                                                                                                              | Doc deliverable (same PR)                                                                                                                                                                                                                |
| -- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP M44 says asset serving is "built on `IRuntimeServices.readFile`", but the committed source surface is `runtime.fs?.readFile` (`runtime.ts:195,56`); there is no `runtime.readFile`.                                                                                                                                                               | Plan implements `runtime.fs?.readFile` and treats `fs` as **optional** (no-op 404 on edge).                                                           | PUBLIC_API.md `@hono-enterprise/react-router-plugin` section documents the real surface (`runtime.fs?.readFile`) + the edge caveat. No ROADMAP text edit (its M44 doc deliverables are already shipped on `docs/roadmap-streaming-ssr`). |
| C2 | ROADMAP M44 lists "`react-router` / `@react-router/node`" as lazy imports, but `@react-router/node`'s only runtime role is `installGlobals()` (polyfill fetch on old Node) — unnecessary because this framework already runs web-standard `Request`/`Response` everywhere; importing it would bind the embed to Node, contradicting runtime independence. | Plan imports **only** the core `react-router` package (`createRequestHandler`) and the app build. `@react-router/node` is NOT imported by the plugin. | PUBLIC_API.md `@hono-enterprise/react-router-plugin` section states core-`react-router`-only and why `@react-router/node` is excluded.                                                                                                   |

## 3. Design decisions

### 3.1 Catch-all mounting — register all 7 verbs at `basename + '/*'`

- **Decision:** `register()` registers the SSR handler (resolving `ISsrService` under
  `CAPABILITIES.SSR`) as the route handler for **all seven HTTP verbs** at `${basename}/*`
  (`basename` defaults to `/`, so `/*`). React Router internally returns 404/405 for unmatched
  routes/methods, so owning the full frontend namespace is correct and matches a true catch-all.
- **Why:** React Router framework-mode loaders run on `GET`/`HEAD` and actions run on
  `POST`/`PUT`/`PATCH`/`DELETE` (resource routes); restricting verbs would silently break actions.
  Precedence is correct for free: app API routes (e.g. `/api/users` = 2 statics) beat the catch-all
  (`/*` = 1 static — `*` is counted static, `route-matcher.ts:46-51`) via the kernel tie-break
  (`router.ts:208-220`), and the asset route (`/assets/*`, 2 statics) beats it the same way. The
  `OPTIONS` catch-all is only reached for **non-preflight** OPTIONS because CORS preflight is
  handled by the `http-security-plugin` middleware (short-circuits before routing).
- **Test home:** `react-router-plugin.test.ts` asserts all 7 verbs are registered at the catch-all
  via `ctx.router.listRoutes()`; `react-router-integration.test.ts` asserts a `/api/health` route
  registered by the app is NOT shadowed by the catch-all.

### 3.2 Lazy build import — async `register()` with an injectable `loadRequestHandler` seam

- **Decision:** `register()` is `async`. The RR handler is obtained from an injectable
  `options.loadRequestHandler(serverBuildPath, mode)`; the **default** implementation lives in
  `src/handler/server-build.ts` and does the real `await import(options.serverBuildPath)` (the RR
  `ServerBuild`, default export) + `await import('react-router')` (`createRequestHandler`), then
  returns `(request, loadContext) => Promise<Response>`. Tests inject a recording fake, so the
  bridge / load-context / asset logic hits 90%+ without the real dep. This mirrors the codebase
  inject-or- lazy pattern (AI_GUIDELINES §12.2). If a real `import()` cannot resolve, the seam
  throws a clear error naming the missing specifier.
- **Why:** React Router and the server build must never be hard dependencies of a JSR package. The
  injectable seam is also the "extract decidable logic" escape the project's coverage rules require.
- **Test home:** `server-build.test.ts` unit-tests the pure
  `assembleHandler(build, createRequestHandler, mode)` branch; `server-build-real-import.test.ts`
  (guarded) exercises the real `await import('npm:react-router')`
  - the default `loadRequestHandler`, skipped when the package is absent.

### 3.3 React Router handler — core `createRequestHandler(build, mode)` only

- **Decision:** Use the **core** `react-router` package's `createRequestHandler(build, mode)` (web-
  standard). Do NOT import `@react-router/node`. This is the runtime-independence-correct choice and
  resolves conflict C2.
- **Why:** The framework already supplies web-standard `Request`/`Response` and the HTTP listener;
  `@react-router/node`'s `installGlobals()` is redundant on Deno/Hono/Bun/CF Workers and would
  couple the embed to Node.
- **Test home:** `server-build-real-import.test.ts` asserts the core export shape; the
  `@react-router/node` exclusion is documented in PUBLIC_API.md (C2).

### 3.4 Request bridge — buffered body in, streaming-or-buffered body out, abort wired

- **Decision:** `request-bridge.ts` builds a web `Request` from `ctx.request` (`method`, `url`, the
  web `headers`, body buffered via `ctx.request.bytes()`), passes it (with the constructed request's
  own `signal` derived from `ctx.signal`) and the `loadContext` to the RR handler, then maps the
  returned web `Response` back onto `ctx.response`: `status()` from `response.status`; each header
  copied with `header()` except multi-value headers (`getSetCookie()` / multiple values) which use
  `appendHeader()`; body is `ctx.response.stream(response.body)` when `response.body` is a
  `ReadableStream<Uint8Array>`, else buffered via `response.arrayBuffer()` →
  `ctx.response.send(bytes)`. It returns the `HandlerResult` for the route handler.
- **Why:** This is the one place kernel types meet web types; centralizing it keeps the route
  handler one line and makes the streaming/buffered + multi-header branches unit-testable.
  `ctx.signal` propagation lets RR abort long loaders on client disconnect.
- **Test home:** `request-bridge.test.ts` drives an injected fake handler returning (a) a buffered
  HTML `Response` and (b) a streaming `Response`, asserting the `snapshot()` `streaming` flag,
  status, headers, and `Set-Cookie` via `appendHeader`.

### 3.5 `loadContext` bridge — default exposes `services` + `user`

- **Decision:** `load-context.ts` exports a default `createLoadContext(ctx)` returning
  `{ services: ctx.services, user: ctx.request.user }` — but `user` is **omitted** (not assigned
  `undefined`) when absent, honoring `exactOptionalPropertyTypes`. `options.getLoadContext`
  overrides the default wholesale.
- **Why:** This is the integration's core value (kernel DI reachable inside RR loaders/actions); the
  default matches the ROADMAP example and is the minimal useful bridge.
- **Test home:** `load-context.test.ts` asserts the default carries `services` + `user` (present and
  absent cases) and that a custom `getLoadContext` is honored.

### 3.6 Static assets — served over `runtime.fs?.readFile`, immutable, separate route

- **Decision:** `static-assets.ts` exports
  `createStaticAssetHandler({ fs, assetsDir, assetUrlPrefix })` returning a `RouteHandler`
  registered at `${assetUrlPrefix}/*` (`assetUrlPrefix` default `/assets/`). The handler maps the
  request path to `assetsDir + decodedPath`, reads it via the injected `IFileSystem.readFile`, sets
  `Content-Type` from a small internal `CONTENT_TYPES` map (`.js`/`.mjs` → `text/javascript`, `.css`
  → `text/css`, `.html` → `text/html`, `.json` → `application/json`, `.svg` → `image/svg+xml`,
  `.woff2` → `font/woff2`, image extensions → `image/*`, default `application/octet-stream`) plus
  `Cache-Control: public, max-age=31536000, immutable` (a constant), and returns the bytes via
  `ctx.response.send`. It returns a `404` (via `ctx.response`) when the file is missing **or** when
  `runtime.fs` is absent. Asset serving is wired by the plugin, NOT a method on `ISsrService`, to
  keep the service surface minimal.
- **Why:** `fs` is optional (`runtime.ts:195`) — edge platforms have no filesystem; the handler must
  degrade to 404 there (RR on edge typically uses a CDN/assets binding, out of scope). The
  `${assetUrlPrefix}/*` route's 2 static segments beat the catch-all's 1 (§3.1).
- **Test home:** `static-assets.test.ts` asserts content-type per extension, the immutable
  `Cache-Control`, 200 + body, the missing-file 404 (fake `readFile` that rejects), and the
  absent-fs 404 (runtime whose `fs` is `undefined`).

### 3.7 Telemetry — no new instrumentation; request span comes free from M24

- **Decision:** M44 ships **no** telemetry code. Because the catch-all is a normal kernel route, the
  existing telemetry request-span middleware (priority 30) already wraps every SSR request and emits
  one server span with W3C `traceparent` — nothing is added. M44 explicitly does NOT nest loader/
  action spans under the request span (there is no OTel `ContextManager`, so such spans would be
  roots); that is a deliberate non-feature, not an oversight.
- **Why:** Owns the gap the ROADMAP flags instead of silently assuming nested tracing works.
- **Test home:** Documented non-behavior; `react-router-integration.test.ts` confirms the request
  still flows through the pipeline (the middleware wraps it) end-to-end.

## 4. Exported surface — every symbol names its consumer

| Exported symbol               | Kind                             | Consumer / real code path that READS it                                                                                        |
| ----------------------------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `ReactRouterPlugin`           | factory fn                       | App entry: `app.register(ReactRouterPlugin({...}))`.                                                                           |
| `SsrService`                  | class (implements `ISsrService`) | Constructed in `react-router-plugin.ts`; resolved via `CAPABILITIES.SSR`; exported for test/override parity with `SseService`. |
| `ReactRouterPluginOptions`    | type                             | Type of the `options` arg to `ReactRouterPlugin`; consumed by every option below.                                              |
| `LoadContextFunction`         | type                             | Type of `options.getLoadContext`; consumed by `request-bridge.ts` / `load-context.ts`.                                         |
| `SsrRequestHandler`           | type                             | Type of the RR handler `(request, loadContext) => Promise<Response>`; consumed by `options.loadRequestHandler` and the bridge. |
| `createStaticAssetHandler`    | factory fn                       | Called by `react-router-plugin.ts` to build the asset `RouteHandler` wired onto the router.                                    |
| `ISsrService`, `CAPABILITIES` | re-export from common            | Apps resolve `ctx.services.get<ISsrService>(CAPABILITIES.SSR)`; the catch-all route handler reads `ISsrService.render`.        |

### 4.1 Options — every option names its consumer

| Option                                                                       | Consumer                                  | Behavior (per implementation)                                                                                                         |
| ---------------------------------------------------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| `serverBuildPath: string` (required)                                         | default `loadRequestHandler`              | Lazy `await import()` target for the RR `ServerBuild` (default export).                                                               |
| `loadRequestHandler?: (serverBuildPath, mode) => Promise<SsrRequestHandler>` | `register()`                              | Injectable lazy-import seam; default = real importer in `server-build.ts`. When provided, `register()` still awaits it (stays async). |
| `assetsDir?: string`                                                         | `createStaticAssetHandler`                | Filesystem root of the built client bundle; when omitted, asset serving is disabled (no asset route registered).                      |
| `assetUrlPrefix?: string` (default `/assets/`)                               | `register()` + `createStaticAssetHandler` | URL prefix the asset route mounts at; maps `${prefix}/*` → `assetsDir + path`.                                                        |
| `basename?: string` (default `/`)                                            | `register()`                              | Mount prefix for the SSR catch-all (`${basename}/*`).                                                                                 |
| `getLoadContext?: LoadContextFunction`                                       | `request-bridge.ts`                       | Builds the RR `loadContext` from `ctx`; default exposes `services` + `user`.                                                          |
| `mode?: 'production' \| 'development'` (default `production`)                | default `loadRequestHandler`              | Passed to `createRequestHandler(build, mode)`.                                                                                        |

(`Cache-Control` max-age is a constant — `31536000` immutable — not an option, to avoid dead
surface.)

## 5. Implementation files

| File                                                             | Purpose                                                                                                                                                                                                                      |
| ---------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/tokens.ts`                                  | Add `CAPABILITIES.SSR = 'ssr'` (alongside `SSE`).                                                                                                                                                                            |
| `packages/common/src/services/ssr.ts`                            | NEW contract module: `ISsrService` with `render(ctx: IRequestContext): Promise<HandlerResult>`.                                                                                                                              |
| `packages/common/src/index.ts`                                   | Export `ISsrService` (type) from `./services/ssr.ts` (token rides with the existing `CAPABILITIES` export).                                                                                                                  |
| `packages/react-router-plugin/deno.json`                         | NEW package config (`@hono-enterprise/react-router-plugin`, `exports: ./src/index.ts`, `test.permissions.net: true` for the real-socket integration test).                                                                   |
| `packages/react-router-plugin/src/index.ts`                      | Barrel: `ReactRouterPlugin`, `SsrService`, `createStaticAssetHandler`, type exports, re-export `ISsrService` + `CAPABILITIES` from common.                                                                                   |
| `packages/react-router-plugin/src/interfaces/index.ts`           | `ReactRouterPluginOptions`, `LoadContextFunction`, `SsrRequestHandler`.                                                                                                                                                      |
| `packages/react-router-plugin/src/plugin/react-router-plugin.ts` | Async `register()`: await `loadRequestHandler`, build `SsrService`, register it under `CAPABILITIES.SSR`, register catch-all (all 7 verbs at `${basename}/*`) + asset route, register health indicator + `onClose` shutdown. |
| `packages/react-router-plugin/src/handler/request-bridge.ts`     | `IRequestContext` → web `Request` (method/url/headers/buffered body/abort) and web `Response` → `IResponse` (status/headers/stream-or-buffer) → `HandlerResult`.                                                             |
| `packages/react-router-plugin/src/handler/load-context.ts`       | Default `createLoadContext(ctx)` + `LoadContextFunction`.                                                                                                                                                                    |
| `packages/react-router-plugin/src/handler/server-build.ts`       | Default `loadRequestHandler(serverBuildPath, mode)` (real lazy imports) + pure `assembleHandler(build, createRequestHandler, mode)` seam.                                                                                    |
| `packages/react-router-plugin/src/assets/static-assets.ts`       | `createStaticAssetHandler({fs, assetsDir, assetUrlPrefix})` → `RouteHandler`; `CONTENT_TYPES` map; immutable `Cache-Control`; 404 on missing/absent-fs.                                                                      |
| `packages/react-router-plugin/src/services/ssr-service.ts`       | `SsrService implements ISsrService`: holds the resolved handler + `getLoadContext`; `render(ctx)` = bridge → handler → write-back → `HandlerResult`.                                                                         |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                           | src covered                                                  | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                    |
| --------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/request-bridge.test.ts`                  | `src/handler/request-bridge.ts`                              | Built `Request` carries `ctx.request.method`/`url`/headers/body (`ctx.request.bytes()`); `ctx.signal` threaded; buffered `Response` → `snapshot().streaming === false` + status/headers copied; streaming `Response` → `snapshot().streaming === true`; `Set-Cookie` emitted via `appendHeader`. Driven by an injected fake `SsrRequestHandler`.                                    |
| `test/unit/load-context.test.ts`                    | `src/handler/load-context.ts`                                | Default `createLoadContext(ctx)` returns `{services, user}` with `user` PRESENT and ABSENT (omitted, not `undefined`); a custom `LoadContextFunction` overrides it.                                                                                                                                                                                                                 |
| `test/unit/server-build.test.ts`                    | `src/handler/server-build.ts`                                | Pure `assembleHandler(build, createRequestHandler, mode)` returns a handler that calls `createRequestHandler(build, mode)` and forwards `(request, loadContext)`; clear error path when the importer rejects (injected fake importers).                                                                                                                                             |
| `test/unit/static-assets.test.ts`                   | `src/assets/static-assets.ts`                                | Content-type per extension from `CONTENT_TYPES`; `Cache-Control: public, max-age=31536000, immutable`; 200 + body for a hit; 404 for a missing file (fake `readFile` rejects); 404 when `fs` is absent (runtime with `fs === undefined`).                                                                                                                                           |
| `test/unit/ssr-service.test.ts`                     | `src/services/ssr-service.ts`                                | `SsrService.render(ctx)` composes bridge → injected fake handler → write-back and returns a `HandlerResult`; service is the value registered under `CAPABILITIES.SSR`.                                                                                                                                                                                                              |
| `test/unit/react-router-plugin.test.ts`             | `src/plugin/react-router-plugin.ts`                          | Plugin shape (`name`, `version`, `provides: [CAPABILITIES.SSR]`, `priority`); async `register()` (awaited) registers `ISsrService` under `CAPABILITIES.SSR`; registers catch-all for **all 7 verbs** at `${basename}/*`; registers the asset route at `${assetUrlPrefix}/*` only when `assetsDir` is set; registers health + `onClose`. Uses an injected `loadRequestHandler` fake. |
| `test/unit/barrel-exports.test.ts`                  | `src/index.ts` (+ `src/interfaces/index.ts` type re-exports) | Every planned export is present and re-exports resolve; mirrors the sibling `barrel-exports.test.ts`.                                                                                                                                                                                                                                                                               |
| `test/fixtures/fake-runtime.ts`                     | —                                                            | Fake `IRuntimeServices` with an injectable `fs` (in-memory `readFile` map) for asset/service tests.                                                                                                                                                                                                                                                                                 |
| `test/fixtures/fake-handler.ts`                     | —                                                            | Recording fake `SsrRequestHandler`: returns a configured web `Response` (buffered or streaming) and records the `request` + `loadContext` it received.                                                                                                                                                                                                                              |
| `test/integration/react-router-integration.test.ts` | end-to-end (streaming + precedence)                          | `RuntimePlugin()` + `ReactRouterPlugin({loadRequestHandler: fake})`, `app.start({port})` + real `fetch()` (NOT `inject()` — it discards streaming bodies): streamed SSR document round-trips over a real socket; an app `/api/health` route is NOT shadowed by the catch-all (precedence).                                                                                          |
| `test/integration/server-build-real-import.test.ts` | `src/handler/server-build.ts` (real path)                    | Guarded `await import('npm:react-router')`; skipped when absent; asserts `createRequestHandler` exists and the default `loadRequestHandler` resolves with a tiny synthetic `ServerBuild` (the real import is the point; a full RR app is out of scope).                                                                                                                             |

The `common` additions (`tokens.ts`, `services/ssr.ts`, `index.ts`) are type/constant-only;
`services/ssr.ts` is a pure interface module like `services/sse.ts` and needs no new runtime test.
The existing `common` token-grammar tests already cover `'ssr'`.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/44-react-router-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
```

PUBLIC_API.md is updated in the same PR (new `@hono-enterprise/react-router-plugin` section + the
`CAPABILITIES.SSR` / `ISsrService` delta under `@hono-enterprise/common`), with JSDoc on every
export.

## 8. Risks & mitigations

- **Asset URL↔path mapping may not match a real RR build's public path.** Mitigated:
  `assetUrlPrefix` is configurable (default `/assets/`), and the asset unit test is decoupled from
  RR's actual output; the guarded real-build test validates the default against a real build.
- **Catch-all precedence.** `/*` is 1 static (`*` counted static), so a single-static-segment app
  route registered AFTER the SSR plugin could be shadowed. Mitigated: documented registration-order
  / static-segment precedence (§3.1) and an integration test proving a 2-static `/api/health` wins;
  typical API routes have ≥2 statics.
- **`runtime.fs` absent on edge.** Asset serving no-ops to 404 (documented); RR on edge normally
  uses a CDN/assets binding (out of scope). SSR document rendering itself is web-standard and still
  works.
- **Local dynamic import of the built server bundle may resolve differently across runtimes.**
  Mitigated: the path is app-provided; the lazy import uses the runtime's native `import()`; the
  guarded real-import test exercises it on the development runtime (Deno).
- **Async `register()` correctness.** Confirmed the kernel awaits `register(): void | Promise<void>`
  (`plugin.ts:498`); the `loadRequestHandler` promise is awaited before routes are mounted.

## 9. Out of scope

- Vite / HMR dev-server integration — app runs `react-router dev` separately; this plugin consumes
  the production build (app build-time concern, AI_GUIDELINES §12.2).
- Browser-side OpenTelemetry / hydration tracing — needs a separate browser OTel setup.
- Multi-backend trace fan-out — M24c (OTel Collector) / deploy config.
- Nested loader/action spans under the SSR request span — deferred (no OTel `ContextManager`);
  request span comes free from M24's middleware (§3.7).
- File-based route discovery — React Router owns it entirely.
- Extracting static-asset serving into a shared static middleware — flagged future (only static
  handler in the tree today).
