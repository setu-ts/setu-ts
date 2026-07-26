# Milestone 33 — Testing Package (`@hono-enterprise/testing`)

> **Status:** Planning. Branch: `feat/33-testing-package`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Provide a first-party testing utilities package so framework and application tests share one
ergonomic, contract-faithful toolkit: a test application factory that auto-starts the kernel
(without binding a socket), a mock-plugin factory for stubbing capability services, a free-function
request injector with string and web-`Request` shorthand, a mock request-context builder that honors
the post-M22/M23/M42 contract (monotonic `startTime` via `runtime.hrtime()`, never `Date.now()`; a
live `AbortSignal`), a mock service registry and mock response builder (the kernel's
`ServiceRegistry`/`ResponseBuilder`/`createRequestContext` are internal and cannot be imported), a
fixture manager for multi-mock setup and reset, and a streaming-response reader for asserting
incremental `Response` bodies. The package depends on `@hono-enterprise/common` (types) and
`@hono-enterprise/kernel` (`createApplication`, `IKernelApplication`, `InjectRequest`,
`InjectResponse`) only; it never imports another plugin and never imports kernel internals.

- **In scope:** `createTestApp`, `createMockPlugin`, `inject`, `createTestContext`,
  `MockServiceRegistry`, `MockResponse`, `FixtureManager`, `collectStream`, and the option/type
  exports they require; the `packages/testing/deno.json` `imports` update; the `PUBLIC_API.md`
  testing Options/Exports/Notes section; the `README.md`.
- **The caller always supplies the runtime provider.** `src/` depends on `common` + `kernel` only
  (confirmed as the committed dependency set at `ARCHITECTURE.md:1425`), so `createTestApp` cannot
  import `RuntimePlugin` to default it in. The kernel makes a `runtime` capability provider
  mandatory at `start()` (`plugin-resolver.ts:23-27`), so `options.plugins` must contain one — the
  real `RuntimePlugin()` from `@hono-enterprise/runtime`, or a mock providing
  `CAPABILITIES.RUNTIME`. Every committed example already passes `RuntimePlugin()` explicitly
  (`ROADMAP.md:3326`, `ROADMAP.md:3350`, `PUBLIC_API.md:4713`). See decision 3.1.
- **NOT this milestone:** a centralized `createFakeRuntime()` fixture (every package currently rolls
  its own `fake-runtime.ts`; consolidating it is a separate cross-package refactor — deferred to a
  future milestone); test-double factories for specific plugin services (e.g. a `MockMailer`); a
  snapshot/golden-file helper; a Supertest-style fluent API (`request(app).get(...)` chains); the
  CLI (M34), SDK (M35), starters (M36), and examples (M37) that consume this package.

## 1. Contracts verified from SOURCE (not names)

