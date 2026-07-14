# Milestone 39 — HTTP Server Adapters (`@hono-enterprise/runtime`)

> **Status:** Planning. Branch: `feat/m39-http-adapters`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Milestone 39 gives the framework its first real HTTP server. It implements `IHttpAdapter` for Node,
Deno, and Bun inside `packages/runtime`, registers the detected adapter under
`CAPABILITIES.HTTP_ADAPTER` via the existing `RuntimePlugin`, and proves a real round-trip:
`app.start({ port })` binds a real socket and a real `fetch`/`curl` returns a real response through
the full middleware → router → handler pipeline. Fifteen milestones were validated only through
`app.inject()` and fakes; this milestone exists to replace those fakes with a real port.

The kernel side is already wired (`application.ts:294-301` resolves `CAPABILITIES.HTTP_ADAPTER`,
calls `adapter.createServer((request) => this.#handleRequest(request))`, then
`adapter.listen(...)`); the kernel needs only one small change — fail loudly when `port` is set with
no adapter registered. The response read seam the ROADMAP once said was missing,
`IResponse.snapshot()`, already exists (`http.ts:149-153`, `response.ts:73-79`), so no `common`
contract change is required. M39 is therefore smaller than the ROADMAP describes: it writes
`IHttpAdapter` implementations, registers them, and proves a real round-trip.

- **In scope:** three `IHttpAdapter` implementations (`NodeHttpAdapter`, `DenoHttpAdapter`,
  `BunHttpAdapter`) plus their internal request/response mapping seams; `RuntimePlugin` registration
  of `CAPABILITIES.HTTP_ADAPTER`; one kernel change (`start()` throws when `port` is set but no
  adapter is registered); a real-socket round-trip test; doc corrections (ROADMAP §39, CLAUDE.md M3
  note) and PUBLIC_API.md additions for the new runtime exports.
- **NOT this milestone:** a Cloudflare Workers adapter — CF has no `listen(port)` model (it exports
  a `fetch` handler invoked by the platform, with no bound-port/`close` lifecycle), so the
  `IHttpAdapter` `createServer`/`listen(handle, port)` contract does not fit it. Deferred; the
  existing `cf-runtime.ts` stub and the `RuntimePlugin` CF throw remain. TLS/HTTPS, HTTP/2, and
  WebSocket upgrades are also out of scope (separate milestones). Auth is `M16`.

## 1. Contracts verified from SOURCE (not names)

