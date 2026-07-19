# Milestone 23 — Runtime Serve on Hono + Cloudflare Workers (`@hono-enterprise/runtime`, `@hono-enterprise/common`, `@hono-enterprise/kernel`)

> **Status:** Planning. Branch: `feat/23-runtime-serve-hono`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Replace the hand-rolled Node/Deno/Bun socket adapters shipped in M41 with **Hono's platform serve
layer**, expose the application as a web-standard `fetch(Request) => Promise<Response>`, and add a
real **Cloudflare Workers** adapter — delivering the CF Workers support the comparison tables
already advertise but the socket-based M41 adapters structurally cannot (CF Workers has no
`listen(port)` model). The `IHttpAdapter` contract in `common` changes from an `IRequest`-based
`createServer` handler to a web-standard `fetch` entry; the kernel gains `app.fetch`; the runtime
adapters delegate binding to `@hono/node-server` (Node), `Deno.serve` (Deno), `Bun.serve` (Bun), and
a `fetch`-export path (CF Workers). This is a net LOC reduction: ~1,030 lines of native req/res
mapping are deleted and replaced by a single shared web-standard mapping helper plus thin
per-platform binders.

- **In scope:**
  - `IHttpAdapter` contract change in `common` (`setHandler` / `fetch` / `listen(port)` / `close`).
  - `IApplication.fetch(request: Request): Promise<Response>` added to `common` and implemented by
    the kernel (delegates to the registered adapter).
  - Kernel `start()` / `stop()` rewired to the new adapter contract (`setHandler` then `listen`).
  - Shared web-standard `Request`↔`IRequest` and `IResponse.snapshot()`↔`Response` mapping helper in
    the runtime package, used by every adapter's `fetch`.
  - Node adapter rewritten to bind via `@hono/node-server` (lazy `npm:` import, injectable host
    seam); `node-http-mapping.ts` deleted.
  - Deno adapter rewritten to bind via `Deno.serve` through an injectable `DenoServeHost` seam;
    `deno-http-mapping.ts` deleted.
  - Bun adapter rewritten to use the shared mapping (keeps its `BunServeHost` seam);
    `bun-http-mapping.ts` deleted.
  - Cloudflare Workers runtime services implemented (no longer a stub) and a new
    `CloudflareWorkersHttpAdapter` (`fetch` works, `listen` throws, `close` is a no-op).
  - `RuntimePlugin` no longer throws for `cloudflare-workers`; it registers the CF runtime services
    and HTTP adapter.
  - PUBLIC_API.md, ARCHITECTURE.md, ROADMAP.md updated in the same PR.
- **NOT this milestone:**
  - Streaming response bodies (`IResponse.stream()`, `IRequestContext.signal`) — owned by **M42**.
    M23's `fetch` buffers the body (pre-reads bytes for idempotent access); M42 replaces the
    buffered path with a streaming one.
  - SSE / React SSR — owned by **M43 / M44**.
  - A Cloudflare Workers runtime with file system access — CF has no `fs`; `IRuntimeServices.fs`
    stays `undefined` on CF (by contract).

## 1. Contracts verified from SOURCE (not names)