| Reference                                        | Source (file:line)                                                | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ------------------------------------------------ | ----------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IKernelApplication`                             | `packages/kernel/src/application/application.ts:80`               | Extends `IApplication` with `inject(request: InjectRequest): Promise<InjectResponse>` (`:88`). Inherits `fetch(request: Request): Promise<Response>` (`:363`, M23) and `stop(): Promise<void>` (`:319`). `createTestApp` returns this type — both `inject()` and `fetch()` are already on it.                                                                                                                                                                                                                  |
| `createApplication`                              | `packages/kernel/src/application/application.ts:690`              | `createApplication(options?: ApplicationOptions): IKernelApplication`. Pre-registers `options.plugins` (`:692`).                                                                                                                                                                                                                                                                                                                                                                                               |
| `ApplicationOptions`                             | `packages/kernel/src/application/application.ts:42`               | Single field `{ plugins?: IPlugin[] }`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `InjectRequest`                                  | `packages/kernel/src/application/application.ts:52`               | `{ method: string; url: string; headers?: Record<string,string> \| Headers; body?: unknown }`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `InjectResponse`                                 | `packages/kernel/src/application/application.ts:68`               | `{ readonly statusCode: number; readonly headers: Headers; readonly body: string \| null; json<T>(): T }`. `body` is `string \| null` — streaming bodies are discarded by `inject()` (PUBLIC_API:1505). **Also `null` for a non-streaming `Uint8Array` body**: `inject()` maps the snapshot with `typeof snapshot.body === 'string' ? … : null` (`:419`), so a `response.send(bytes)` handler reads back as `body: null`. A byte-body assertion must go through `fetch()` + `collectStream`, never `inject()`. |
| `start()` without port                           | `packages/kernel/src/application/application.ts:132`              | `start(options?)` compiles the pipeline (`:295`) and sets the handler (`:303`, step 8) even when `port` is absent; `listen` runs only when `port` is provided (`:307`, step 9). So `inject()` and `fetch()` work without a socket.                                                                                                                                                                                                                                                                             |
| **`runtime` provider is mandatory at `start()`** | `packages/kernel/src/registry/plugin-resolver.ts:23-27`           | `resolvePlugins` throws `"No plugin provides the mandatory 'runtime' capability. Register a runtime plugin (e.g. RuntimePlugin from @hono-enterprise/runtime)."` when no plugin declares `provides: [CAPABILITIES.RUNTIME]`. **Verified by running it:** `createApplication({ plugins: [] })` + `await start()` throws that message. So `createTestApp()` with an empty plugin list cannot auto-start — see §0 and decision 3.1.                                                                               |
| **Why `inject()` needs `start()`**               | `packages/kernel/src/application/application.ts:441`              | NOT because the pipeline is uncompiled — `MiddlewarePipeline.execute` compiles lazily (`middleware-pipeline.ts:68`, `this.#compiled ?? this.compile()`). The real cause: `#handleRequest` resolves `this.#registry.get<IRuntimeServices>(CAPABILITIES.RUNTIME)` before its `try`, and plugins only run `register(ctx)` during `start()` step 3 (`:275-278`). **Verified by running it:** an un-started app's `inject()` throws `"No service registered for capability 'runtime'. …"`.                          |
| **Middleware cannot be added after `start()`**   | `packages/kernel/src/pipeline/middleware-pipeline.ts:34-35`       | `MiddlewarePipeline.add` throws `"Cannot add middleware after the pipeline has been compiled."` once `compile()` has run, and `start()` step 6 compiles (`application.ts:295`). **Verified by running it:** post-`start()` `app.middleware.add(…)` throws. Drives the `autoStart: false` design (decision 3.1).                                                                                                                                                                                                |
| **Routes CAN be added after `start()`**          | `packages/kernel/src/router/router.ts:52`                         | `Router` has no compile step and no started guard; `#handleRequest` calls `this.#router.match(...)` per request (`application.ts:476`). **Verified by running it:** a route registered on a started app returns 200 through `inject()`. So the integration tests may register routes on the app `createTestApp` returns.                                                                                                                                                                                       |
| `ServiceRegistry.getAll` merge order             | `packages/kernel/src/registry/service-registry.ts:77-88`          | Returns `[...inherited, ...(single ? [single] : []), ...own multi]` — the **single** registration is included, not just the multi list. `register('t', svc)` then `getAll('t')` yields `[svc]`. `MockServiceRegistry.getAll` must reproduce this (decision 3.5).                                                                                                                                                                                                                                               |
| `ServiceRegistry.get` throw text                 | `packages/kernel/src/registry/service-registry.ts:63-67`          | Two sentences, verbatim: `` `No service registered for capability '${token}'. Register a plugin that provides it, or check the token spelling against CAPABILITIES.` ``                                                                                                                                                                                                                                                                                                                                        |
| `ServiceRegistry` duplicate/override             | `packages/kernel/src/registry/service-registry.ts:104`            | `#store` honors `RegisterOptions`: `multi: true` appends to the multi list; otherwise a second `register` on an occupied token throws unless `override: true` replaces it (`registry.ts:57-66` documents the throw). `MockServiceRegistry` must match (decision 3.5).                                                                                                                                                                                                                                          |
| Committed dependency set                         | `ARCHITECTURE.md:1425`                                            | `@hono-enterprise/testing` **Dependencies** row is `common`, `kernel` — confirming §0's constraint that `src/` never imports `@hono-enterprise/runtime`.                                                                                                                                                                                                                                                                                                                                                       |
| `inject()` body handling                         | `packages/kernel/src/application/application.ts:374`              | Stringifies non-string `body`, sets `content-type: application/json` when absent, normalizes relative URLs to `http://localhost…`, builds a synthetic `IRequest`, runs `#handleRequest`, maps `snapshot()` to `InjectResponse`.                                                                                                                                                                                                                                                                                |
| `fetch()`                                        | `packages/kernel/src/application/application.ts:363`              | Delegates to `IHttpAdapter.fetch(request: Request): Promise<Response>`. Requires `CAPABILITIES.HTTP_ADAPTER`. Returns a web-standard `Response` (streaming bodies preserved).                                                                                                                                                                                                                                                                                                                                  |
| `IPlugin`                                        | `packages/common/src/plugin.ts:470`                               | `name`, `version`, `dependencies?`, `optionalDependencies?`, `provides?`, `consumes?`, `priority?`, `register(ctx): void \| Promise<void>`.                                                                                                                                                                                                                                                                                                                                                                    |
| `IPluginContext`                                 | `packages/common/src/plugin.ts:409`                               | `services`, `middleware`, `router`, `environment`, `health`, `metrics`, `openapi`, `decorators`, `cli`, `lifecycle`, `runtime`, `config?`, `logger?`, `metadata?`, `container?`, `options`, `app`.                                                                                                                                                                                                                                                                                                             |
| `IServiceRegistry`                               | `packages/common/src/registry.ts:55`                              | `register<T>`, `registerFactory<T>`, `get<T>`, `getAll<T>`, `has`, `unregister`. No `createChild` — that is kernel-internal.                                                                                                                                                                                                                                                                                                                                                                                   |
| `IRequest`                                       | `packages/common/src/http.ts:33`                                  | `method`, `url`, `path`, `headers`, `ip?`, `user?` (writable `:48`), `tenant?` (M32), `signal?` (`:64`), `json<T>()`, `text()`, `bytes()`.                                                                                                                                                                                                                                                                                                                                                                     |
| `IResponse`                                      | `packages/common/src/http.ts:100`                                 | `status(code)`, `header(name,value)`, `appendHeader(name,value)`, `json<T>(body)`, `text(body)`, `send(body?)`, `redirect(url,status?)`, `stream(body)`, `snapshot()`.                                                                                                                                                                                                                                                                                                                                         |
| `IRequestContext`                                | `packages/common/src/http.ts:199`                                 | `id: string`, `request: IRequest`, `response: IResponse`, `services: IServiceRegistry`, `params: Readonly<Record<string,string>>`, `query: Readonly<Record<string,string>>`, `state: Map<string,unknown>`, `startTime: number`, `signal: AbortSignal` (non-optional since M42, `:227`).                                                                                                                                                                                                                        |
| `ResponseSnapshot`                               | `packages/common/src/http.ts:332`                                 | Discriminated union keyed on `streaming`: `false` → `{ status, headers, body: Uint8Array\|string\|null }`; `true` → `{ status, headers, body: ReadableStream<Uint8Array> }`.                                                                                                                                                                                                                                                                                                                                   |
| `IRuntimeServices`                               | `packages/common/src/runtime.ts:178`                              | `platform()`, `version()`, `hostname()`, `uuid()`, `randomBytes()`, `subtle`, `now()`, `hrtime()` (monotonic ms), `setTimeout`, `clearTimeout`, `setInterval`, `clearInterval`, `env`, `exit()`, `fs?`, `workers?`.                                                                                                                                                                                                                                                                                            |
| `CAPABILITIES`                                   | `packages/common/src/tokens.ts:39`                                | String constants: `RUNTIME: 'runtime'`, `DATABASE: 'database'`, `LOGGER: 'logger'`, etc. Lowercase kebab-case.                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ILogger`                                        | `packages/common/src/services/logger.ts:29`                       | `level: LogLevel`, `fatal/error/warn/info/debug/trace(message, metadata?)`, `child(bindings)`.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `ServiceRegistry` (NOT exported)                 | `packages/kernel/src/registry/service-registry.ts:32`             | Kernel-internal; implements `IServiceRegistry` with `createChild()`. NOT in `packages/kernel/src/index.ts` (`:11-18` exports only `ApplicationOptions`, `IKernelApplication`, `InjectRequest`, `InjectResponse`, `createApplication`). The testing package CANNOT import it — `MockServiceRegistry` is the testing package's own `IServiceRegistry` implementation.                                                                                                                                            |
| `ResponseBuilder` (NOT exported)                 | `packages/kernel/src/context/response.ts:16`                      | Kernel-internal; implements `IResponse` with `snapshot()` and an `ended` getter. NOT exported. `MockResponse` is the testing package's own `IResponse` implementation.                                                                                                                                                                                                                                                                                                                                         |
| `createRequestContext` (NOT exported)            | `packages/kernel/src/context/request-context.ts:44`               | Kernel-internal; builds `IRequestContext` with `runtime.uuid()` for `id`, `runtime.hrtime()` for `startTime`, `request.signal ?? NEVER_ABORT_CONTROLLER.signal` for `signal`, a child registry, parsed query. NOT exported. `createTestContext` replicates this shape.                                                                                                                                                                                                                                         |
| `RuntimePlugin`                                  | `packages/runtime/src/plugin/runtime-plugin.ts:102`               | `RuntimePlugin(options?: RuntimeOptions): IPlugin`; `provides: [CAPABILITIES.RUNTIME, CAPABILITIES.HTTP_ADAPTER]`; `priority: PLUGIN_PRIORITY.HIGHEST`. `RuntimeOptions` (`:32`) is `platform?` (`:38`, public), `adapters?` (`:46`) and `httpAdapters?` (`:54`) — the latter two are marked **`@internal`**, so this package's tests use them only if nothing else works (see §8). The user imports `RuntimePlugin` from `@hono-enterprise/runtime`; the testing package does NOT re-export it.               |
| `@hono/hono` version                             | `deno.lock:4`                                                     | `jsr:@hono/hono@^4.12.30` → resolved `4.12.31`. Not a dependency of this package (kernel owns it).                                                                                                                                                                                                                                                                                                                                                                                                             |
| `@std/testing` version                           | `deno.lock:15`                                                    | `jsr:@std/testing@^1.0.19` → `1.0.19`. Root-level import, available to all workspace packages.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `@std/expect` version                            | `deno.lock:9`                                                     | `jsr:@std/expect@^1.0.20` → `1.0.20`. Root-level import.                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `@hono-enterprise/common` version                | `packages/kernel/deno.json:7`                                     | `jsr:@hono-enterprise/common@^0.1.0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@hono-enterprise/kernel` version                | `packages/runtime/deno.json:11`                                   | `jsr:@hono-enterprise/kernel@^0.1.0`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `@hono-enterprise/runtime` version               | `packages/runtime/deno.json:10` (name)                            | `jsr:@hono-enterprise/runtime@^0.1.0` (test-only dependency for integration/e2e tests).                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `packages/testing` stub                          | `packages/testing/src/index.ts:1`, `packages/testing/deno.json:1` | M0 stub: `export {};` and a bare `deno.json` with no `imports`. Both are replaced in this milestone.                                                                                                                                                                                                                                                                                                                                                                                                           |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                | Resolution (picked side)                                                                                                                                                                                                                                                                                                                     | Doc deliverable (same PR)                                                                                                                                                                                                                                                         |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | Three committed lists of this package's utilities disagree, and all three are short. ROADMAP M33 lists `src/fixtures/fixture-manager.ts` in the Implementation Files (`ROADMAP.md:3369`) but its Utilities list (`ROADMAP.md:3356-3360`) names no `FixtureManager`. `ARCHITECTURE.md:2204-2207` lists only `createTestApp`/`createMockPlugin`/`inject`/`createTestContext` — omitting `FixtureManager` **and** `MockServiceRegistry` (which ROADMAP does list). `ARCHITECTURE.md:1426`'s per-package **Public API** row is shorter still: `createTestApp()`; `createMockPlugin()`; `inject()`.                          | **The §4 exported surface is authoritative**; `FixtureManager` is exported (decision 3.8) and every doc list is corrected to match it. It collects mock-plugin definitions and real plugins, produces the `IPlugin[]` for `createTestApp`, and resets between tests.                                                                         | Three edits in this PR: (a) add `FixtureManager` to the ROADMAP M33 Utilities list; (b) add `MockServiceRegistry`, `MockResponse`, `FixtureManager`, `collectStream` to `ARCHITECTURE.md:2204-2207`; (c) extend the `ARCHITECTURE.md:1426` Public API row to the full §4 surface. |
| C2 | ROADMAP M33 lists `inject` as a standalone utility (`ROADMAP.md:3358`), but `inject` already exists as a method on `IKernelApplication` (`packages/kernel/src/application/application.ts:88`). A bare re-export would be dead surface.                                                                                                                                                                                                                                                                                                                                                                                  | **The testing package's `inject` is a free function with a richer input union** — `string` shorthand, `InjectRequest` object, and web-standard `Request` — that normalizes all three to `InjectRequest` and delegates to `app.inject()` (decision 3.3). The string and `Request` shorthand are the distinguishing behavior the method lacks. | Document the free-function `inject(app, request)` in the PUBLIC_API testing section, noting it delegates to `app.inject()` after normalization.                                                                                                                                   |
| C3 | ROADMAP M33 note (M22/M23 impact, `ROADMAP.md:3309-3315`) says `createTestApp` "must expose a `fetch(Request)` test entry alongside `inject()`" and "Add a helper to assert streaming responses (read the Response body incrementally)." `IKernelApplication.fetch()` already exists (`:363`), so `createTestApp` satisfies the first clause by returning the started `IKernelApplication`. The streaming helper has no home in the ROADMAP file list.                                                                                                                                                                  | **`createTestApp` returns `IKernelApplication` unchanged** — both `inject()` and `fetch()` are already on it (decision 3.1). **Add `collectStream(response: Response)` in `src/inject.ts`** (decision 3.7) for the incremental-body helper; add `src/inject.ts` to the ROADMAP file list (already present).                                  | Add the streaming-helper note to the PUBLIC_API testing section; no ROADMAP file-list change needed (`src/inject.ts` is already listed).                                                                                                                                          |
| C4 | PUBLIC_API has a Testing examples section (`PUBLIC_API.md:4706-4748`) showing `createTestApp` and `createMockPlugin` usage, but no formal Options/Exports/Notes subsection the way every plugin package has. The committed exports are undocumented.                                                                                                                                                                                                                                                                                                                                                                    | **Add a full Testing Package Options/Exports/Notes section to PUBLIC_API.md** listing every `src/index.ts` export with JSDoc, matching the structure every other package follows.                                                                                                                                                            | Add the PUBLIC_API.md Testing Package section in the same PR.                                                                                                                                                                                                                     |
| C5 | `packages/testing/deno.json` (M0 stub) has no `imports` map, but `src/` imports from `@hono-enterprise/common` and `@hono-enterprise/kernel`, and tests import from `@hono-enterprise/runtime`.                                                                                                                                                                                                                                                                                                                                                                                                                         | **Add `imports` to `packages/testing/deno.json`** with `common`, `kernel`, and `runtime` (test-only) entries, following the `packages/runtime/deno.json:9-12` pattern.                                                                                                                                                                       | No doc change; the `deno.json` edit ships in the same PR.                                                                                                                                                                                                                         |
| C6 | **`PUBLIC_API.md:161-171` ("Testing Without a Server") documents behavior the kernel does not have.** The example builds `createApplication({ plugins: [RuntimePlugin()] })`, registers a route, and calls `await app.inject(...)` with **no `start()`**, asserting `statusCode // 200`. Verified by running it verbatim: it throws `"No service registered for capability 'runtime'. …"`, because plugins register during `start()` (§1, "Why `inject()` needs `start()`"). This plan's decision 3.1 asserts the opposite of the committed example, and this is precisely the doc `createTestApp` exists to supersede. | **The code is right and the doc is wrong** — `inject()` requires `start()`. Correct the example to `await app.start();` before `inject()`, and point the section at `createTestApp` (which does that for the caller). Not fixing it would leave a committed example that throws, still contradicting decision 3.1 after this PR merges.      | Correct the `PUBLIC_API.md:161-171` example to call `await app.start()` before `inject()`, and add a cross-reference to the new Testing Package section.                                                                                                                          |