| Reference                          | Source (file:line)                                                                                                 | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------------------------------- | ------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES.HTTP_ADAPTER`        | `packages/common/src/tokens.ts:99`                                                                                 | value `'http-adapter'`; JSDoc at `:98` states the runtime plugin registers its `IHttpAdapter` here.                                                                                                                                                                                                                                                                                                                                       |
| `IHttpAdapter`                     | `packages/common/src/runtime.ts:204-227`                                                                           | `createServer(handler: (request: IRequest) => Promise<IResponse>): ServerHandle` (`:212`); `listen(handle: ServerHandle, port: number, hostname?: string): Promise<void>` (`:220`); `close(handle: ServerHandle): Promise<void>` (`:226`).                                                                                                                                                                                                |
| `ServerHandle`                     | `packages/common/src/runtime.ts:25`                                                                                | `export type ServerHandle = unknown;` — opaque; each adapter narrows it without `as any`.                                                                                                                                                                                                                                                                                                                                                 |
| `IRequest`                         | `packages/common/src/http.ts:32-68`                                                                                | `method`, `url`, `path`, `headers: Headers`, `ip?`, `user?`, `json<T>()`, `text()`, `bytes()` — the surface an adapter builds from a native request.                                                                                                                                                                                                                                                                                      |
| `IResponse.snapshot()`             | `packages/common/src/http.ts:149-153`                                                                              | returns `{ readonly status: number; readonly headers: Headers; readonly body: Uint8Array \| string \| null }` — status + headers + body, the full read surface.                                                                                                                                                                                                                                                                           |
| `ResponseBuilder.snapshot()`       | `packages/kernel/src/context/response.ts:73-79`                                                                    | the kernel's concrete `IResponse` returns `{ status, headers, body }` from its private fields — the read seam is real and complete; no kernel internals are needed.                                                                                                                                                                                                                                                                       |
| Kernel already wired               | `packages/kernel/src/application/application.ts:294-301`                                                           | `if (options?.port !== undefined && this.#registry.has(CAPABILITIES.HTTP_ADAPTER)) { const adapter = ...get<IHttpAdapter>(...); this.#serverHandle = adapter.createServer((request: IRequest) => this.#handleRequest(request)); await adapter.listen(this.#serverHandle, options.port, options.hostname); }`.                                                                                                                             |
| `#handleRequest` return            | `packages/kernel/src/application/application.ts:401`                                                               | `async #handleRequest(request: IRequest): Promise<ResponseBuilder>` — `ResponseBuilder implements IResponse`, so the adapter receives an `IResponse` and calls `.snapshot()` (`:469` returns it).                                                                                                                                                                                                                                         |
| Silent no-listen footgun           | `packages/kernel/src/application/application.ts:295`                                                               | condition is `options?.port !== undefined && this.#registry.has(CAPABILITIES.HTTP_ADAPTER)` — `port` set with no adapter ⇒ `start()` silently serves nothing.                                                                                                                                                                                                                                                                             |
| `app.inject()` shares the pipeline | `packages/kernel/src/application/application.ts:348,381-382`                                                       | `inject()` runs `#handleRequest` then reads `response.snapshot()` — the identical path the adapter drives, so inject and the real socket share one pipeline.                                                                                                                                                                                                                                                                              |
| `StartOptions`                     | `packages/common/src/plugin.ts:328-333`                                                                            | `{ readonly port?: number; readonly hostname?: string }`.                                                                                                                                                                                                                                                                                                                                                                                 |
| `RuntimePlugin` today              | `packages/runtime/src/plugin/runtime-plugin.ts:73-96`                                                              | `platform = options?.platform ?? detectRuntime()` (`:73`); throws on `'cloudflare-workers'` (`:76-81`); `register()` builds services via a platform→factory map and registers only `CAPABILITIES.RUNTIME` (`:95`); `provides: [CAPABILITIES.RUNTIME]` (`:86`); injectable `adapters?: AdapterFactories` (`:40`) — the seam to mirror for HTTP adapters; `:91-93` throws `No adapter factory for platform` when a platform has no factory. |
| `detectRuntime()`                  | `packages/runtime/src/detector/runtime-detector.ts:27-38`                                                          | returns `'deno' \| 'bun' \| 'cloudflare-workers' \| 'node'`; default `'node'`.                                                                                                                                                                                                                                                                                                                                                            |
| No adapter exists today            | `search_files` over `packages/runtime/src` for `IHttpAdapter\|createServer\|HTTP_ADAPTER\|implements IHttpAdapter` | 0 matches. The `adapters/{node,deno,bun,cloudflare}/` files are `*-runtime.ts` only; no `IHttpAdapter` implementation and no `HTTP_ADAPTER` registration exist anywhere in the repo.                                                                                                                                                                                                                                                      |
| Runtime test permissions           | `packages/runtime/deno.json:9-13`                                                                                  | `test.permissions` grants only `sys: ["hostname"]` — no `net`; a real round-trip test that binds a port and `fetch`es needs `net: true` added.                                                                                                                                                                                                                                                                                            |
| Node static imports work           | `packages/runtime/src/adapters/node/node-runtime.ts:14-16`                                                         | the repo already imports `node:os`, `node:fs/promises`, `node:process` statically — `node:http` uses the same mechanism and loads under Deno/Node/Bun.                                                                                                                                                                                                                                                                                    |

External HTTP APIs — confirmed by reading the official docs (not memory):

- `Deno.serve` — `https://docs.deno.com/api/deno/~/Deno.serve` (read 2026-07-14): atomic
  create-and-start; the handler is web-standard
  `(request: Request) => Response | Promise<Response>`; `ServeTcpOptions` carries `port`,
  `hostname`, `reusePort`, `tcpBacklog`; `ServeOptions` carries `onListen`, `onError`, `signal`;
  returns `Deno.HttpServer` with `.addr` (bound `NetAddr`, yields the real port), `.shutdown()`
  (graceful close), and `.finished`.
- `Bun.serve` — `https://bun.sh/docs/api/http` (read 2026-07-14): atomic create-and-start;
  `fetch: (request: Request) => Response | Promise<Response>`; options `port`, `hostname`; returns a
  server with `.stop()` (graceful close) and `.requestIP(req)`.
- `node:http` — `https://nodejs.org/api/http.html` (read 2026-07-14):
  `http.createServer(requestListener)` returns `http.Server` (created without listening);
  `server.listen(port, host, callback)`; `server.close(callback)`; `request` is `IncomingMessage`
  (`.method`, `.url` = path+query, `.headers` lowercase object); `response` is `ServerResponse`
  (`.writeHead`, `.setHeader`, `.end`). Node is the only runtime whose native create/listen split
  matches the `IHttpAdapter` contract directly.

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                           | Resolution (picked side)                                                                                                                                                                                                                                                                                          | Doc deliverable (same PR)                                                                                                                                                              |
| -- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | ROADMAP §39 deferral note (`ROADMAP.md:3274-3278`) says adapters were deferred because "`IResponse` is write-only (no read/snapshot surface), so an adapter cannot serialize the response without reaching into kernel internals." | **Source is the truth: `IResponse.snapshot()` exists** (`http.ts:149-153`), added in M11 (commit `c37a2ef`) and already used by `cacheMiddleware` and `app.inject()` (`application.ts:382`). The read seam is complete — `snapshot()` returns status + headers + body. The deferral rationale is stale and false. | Rewrite ROADMAP §39 deferral note + task 1 (the "design a snapshot seam" task is already done) to state the seam shipped in M11 and M39 only implements the adapters + registers them. |
| C2 | CLAUDE.md M3 status (`CLAUDE.md:116-118`) says HTTP adapters deferred because "`IResponse` has no read surface; needs a web-standard Request/Response seam designed against the kernel."                                           | Same as C1 — `snapshot()` is the seam and it already exists.                                                                                                                                                                                                                                                      | Correct the CLAUDE.md M3 note to reference `snapshot()` (M11) as the read seam M39 builds on.                                                                                          |
| C3 | PUBLIC_API.md (`PUBLIC_API.md:3293-3297`) already correctly documents `snapshot()` as the read surface and says M39 owns wiring the concrete adapters; `:3206` documents `HTTP_ADAPTER` as single-provider.                        | No conflict — PUBLIC_API is already correct on the snapshot claim.                                                                                                                                                                                                                                                | No change for the snapshot claim; ADD the new runtime adapter exports (§4) to the PUBLIC_API runtime section in the same PR.                                                           |
| C4 | ARCHITECTURE.md (`ARCHITECTURE.md:894-896`) already names `NodeHttpAdapter`/`DenoHttpAdapter`/`BunHttpAdapter` and the `IHttpAdapter` contract (`:884-889`).                                                                       | No conflict — ARCHITECTURE already anticipates these adapters.                                                                                                                                                                                                                                                    | None (checked).                                                                                                                                                                        |

## 3. Design decisions

### 3.1 The `createServer(handler: (request: IRequest) => Promise<IResponse>)` seam — keep it, translate behind it

- **Decision:** Keep the existing `IHttpAdapter` / `IRequest` / `IResponse` contract unchanged. Each
  adapter translates the native request into an `IRequest` and serializes `IResponse.snapshot()`
  into the native response behind the contract.
- **Why:** The kernel is already wired to this exact seam (`application.ts:297-300`),
  `#handleRequest` builds the `IRequestContext` from `IRequest` (`application.ts:421`), and
  `snapshot()` already exposes the full response state (`response.ts:73-79`). Deno and Bun are
  natively web-standard `Request→Response`, but the framework's `IRequest`/`IResponse` carry more
  than a bare `Request` (path, `ip`, principal, params via context), and the kernel's context
  construction depends on `IRequest`. Making the contract web-standard would force kernel changes
  for no gain and would widen a public `common` interface. The adapters are the natural translation
  boundary — thin, per-runtime, and the only place runtime-specific HTTP shapes may appear
  (`packages/runtime` is the sanctioned home; AI_GUIDELINES §4.1/§4.3). No `common` change, no
  PUBLIC_API contract change.
- **Test home:** `test/unit/*-http-mapping.test.ts` assert `Request`/`IncomingMessage` → `IRequest`
  and `snapshot` → `Response`/`ServerResponse` directly; `test/integration/runtime-plugin.test.ts`
  asserts the full pipeline through the unchanged contract.

### 3.2 `ServerHandle = unknown` — narrow via a per-adapter handle class plus `instanceof`

- **Decision:** Each adapter declares a concrete, internal handle class (`NodeHttpServerHandle`,
  `DenoHttpServerHandle`, `BunHttpServerHandle`) holding its native server (for Deno/Bun, the
  pending handler before `listen`, since `serve` is atomic). `createServer` returns that instance
  typed as `ServerHandle`; `listen` and `close` narrow it back with an `instanceof` user-defined
  type guard. No `as any`, no `@ts-ignore`.
- **Why:** `ServerHandle` is intentionally `unknown` so `common` stays runtime-free. The handle is
  created and consumed by the same adapter, so `instanceof` is sound and type-safe; it also lets
  in-package tests read the bound port (for example `handle.server.addr.port` for Deno) by narrowing
  to the concrete class. The handle classes are internal — not exported from `src/index.ts` — but
  tests import them from the adapter module directly. This mirrors the existing `*Host` injection
  pattern (`node-runtime.ts`, `deno-runtime.ts`) where a single sanctioned boundary cast is confined
  to the adapter.
- **Test home:** `test/unit/*-http-adapter.test.ts` exercise `createServer` → `listen` → `close` and
  read the bound address via the narrowed handle.

### 3.3 `start()` with `port` but no adapter — throw, not silently skip

- **Decision:** Change `application.ts:295` so that when `options?.port !== undefined` and
  `CAPABILITIES.HTTP_ADAPTER` is NOT registered, `start()` throws a clear error such as
  `Cannot start HTTP server on port <port>: no 'http-adapter' capability is registered. Register the
  RuntimePlugin or a custom IHttpAdapter.`.
  When `port` is `undefined`, behavior is unchanged (no listen — supports inject-only apps).
- **Why:** Today `app.start({ port: 3000 })` with no adapter starts "successfully" and serves
  nothing — a silent footgun that is exactly the failure this milestone exists to make visible.
  Failing fast turns a confusing no-response into an explicit, actionable error. This is a small
  kernel change owned by this milestone; `start()` already documents that it throws for unsatisfied
  configuration (`plugin.ts:360-362`), so this extends that contract consistently.
- **Test home:** `packages/kernel/test/integration/application-http-start.test.ts` asserts
  `start({port})` throws without an adapter and listens for real with one.

### 3.4 RuntimePlugin adapter selection — platform map plus injectable `httpAdapters`

- **Decision:** Extend `RuntimePlugin` to also register an `IHttpAdapter` under
  `CAPABILITIES.HTTP_ADAPTER`. Add a `httpAdapters?: HttpAdapterFactories` option (parallel to the
  existing `adapters?: AdapterFactories` at `runtime-plugin.ts:40`) mapping platform →
  `() => IHttpAdapter`. The default map registers `DenoHttpAdapter` for `'deno'`, `NodeHttpAdapter`
  for `'node'`, `BunHttpAdapter` for `'bun'`. Add `CAPABILITIES.HTTP_ADAPTER` to `provides`. On
  `'cloudflare-workers'` the plugin already throws before registration (`runtime-plugin.ts:76-81`);
  for any platform with no HTTP adapter factory it throws `No HTTP adapter for platform: <platform>`
  (fail fast, mirroring the runtime-services factory guard at `:91-93`). An unknown runtime
  therefore never silently registers nothing.
- **Why:** Reuses the existing detection + injection pattern, keeps the adapter choice testable
  without real I/O (inject a fake `IHttpAdapter` factory, exactly as the unit test injects a fake
  runtime-services factory at `runtime-plugin.test.ts:106-109`), and makes "which adapter runs" a
  single explicit map.
- **Test home:** `test/unit/runtime-plugin.test.ts` (extended) asserts `CAPABILITIES.HTTP_ADAPTER`
  is registered for deno/node/bun with the right concrete type, that `httpAdapters` injection
  overrides the default, and that an unsupported platform throws.

### 3.5 Runtimes shipped — Node, Deno, Bun; Cloudflare explicitly out

- **Decision:** Ship `NodeHttpAdapter`, `DenoHttpAdapter`, `BunHttpAdapter`. Do NOT ship a
  Cloudflare adapter in M39.
- **Why:** Node/Deno/Bun are named in ROADMAP §39 and all bind a TCP port — they fit
  `createServer`/`listen(handle, port)`/`close`. Cloudflare Workers has no port-binding server: it
  exports a `fetch` handler invoked by the platform, with no `listen`/`close` lifecycle. Forcing it
  into `IHttpAdapter.listen(handle, port)` would be a lie (no port, no close). A CF adapter needs a
  different shape (likely a distinct export/contract) and is deferred; the existing `cf-runtime.ts`
  stub and the `RuntimePlugin` CF throw remain unchanged.
- **Test home:** `test/unit/runtime-plugin.test.ts` asserts CF/unsupported throws; no CF adapter
  test file is planned.

## 4. Exported surface — every symbol names its consumer

| Exported symbol             | Kind  | Consumer / real code path that READS it                                                                                                                               |
| --------------------------- | ----- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `NodeHttpAdapter`           | class | `RuntimePlugin` default `httpAdapters.node`; resolves `CAPABILITIES.HTTP_ADAPTER`; kernel `start()` calls `createServer`/`listen`/`close` (`application.ts:296-300`). |
| `DenoHttpAdapter`           | class | `RuntimePlugin` default `httpAdapters.deno`; same kernel path.                                                                                                        |
| `BunHttpAdapter`            | class | `RuntimePlugin` default `httpAdapters.bun`; same kernel path.                                                                                                         |
| `HttpAdapterFactories`      | type  | `RuntimeOptions.httpAdapters` consumer; the injection seam tests use.                                                                                                 |
| `RuntimeOptions` (extended) | type  | `RuntimePlugin(options)` — already exported; gains the `httpAdapters` field.                                                                                          |

Internal (NOT exported from `src/index.ts`, imported only by their adapter plus in-package tests):
`NodeHttpServerHandle`, `DenoHttpServerHandle`, `BunHttpServerHandle`, and the three
`*-http-mapping.ts` transform functions. Listed here to prove they are not dead surface — each is
read on the real request path by its adapter and by its mapping test.

### 4.1 Options — every option names its consumer

| Option                        | Consumer                                | Behavior (per implementation)                                                                                                                                                   |
| ----------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RuntimeOptions.httpAdapters` | `RuntimePlugin.register`                | Platform → `() => IHttpAdapter` map; defaults to the three concrete adapters. When provided, overrides defaults (testing seam). Throws if the detected platform has no factory. |
| `StartOptions.port`           | kernel `start()` (`application.ts:295`) | When set, requires `HTTP_ADAPTER` (else throws per 3.3) and calls `adapter.listen(handle, port, hostname)`. When unset, no listen.                                              |
| `StartOptions.hostname`       | kernel `start()` (`application.ts:300`) | Passed to `adapter.listen`; `undefined` ⇒ adapter binds all interfaces.                                                                                                         |

## 5. Implementation files

| File                                                        | Purpose                                                                                                                                                                                                                                                             |
| ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/runtime/src/adapters/deno/deno-http-adapter.ts`   | `DenoHttpAdapter implements IHttpAdapter`; `createServer` stores the handler in a `DenoHttpServerHandle`; `listen` calls `Deno.serve({ port, hostname, handler, onListen })` and stores the `Deno.HttpServer` on the handle; `close` calls `server.shutdown()`.     |
| `packages/runtime/src/adapters/deno/deno-http-mapping.ts`   | internal pure seam: `mapDenoRequest(Request): IRequest` and `mapSnapshotToDenoResponse(snapshot): Response`. NOT exported from `index.ts`.                                                                                                                          |
| `packages/runtime/src/adapters/node/node-http-adapter.ts`   | `NodeHttpAdapter implements IHttpAdapter`; `createServer` calls `http.createServer` and stores the `http.Server` in a `NodeHttpServerHandle`; `listen` calls `server.listen(port, hostname)`; `close` calls `server.close()`. Static `import ... from 'node:http'`. |
| `packages/runtime/src/adapters/node/node-http-mapping.ts`   | internal pure seam: `mapNodeRequest(IncomingMessage, body): IRequest` and `writeSnapshotToNodeResponse(snapshot, ServerResponse): void`. NOT exported.                                                                                                              |
| `packages/runtime/src/adapters/bun/bun-http-adapter.ts`     | `BunHttpAdapter implements IHttpAdapter`; `createServer` stores the handler in a `BunHttpServerHandle`; `listen` calls `Bun.serve({ port, hostname, fetch })` and stores the server; `close` calls `server.stop()`.                                                 |
| `packages/runtime/src/adapters/bun/bun-http-mapping.ts`     | internal pure seam: `mapBunRequest(Request): IRequest` and `mapSnapshotToBunResponse(snapshot): Response`. NOT exported.                                                                                                                                            |
| `packages/runtime/src/plugin/runtime-plugin.ts` (modified)  | register `CAPABILITIES.HTTP_ADAPTER` from the platform→adapter map; add `httpAdapters` option + `HttpAdapterFactories` type; add `CAPABILITIES.HTTP_ADAPTER` to `provides`.                                                                                         |
| `packages/runtime/src/index.ts` (modified)                  | export `NodeHttpAdapter`, `DenoHttpAdapter`, `BunHttpAdapter`, `HttpAdapterFactories`; extend the `RuntimeOptions` re-export.                                                                                                                                       |
| `packages/runtime/deno.json` (modified)                     | add `net: true` to `test.permissions` so the real round-trip test binds a port and `fetch`es — and actually runs rather than silently skipping.                                                                                                                     |
| `packages/kernel/src/application/application.ts` (modified) | `start()` throws when `port` is set but `HTTP_ADAPTER` is absent (3.3).                                                                                                                                                                                             |
| `ROADMAP.md` (modified)                                     | fix §39 deferral note + task list (C1).                                                                                                                                                                                                                             |
| `CLAUDE.md` (modified)                                      | fix M3 status note (C2).                                                                                                                                                                                                                                            |
| `PUBLIC_API.md` (modified)                                  | add the new runtime adapter exports to the runtime section (C3).                                                                                                                                                                                                    |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

The per-file 90% branch/function/line bar is decided here. Each new `src/` file maps to a named test
file. The external-I/O lines that only run on a specific runtime sit behind a guarded test, but the
translation and branching logic around them is extracted into the internal `*-http-mapping` seam and
unit-tested directly. The **real round-trip** is stated explicitly at the bottom of this table — a
fake standing in for a real server is not sufficient for this milestone.

| Test file                                                               | src covered                                      | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                       |
| ----------------------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/runtime/test/unit/deno-http-mapping.test.ts`                  | `adapters/deno/deno-http-mapping.ts`             | `mapDenoRequest(new Request('http://x/y?q=1', {method:'POST', body:'...'}))` → `IRequest` with `method`/`url`/`path`/`headers`; `json()`/`text()`/`bytes()` round-trip; GET-no-body. `mapSnapshotToDenoResponse({status,headers,body})` → `Response` with matching status/headers/body for `string`, `Uint8Array`, and `null`.                         |
| `packages/runtime/test/unit/node-http-mapping.test.ts`                  | `adapters/node/node-http-mapping.ts`             | `mapNodeRequest` from a fake `IncomingMessage` (method/url/headers + buffered body) → `IRequest` (`json`/`text`/`bytes`); `writeSnapshotToNodeResponse` against a fake `ServerResponse` that records `statusCode`, `setHeader`/`writeHead`, and `end(body)` for string/bytes/null.                                                                     |
| `packages/runtime/test/unit/bun-http-mapping.test.ts`                   | `adapters/bun/bun-http-mapping.ts`               | same shape as the Deno mapping (web-standard `Request`/`Response`); string/bytes/null body branches.                                                                                                                                                                                                                                                   |
| `packages/runtime/test/unit/deno-http-adapter.test.ts`                  | `adapters/deno/deno-http-adapter.ts`             | REAL round-trip: `createServer(handler)` → handle; `listen(handle, 0, '127.0.0.1')`; read the bound port from the narrowed `DenoHttpServerHandle.server.addr`; `fetch` → assert status/headers/body; `close` → a follow-up `fetch` rejects. Plus the createServer-before-listen handle shape and `instanceof` narrowing.                               |
| `packages/runtime/test/unit/node-http-adapter.test.ts`                  | `adapters/node/node-http-adapter.ts`             | REAL round-trip via `node:http` under Deno, guarded `skipIf` the `node:http` server fails to bind; same createServer/listen/fetch/close as Deno; `NodeHttpServerHandle` narrowing. The mapping seam (above) covers translation regardless.                                                                                                             |
| `packages/runtime/test/unit/bun-http-adapter.test.ts`                   | `adapters/bun/bun-http-adapter.ts`               | guarded REAL round-trip `skipIf(typeof Bun === 'undefined')`; `createServer`/handle-narrowing/not-listened-`close` unit-tested unconditionally (no Bun global needed); `listen`/`close` calling `Bun.serve`/`stop` behind the guard.                                                                                                                   |
| `packages/runtime/test/unit/runtime-plugin.test.ts` (extended)          | `plugin/runtime-plugin.ts`                       | `HTTP_ADAPTER` registered for deno/node/bun with the correct concrete type; `httpAdapters` injection override; CF/unsupported throws; `provides` includes `HTTP_ADAPTER`.                                                                                                                                                                              |
| `packages/runtime/test/integration/runtime-plugin.test.ts` (extended)   | full pipeline (runtime-plugin + kernel wiring)   | REAL round-trip: `createApplication({plugins:[RuntimePlugin()]})`, register a route, `app.start({port})`, real `fetch`, assert status/headers/body through middleware+router+handler, then `app.stop()`. The bound port is discovered with a temporary `Deno.listen({port:0})` because the kernel does not surface the OS-assigned port from `port:0`. |
| `packages/kernel/test/integration/application-http-start.test.ts` (new) | `kernel/application/application.ts` (3.3 change) | `start({port})` throws when no `HTTP_ADAPTER`; `start({port})` listens for real with one; `start()` (no port) never throws regardless of adapter.                                                                                                                                                                                                      |

**The real round-trip (the milestone's behavioral criterion):** the Deno adapter unit test and the
runtime integration test both bind a real OS socket, issue a real `fetch`, and assert the response
traversed the full plugin pipeline. `app.stop()` is called in every case. A skipped round-trip is
treated as a failure — the `net: true` permission (§5) is what makes the Deno round-trip actually
run rather than silently skip.

Modified non-`src` files (`deno.json`, `ROADMAP.md`, `CLAUDE.md`, `PUBLIC_API.md`) carry no test
mapping (config/docs).

## 7. Verification gates

```bash
git branch --show-current        # must be feat/m39-http-adapters
deno task check:plan             # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage 2>&1 | sed 's/\x1b\[[0-9;]*m//g' | grep -E '^\| runtime/src'
grep -rn 'new Function\|eval(\| require(\|as any\|@ts-ignore\|globalThis.__' packages/runtime/src
```

## 8. Risks & mitigations

- **Deno `node:http` server compatibility (the one "confirm, do not assume" item):** the plan
  assumes `http.createServer().listen()` binds a real port under Deno and is `fetch`-able, so the
  `NodeHttpAdapter` real round-trip runs in the Deno CI suite. This could not be executed during
  planning (no shell in this toolset). Mitigation: the `node-http-adapter` test guards with `skipIf`
  the bind fails, and the `node-http-mapping` seam is unit-tested unconditionally; if the compat
  server does not bind, the Node real round-trip stays guarded and the translation + lifecycle
  branching remain covered. Confirm at implementation time.
- **Test permission grant:** adding `net: true` to `packages/runtime/deno.json` `test.permissions`
  must actually grant the bound socket + `fetch` (and not be overridden by the root `deno test`
  flags). If the real round-trip test silently SKIPS
  (`Deno.permissions.query({name:'net'}).state
  !== 'granted'`), the behavioral criterion is unmet.
  Mitigation: the test guards on the permission and the config grants it; CI must show the
  round-trip RUNNING, not skipped.
- **Port discovery for the full-app test:** the kernel does not surface the OS-assigned port from
  `port:0` (changing `start(): Promise<void>` to return a port is a contract change, out of scope).
  Using a temporary `Deno.listen({port:0})` to find a free port has a tiny TOCTOU race. Mitigation:
  acceptable for tests; skip-on-`EADDRINUSE` fallback.
- **Bun coverage:** `Bun.serve` cannot run under Deno. Mitigation: the `bun-http-mapping.ts` seam
  (pure web-standard transforms) is unit-tested unconditionally; only the `Bun.serve`/`stop` I/O
  lines sit behind the guarded test. The branching around them (handle creation, `instanceof`
  narrowing, not-listened `close`) is unit-tested without Bun, so no untested branch is left.

## 9. Out of scope

- Cloudflare Workers adapter — different lifecycle (no bound port, no `listen`/`close`); deferred to
  a milestone that designs the CF-specific shape.
- TLS/HTTPS, HTTP/2, WebSocket upgrades — separate milestones.
- Surfacing the bound port from `app.start()` — would require changing `start(): Promise<void>` into
  a port-returning contract; noted as a future enhancement, not part of M39.
- Auth (`M16`), CORS/security headers (`M17`).

## Verification appendix

This appendix records how each load-bearing fact was confirmed. The source-code facts below were
verified by opening the cited file and reading the cited line with the `read_file` tool (real
content, reproduced verbatim); the external HTTP APIs were confirmed by fetching the official
documentation URLs with `web_url_read` on 2026-07-14. Per the task's "no fabricated output" rule,
the terminal-only gates that could NOT be executed in this toolset are listed verbatim as commands
to run — their output is intentionally absent, not invented.

### A. Source facts verified from the files

- `CAPABILITIES.HTTP_ADAPTER` exists — `packages/common/src/tokens.ts:99`:

  ```typescript
  HTTP_ADAPTER: 'http-adapter',
  ```

  (JSDoc at line 98: "HTTP server adapter — the runtime plugin registers its IHttpAdapter here.")

- `IHttpAdapter` exists — `packages/common/src/runtime.ts:204-227`:

  ```typescript
  export interface IHttpAdapter {
    createServer(handler: (request: IRequest) => Promise<IResponse>): ServerHandle;
    listen(handle: ServerHandle, port: number, hostname?: string): Promise<void>;
    close(handle: ServerHandle): Promise<void>;
  }
  ```

- `ServerHandle = unknown` — `packages/common/src/runtime.ts:25`:

  ```typescript
  export type ServerHandle = unknown;
  ```

- `IResponse.snapshot()` exists — `packages/common/src/http.ts:149-153`:

  ```typescript
  snapshot(): {
    readonly status: number;
    readonly headers: Headers;
    readonly body: Uint8Array | string | null;
  };
  ```

- `ResponseBuilder.snapshot()` carries status + headers + body —
  `packages/kernel/src/context/response.ts:73-79`:

  ```typescript
  snapshot(): { status: number; headers: Headers; body: Uint8Array | string | null } {
    return {
      status: this.#status,
      headers: this.#headers,
      body: this.#body,
    };
  }
  ```

- The kernel side is already wired — `packages/kernel/src/application/application.ts:294-301`:

  ```typescript
  // 8. Listen only if adapter + port are available
  if (options?.port !== undefined && this.#registry.has(CAPABILITIES.HTTP_ADAPTER)) {
    const adapter = this.#registry.get<IHttpAdapter>(CAPABILITIES.HTTP_ADAPTER);
    this.#serverHandle = adapter.createServer((request: IRequest) => this.#handleRequest(request));
    await adapter.listen(this.#serverHandle, options.port, options.hostname);
  }
  ```

  `#handleRequest` returns `Promise<ResponseBuilder>` (`application.ts:401`), and
  `ResponseBuilder implements IResponse`, so the adapter receives an `IResponse` and calls
  `.snapshot()` — exactly as `inject()` already does at `application.ts:382`.

- `app.inject()` runs the full pipeline and reads `snapshot()` —
  `packages/kernel/src/application/application.ts:348,381-382`:

  ```typescript
  async inject(request: InjectRequest): Promise<InjectResponse> {
    ...
    const response = await this.#handleRequest(syntheticRequest);
    const snapshot = response.snapshot();
  ```

- No `IHttpAdapter` implementation exists today — a `search_files` scan of `packages/runtime/src`
  for the pattern `IHttpAdapter|createServer|HTTP_ADAPTER|implements
  IHttpAdapter` returned **0
  results**. The `adapters/{node,deno,bun,cloudflare}/` directories contain only `*-runtime.ts`
  files (runtime services); no `*-http-adapter.ts` and no `HTTP_ADAPTER` registration exist anywhere
  in the repo.

- `RuntimePlugin` registers only `CAPABILITIES.RUNTIME` today —
  `packages/runtime/src/plugin/runtime-plugin.ts:86,95`:

  ```typescript
  provides: [CAPABILITIES.RUNTIME],
  ...
  ctx.services.register(CAPABILITIES.RUNTIME, services);
  ```

  It has an injectable `adapters?: AdapterFactories` option (`:40`) and throws on
  `'cloudflare-workers'` (`:76-81`) — the seam mirrored for HTTP adapters in 3.4.

- Runtime test permissions lack `net` — `packages/runtime/deno.json:9-13`:

  ```json
  "test": {
    "permissions": {
      "sys": ["hostname"]
    }
  }
  ```

### B. External HTTP APIs confirmed from official docs (read 2026-07-14)

- `Deno.serve` — fetched `https://docs.deno.com/api/deno/~/Deno.serve`. Confirmed: atomic
  create-and-start; web-standard handler `(Request) => Response | Promise<Response>`; options
  `port`, `hostname`, `onListen`, `onError`, `signal`; returns `Deno.HttpServer` exposing `.addr`
  (bound `NetAddr` with the real port), `.shutdown()`, `.finished`.
- `Bun.serve` — fetched `https://bun.sh/docs/api/http`. Confirmed: atomic create-and-start;
  `fetch: (Request) => Response | Promise<Response>`; options `port`, `hostname`; returns a server
  with `.stop()`, `.requestIP(req)`.
- `node:http` — fetched `https://nodejs.org/api/http.html`. Confirmed: `http.createServer` returns
  an `http.Server` (create without listen); `server.listen(port, host, cb)`; `server.close(cb)`;
  `IncomingMessage` has `.method`/`.url`/`.headers`; `ServerResponse` has
  `.writeHead`/`.setHeader`/`.end`.

### C. Terminal gates — could NOT be executed (no command-execution tool in this toolset)

This architect-mode toolset exposes no `execute_command` / shell capability, so the following
commands were not run and their output is NOT reproduced here (it would be fabricated). Run them on
`feat/m39-http-adapters` to produce the real appendix output:

```bash
git branch --show-current                       # expect: feat/m39-http-adapters
deno task check:plan                            # expect: plan-lint OK, 0 errors
git diff --name-only main HEAD                  # expect: plans/milestone-39-http-adapters.md only
git status --porcelain                          # expect: empty after commit
deno task fmt:check && deno task lint && deno task check && deno task test
grep -rn 'new Function\|eval(\| require(\|as any\|@ts-ignore\|globalThis.__' packages/runtime/src
```

Structural confidence that `deno task check:plan` passes: the linter (`scripts/plan-lint.ts`) fails
only on (a) an unfilled template blank, of which none remain; (b) a missing required section heading
— all nine are present (Objective & scope, Contracts verified from SOURCE, Committed-doc conflicts,
Design decisions, Exported surface, Implementation files, Test plan, Verification gates, Out of
scope); (c) a non-canonical file at `plans/` root — the only file added is
`milestone-39-http-adapters.md`, which is canonical. Undecided-alternative markers are avoided in
the prose. `deno fmt --check` on the new markdown should be confirmed when the shell is available.