| Reference                                          | Source (file:line)                                           | Verified surface / fact                                                                                                                                                                                                                                                                                     |
| -------------------------------------------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IHttpAdapter`                                     | `packages/common/src/runtime.ts:204`                         | Currently `createServer((IRequest)=>Promise<IResponse>): ServerHandle` + `listen(handle,port,hostname?)` + `close(handle)`. M23 replaces this surface with `setHandler` + `fetch(Request)` + `listen(port,hostname?)` + `close(handle)`.                                                                    |
| `ServerHandle`                                     | `packages/common/src/runtime.ts:25`                          | `export type ServerHandle = unknown;` — opaque, adapter-defined. Unchanged.                                                                                                                                                                                                                                 |
| `IRequest`                                         | `packages/common/src/http.ts:32`                             | `method`/`url`/`path`/`headers`/`ip?`/`user?`/`json()`/`text()`/`bytes()`. The shared mapping must produce this shape from a web `Request`. `ip` is optional and is NOT derivable from a web `Request` (see §3.4).                                                                                          |
| `IResponse.snapshot()`                             | `packages/common/src/http.ts:149`                            | Returns `{ status: number; headers: Headers; body: Uint8Array \| string \| null }`. The shared mapping reads exactly this shape to build a web `Response`.                                                                                                                                                  |
| `IApplication`                                     | `packages/common/src/plugin.ts:365`                          | Has `router`/`middleware`/`services`/`register`/`start`/`stop`. M23 adds `fetch(request: Request): Promise<Response>` (additive, non-breaking).                                                                                                                                                             |
| `StartOptions`                                     | `packages/common/src/plugin.ts:352`                          | `{ port?: number; hostname?: string }`. Unchanged; `start({ port })` still drives `listen`.                                                                                                                                                                                                                 |
| `CAPABILITIES.HTTP_ADAPTER`                        | `packages/common/src/tokens.ts:99`                           | `'http-adapter'`, single-provider. Registered by `RuntimePlugin`; consumed only by the kernel (`application.ts:302`) and the runtime plugin itself.                                                                                                                                                         |
| `CAPABILITIES.RUNTIME`                             | `packages/common/src/tokens.ts`                              | `'runtime'`, single-provider, mandatory. Unchanged.                                                                                                                                                                                                                                                         |
| Kernel `#handleRequest`                            | `packages/kernel/src/application/application.ts:407`         | `(request: IRequest) => Promise<ResponseBuilder>`; `ResponseBuilder` implements `IResponse` (has `snapshot()`). This is the handler the adapter will call.                                                                                                                                                  |
| Kernel `start()` listen block                      | `packages/kernel/src/application/application.ts:294`         | Currently `adapter.createServer(handler)` then `adapter.listen(handle, port, hostname)`. M23 rewires to `adapter.setHandler(handler)` then `adapter.listen(port, hostname)`.                                                                                                                                |
| Kernel `stop()` close block                        | `packages/kernel/src/application/application.ts:340`         | `adapter.close(this.#serverHandle)`. Unchanged shape; `close(handle)` still takes the `ServerHandle` returned by `listen`.                                                                                                                                                                                  |
| Kernel `inject()`                                  | `packages/kernel/src/application/application.ts:354`         | Already synthesizes an `IRequest` from a method/url/headers/body and maps `snapshot()` to an `InjectResponse`. Confirms the kernel already owns `IRequest` synthesis; M23's `app.fetch` delegates to the adapter (which owns the web `Request`→`IRequest` mapping) rather than duplicating `inject`'s path. |
| `RuntimePlugin` CF throw                           | `packages/runtime/src/plugin/runtime-plugin.ts:107`          | Throws `'Cloudflare Workers runtime is not yet supported'` for `platform === 'cloudflare-workers'`. M23 removes this throw and wires the CF adapters.                                                                                                                                                       |
| `defaultHttpAdapters`                              | `packages/runtime/src/plugin/runtime-plugin.ts:83`           | Maps `deno`/`node`/`bun` → adapter factories; CF explicitly absent. M23 adds the CF entry.                                                                                                                                                                                                                  |
| `createCloudflareRuntimeServices`                  | `packages/runtime/src/adapters/cloudflare/cf-runtime.ts:17`  | Currently a stub that throws. M23 implements it (moved to `workers/cf-runtime.ts`).                                                                                                                                                                                                                         |
| Deno adapter (current)                             | `packages/runtime/src/adapters/deno/deno-http-adapter.ts:41` | `createDenoHandler()` maps `Request`→`IRequest`→handler→`snapshot`→`Response` (already web-standard). M23 extracts this into the shared mapping and binds via `Deno.serve` through a `DenoServeHost` seam.                                                                                                  |
| Bun adapter (current)                              | `packages/runtime/src/adapters/bun/bun-http-adapter.ts:111`  | Injectable `BunServeHost` seam already exists; `createBunFetchHandler()` does the web-standard mapping. M23 keeps the seam, swaps the mapping to the shared helper.                                                                                                                                         |
| Node adapter (current)                             | `packages/runtime/src/adapters/node/node-http-adapter.ts:78` | Uses `node:http` `createServer` + `node-http-mapping.ts` (`IncomingMessage`/`ServerResponse`). M23 deletes this mapping and binds via `@hono/node-server` `serve({ fetch })`.                                                                                                                               |
| Hono dependency                                    | `packages/kernel/deno.json:7`                                | Kernel depends on `jsr:@hono/hono@^4.12.30` (for routing, M22). `@hono/node-server` is a SEPARATE npm package (the Node serve adapter) — not part of `@hono/hono`; M23 lazy-loads it (§3.5).                                                                                                                |
| No plugin references `IHttpAdapter`/`HTTP_ADAPTER` | grep across `packages/*-plugin`                              | Verified: only `common` (contract), `kernel` (consumer), and `runtime` (provider) reference `IHttpAdapter` / `CAPABILITIES.HTTP_ADAPTER`. The contract change is contained — no plugin breaks.                                                                                                              |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                        | Resolution (picked side)                                                                                                                                                               | Doc deliverable (same PR)                                                                                         |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------- |
| C1 | PUBLIC_API.md §36 (`PUBLIC_API.md:3697`) says "M3 provides runtime services only; HTTP server adapters are deferred to a dedicated milestone" and lists `createCloudflareRuntimeServices` as "Stub — throws". M23 makes CF real and ships the `fetch`-based adapter contract.                   | M23 wins: the deferral note is replaced with the M23 reality (Hono-serve `fetch` contract, CF Workers implemented).                                                                    | PUBLIC_API.md §36 rewritten: `IHttpAdapter` contract, `IApplication.fetch`, CF adapter row, removed mapping rows. |
| C2 | ARCHITECTURE.md §7 (`ARCHITECTURE.md:895`) shows the OLD `IHttpAdapter` (`createServer`/`listen(handle)`/`close`) and the M41 "CF Workers explicitly excluded" note (`ARCHITECTURE.md:3407`-area in ROADMAP, and the runtime-support matrix at `ARCHITECTURE.md:802` lists only Node/Deno/Bun). | M23 wins: the `IHttpAdapter` snippet is updated to `setHandler`/`fetch`/`listen(port)`/`close`; the runtime-support matrix adds Cloudflare Workers; the "CF excluded" note is removed. | ARCHITECTURE.md §7 + runtime matrix updated.                                                                      |
| C3 | ROADMAP.md M41 (`ROADMAP.md:3407`) says "Cloudflare Workers is explicitly excluded (no `listen(port)` model)" and M23 (`ROADMAP.md:2447`) says M23 "Supersedes the M41 adapters".                                                                                                               | M23 wins: M41's CF-excluded note is corrected to point at M23 as the superseder; the M23 deliverables are checked and the progress-tracking row flips to ✅.                           | ROADMAP.md M41 note + M23 deliverables + progress table.                                                          |

## 3. Design decisions

### 3.1 `IHttpAdapter` contract — `fetch` entry on the adapter