## 3. Design decisions

### 3.1 `createTestApp` — wraps `createApplication` + auto-`start()`

- **Decision:** `createTestApp(options?: TestAppOptions): Promise<IKernelApplication>` calls
  `createApplication({ plugins: options?.plugins ?? [] })`, then `await app.start()` (no `port`),
  then returns the `IKernelApplication`. When `options?.autoStart === false`, it returns the app
  without calling `start()`.
- **`options.plugins` must include a `runtime` capability provider.** The kernel throws at `start()`
  when none does (`plugin-resolver.ts:23-27`, verified by running it), and this package cannot
  import `RuntimePlugin` to default one in — `src/` is limited to `common` + `kernel`
  (`ARCHITECTURE.md:1425`). So `createTestApp()` and `createTestApp({ plugins: [] })` with the
  default `autoStart: true` **throw by design**, with the kernel's own message naming the fix. This
  is documented on the `plugins` option (§4.1), stated in the JSDoc with the `RuntimePlugin()`
  import shown in an `@example`, and asserted as a throw in the unit test rather than papered over.
  A mock providing `CAPABILITIES.RUNTIME` (via
  `createMockPlugin({ name: 'runtime', service: fakeRuntime })`) is the zero-dependency alternative
  for tests that never touch real runtime services.
- **Why auto-start at all:** `inject()` needs the plugins registered — `#handleRequest` resolves
  `CAPABILITIES.RUNTIME` from the registry on its first line (`application.ts:441`) and plugins only
  register during `start()` step 3 (`:275-278`), so an un-started app's `inject()` throws
  `"No service registered for capability 'runtime'"` (verified). Note this is NOT a pipeline-compile
  problem: `MiddlewarePipeline.execute` compiles lazily (`middleware-pipeline.ts:68`). `fetch()`
  additionally needs the handler installed, which is `start()` step 8 (`:303`). Auto-starting
  without a `port` skips `listen` (step 9, `:307`), so tests run fully in-process with no socket.
- **`autoStart: false` exists for two reasons, and the second is the common one:** (a) registering
  more plugins imperatively before `start()`, since `register()` throws once started (`:125`); and
  (b) **adding global middleware at all** — `MiddlewarePipeline.add` throws
  `"Cannot add middleware after the pipeline has been compiled."` once `start()` step 6 has run
  (`middleware-pipeline.ts:34-35`, verified by running it). Since testing middleware is a primary
  use of this package, `autoStart: false` + `app.middleware.add(...)` + `await app.start()` is the
  documented sequence for it, and the JSDoc says so. Routes are unaffected — the `Router` has no
  compile step, so `app.router.get(...)` works on a started app (verified).
- **Test home:** `test/integration/test-app.test.ts` asserts that a started test app's `inject()`
  returns the routed response, and that a route registered AFTER `createTestApp` returns still
  matches. `test/unit/test-app.test.ts` asserts: `createTestApp({ plugins: [] })` rejects with the
  kernel's mandatory-runtime message; `autoStart: false` with an empty list resolves without
  throwing (proving `start()` was not called); an `autoStart: false` app accepts
  `middleware.add(...)` and a subsequent `start()`, while the default-started app throws on
  `middleware.add(...)`.

### 3.2 `createMockPlugin` — registers a mock service under a capability token

- **Decision:** `createMockPlugin(options: MockPluginOptions): IPlugin` returns a plugin with
  `name: options.name`, `version: '0.1.0'`, `provides: [options.provides ?? options.name]`, and a
  `register(ctx)` that calls
  `ctx.services.register(options.provides ?? options.name, options.service)` then invokes
  `options.register?.(ctx)` for extra registration. `MockPluginOptions` is
  `{ name: string; service: object; provides?: string; priority?: number; register?: (ctx: IPluginContext) => void | Promise<void> }`.
- **Why:** The PUBLIC_API example (`PUBLIC_API.md:4735`) passes
  `{ name: 'database', service: {...} }` and the mock is consumed as the `database` capability.
  Using `name` as the default token matches that example with zero extra config; `provides`
  overrides the token when the plugin name and the capability token differ. The optional `register`
  callback lets a mock add middleware, routes, or lifecycle hooks beyond a bare service
  registration.
- **Test home:** `test/unit/mock-plugin.test.ts` asserts the returned plugin's `name`, `provides`,
  that `register()` calls `services.register` with the right token and service, and that the
  `register` callback runs.

### 3.3 `inject` — free function with string, `InjectRequest`, and `Request` shorthand

- **Decision:**
  `inject(app: IKernelApplication, request: string | InjectRequest | Request): Promise<InjectResponse>`.
  A `string` is a **URL only** and becomes `{ method: 'GET', url: request }` — a `"GET /users"`
  method-prefixed form is explicitly NOT supported, because the kernel only normalizes strings
  starting with `/` (`application.ts:392-397`) and would hand `"GET /users"` to `new URL()`, which
  throws inside `createRequestContext` and surfaces as a 400 rather than a routed response. Callers
  needing a non-GET method use the `InjectRequest` object form. An `InjectRequest` passes through
  unchanged. A web-standard `Request` is normalized: `method` from `request.method`, `url` from
  `request.url`, `headers` from `request.headers`, `body` from `await request.text()` when the
  method is not `GET`/`HEAD` and the body is not null. All three arms delegate to
  `app.inject(normalized)`.
- **Why:** The kernel's `app.inject()` requires a structured `InjectRequest` (`application.ts:52`).
  The string shorthand removes boilerplate for the common `GET '/path'` case; the `Request` arm lets
  a test reuse a `new Request(url, { method, body, headers })` it already built for `app.fetch()`,
  so the same request object exercises both the inject path and the fetch path. Without the
  `Request` arm, tests would hand-translate `Request` fields into `InjectRequest`, duplicating the
  kernel's own `inject()` body normalization.
- **Test home:** `test/unit/inject.test.ts` asserts the string, `InjectRequest`, and `Request` arms
  each produce the expected `InjectRequest` (via a fake app that records the call);
  `test/integration/inject.test.ts` asserts the end-to-end `InjectResponse` through a real started
  app.

### 3.4 `createTestContext` — builds a contract-faithful `IRequestContext`

- **Decision:** `createTestContext(options?: TestContextOptions): IRequestContext` first resolves
  one runtime — `const runtime = options?.runtime ?? DEFAULT_TEST_RUNTIME` (the internal default of
  decision 3.9) — so every runtime-derived field reads from a single source rather than repeating a
  `??` fallback per field. It then constructs an `IRequestContext` with: `id` from `runtime.uuid()`;
  `request` from a `MockRequest` built from `options?.request` (defaults: `method: 'GET'`,
  `url: 'http://localhost/'`, `path` derived, `headers: new Headers()`, body readers backed by
  `options?.body`); `response` from `options?.response ?? new MockResponse()`; `services` from
  `options?.services ?? new MockServiceRegistry()`; `params` from `options?.params ?? {}`; `query`
  from `options?.query` (parsed from the URL when absent); `state` from
  `options?.state ?? new Map()`; `signal` from `options?.signal ?? new AbortController().signal`.
  `TestContextOptions` exposes every overridable field.
- **`startTime` precedence is explicit:** `options?.startTime ?? runtime.hrtime()`, where `runtime`
  is the resolved runtime above — so a direct `startTime` wins over an injected runtime's
  `hrtime()`, which wins over `DEFAULT_TEST_RUNTIME.hrtime()`'s `0`. All three are monotonic
  readings — never `Date.now()`. The direct override exists so a duration test can pin an origin
  without constructing a whole `IRuntimeServices` fake; a test that needs the clock to _advance_
  injects a `runtime` whose `hrtime()` returns successive values instead.