- **Decision:** The new `IHttpAdapter` surface is
  `setHandler(handler: (request: IRequest) => Promise<IResponse>): void` (kernel calls this once at
  `start()`, after the pipeline compiles, before any `fetch`/`listen`),
  `fetch(request: Request): Promise<Response>` (the universal web-standard entry),
  `listen(port: number, hostname?: string): Promise<ServerHandle>` (binds `adapter.fetch` to a real
  socket), and `close(handle: ServerHandle): Promise<void>`. The kernel exposes
  `app.fetch(request: Request): Promise<Response>` which delegates to `adapter.fetch` (resolved from
  `CAPABILITIES.HTTP_ADAPTER`).
- **Why:** `fetch` must be callable without `listen` (Cloudflare Workers exports `fetch` and never
  binds a socket), so the handler cannot be passed only at `listen` time. `setHandler` mirrors the
  current `createServer(handler)` call (which also receives the handler at `start()` time, not at
  factory construction) and lets `fetch` work after `start()` with no `port`. Putting `fetch` on the
  adapter (not just the kernel) matches the ROADMAP ("`IHttpAdapter` exposes the app's `fetch`") and
  keeps the web `Request`↔`IRequest` mapping in the runtime package, the sanctioned home for
  HTTP-adapter code.
- **Test home:** `test/unit/runtime-plugin.test.ts` (adapter registered under `HTTP_ADAPTER`,
  `setHandler` callable); `test/unit/{node,deno,bun,cf}-http-adapter.test.ts` (`fetch` round-trip
  through a fake handler; `listen`/`close` per platform); `test/integration/*-http-adapter.test.ts`
  (real socket round-trip); kernel `test/integration/application.test.ts` (`app.fetch` delegates).

### 3.2 Shared web-standard mapping — one helper for all adapters

- **Decision:** A single helper at `packages/runtime/src/adapters/shared/fetch-mapping.ts` provides
  `mapWebRequestToFrameworkRequest(request: Request): Promise<IRequest>` (pre-reads the body into
  bytes for idempotent `json()`/`text()`/`bytes()` access) and
  `mapSnapshotToWebResponse(snapshot): Response`. Every adapter's `fetch` composes these two; the
  per-platform `*-http-mapping.ts` files are deleted.
- **Why:** The Deno and Bun adapters already did near-identical web-standard mapping; the Node
  adapter's `IncomingMessage`/`ServerResponse` mapping is replaced entirely by `@hono/node-server`
  (which does the native↔web conversion itself). One shared helper removes the duplication, fixes a
  latent bug (Deno/Bun currently delegate to `request.json()` etc., which fails on a second read —
  pre-reading makes body access idempotent, matching the old Node adapter's behavior), and is
  pure/unit-testable with no platform permissions.
- **Test home:** `test/unit/fetch-mapping.test.ts` (Request→IRequest field-by-field; idempotent
  multi-read; snapshot→Response status/headers/body for string/bytes/null).

### 3.3 Body buffering — pre-read, not streaming

- **Decision:** `mapWebRequestToFrameworkRequest` pre-reads the full body via
  `await request.arrayBuffer()` before constructing the `IRequest`. `fetch` therefore buffers the
  entire request body before the handler runs.
- **Why:** `IRequest.json/text/bytes` must be safely callable more than once (middleware + handler
  both read the body today; the Node adapter already pre-reads for this reason). A web `Request`
  body is one-shot, so delegation is unsafe. Streaming is M42's concern (`IResponse.stream()` and
  `IRequestContext.signal`); M23 deliberately does not introduce a streaming read path that M42
  would then have to rework.
- **Test home:** `test/unit/fetch-mapping.test.ts` (assert `json()` then `text()` then `bytes()` all
  return consistent data from a single `Request`).

### 3.4 Client IP — not populated on the web-standard path

- **Decision:** The shared mapping does NOT set `IRequest.ip`. The old Node adapter populated it
  from `socket.remoteAddress`; a web `Request` carries no client IP. Consumers needing the client IP
  must read a proxy header (`X-Forwarded-For`, `X-Real-IP`) in their own middleware.
- **Why:** `ip` is optional on `IRequest` (`http.ts:42`); populating it would require a
  platform-specific reach into the native socket, which defeats the web-standard `fetch` contract
  and is exactly the native mapping M23 deletes. This is a deliberate, flagged regression on the
  Node path, shipped as a PUBLIC_API/ARCHITECTURE note.
- **Test home:** `test/unit/fetch-mapping.test.ts` (assert `ip` is `undefined` on the mapped
  request); `test/unit/node-http-adapter.test.ts` (assert no `ip` on the round-tripped request).

### 3.5 `@hono/node-server` — lazy `npm:` import with an injectable host seam

- **Decision:** The Node adapter takes an injectable `NodeServeHost` interface
  (`serve({ fetch, port, hostname }): NodeServer` where `NodeServer` has `close()`). The default
  host lazy-loads `@hono/node-server` via `await import('npm:@hono/node-server@^2.0.0')` inside
  `serve()` and throws a clear error if the import fails (package not installed). Unit tests inject
  a fake host that records `serve`/`close` calls; one guarded integration test exercises the REAL
  `import('npm:@hono/node-server')` (skipped when the dep is absent).