- **Why:** The kernel's `createRequestContext` (`request-context.ts:44`) is internal and cannot be
  imported (§1). Its construction sets `startTime` via `runtime.hrtime()` (monotonic) and `signal`
  via `request.signal ?? NEVER_ABORT_CONTROLLER.signal` — a fixture that used `Date.now()` for
  `startTime` would make a broken duration calculation pass (CLAUDE.md "Never mix clocks"). The
  default `startTime: 0` is a monotonic origin, not an epoch; tests that exercise duration logic
  pass a `runtime` with a controllable `hrtime()`. The default `signal` is a live, never-aborting
  `AbortController().signal` so handlers calling `ctx.signal.addEventListener('abort', …)` never
  throw on a null signal.
- **Test home:** `test/unit/mock-context.test.ts` asserts every default field, every override, that
  `startTime` is `0` (not `Date.now()`), that `signal` is a live `AbortSignal`, and that
  `MockRequest` body readers parse the provided body. The `startTime` precedence is asserted at all
  three levels: default `0`; `runtime.hrtime()` when only a `runtime` is passed; and the direct
  `startTime` winning when both are passed.

### 3.5 `MockServiceRegistry` — in-memory `IServiceRegistry` with registration recording

- **Decision:** `MockServiceRegistry` implements `IServiceRegistry` (`common/src/registry.ts:55`)
  with a `Map<CapabilityToken, Registration>` for single registrations and a
  `Map<CapabilityToken, Registration[]>` for multi registrations, where a `Registration` holds an
  instance or a factory. It reproduces the kernel `ServiceRegistry`'s observable semantics
  field-for-field, because a double that diverges hides the bug it exists to catch:
  - `get` resolves a factory once and caches it, and on a miss throws the kernel's **verbatim**
    two-sentence message (`service-registry.ts:63-67`):
    `` `No service registered for capability '${token}'. Register a plugin that provides it, or check the token spelling against CAPABILITIES.` ``
  - `getAll` returns `[...(single ? [single] : []), ...multi]` — the **single registration is
    included**, matching `service-registry.ts:77-88`. Returning only the multi list would make
    `register('t', svc)` then `getAll('t')` yield `[]` in tests and `[svc]` in production. (The real
    registry also prepends a parent's providers; `MockServiceRegistry` has no parent because it
    deliberately omits the kernel-internal `createChild`, so that clause has no analogue.)
  - `register`/`registerFactory` honor `RegisterOptions` exactly as `#store` does
    (`service-registry.ts:104`): `multi: true` appends to the multi list; otherwise a second
    registration on an occupied token **throws**, unless `override: true` replaces it.
  - `has` checks both maps; `unregister` deletes from both and returns whether anything was removed.
  - A readonly `registrations: ReadonlyArray<{ token: string; multi: boolean }>` field records every
    `register`/`registerFactory` call for test assertions.
- **Why:** The kernel's `ServiceRegistry` is internal (`service-registry.ts:32`, not exported from
  `kernel/src/index.ts`). `createTestContext` needs a registry for `ctx.services`, and unit tests
  for middleware need to inspect what was registered. The recording field is the distinguishing
  feature a bare `Map`-backed implementation would lack.
- **Test home:** `test/unit/mock-registry.test.ts` asserts
  `register`/`registerFactory`/`get`/`getAll`/`has`/`unregister` behavior, the
  duplicate-registration throw, the `override: true` replacement, the `multi: true` append, that
  `getAll` includes a single registration, the verbatim miss message, and the `registrations`
  recording. One test cross-checks the mock against the real kernel registry's observable behavior
  through a started app (§6, integration) so the two cannot silently diverge.

### 3.6 `MockResponse` — in-memory `IResponse` with `snapshot()` and `ended`

- **Decision:** `MockResponse` implements `IResponse` (`common/src/http.ts:100`) with a mutable
  `#status` (default `200`), `#headers = new Headers()`, `#body`, `#streaming`, `#ended`. Chaining
  methods (`status`, `header`, `appendHeader`) return `this`. Terminal methods (`json`, `text`,
  `send`, `redirect`, `stream`) set the body and `#ended = true` and return a `HandlerResult` brand.
  `snapshot()` returns the `ResponseSnapshot` discriminated union (`http.ts:332`): the
  `streaming:
  false` arm with `body: Uint8Array | string | null` when no stream was set, the
  `streaming: true` arm with `body: ReadableStream<Uint8Array>` when `stream()` was called. A
  readonly `ended: boolean` getter (not on `IResponse`, an extra for tests) reports whether a
  terminal method was called.
- **Why:** The kernel's `ResponseBuilder` is internal (`response.ts:16`, not exported).
  `createTestContext` needs an `IResponse` for `ctx.response`. The `ended` getter lets short-circuit
  tests assert that a middleware responded without calling `next()` (CLAUDE.md "Short-circuit tests
  are mandatory") — the same role `ResponseBuilder.ended` plays inside the kernel. `snapshot()` lets
  middleware tests inspect the response after `next()` returns, matching the cache-middleware
  pattern.
- **Test home:** `test/unit/mock-context.test.ts` (co-located because `MockResponse` lives in
  `src/mock-context.ts`) asserts every terminal method sets `ended`, `snapshot()` returns the right
  arm, `stream()` sets `streaming: true`, and `header`/`appendHeader` overwrite vs. append.

### 3.7 `collectStream` — reads a web `Response` body incrementally

- **Decision:** `collectStream(response: Response): Promise<StreamingBody>` reads `response.body` (a
  `ReadableStream<Uint8Array>`) chunk by chunk via a `ReadableStream` reader, collecting each
  `Uint8Array` chunk into `chunks: Uint8Array[]` and decoding the concatenation into `text: string`
  with `TextDecoder`. Returns `{ chunks, text }`. Throws if `response.body` is `null`.
- **Why:** The M22/M23 note (`ROADMAP.md:3314`) says "Add a helper to assert streaming responses
  (read the Response body incrementally)." `app.fetch()` returns a web `Response` whose `body` is a
  `ReadableStream`; `app.inject()` discards streaming bodies (`InjectResponse.body` is
  `string | null`, `application.ts:419`). So a streaming test must go through `fetch()` and read the
  stream — `collectStream` centralizes that read so every streaming test (SSE, file download, SSR)
  does it identically. Reading chunk-by-chunk (not `.text()`) lets a test assert intermediate frame
  boundaries.
- **Test home:** `test/unit/inject.test.ts` asserts `collectStream` reads a synthetic
  `new Response(new ReadableStream(...))` into the expected chunks and text, and throws on a null
  body.

### 3.8 `FixtureManager` — collects mocks and plugins, resets between tests

- **Decision:** `FixtureManager` has
  `mock(name: string, service: object, options?: { provides?: string; priority?: number }): this`
  (internally calls `createMockPlugin` and stores the result), `plugin(plugin: IPlugin): this`
  (stores a real plugin), `plugins(): IPlugin[]` (returns all stored mocks and plugins in insertion
  order), and `reset(): void` (clears the store). It is a plain class, not a plugin itself.
- **Why:** Integration tests that mock several capabilities at once (e.g. `database` + `cache` +
  `logger`) currently build the plugin array by hand and rebuild it in every `beforeEach`. A fixture
  manager centralizes the setup and the reset, so `afterEach(() => fixtures.reset())` is the only
  teardown needed. `plugins()` feeds directly into `createTestApp({ plugins: fixtures.plugins() })`.
- **Test home:** `test/unit/fixture-manager.test.ts` asserts `mock` produces a plugin registered
  under the right token, `plugin` stores reals, `plugins()` returns insertion order, and `reset()`
  clears the store.

### 3.9 Default fake runtime inside `createTestContext` — monotonic, never `Date.now()`

- **Decision:** When `options?.runtime` is absent, `createTestContext` resolves the module-level
  `DEFAULT_TEST_RUNTIME` (decision 3.4) — an `IRuntimeServices` with `hrtime: () => 0` (a fixed
  monotonic origin), `uuid: () => 'test-ctx'`, `now: () => 0`, and no-op timers. It is a named
  internal constant rather than an inline object literal so the unit test can cover its accessors
  directly and the per-file 90% bar is met without contorting `createTestContext` calls. It is NOT
  exported — tests that need a controllable clock pass their own `IRuntimeServices` (the established
  `fake-runtime.ts` pattern, e.g. `packages/websocket-plugin/test/fixtures/fake-runtime.ts:38`).
- **Why:** CLAUDE.md "Never mix clocks" — `startTime` must be a monotonic `runtime.hrtime()`
  reading, never `Date.now()`. A default of `0` is a monotonic origin; `Date.now()` would be a
  ~1.7e12 epoch that makes `runtime.hrtime() - ctx.startTime` yield garbage. Exporting a
  `createFakeRuntime()` is deferred (§0, out of scope) because every package already has its own and
  consolidating them is a cross-package refactor.
- **Test home:** `test/unit/mock-context.test.ts` asserts the default `startTime` is `0` and `id` is
  `'test-ctx'`, that passing a custom `runtime` with `hrtime: () => 42` sets `startTime: 42`, and
  that `DEFAULT_TEST_RUNTIME`'s remaining accessors (`now()`, the no-op timers) are exercised so no
  branch in the constant is left uncovered.

## 4. Exported surface — every symbol names its consumer

| Exported symbol                  | Kind     | Consumer / real code path that READS it                                                                                                                                               |
| -------------------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `createTestApp`                  | function | Integration and e2e test suites across the framework and consumer apps that need a started, in-process kernel app for `inject()`/`fetch()`.                                           |
| `TestAppOptions`                 | type     | Callers of `createTestApp` that type the options bag (`plugins`, `autoStart`).                                                                                                        |
| `createMockPlugin`               | function | Tests that stub a capability service (e.g. a mock `database` repository) without registering the real plugin.                                                                         |
| `MockPluginOptions`              | type     | Callers of `createMockPlugin`.                                                                                                                                                        |
| `inject`                         | function | Tests exercising HTTP request handling without a socket; the string and `Request` shorthand arms serve tests that want ergonomic one-liners or reuse a `Request` built for `fetch()`. |
| `createTestContext`              | function | Unit tests for middleware and route handlers that need an `IRequestContext` in isolation, without starting an app.                                                                    |
| `TestContextOptions`             | type     | Callers of `createTestContext`.                                                                                                                                                       |
| `MockServiceRegistry`            | class    | `createTestContext` default `services`; unit tests that inspect registrations via the `registrations` field.                                                                          |
| `MockResponse`                   | class    | `createTestContext` default `response`; unit tests that inspect `snapshot()` or `ended` to assert short-circuit behavior.                                                             |
| `FixtureManager`                 | class    | Integration tests that mock multiple capabilities and reset between tests.                                                                                                            |
| `collectStream`                  | function | Streaming-response tests (SSE, file download, SSR) that read a `fetch()` `Response` body incrementally.                                                                               |
| `StreamingBody`                  | type     | Callers of `collectStream` that destructure `{ chunks, text }`.                                                                                                                       |
| `InjectRequest` (re-export)      | type     | Callers of `inject` that use the object form; re-exported from `@hono-enterprise/kernel` so tests import from one package.                                                            |
| `InjectResponse` (re-export)     | type     | Tests that type the `inject()` return value; re-exported from `@hono-enterprise/kernel`.                                                                                              |
| `IKernelApplication` (re-export) | type     | Tests that type the `createTestApp` return value; re-exported from `@hono-enterprise/kernel`.                                                                                         |

### 4.1 Options — every option names its consumer

| Option                         | Consumer                                                                | Behavior (per implementation)                                                                                                                                                                                                                                                                                        |
| ------------------------------ | ----------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `TestAppOptions.plugins`       | `createTestApp` → `createApplication({ plugins })`                      | Pre-registered before `start()`. **Must include a `runtime` capability provider** (`RuntimePlugin()`, or a mock providing `CAPABILITIES.RUNTIME`) whenever `autoStart` is left at `true` — the kernel throws otherwise (`plugin-resolver.ts:23-27`). Defaults to `[]`, which is only usable with `autoStart: false`. |
| `TestAppOptions.autoStart`     | `createTestApp`                                                         | `true` (default): calls `await app.start()` before returning. `false`: returns the un-started app, which is required both to register more plugins (`register()` throws once started) and to add global middleware (`middleware.add` throws after `start()` compiles the pipeline).                                  |
| `MockPluginOptions.name`       | `createMockPlugin` → `IPlugin.name` and default capability token        | Plugin name and the token `service` is registered under (when `provides` is absent).                                                                                                                                                                                                                                 |
| `MockPluginOptions.service`    | `createMockPlugin` → `ctx.services.register(token, service)`            | The mock service object registered under the token.                                                                                                                                                                                                                                                                  |
| `MockPluginOptions.provides`   | `createMockPlugin` → `IPlugin.provides` and registration token          | Overrides the token when the plugin name and capability token differ. Defaults to `name`.                                                                                                                                                                                                                            |
| `MockPluginOptions.priority`   | `createMockPlugin` → `IPlugin.priority`                                 | Registration priority; passed through to the kernel resolver.                                                                                                                                                                                                                                                        |
| `MockPluginOptions.register`   | `createMockPlugin` → extra `register(ctx)` body                         | Additional registration (middleware, routes, hooks) beyond the bare service registration.                                                                                                                                                                                                                            |
| `TestContextOptions.request`   | `createTestContext` → `MockRequest` fields                              | Partial `IRequest` overrides (method, url, headers, etc.).                                                                                                                                                                                                                                                           |
| `TestContextOptions.body`      | `createTestContext` → `MockRequest` body readers                        | Backs `json()`, `text()`, `bytes()` on the mock request.                                                                                                                                                                                                                                                             |
| `TestContextOptions.runtime`   | `createTestContext` → `id` via `uuid()`, `startTime` via `hrtime()`     | When absent, an internal monotonic default is used.                                                                                                                                                                                                                                                                  |
| `TestContextOptions.services`  | `createTestContext` → `ctx.services`                                    | Defaults to `new MockServiceRegistry()`.                                                                                                                                                                                                                                                                             |
| `TestContextOptions.response`  | `createTestContext` → `ctx.response`                                    | Defaults to `new MockResponse()`.                                                                                                                                                                                                                                                                                    |
| `TestContextOptions.params`    | `createTestContext` → `ctx.params`                                      | Defaults to `{}`.                                                                                                                                                                                                                                                                                                    |
| `TestContextOptions.query`     | `createTestContext` → `ctx.query`                                       | Defaults to query parsed from the request URL.                                                                                                                                                                                                                                                                       |
| `TestContextOptions.state`     | `createTestContext` → `ctx.state`                                       | Defaults to `new Map()`.                                                                                                                                                                                                                                                                                             |
| `TestContextOptions.signal`    | `createTestContext` → `ctx.signal`                                      | Defaults to `new AbortController().signal` (live, never-aborting).                                                                                                                                                                                                                                                   |
| `TestContextOptions.startTime` | `createTestContext` → `ctx.startTime` (decision 3.4, precedence bullet) | Highest-precedence monotonic origin: `options.startTime ?? options.runtime?.hrtime() ?? 0`. Lets a duration test pin an origin without building a full `IRuntimeServices` fake.                                                                                                                                      |

## 5. Implementation files

| File                              | Purpose                                                                                                                                                                                                                                                                                                                                                                                           |
| --------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                    | Barrel: exports `createTestApp`, `TestAppOptions`, `createMockPlugin`, `MockPluginOptions`, `inject`, `createTestContext`, `TestContextOptions`, `MockServiceRegistry`, `MockResponse`, `FixtureManager`, `collectStream`, `StreamingBody`; re-exports `InjectRequest`, `InjectResponse`, `IKernelApplication` from `@hono-enterprise/kernel`.                                                    |
| `src/test-app.ts`                 | `createTestApp` — wraps `createApplication` + auto-`start()`.                                                                                                                                                                                                                                                                                                                                     |
| `src/mock-plugin.ts`              | `createMockPlugin` — returns an `IPlugin` registering a mock service.                                                                                                                                                                                                                                                                                                                             |
| `src/inject.ts`                   | `inject` free function (string/`InjectRequest`/`Request` normalization + delegation) and `collectStream` streaming reader.                                                                                                                                                                                                                                                                        |
| `src/mock-context.ts`             | `createTestContext`, `MockRequest` (internal `IRequest` double), `MockResponse` (`IResponse` double with `snapshot()` and `ended`), and the internal default fake runtime.                                                                                                                                                                                                                        |
| `src/mock-registry.ts`            | `MockServiceRegistry` — in-memory `IServiceRegistry` with registration recording.                                                                                                                                                                                                                                                                                                                 |
| `src/fixtures/fixture-manager.ts` | `FixtureManager` — collects mocks/plugins, produces `IPlugin[]`, resets.                                                                                                                                                                                                                                                                                                                          |
| `packages/testing/deno.json`      | Adds `imports` for `common`, `kernel`, `runtime` (test-only). No `test.permissions` block is planned: the root task already grants `--allow-read --allow-import --allow-env --allow-sys=hostname` (`deno.json:47`), and no test in this package binds a socket — `createTestApp` never passes a `port`. Confirm at implementation time; add a block only if a test actually fails on permissions. |
| `packages/testing/README.md`      | Package purpose, installation, usage examples, API reference links.                                                                                                                                                                                                                                                                                                                               |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                           | src covered                              | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| ----------------------------------- | ---------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `test/unit/test-app.test.ts`        | `src/test-app.ts`                        | `createTestApp({ plugins: [] })` (default `autoStart`) **rejects** with the kernel's `"No plugin provides the mandatory 'runtime' capability"` message (decision 3.1); `createTestApp({ plugins: [], autoStart: false })` resolves to an `IKernelApplication` (type-checks) — resolving at all proves `start()` was not called, since starting an empty list throws; that un-started app accepts `app.middleware.add(...)` and a subsequent `await app.start()` given a mock runtime provider, whereas the same `add` on an auto-started app throws `"Cannot add middleware after the pipeline has been compiled."`; a second `start()` throws `"Application has already been started."` (kernel invariant). **No spying on `start`** — `createTestApp` constructs the app internally via `createApplication`, so there is no seam to intercept it; auto-start is asserted through its observable effects (a successful `inject()`, and the middleware-add throw) instead. The runtime provider throughout is `createMockPlugin({ name: 'runtime', service: fakeRuntime, provides: CAPABILITIES.RUNTIME })`, keeping the unit tier free of `@hono-enterprise/runtime`. |
| `test/unit/mock-plugin.test.ts`     | `src/mock-plugin.ts`                     | `createMockPlugin({ name: 'database', service: svc })` returns an `IPlugin` with `name: 'database'`, `provides: ['database']`; `register(ctx)` calls `ctx.services.register('database', svc)` (fake `IPluginContext` with a `MockServiceRegistry`); `provides: 'db'` registers under `'db'` not `'database'`; the `register` callback runs after the service registration.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `test/unit/inject.test.ts`          | `src/inject.ts`                          | `inject(app, '/users')` calls `app.inject({ method: 'GET', url: '/users' })` (fake `IKernelApplication` records the call); `inject(app, { method: 'POST', url: '/u', body: { a: 1 } })` passes through; `inject(app, new Request('http://localhost/u', { method: 'POST', body: 'x' }))` normalizes to `{ method: 'POST', url: 'http://localhost/u', body: 'x' }`; `collectStream(new Response(stream))` returns the expected `{ chunks, text }`; `collectStream(new Response(null))` throws.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `test/unit/mock-context.test.ts`    | `src/mock-context.ts`                    | `createTestContext()` returns an `IRequestContext` with `id: 'test-ctx'`, `startTime: 0` (not `Date.now()`), `signal` a live `AbortSignal`, `services` a `MockServiceRegistry`, `response` a `MockResponse`; `MockRequest.json()`/`text()`/`bytes()` all read `options.body`; `MockResponse.json({x:1})` sets `ended`, `snapshot()` returns `{ streaming: false, status: 200, body: '{"x":1}' }`; `MockResponse.stream(s)` sets `snapshot().streaming: true`; `header` overwrites and `appendHeader` appends; `redirect`/`send`/`text` each set `ended`; **`startTime` precedence across all three levels** — default `0`, `runtime: { hrtime: () => 42 }` gives `42`, and `{ startTime: 7, runtime: { hrtime: () => 42 } }` gives `7` (decision 3.4); `runtime: { uuid: () => 'r' }` sets `id: 'r'`; `query` defaults to the parse of the request URL's search params and is overridable; `signal` override is honored.                                                                                                                                                                                                                                               |
| `test/unit/mock-registry.test.ts`   | `src/mock-registry.ts`                   | `register('t', svc)` then `get('t')` returns `svc`; `has('t')` is true; `get('missing')` throws the **verbatim** two-sentence kernel message (asserted as an exact string, per decision 3.5); `register('t', svc2)` without options throws; `register('t', svc2, { override: true })` replaces; `register('t', svc2, { multi: true })` appends; **`register('t', svc)` then `getAll('t')` returns `[svc]`** — the single registration is included, matching `service-registry.ts:77-88`; `registerFactory` resolves once and caches (factory call count is 1 after two `get`s); `unregister('t')` then `has('t')` is false and the return value reports whether anything was removed; `registrations` records every call with its `multi` flag.                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `test/unit/fixture-manager.test.ts` | `src/fixtures/fixture-manager.ts`        | `mock('database', svc).plugins()` returns one `IPlugin` with `name: 'database'`; `plugin(realPlugin)` stores it; `plugins()` returns mocks then reals in insertion order; `reset()` clears the store so `plugins()` returns `[]`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| `test/unit/barrel-exports.test.ts`  | `src/index.ts`                           | Every named export is defined (typeof check); re-exports `InjectRequest`, `InjectResponse`, `IKernelApplication` are the same types as `@hono-enterprise/kernel` (import both and assert assignability).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `test/integration/test-app.test.ts` | `src/test-app.ts` + `src/mock-plugin.ts` | `createTestApp({ plugins: [RuntimePlugin(), mockDb] })` then registering `app.router.get('/users', …)` on the returned (already-started) app — proving post-`start()` route registration works (§1); `await inject(app, '/users')` returns `{ statusCode: 200, body: '…' }`; `await app.fetch(new Request('http://localhost/users'))` returns a `Response` with status 200; the mock's service is resolvable from `app.services` under its token, and `app.services.getAll(token)` includes it — the cross-check that `MockServiceRegistry`'s `getAll` semantics match the real kernel registry (decision 3.5); `app.stop()` resolves.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `test/integration/inject.test.ts`   | `src/inject.ts`                          | Through a real started app: `inject(app, '/users')` (URL-only string arm) and `inject(app, new Request('http://localhost/users'))` return equal `InjectResponse` status and body; a POST with a JSON body round-trips through `response.json()`; a byte-body route (`response.send(bytes)`) read via `inject()` yields `body: null` — the documented `Uint8Array` limitation (§1) — while the same route through `fetch()` + `collectStream` yields the bytes.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `test/e2e/testing-e2e.test.ts`      | all `src/`                               | A full app with `RuntimePlugin()` + a real route; exercise `inject()` (non-streaming), `fetch()` (streaming via `collectStream`), `createTestContext` (unit-style middleware test inside the e2e), `FixtureManager` (multi-mock setup and reset); assert the streaming `fetch()` body is read incrementally and the inject body is the buffered string.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/33-testing-package, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; ≥90% branch/function/line every src file
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/testing/src
```

Same-PR tracking deliverables (a merged milestone that left these behind is a defect):

- Flip `ROADMAP.md:4333` row 33 from `⬜` to `✅` and check the four M33 Deliverables boxes
  (`ROADMAP.md:3381-3384`).
- Update the CLAUDE.md "Current status" section: mark M33 complete with its PR number and repoint
  "Next milestone" at M34 (CLI).
- Ship the five doc corrections named in §2 (C1 ×3 lists, C2, C3, C4, C6).
- `git mv plans/milestone-33-testing-package.md plans/archive/` and confirm
  `git ls-files plans/ | grep milestone-33` returns only the archived path.

## 8. Risks & mitigations

- **Risk:** `MockResponse.snapshot()` drifts from the kernel's `ResponseBuilder.snapshot()` shape
  (the M42 discriminated union). A middleware test that asserts `snapshot().body` against the mock
  would pass while the real builder returns a different arm. **Mitigation:**
  `MockResponse.snapshot()` returns the exact `ResponseSnapshot` union from
  `common/src/http.ts:332`; the unit test asserts both arms (`streaming: false` with `string` body,
  `streaming: true` with `ReadableStream` body) against the type, and the e2e test cross-checks the
  mock's `snapshot()` against a real `app.inject()` body.
- **Risk:** `createTestContext` defaults `startTime` to `0` but a test passes a `runtime` whose
  `hrtime()` returns an epoch-like number, or passes `startTime: Date.now()` directly, reintroducing
  the clock-mixing bug. **Mitigation:** Decisions 3.4 and 3.9 and the JSDoc on both
  `TestContextOptions.startTime` and `TestContextOptions.runtime` state that the value must be a
  monotonic reading; the unit test asserts the default is `0` and that both override levels are used
  verbatim. The `Date.now()` grep in §7 catches any `Date.now()` in `src/`.
- **Risk:** `inject`'s `Request` arm reads the body with `await request.text()`, consuming the
  stream; a test that then passes the same `Request` to `app.fetch()` gets an empty body.
  **Mitigation:** The JSDoc warns the `Request` body is consumed; the unit test asserts the body is
  read correctly and documents the one-shot nature. Tests that need the same request twice construct
  two `Request` objects.
- **Risk:** `MockServiceRegistry` diverges from the kernel's `ServiceRegistry` on any observable
  behavior, so a test passes against the mock and fails (or hides a bug) against the real one. The
  concrete near-miss this plan already corrected: `getAll` returning only the multi list, which
  would yield `[]` where the kernel yields `[svc]` (`service-registry.ts:77-88`). **Mitigation:**
  Decision 3.5 enumerates the semantics field-for-field against the kernel source — verbatim throw
  message, `getAll` including the single registration, `override`/`multi` handling, factory-caching
  — and the unit test asserts each. The integration test additionally exercises the SAME assertions
  against the real kernel registry through a started app, so a future divergence fails a test rather
  than silently changing what the doubles teach.
- **Risk:** `createTestApp` auto-starts with the real `RuntimePlugin()`, which calls
  `detectRuntime()` and may fail in an exotic test environment. **Mitigation:** The caller controls
  the plugin list. The integration and e2e tiers use the real `RuntimePlugin()` on the Deno test
  runner — the supported path, and the tier where exercising the real dependency is the point. The
  unit tier instead registers a mock runtime provider
  (`createMockPlugin({ name: 'runtime', service: fakeRuntime, provides: CAPABILITIES.RUNTIME })`),
  which needs no OS permissions and keeps `test/unit` free of `@hono-enterprise/runtime`. Note the
  `RuntimeOptions.adapters`/`httpAdapters` injection seams are marked `@internal` in the runtime
  package (§1), so this plan does NOT reach for another package's internal options — the mock-plugin
  route achieves the same isolation through public surface.

## 9. Out of scope

- A centralized `createFakeRuntime()` fixture — every package currently rolls its own
  `test/fixtures/fake-runtime.ts`; consolidating them into the testing package is a cross-package
  refactor deferred to a future milestone. `createTestContext` accepts an injected
  `IRuntimeServices` so the existing per-package fakes work today.
- Test-double factories for specific plugin services (e.g. `MockMailer`, `MockCacheStore`) — these
  belong in their respective plugin packages' test fixtures, not in the general testing package.
- A snapshot/golden-file helper. `AI_GUIDELINES.md:397` permits snapshots "sparingly, only for
  stable output (e.g., OpenAPI spec generation)" — but that names a candidate, not an existing
  practice: `grep -rln "assertSnapshot\|toMatchSnapshot\|__snapshots__" packages/` returns nothing,
  so no package in this repo snapshot-tests today. With zero current consumers, a helper here would
  be dead surface; the milestone that first needs one can add it and name its consumer.
- A Supertest-style fluent API (`request(app).get('/x').expect(200)`) — the free-function `inject`
  and the `InjectResponse` shape are the committed surface; a fluent builder is a future
  enhancement.
- The CLI (M34), SDK (M35), starters (M36), and examples (M37) that consume this package.