- **Verified API surface (web search, 2026-07-19):** The latest published line is **v2.x** (GitHub
  releases tag `v2.0.10` "Latest" on 2026-07-15; `v2.0.0` shipped 2026-04-21 — see
  https://github.com/honojs/node-server/releases). The plan's earlier `^1.13.0` pin was stale and
  would resolve only to the v1 line, missing v2's perf and security fixes.
  `serve(options,
  listeningListener?)` accepts `options.fetch` (a **web-standard**
  `(request: Request) =>
  Response | Promise<Response>` handler — the adapter does the
  `IncomingMessage`→`Request` and `Response`→`ServerResponse` bridging itself), `options.port`
  (default `3000`), `options.hostname`, `options.createServer`, `options.serverOptions`,
  `options.overrideGlobalObjects` (default `true`), `options.autoCleanupIncoming` (default `true`),
  and `options.websocket`. It returns a native Node.js `http.Server` / `http2.Http2Server` /
  `http2.Http2SecureServer` whose close method is **`close()`** (standard `http.Server.close()`, NOT
  `shutdown()` — source: README https://github.com/honojs/node-server and DeepWiki Server API
  https://deepwiki.com/honojs/node-server/4.1-server-api). The package is ESM-only (`type: module`
  added in v2, PR #336) with bundled TypeScript types (99.2% TS), so the `npm:` specifier resolves
  cleanly under Deno. **v2 breaking changes**
  (https://github.com/honojs/node-server/releases/tag/v2.0.0): (1) dropped Node.js v18 — requires
  **Node.js v20+**; (2) removed `@hono/node-server/vercel` (unused by M23); (3) the public `serve()`
  API is unchanged. None of these affect M23's `serve({ fetch, port, hostname })` usage.
- **`overrideGlobalObjects: false` in the default host:** `@hono/node-server` v2 defaults
  `overrideGlobalObjects` to `true`, which rewrites the global `Request`/`Response` with lightweight
  implementations for speed. Inside the Hono Enterprise runtime that global mutation would leak
  across adapters and corrupt the shared web-standard mapping (§3.2). The default `NodeServeHost`
  therefore calls `serve({ fetch, port, hostname, overrideGlobalObjects: false })` so the Node
  adapter never mutates globals; the `NodeServeHost` interface exposes the full options object so a
  consumer can opt back in. This is asserted in the unit test (fake host records
  `overrideGlobalObjects: false`).
- **Why:** `@hono/node-server` is a Node-only npm package (AI_GUIDELINES §12.2 — heavy dep, never a
  hard dependency). The injectable-host pattern is identical to the existing `BunServeHost` seam
  (`bun-http-adapter.ts:24`), making the Node adapter fully unit-testable with no `net` permission
  and no guarded skips for the branching logic. The lazy import is the ONLY load path; there is no
  `globalThis.__` shim (CLAUDE.md "Common pitfalls").
- **Test home:** `test/unit/node-http-adapter.test.ts` (fake host: `listen` calls `host.serve` with
  the `fetch`/`port`/`hostname` and `overrideGlobalObjects: false`; `close` calls `server.close`;
  type-guard on the handle); `test/integration/node-http-adapter.test.ts` (guarded real
  `@hono/node-server` import + real socket round-trip, skipped when the dep is missing).

### 3.6 Deno adapter — injectable `DenoServeHost` seam

- **Decision:** The Deno adapter takes an injectable `DenoServeHost` interface
  (`serve({ port, hostname, fetch }): DenoServer` where `DenoServer` has
  `shutdown(): Promise<void>`). The default host is built from the real `Deno.serve` global via a
  single sanctioned cast. Unit tests inject a fake host (no `net` permission needed); the
  integration test binds a real socket.
- **Why:** The current Deno adapter calls `Deno.serve` directly, forcing every unit test to need
  `net: true`. An injectable seam (matching `BunServeHost` and the new `NodeServeHost`) makes the
  Deno adapter unit-testable in isolation and the real-socket path an explicit integration test.
- **Test home:** `test/unit/deno-http-adapter.test.ts` (fake host records `serve`/`shutdown`);
  `test/integration/deno-http-adapter.test.ts` (real `Deno.serve` round-trip).

### 3.7 Cloudflare Workers — `fetch` works, `listen` throws, `close` no-op

- **Decision:** `CloudflareWorkersHttpAdapter` implements `setHandler`/`fetch` (using the shared
  mapping), `listen(port, hostname?)` which throws
  `'Cloudflare Workers has no listen(port) model — export default { fetch: app.fetch } instead'`,
  and `close(handle)` which is a no-op (returns `Promise.resolve()`). The CF runtime services
  (`createCloudflareRuntimeServices`) are implemented for real: `platform()` returns
  `'cloudflare-workers'`, `uuid()`/`randomBytes()`/`subtle` use the global `crypto`,
  `now()`/`hrtime()` use `performance`, timers use the global `setTimeout`/`clearTimeout`, `env`
  reads from the Workers env (passed via a `globals`/`env` injection seam for testability), `exit`
  throws, and `fs` is `undefined` (no file system on edge).
- **Why:** CF Workers' model is `export default { fetch }` — there is no socket to bind, so `listen`
  must fail loudly (a silent no-op would hide a misconfigured deploy). `close` is a no-op because
  there is no server handle to close. The runtime services are mandatory (`RuntimePlugin` registers
  `CAPABILITIES.RUNTIME`); the stub throw blocked any CF deployment.
- **Test home:** `test/unit/cf-http-adapter.test.ts` (`fetch` round-trip; `listen` throws; `close`
  no-op); `test/unit/cf-runtime.test.ts` (each `IRuntimeServices` method; `fs` undefined; env
  injection seam).

### 3.8 Kernel `app.fetch` — delegate to the adapter

- **Decision:** `IApplication` gains `fetch(request: Request): Promise<Response>`. The kernel
  implementation resolves `IHttpAdapter` from `CAPABILITIES.HTTP_ADAPTER` and returns
  `adapter.fetch(request)`. `start()` calls
  `adapter.setHandler((request: IRequest) =>
  this.#handleRequest(request))` whenever the adapter
  is present (regardless of whether `port` is set), then, only when `port` is provided, calls
  `adapter.listen(port, hostname)` and stores its returned `ServerHandle` as
  `this.#serverHandle = await adapter.listen(port, hostname)` (the new `listen(port, hostname?)`
  RETURNS the handle — it no longer receives one, so `start()` must capture the return value).
  `stop()` calls `adapter.close(this.#serverHandle)` when a handle exists.
- **Why:** `setHandler` must run even without `port` so `app.fetch` works on CF Workers (where
  `start()` is called with no port, then `export default { fetch: app.fetch }`). Keeping the
  adapter-optional behavior (no adapter registered → no `setHandler`/`listen`, pure-`inject` apps
  still work) preserves backward compatibility for tests that build a kernel app with no
  `RuntimePlugin` HTTP adapter.
- **Test home:** `test/integration/application.test.ts` (`app.fetch` returns the handler's response;
  `start({ port })` calls `setHandler` then `listen`; `start()` with no port still enables
  `app.fetch`; `stop()` calls `close`).

### 3.9 Directory layout — `cloudflare/` renamed to `workers/`

- **Decision:** The existing `packages/runtime/src/adapters/cloudflare/` directory is renamed to
  `workers/` and both `cf-runtime.ts` (implemented) and the new `cf-http-adapter.ts` live there. The
  `shared/` directory holds `fetch-mapping.ts`. Imports in `runtime-plugin.ts` and `index.ts` are
  updated.
- **Why:** The ROADMAP lists `src/adapters/workers/*` for the new adapter; keeping a separate
  `cloudflare/` dir for runtime services and a `workers/` dir for the HTTP adapter for the same
  platform is confusing. Consolidating into `workers/` matches the ROADMAP and keeps one dir per
  platform (node/deno/bun/workers).
- **Test home:** `test/unit/cf-runtime.test.ts` and `test/unit/cf-http-adapter.test.ts` import from
  the new path; `test/unit/barrel-exports.test.ts` (NEW for the runtime package) asserts the public
  surface.

## 4. Exported surface — every symbol names its consumer

### 4.1 `@hono-enterprise/common` (contract changes)

| Exported symbol              | Kind             | Consumer / real code path that READS it                                                                                                                                                                |
| ---------------------------- | ---------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `IHttpAdapter` (changed)     | interface        | `packages/kernel/src/application/application.ts` (`start`/`stop`/`fetch` resolve and call it); `packages/runtime/src/plugin/runtime-plugin.ts` (registers it); all four runtime adapters implement it. |
| `IApplication.fetch` (added) | interface method | Cloudflare Workers consumer code (`export default { fetch: app.fetch }`); kernel `Application.fetch` implements it.                                                                                    |

### 4.2 `@hono-enterprise/kernel`

| Exported symbol                                            | Kind             | Consumer / real code path that READS it    |
| ---------------------------------------------------------- | ---------------- | ------------------------------------------ |
| `IKernelApplication.fetch` (inherited from `IApplication`) | interface method | CF Workers export path; integration tests. |

### 4.3 `@hono-enterprise/runtime` (values)

| Exported symbol                                                                       | Kind           | Consumer / real code path that READS it                                                                                                                                                     |
| ------------------------------------------------------------------------------------- | -------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RuntimePlugin`                                                                       | function       | Application authors; `runtime-plugin.test.ts`. Registers the adapter under `HTTP_ADAPTER`.                                                                                                  |
| `RuntimeOptions`                                                                      | type           | Application authors passing `platform`/`adapters`/`httpAdapters`.                                                                                                                           |
| `HttpAdapterFactories`                                                                | type           | Tests injecting fake adapters; now includes `'cloudflare-workers'`.                                                                                                                         |
| `detectRuntime`, `GlobalScope`                                                        | function/type  | `RuntimePlugin` auto-detection; unchanged.                                                                                                                                                  |
| `createDenoRuntimeServices`, `DenoHost`, `DenoFileInfo`, `DenoDirEntry`               | function/types | `RuntimePlugin` default factory; unchanged.                                                                                                                                                 |
| `buildNodeHost`, `createNodeRuntimeServices`, `NodeHost`, `NodeFsInfo`, `NodeModules` | function/types | `RuntimePlugin` default factory; unchanged.                                                                                                                                                 |
| `createBunRuntimeServices`, `BunHost`, `BunFileInfo`                                  | function/types | `RuntimePlugin` default factory; unchanged.                                                                                                                                                 |
| `createCloudflareRuntimeServices` (now real)                                          | function       | `RuntimePlugin` default CF factory; `cf-runtime.test.ts`.                                                                                                                                   |
| `DenoHttpAdapter` (rewritten)                                                         | class          | `RuntimePlugin` default Deno HTTP adapter factory; `deno-http-adapter.test.ts`.                                                                                                             |
| `NodeHttpAdapter` (rewritten)                                                         | class          | `RuntimePlugin` default Node HTTP adapter factory; `node-http-adapter.test.ts`.                                                                                                             |
| `BunHttpAdapter` (rewritten)                                                          | class          | `RuntimePlugin` default Bun HTTP adapter factory; `bun-http-adapter.test.ts`.                                                                                                               |
| `CloudflareWorkersHttpAdapter` (NEW)                                                  | class          | `RuntimePlugin` default CF HTTP adapter factory; `cf-http-adapter.test.ts`.                                                                                                                 |
| `NodeServeHost`, `NodeServer` (NEW)                                                   | types          | `NodeHttpAdapter` constructor injection seam; `node-http-adapter.test.ts` fake host.                                                                                                        |
| `DenoServeHost`, `DenoServer` (NEW)                                                   | types          | `DenoHttpAdapter` constructor injection seam; `deno-http-adapter.test.ts` fake host.                                                                                                        |
| `BunServeHost`, `BunServer` (existing)                                                | types          | `BunHttpAdapter` constructor injection seam; unchanged.                                                                                                                                     |
| `isNodeHttpServerHandle`, `isDenoHttpServerHandle`, `isBunHttpServerHandle`           | functions      | Each adapter's own `close(handle)` uses its guard to validate the handle before closing (real path, not test-only).                                                                         |
| `mapWebRequestToFrameworkRequest`, `mapSnapshotToWebResponse` (NEW, internal helper)  | functions      | NOT exported from `src/index.ts` (internal to the runtime package); consumed by all four adapters' `fetch`. Exported surface stays clean — the helper is tested directly via its file path. |

> Removed exports: the per-platform `*-http-mapping.ts` modules (`mapNodeRequest`,
> `writeSnapshotToNodeResponse`, `mapDenoRequest`, `mapSnapshotToDenoResponse`, `mapBunRequest`,
> `mapSnapshotToBunResponse`) are deleted along with their files; they were never exported from
> `src/index.ts` (internal), so no public-surface row is removed. PUBLIC_API.md rows for the deleted
> internal handle types are corrected.

### 4.4 Options — every option names its consumer

| Option                                        | Consumer                       | Behavior (per implementation)                                                                                      |
| --------------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------ |
| `RuntimeOptions.platform`                     | `RuntimePlugin`                | Force a platform; selects the runtime + HTTP adapter factory. Now accepts `'cloudflare-workers'` without throwing. |
| `RuntimeOptions.adapters`                     | `RuntimePlugin`                | Override runtime-service factories (test seam). Unchanged.                                                         |
| `RuntimeOptions.httpAdapters`                 | `RuntimePlugin`                | Override HTTP-adapter factories (test seam). Now may include a `'cloudflare-workers'` entry.                       |
| `NodeHttpAdapter(host?)` ctor arg             | `NodeHttpAdapter`              | Injectable `NodeServeHost`; defaults to the lazy-`@hono/node-server` host.                                         |
| `DenoHttpAdapter(host?)` ctor arg             | `DenoHttpAdapter`              | Injectable `DenoServeHost`; defaults to the real `Deno.serve` host.                                                |
| `BunHttpAdapter(host?)` ctor arg              | `BunHttpAdapter`               | Injectable `BunServeHost`; defaults to the real `Bun` global. Unchanged.                                           |
| `CloudflareWorkersHttpAdapter()` ctor         | `CloudflareWorkersHttpAdapter` | No args; `fetch` uses the shared mapping, `listen` throws, `close` no-op.                                          |
| `StartOptions.port` / `StartOptions.hostname` | Kernel `start()`               | Drive `adapter.listen(port, hostname)`; unchanged.                                                                 |

## 5. Implementation files

| File                                                       | Purpose                                                                                                                                                                                                          |
| ---------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/src/runtime.ts`                           | `IHttpAdapter` contract: `setHandler` / `fetch` / `listen(port,hostname?)` / `close`.                                                                                                                            |
| `packages/common/src/plugin.ts`                            | `IApplication.fetch(request: Request): Promise<Response>` added.                                                                                                                                                 |
| `packages/kernel/src/application/application.ts`           | `fetch()` delegate; `start()` calls `setHandler` + `listen`; `stop()` calls `close`.                                                                                                                             |
| `packages/runtime/src/adapters/shared/fetch-mapping.ts`    | NEW shared `mapWebRequestToFrameworkRequest` + `mapSnapshotToWebResponse`.                                                                                                                                       |
| `packages/runtime/src/adapters/node/node-http-adapter.ts`  | Rewrite: `setHandler`/`fetch` (shared mapping)/`listen` (lazy `@hono/node-server` via `NodeServeHost`)/`close`.                                                                                                  |
| `packages/runtime/src/adapters/node/node-http-mapping.ts`  | DELETE (replaced by shared mapping + `@hono/node-server`).                                                                                                                                                       |
| `packages/runtime/src/adapters/deno/deno-http-adapter.ts`  | Rewrite: `setHandler`/`fetch` (shared mapping)/`listen` (`Deno.serve` via `DenoServeHost`)/`close`.                                                                                                              |
| `packages/runtime/src/adapters/deno/deno-http-mapping.ts`  | DELETE (replaced by shared mapping).                                                                                                                                                                             |
| `packages/runtime/src/adapters/bun/bun-http-adapter.ts`    | Rewrite: `setHandler`/`fetch` (shared mapping)/`listen` (`Bun.serve` via existing `BunServeHost`)/`close`.                                                                                                       |
| `packages/runtime/src/adapters/bun/bun-http-mapping.ts`    | DELETE (replaced by shared mapping).                                                                                                                                                                             |
| `packages/runtime/src/adapters/workers/cf-runtime.ts`      | NEW (moved from `cloudflare/`): implemented `IRuntimeServices` for CF Workers.                                                                                                                                   |
| `packages/runtime/src/adapters/workers/cf-http-adapter.ts` | NEW: `CloudflareWorkersHttpAdapter` (`fetch`/`listen` throws/`close` no-op).                                                                                                                                     |
| `packages/runtime/src/adapters/cloudflare/cf-runtime.ts`   | DELETE (moved to `workers/`).                                                                                                                                                                                    |
| `packages/runtime/src/plugin/runtime-plugin.ts`            | Remove CF throw; add CF runtime + HTTP adapter to defaults; `HttpAdapterFactories` includes CF.                                                                                                                  |
| `packages/runtime/src/index.ts`                            | Update exports: add `CloudflareWorkersHttpAdapter`, `NodeServeHost`/`NodeServer`, `DenoServeHost`/`DenoServer`; remove deleted mapping re-exports (none existed); update `createCloudflareRuntimeServices` path. |
| `packages/runtime/deno.json`                               | No `@hono/node-server` import-map entry needed (lazy `npm:` import resolves at runtime); `test.permissions` unchanged (`net: true` already present for integration tests).                                       |
| `PUBLIC_API.md`                                            | §36 rewritten: `IHttpAdapter` contract, `IApplication.fetch`, CF adapter row, removed mapping rows, CF runtime services no longer a stub.                                                                        |
| `ARCHITECTURE.md`                                          | §7 `IHttpAdapter` snippet + runtime-support matrix (CF now real) + "CF excluded" note removed.                                                                                                                   |
| `ROADMAP.md`                                               | M23 deliverables checked; M41 CF-excluded note corrected; progress-tracking row → ✅.                                                                                                                            |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                                                                                                                                                                 | src covered                                                       | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/common/test/unit/types.test.ts` (existing, extended)                                                                                                                                                            | `packages/common/src/runtime.ts`, `packages/common/src/plugin.ts` | Type-level: `IHttpAdapter` has `setHandler`/`fetch`/`listen`/`close`; `IApplication` has `fetch`. (These are interface files with no runtime behavior — `deno check` is the coverage gate; the test asserts the new shapes compile against a fake adapter/app.)                                                                                                                                                                                                                       |
| `packages/runtime/test/unit/fetch-mapping.test.ts` (NEW)                                                                                                                                                                  | `src/adapters/shared/fetch-mapping.ts`                            | `mapWebRequestToFrameworkRequest(Request)` produces `IRequest` with correct `method`/`url`/`path`/`headers`; `json()`/`text()`/`bytes()` each return consistent data and are safely callable more than once (idempotent pre-read); `ip` is `undefined`. `mapSnapshotToWebResponse({status,headers,body})` builds a `Response` with matching status, headers, and body for `string`/`Uint8Array`/`null`.                                                                               |
| `packages/runtime/test/unit/node-http-adapter.test.ts` (rewritten)                                                                                                                                                        | `src/adapters/node/node-http-adapter.ts`                          | With a fake `NodeServeHost`: `setHandler` stores the handler; `fetch(Request)` maps via the shared helper and returns the handler's `Response`; `listen(port,hostname)` calls `host.serve({ fetch, port, hostname })` and stores the returned `NodeServer`; `close(handle)` calls `server.close()`; `isNodeHttpServerHandle` accepts/rejects handles; `listen` with no host throws the lazy-import error when `@hono/node-server` is absent (driven by a host whose `serve` rejects). |
| `packages/runtime/test/unit/deno-http-adapter.test.ts` (NEW — replaces integration-only coverage)                                                                                                                         | `src/adapters/deno/deno-http-adapter.ts`                          | With a fake `DenoServeHost`: `setHandler`/`fetch` round-trip; `listen(port,hostname)` calls `host.serve({ port, hostname, fetch })`; `close(handle)` calls `server.shutdown()`; type-guard.                                                                                                                                                                                                                                                                                           |
| `packages/runtime/test/unit/bun-http-adapter.test.ts` (rewritten)                                                                                                                                                         | `src/adapters/bun/bun-http-adapter.ts`                            | With a fake `BunServeHost` (existing seam): `setHandler`/`fetch` round-trip via shared mapping; `listen` calls `host.serve({ port, hostname?, fetch })`; `close` calls `server.stop()`; type-guard.                                                                                                                                                                                                                                                                                   |
| `packages/runtime/test/unit/cf-http-adapter.test.ts` (NEW)                                                                                                                                                                | `src/adapters/workers/cf-http-adapter.ts`                         | `setHandler`/`fetch` round-trip via shared mapping; `listen(port)` throws `'Cloudflare Workers has no listen(port) model'`; `close(handle)` is a no-op (resolves).                                                                                                                                                                                                                                                                                                                    |
| `packages/runtime/test/unit/cf-runtime.test.ts` (rewritten from existing stub test)                                                                                                                                       | `src/adapters/workers/cf-runtime.ts`                              | `platform()` returns `'cloudflare-workers'`; `uuid()`/`randomBytes()` use `crypto`; `subtle` is `crypto.subtle`; `now()`/`hrtime()` use `performance`; timers work; `env` reads from the injected env seam; `fs` is `undefined`; `exit` throws.                                                                                                                                                                                                                                       |
| `packages/runtime/test/unit/runtime-plugin.test.ts` (rewritten)                                                                                                                                                           | `src/plugin/runtime-plugin.ts`                                    | CF platform NO LONGER throws; CF registers a `CloudflareWorkersHttpAdapter` under `HTTP_ADAPTER`; `HttpAdapterFactories` accepts a `'cloudflare-workers'` entry; default factories map each platform to the right adapter; `setHandler`/`fetch`/`listen`/`close` are the adapter surface (fake adapter records calls).                                                                                                                                                                |
| `packages/runtime/test/unit/barrel-exports.test.ts` (NEW)                                                                                                                                                                 | `src/index.ts`                                                    | Asserts every documented export is present and every removed export is gone (no stale `mapNodeRequest` etc. leaks).                                                                                                                                                                                                                                                                                                                                                                   |
| `packages/runtime/test/integration/node-http-adapter.test.ts` (rewritten)                                                                                                                                                 | `src/adapters/node/node-http-adapter.ts` (real path)              | Guarded REAL `await import('npm:@hono/node-server@^2.0.0')` — skipped when the dep is absent; when present, binds a real socket, issues a real `fetch`, asserts the round-trip status/body/headers, then `close()`.                                                                                                                                                                                                                                                                   |
| `packages/runtime/test/integration/deno-http-adapter.test.ts` (rewritten)                                                                                                                                                 | `src/adapters/deno/deno-http-adapter.ts` (real path)              | Real `Deno.serve` socket round-trip: `fetch` returns the handler's response; `close` shuts the server down.                                                                                                                                                                                                                                                                                                                                                                           |
| `packages/runtime/test/integration/runtime-plugin.test.ts` (extended)                                                                                                                                                     | `src/plugin/runtime-plugin.ts` (real path)                        | A kernel app with `RuntimePlugin({ platform: 'deno' })` + a route, started on a real port, round-trips a request through `app.fetch`/`adapter.fetch` end-to-end.                                                                                                                                                                                                                                                                                                                      |
| `packages/kernel/test/integration/application.test.ts` (extended)                                                                                                                                                         | `packages/kernel/src/application/application.ts`                  | `app.fetch(Request)` returns the route handler's `Response`; `start({ port })` calls `setHandler` then `listen`; `start()` with no port still enables `app.fetch` (CF-style path, using a fake adapter); `stop()` calls `close`.                                                                                                                                                                                                                                                      |
| DELETE `test/unit/node-http-mapping.test.ts`, `test/unit/deno-http-mapping.test.ts`, `test/unit/bun-http-mapping.test.ts`, `test/unit/node-http-adapter-coverage.test.ts`, `test/unit/node-http-mapping-coverage.test.ts` | (deleted src)                                                     | The mapping logic they covered is now in `fetch-mapping.test.ts`; the coverage-only tests are obsolete.                                                                                                                                                                                                                                                                                                                                                                               |

> Per-file 90% bar: every NEW `src/` file (`fetch-mapping.ts`, `cf-http-adapter.ts`, `cf-runtime.ts`
> moved) and every REWRITTEN adapter (`node`/`deno`/`bun`/`cf` http-adapter) must clear 90% branch /
> function / line. The injectable-host seams make the branching logic (host present vs. absent,
> `listen` vs. `fetch`-only, `close` on a null handle) fully unit-coverable with no guarded skips
> except the single real `@hono/node-server` import line. `runtime.ts` and `plugin.ts` in `common`
> are interface-only — `deno check` is their gate (no runtime branches to cover).

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/23-runtime-serve-hono, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
```

After implementation, also grep for forbidden constructs in the touched packages:
`grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/common/src packages/kernel/src packages/runtime/src`
— must be empty (comments excepted). The lazy `await import('npm:@hono/node-server@^2.0.0')` is the
only dynamic import; there is no `globalThis.__` shim and no `new Function`.

## 8. Risks & mitigations

- **`@hono/node-server` version drift:** the lazy import pins `^2.0.0` (verified latest line is v2.x
  — `v2.0.10` "Latest" on 2026-07-15, per https://github.com/honojs/node-server/releases). If the
  published API of `serve({ fetch, port, hostname })` differs at the pinned version, the guarded
  real-import integration test fails loudly (not silently). Mitigation: the `NodeServeHost`
  interface is the only surface the adapter depends on; if `@hono/node-server`'s return shape
  changes, only the default host's cast changes, not the adapter logic. Note v2 requires Node.js
  v20+ (v18 dropped); the runtime's Node detector does NOT enforce a minimum version (it only
  reports `nodeVersion` as a string — `packages/runtime/src/adapters/node/node-runtime.ts:69`), and
  M23 adds no such gate. Running the Node adapter on v18 is a deployer concern surfaced by
  `@hono/node-server`'s own engines requirement, not enforced by this package — so M23 introduces no
  new version constraint at all.
- **CF Workers runtime services env access:** CF Workers does not expose a global `env` object the
  way Node/Deno do; bindings arrive via the `env` parameter of the `fetch` handler. Mitigation:
  `createCloudflareRuntimeServices` accepts an injectable env source (defaulting to an empty record
  plus a `globals` seam), and the plan documents that CF env bindings are wired by the deployer
  through the adapter's `fetch` path (a follow-up concern if the kernel needs per-request env — not
  in M23 scope).
- **Behavioral regression on `IRequest.ip`:** Node consumers that read `ctx.request.ip` will see
  `undefined` after M23. Mitigation: flagged in §3.4, documented in PUBLIC_API/ARCHITECTURE, and
  asserted in tests; the migration note points consumers at `X-Forwarded-For` middleware.
- **Coverage drop from deleted mapping tests:** deleting `*-http-mapping.ts` removes their test
  files; the shared `fetch-mapping.test.ts` must cover the consolidated logic at 90%+. Mitigation:
  the test plan maps every mapping branch (string/bytes/null body, idempotent multi-read, header
  fidelity) to `fetch-mapping.test.ts` before implementation.
- **Plugin suite regressions:** the `IHttpAdapter` contract change is contained (no plugin
  references it, verified §1), but the kernel `start()`/`stop()` rewire touches every plugin's
  integration tests. Mitigation: `deno task test` runs the full suite; any plugin integration test
  that asserted the old `createServer`/`listen(handle)` call shape is updated in the same PR.

## 9. Out of scope

- **Streaming response bodies** (`IResponse.stream()`, `IRequestContext.signal`, abort wiring) —
  M42. M23's `fetch` buffers; M42 replaces the buffered path.
- **SSE plugin** — M43. **React Router SSR** — M44.
- **Per-request Cloudflare Workers env bindings** threaded into `IRuntimeServices.env` from the
  `fetch` handler's `env` param — a CF-specific env-wiring concern deferred to a follow-up if the
  kernel needs per-request env; M23 provides a stable, testable CF runtime services baseline.
- **`@hono/node-server` as a workspace import-map entry** — not needed; the lazy `npm:` import
  resolves at runtime. Adding it to `deno.json` `imports` would make it a hard dependency graph
  edge, which §12.2 forbids for a heavy dep.
