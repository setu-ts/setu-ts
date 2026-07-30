# Milestone 49 — gRPC Plugin (`@hono-enterprise/grpc-plugin`)

> **Status:** Planning. Branch: `feat/m49-grpc-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Provide **gRPC** as an optional plugin so a Hono Enterprise application can co-serve gRPC
family APIs — the gRPC, Connect, and gRPC-Web protocols — on the **same port and the same
fetch handler** as its existing Hono routes, with no separate listener, no raw socket, and
identical behavior on Node, Deno, Bun, and Cloudflare Workers. The plugin registers an
`IGrpcService` under a new `CAPABILITIES.GRPC = 'grpc'` token; applications register Protobuf
service implementations, and get server reflection and a gRPC Health v1 service bridged to the
existing health plugin (M20) for free.

The recommended runtime is **Connect-ES** (`@connectrpc/connect` core plus the Protobuf-ES
runtime `@bufbuild/protobuf`) because it is **fetch-native**: it operates on the web
`Request`/`Response` the HTTP adapter already owns. Like the WebSocket plugin (M46), gRPC must
bypass `IRequest`/`IResponse` (which pre-read the body and cannot express trailers), so it hooks
the same HTTP-adapter seam — one new **optional** `IHttpAdapter.setRpcHandler?(handler)` member.
Unlike WebSocket, Connect is pure fetch, so it needs **no per-runtime upgraders**: a single
interceptor serves all four runtimes.

- **In scope:** the `common` gRPC contract + `GRPC` token + the `IHttpAdapter.setRpcHandler?`
  widening; a shared fetch-RPC interceptor store + gRPC request detection in `runtime`; the
  four adapters consulting it before body mapping; the `grpc-plugin` package (Connect loader +
  universal-handler fetch bridge, service registry, reflection, health bridge, options, errors);
  and the full unit + integration + real-path e2e test tree. Public surface, PUBLIC_API.md,
  ARCHITECTURE.md, README.md, ROADMAP.md, and `scripts/release-packages.ts` updated in the same PR.
- **NOT this milestone:** a `honoe generate grpc-service` CLI schematic (§9 — the CLI cannot run
  the `buf`/`protoc-gen-es` codegen that a service stub requires; it is app-level build tooling,
  like Vite for M44); auth/telemetry/metrics/multi-tenancy bridging into the gRPC call path
  (the interceptor runs before the kernel pipeline; §9 names the owning milestones); the browser
  client SDK (M35); async service reflection beyond Connect's built-in `grpc.reflection.v1`.

### 0.1 Recommended approach and rejected alternatives

The gRPC delivery question is: how do you serve gRPC on a **Hono/Deno fetch-based** runtime that
also runs on Node, Bun, and Workers? Three approaches were evaluated; **Connect-ES is
recommended**.

| Approach | Runtime fit | Co-serves with Hono | Streaming (all 4 RPC kinds) | Protocols | Verdict |
| --- | --- | --- | --- | --- | --- |
| **Connect-ES** (`@connectrpc/connect` + `@bufbuild/protobuf`) — RECOMMENDED | Fetch-native; one interceptor serves Node, Deno, Bun, Workers identically | Yes — same `fetch` handler; returns `null` to fall through to Hono | Yes — unary, server/client/bidi over web `ReadableStream` | Connect, gRPC, gRPC-Web; interops with grpcurl/Envoy/grpc-gateway | **Ship.** Zero per-runtime code; first-class reflection + health. |
| `@grpc/grpc-js` + `@grpc/proto-loader` | Node-only; binds a raw HTTP/2 socket (`http2` core) | No — needs its own listener/port; cannot share the Hono fetch handler | Yes | gRPC only (no Connect, no first-class gRPC-Web server) | **Reject.** Breaks runtime independence (AI_GUIDELINES §4.1), violates §4.3 (no plugin may create an HTTP server), and cannot run on Deno/Bun/Workers. |
| `grpc-web` (server side) | Not a server runtime; it is a browser wire format that needs Envoy/proxy translation to real gRPC | No — requires a sidecar proxy | Unary + server-streaming only (gRPC-Web limit) | gRPC-Web only | **Reject.** Adds an operational dependency (Envoy) and lacks client-streaming/bidi. Connect ships gRPC-Web compatibility from the server for free. |

**Why Connect-ES wins on this framework specifically:** the [`IHttpAdapter`](packages/common/src/runtime.ts:292)
contract is web-`fetch`-centric (`fetch(request: Request): Promise<Response>`), so a runtime
that already speaks `Request`/`Response` slots in with one interceptor. The alternatives
re-introduce the raw-socket server model that M23 deliberately removed (`@grpc/grpc-js`) or
demand a proxy the framework cannot own (`grpc-web`). The same reasoning that made M46 reject
`@hono/node-ws` (it demanded a concrete Hono instance the framework does not expose) applies to
`@connectrpc/connect-hono`: it mounts onto a Hono app object, which the kernel keeps private, so
the plugin uses the Connect **core** universal handler over a thin fetch bridge instead.

### 0.2 Impact analysis — what gets touched

Every area the milestone reaches, with paths:

| Area | Change | Paths |
| --- | --- | --- |
| Workspace manifest | Register the new package | `deno.json` (add `"./packages/grpc-plugin"` to `workspace`) |
| `common` contract | New gRPC service + interceptor types; new token; adapter widening | `packages/common/src/services/grpc.ts` (new), `packages/common/src/tokens.ts`, `packages/common/src/runtime.ts`, `packages/common/src/index.ts` |
| `runtime` adapter seam (biggest impact) | A shared fetch-RPC interceptor store + gRPC detection; all four HTTP adapters consult it before the shared body mapping | `packages/runtime/src/adapters/shared/rpc-interceptor-store.ts` (new), `packages/runtime/src/adapters/shared/rpc-detection.ts` (new), `packages/runtime/src/adapters/{deno,node,bun,workers}/*-http-adapter.ts` (4 edits), `packages/runtime/src/index.ts` |
| New package | Full plugin tree mirroring `websocket-plugin` | `packages/grpc-plugin/{deno.json,README.md,src/index.ts,src/plugin/grpc-plugin.ts,src/services/grpc-service.ts,src/transports/connect-loader.ts,src/transports/connect-fetch-bridge.ts,src/transports/connect-router-builder.ts,src/health/grpc-health-bridge.ts,src/reflection/grpc-reflection.ts,src/interfaces/index.ts,src/errors/grpc-errors.ts}` + `test/{unit,integration,e2e}` |
| Public API | New `grpc-plugin` section; widen the `IHttpAdapter` / Runtime listing; note the M49 seam | `PUBLIC_API.md` |
| Architecture | Add the gRPC plugin to the plugin set; record the adapter seam beside the M46 upgrade seam | `ARCHITECTURE.md` (§3 diagram + §7 note) |
| Root README | Add the gRPC plugin row | `README.md` |
| Roadmap | New milestone entry (added by Code during implementation, not by this plan) | `ROADMAP.md` |
| Release list | Include the new publishable package | `scripts/release-packages.ts` |
| Cross-plugin interplay | Health (M20) bridged in-scope; auth/telemetry/metrics/multi-tenancy deferred (§9) | none (capability-token resolved at runtime) |
| CLI schematic | Assessed — deferred (§9) | `packages/cli/src/schematics/registry.ts` (no change this milestone) |

## 1. Contracts verified from SOURCE (not names)

Every external reference the design leans on, verified by opening the source and citing
file:line. A name not read is not verified.

| Reference | Source (file:line) | Verified surface / fact |
| --- | --- | --- |
| `IHttpAdapter` | `packages/common/src/runtime.ts:292-342` | Exactly five members today: `setHandler`, `fetch`, `listen`, `close`, and the optional `setUpgradeRouter?` (since 0.2.0). A new optional `setRpcHandler?` is additive and follows the exact same precedent. |
| `IRequest` | `packages/common/src/http.ts:33-85` | Carries `method`/`url`/`path`/`headers`/`ip?`/`user?`/`tenant?`/`signal?`/`json`/`text`/`bytes`. Carries **no** native `Request` and exposes the body only through the three readers — so a gRPC handler provably cannot reach the raw streaming body or trailers through it. |
| `IResponse` | `packages/common/src/http.ts:100-197` | Has `status`/`header`/`appendHeader`/`json`/`text`/`send`/`redirect`/`stream(ReadableStream<Uint8Array>)` (since 0.2.0)/`snapshot()`. Has **no trailing-header** surface — gRPC status + trailers cannot be expressed, so gRPC cannot return through `IResponse`. |
| `mapWebRequestToFrameworkRequest` | `packages/runtime/src/adapters/shared/fetch-mapping.ts:26-67` | Calls `await request.arrayBuffer()` (line 37) on every request, **disturbing** the body. Combined with the `IRequest`/`IResponse` facts above, the gRPC interceptor MUST run before this call. |
| `UpgradeRouterStore` | `packages/runtime/src/adapters/shared/upgrade-router-store.ts:18-70` | The exact shared-store pattern: hold a callback, consult it, return `null` to fall through, convert a throwing callback to a safe rejection. The new `RpcInterceptorStore` mirrors this. |
| Deno adapter fetch path | `packages/runtime/src/adapters/deno/deno-http-adapter.ts:154-168` | `createFetchHandler` consults `#tryUpgrade` first, then `mapWebRequestToFrameworkRequest`. The gRPC consult slots in between — after the upgrade short-circuit, before the body is read. |
| Node adapter fetch + upgrade | `packages/runtime/src/adapters/node/node-http-adapter.ts:96-146` | Uses `@hono/node-server` `serve({ fetch })`; the upgrade lives on the raw `upgrade` event while ordinary traffic goes through the `fetch` callback. gRPC is ordinary HTTP traffic, so it is consulted inside the `fetch` callback, before the mapping. |
| `IRouterApi` | `packages/common/src/plugin.ts:74-141` | Exposes verbs, `group`, `listRoutes` only — **no** raw-fetch or catch-all route registration. So gRPC cannot mount on the kernel router; the adapter seam is the only path. |
| `app.fetch` | `packages/kernel/src/application/application.ts:387-394` | `Application.fetch(request)` delegates straight to `adapter.fetch(request)`. The adapter is therefore the single place a fetch-RPC can be intercepted for every entry path (listen, Workers `export default { fetch }`, and `inject`). |
| `CAPABILITIES` + token grammar | `packages/common/src/tokens.ts:39-148` | No `GRPC` key exists; `WEBSOCKET: 'websocket'`, `SSE: 'sse'`, `HTTP_ADAPTER: 'http-adapter'` do. Grammar `^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$` (dot-namespaced; colons illegal). `'grpc'` is one valid lowercase segment. |
| `PluginResolver` duplicate detection | `packages/kernel/src/registry/plugin-resolver.ts` | Duplicate plugin names and duplicate capability providers throw at startup. `GrpcPlugin` is single-instance, claiming the bare `grpc` token exactly once (§3.8). |
| `IPluginContext` / `IPlugin` | `packages/common/src/plugin.ts` | `register(ctx): void \| Promise<void>`, `provides`, `optionalDependencies`, `priority`, `ctx.runtime` (non-optional), `ctx.services`, `ctx.health.register`, `ctx.lifecycle.onClose`. Read directly (non-optional) like the SSE/WebSocket plugins. |
| `IHealthService` / health bridge precedent | `packages/common/src/services/health.ts` + `packages/health-plugin` | The health plugin aggregates `IHealthIndicator` registrations; the gRPC Health v1 service delegates its `Check` to the same aggregate so `/grpc/grpc.health.v1.Health/Check` reflects `/health`. |
| `@connectrpc/connect` | npm registry (verified: latest `2.1.2`, published Jul 2026) | Implements Connect, gRPC, gRPC-Web; type-safe; full streaming; first-class server reflection + Health v1. Connect-ES 2.0 uses Protobuf-ES 2.0 APIs. Loaded inject-or-lazy (§3.2). |
| `@bufbuild/protobuf` (Protobuf-ES runtime) | npm registry (2.x line; Connect 2.x peer) | The schema runtime Connect depends on; also what `buf generate`/`protoc-gen-es` emit against. The exact pinned version is the one `@connectrpc/connect@^2.1.2` declares as its dependency (confirmed via `deno info npm:@connectrpc/connect@^2.1.2` at implementation). |
| `app.inject` streaming caveat | `packages/kernel/src/application/application.ts:440-446` | `inject()` cannot read a streaming body; the gRPC e2e therefore drives `app.fetch(webRequest)` and reads the returned `Response` body stream, not `inject()`. |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| # | Conflict | Resolution (picked side) | Doc deliverable (same PR) |
| --- | --- | --- | --- |
| C1 | `ARCHITECTURE.md` §3 lists no gRPC plugin, and §7's `IHttpAdapter` narrative (lines ~896-910, 5690-5697) documents only the M23 `fetch` contract and the M46 `setUpgradeRouter?` widening. This milestone adds a third, fetch-RPC seam. | Ship it: `setRpcHandler?` is a new optional adapter member, documented alongside `setUpgradeRouter?`. | Add a sentence to the ARCHITECTURE.md §7 `IHttpAdapter` narrative naming `setRpcHandler?` and its gRPC consumer; add the gRPC plugin node to the §3 plugin set. |
| C2 | `README.md` has no gRPC row; `PUBLIC_API.md` Runtime type group (line ~5431) and the four HTTP adapters (lines ~5592-5595) list no RPC interceptor. | The widening is deliberate and public. | Add the `grpc-plugin` row to README; add the gRPC type group to the `common` PUBLIC_API table; add `setRpcHandler?` to the `IHttpAdapter` listing; add an "M49 added `setRpcHandler?`" note beside the M46 one. |
| C3 | `ROADMAP.md` has no gRPC milestone. | The entry is added by Code during implementation (this plan does not edit ROADMAP.md). | Named Code deliverable: a new "Milestone 49" section in the ROADMAP style, plus a "Progress Tracking" row, plus flipping the `README`/`ARCHITECTURE` rows when it ships. |
| C4 | `scripts/release-packages.ts` enumerates publishable packages explicitly (alpha.3 published 38). | The new package must be added so the next release includes it. | Named Code deliverable: add `@hono-enterprise/grpc-plugin` to the publish list and run `deno task release:verify`. |

## 3. Design decisions

### 3.1 Where gRPC is intercepted

- **Decision:** Inside each HTTP adapter's `fetch` path, **after** the WebSocket upgrade
  short-circuit and **before** `mapWebRequestToFrameworkRequest` reads the body. One new optional
  member on `IHttpAdapter`: `setRpcHandler?(handler: RpcFetchHandler): void`, where
  `RpcFetchHandler = (request: Request) => Promise<Response | null>`. A `Response` return means the
  request was handled as gRPC/Connect/gRPC-Web; `null` means "not an RPC request" and the adapter
  falls through to the ordinary Hono pipeline unchanged.
- **Why:** Verified in §1 — `IRequest`/`IResponse` cannot express a gRPC exchange (no raw body
  stream, no trailers), and the shared mapping disturbs the body. The adapter is the only
  component holding the native `Request` and owning the serve loop. A single optional member keeps
  the widening minimal and matches the `setUpgradeRouter?` (M46), `fs?` (M44), `workers?` (M45)
  precedents. gRPC is ordinary HTTP traffic (no protocol upgrade), so it does not need a raw
  socket event like Node WebSocket did — it rides the `fetch` callback on every runtime.
- **Test home:** `runtime/test/unit/rpc-interceptor-store.test.ts` (store-then-consult returns the
  Response; `null` fall-through; a throwing handler surfaces as a 500, never a crash) and each
  adapter test asserting a gRPC request is served without ever invoking the framework handler.

### 3.2 The Connect runtime and how it loads

- **Decision:** Use Connect-ES **core** only — `npm:@connectrpc/connect@^2.1.2` plus the
  Protobuf-ES runtime `npm:@bufbuild/protobuf` (2.x, the version Connect declares as its peer,
  confirmed at implementation). Load them **inject-or-lazy** through an injected `ConnectModule`
  seam (`connectModule` option) defaulting to a lazy `import()` of both specifiers, adapted through
  a structural `adaptConnectModule(mod)` facade so the plugin never imports Connect types for its
  own internals. The plugin's `deno.json` carries **zero** Connect dependencies (no runtime, no
  type dependency) — exactly the zero-dependency-plugin ethos every other capability plugin
  follows.
- **Why:** AI_GUIDELINES §12.2 forbids a heavy runtime driver as a hard plugin dependency; the
  framework owns no gRPC library. The app supplies generated service definitions from its own
  `buf`/`protoc-gen-es` build step (app-level build tooling, like Vite for M44), so the plugin is
  generic over them rather than importing `@bufbuild/protobuf` types. The lazy load is what makes
  the package publish with no dependency graph entry. The structural facade is precedented by
  `SmtpProvider`/`ISesClient` (M29) and `adaptWsModule` (M46).
- **Test home:** `grpc-plugin/test/unit/connect-loader.test.ts` drives `adaptConnectModule` with a
  hand-built fake module and asserts the branching around a missing module throws a named error;
  `grpc-plugin/test/unit/connect-real-import.test.ts` is the guarded REAL
  `import('npm:@connectrpc/connect@^2.1.2')` + `import('npm:@bufbuild/protobuf')`, skipped when the
  packages are absent.

### 3.3 Serving Connect on the fetch handler (the universal-handler bridge)

- **Decision:** Build a Connect `ConnectRouter` lazily, register service implementations onto it,
  and serve it through a thin, pure fetch bridge (`src/transports/connect-fetch-bridge.ts`) that
  converts a web `Request` to Connect's universal request, invokes the universal handler, and
  converts the universal response back to a web `Response`. The bridge is modeled on Connect's
  own `@connectrpc/connect-cloudflare-workers` serving path (the canonical fetch-native
  Request-to-Response reference).
- **Why:** `@connectrpc/connect-hono` mounts onto a concrete Hono app the kernel keeps private
  (the same trap that made M46 reject `@hono/node-ws`), and the per-Node/Express/Fastify adapters
  are not fetch-native. The universal handler is framework-agnostic, and the two converters are
  pure transforms (headers + body `ReadableStream` + status) that are trivially unit-testable off
  a real network — the exact shape the codebase uses for `mapWebRequestToFrameworkRequest` and the
  realtime codec. The Connect universal types the bridge touches are read from the shipped
  `@connectrpc/connect@^2.1.2` `.d.ts` at implementation (standard external-API verification).
- **Test home:** `grpc-plugin/test/unit/connect-fetch-bridge.test.ts` exercises the two pure
  converters on representative unary and streaming shapes (input bytes unchanged, streaming body
  passed through, status + trailers carried); the real handler is exercised end-to-end in the e2e.

### 3.4 Request routing — path prefix and content type

- **Decision:** A request is treated as RPC when its path starts with the configured `basePath`
  (default `/grpc`, slash-trailing) **or** its `Content-Type` is one of the RPC media types
  (`application/grpc`, `application/grpc+proto`, `application/proto`, `application/connect`,
  `application/connect+proto`, `application/connect+json`, `application/grpc-web`,
  `application/grpc-web+proto`, `application/grpc-web+proto`). Detection lives in one shared
  `isRpcRequest(headers, basePath)` helper consulted by the interceptor store, hoisted once at
  registration time. Variable data (tenant, request id) travels in Connect request metadata,
  surfaced to service implementations — not in the path.
- **Why:** Path-prefix matching is O(1) and deterministic; content-type detection catches clients
  that POST to `/` with `application/grpc`. A `Map` lookup plus a header read is the established
  precedent (the WebSocket exact-path table, §3.4 of M46). The kernel's path matcher is internal
  (`packages/kernel/src/router/route-matcher.ts`, not exported from the kernel index), so hand-rolling
  a second `:param` matcher would duplicate logic CLAUDE.md forbids — the prefix check needs none.
- **Test home:** `runtime/test/unit/rpc-detection.test.ts` — prefix match hit/miss, every RPC media
  type matches, a plain `application/json` request to a non-prefix path returns `null`, and a
  gRPC request to an ordinary Hono path still falls through only when the prefix differs.

### 3.5 gRPC Health v1 bridge (interplay with M20)

- **Decision:** The plugin registers Connect's gRPC Health v1 service
  (`grpc.health.v1.Health`) whose `Check` delegates to the framework health aggregate
  (`ctx.services.get(CAPABILITIES.HEALTH)`) when present and reports `SERVING` otherwise.
  Controlled by the `health` option (default `true`).
- **Why:** Kubernetes and operators probe `:443/grpc/grpc.health.v1.Health/Check`; reporting a
  status disconnected from the rest of the app's health is a silent lie. Bridging through the
  capability token keeps the plugin decoupled (no import of the health plugin) and matches how the
  OpenAPI/metrics plugins already consume health. The absent-plugin fallback (`SERVING`) keeps the
  RPC endpoint usable in a minimal app.
- **Test home:** `grpc-plugin/test/unit/grpc-health-bridge.test.ts` — with a fake health aggregate
  the gRPC status maps each `HealthStatus` to the matching serving/not-serving enum; with no
  health capability it reports `SERVING`; `health: false` registers nothing.

### 3.6 Server reflection

- **Decision:** Register Connect's server reflection (`grpc.reflection.v1.ServerReflection`, plus
  the v1alpha fallback clients like grpcurl still expect) when `reflection` is `true` (default
  `true`). Exposes every registered service so `grpcurl`, `grpcui`, and Postman can list and call
  methods with no manual `.proto`.
- **Why:** Reflection is the single highest-value gRPC DX feature and Connect ships it with no
  added dependency. Defaulting it on matches the OpenAPI plugin serving Swagger UI by default (M21).
- **Test home:** `grpc-plugin/test/unit/grpc-reflection.test.ts` — registered services appear in the
  reflection list; `reflection: false` registers nothing; the real reflection response is asserted
  in the e2e via a Connect reflection client.

### 3.7 Streaming and trailers

- **Decision:** All four RPC kinds are supported: unary, server-streaming, client-streaming, and
  bidirectional streaming, over web `ReadableStream` on every runtime. Connect encodes gRPC-Web
  and Connect-protocol trailers in the body (HTTP/1.1-safe) and emits real HTTP/2 trailing headers
  for the gRPC protocol when the runtime's fetch supports them; the fetch bridge forwards whatever
  the universal handler produces unchanged.
- **Why:** The framework's streaming primitive `IResponse.stream()` (M42) already proved web
  `ReadableStream` is native to Node/Deno/Bun/Workers; Connect rides the same primitive. gRPC-over-
  HTTP/2 requires TLS in development (h2c cleartext support varies by runtime), so the e2e exercises
  the Connect protocol over HTTP/1.1 as the primary real path and the gRPC-protocol path through a
  real client only where the runtime supports it.
- **Test home:** `grpc-plugin/test/e2e/grpc-streaming-e2e.test.ts` — a server-streaming method
  yields its framed messages in order through `app.fetch`; a bidi method echoes; the gRPC status
  trailer is present.

### 3.8 Plugin instance count and token ownership

- **Decision:** `GrpcPlugin` is single-instance, `name: 'grpc-plugin'`,
  `provides: [CAPABILITIES.GRPC]`, `optionalDependencies: ['logger', 'health']`, priority `NORMAL`.
- **Why:** `PluginResolver` throws on duplicate plugin names and duplicate capability providers
  (verified in §1), and two competing RPC routers on one server has no coherent meaning.
- **Test home:** `grpc-plugin/test/integration/grpc-integration.test.ts` — the service resolves
  from `CAPABILITIES.GRPC` in a real kernel app, and registering the plugin twice throws at startup.

### 3.9 Behavior when the adapter cannot serve RPC

- **Decision:** The plugin probes `typeof adapter.setRpcHandler === 'function'`. When absent it
  still registers the service and health indicator (reporting `available: false`), and
  `service.addService(...)` succeeds but `register()` logs a warning that RPC requests will not be
  served. This mirrors the M45 `WorkerPoolUnavailableError` / M46 `WebSocketUnavailableError`
  degraded path so one codebase deploys everywhere.
- **Why:** A custom third-party adapter that predates this widening must not crash an application
  at startup. Surfacing unavailability at registration (not silently at first request) is the
  honest default.
- **Test home:** `grpc-plugin/test/unit/grpc-plugin.test.ts` — a fake adapter without
  `setRpcHandler` registers cleanly, health reports `available: false`, and the plugin logs the
  documented warning.

### 3.10 External-type policy for Connect and Protobuf-ES

- **Decision:** Declare minimal structural facades (`ConnectModuleLike`, `ConnectRouterLike`,
  `UniversalHandlerLike`, `GrpcServiceDefinition`) in the plugin and adapt the imported modules
  through `adaptConnectModule`. Never `import type` from `@connectrpc/connect` or
  `@bufbuild/protobuf` at the framework boundary; the app brings its own generated types and the
  plugin is generic over them.
- **Why:** Adding a type dependency on a heavy gRPC library contradicts the zero-dependency-plugin
  rule and would force every consumer's type-check to resolve Connect. The structural-facade pattern
  is established (M29, M46). The `addService` signature is generic
  `addService<TDef>(definition: TDef, implementation: ...)` constrained to the structural
  `GrpcServiceDefinition`, so the app's real generated definition satisfies it.
- **Test home:** `grpc-plugin/test/unit/connect-loader.test.ts` passes a hand-built fake module
  through `adaptConnectModule`; the guarded real-import test proves the real modules satisfy the
  same shape.

## 4. Exported surface — every symbol names its consumer

### 4.1 `@hono-enterprise/common` (contract additions)

| Exported symbol | Kind | Consumer / real code path that READS it |
| --- | --- | --- |
| `CAPABILITIES.GRPC` | token | `GrpcPlugin.provides` + `ctx.services.register`; resolved by application code and the integration test. |
| `IGrpcService` | interface | Implemented by `GrpcService`; the type argument of `ctx.services.get` in the integration and e2e tests and in application code. |
| `GrpcServiceDefinition` | interface (generic constraint) | The `definition` parameter type of `IGrpcService.addService`; satisfied structurally by the app's generated Protobuf-ES service descriptor. |
| `GrpcCallContext` | interface | Passed to every service method implementation; carries Connect metadata + `ctx.services` for capability resolution. |
| `GrpcServiceStatus` | type | The gRPC status code union returned from `Check` and used by the health bridge. |
| `RpcFetchHandler` | type | The parameter type of `IHttpAdapter.setRpcHandler`; stored and called by all four adapters. |
| `IHttpAdapter.setRpcHandler?` | method (widening) | Called by `GrpcPlugin.register`; implemented by all four runtime adapters. |

### 4.2 `@hono-enterprise/runtime` (interceptor additions)

| Exported symbol | Kind | Consumer / real code path that READS it |
| --- | --- | --- |
| `isRpcRequest` | function | Called by all four adapters to decide whether to consult the interceptor at all; shared to avoid four copies (the `isWebSocketUpgradeRequest` precedent). |
| `RPC_MEDIA_TYPES` | constant | The media-type allow-list `isRpcRequest` matches; exported so tests and custom adapters share one source of truth. |
| `RpcInterceptorStore` | class | Held by each of the four adapter handles; `set` stores the handler, `consult` answers Response/null. |
| `RpcFetchHandler` | type (re-exported) | Re-exported so a custom adapter author needs only the runtime package. |

### 4.3 `@hono-enterprise/grpc-plugin`

| Exported symbol | Kind | Consumer / real code path that READS it |
| --- | --- | --- |
| `GrpcPlugin` | fn | Registered by application code; driven by the integration and e2e tests. |
| `GrpcService` | class | Registered under `CAPABILITIES.GRPC` by the plugin; exported so applications can compose it in tests without subclassing. |
| `adaptConnectModule` | function | Called by the loader and directly by the unit test with a fake module. |
| `GrpcUnavailableError` | class | Thrown by `GrpcService` when no adapter seam exists; asserted with `instanceof` in the plugin unit test. |
| `GrpcPluginOptions` | type | The parameter type of `GrpcPlugin`; every field consumed per §4.4. |

### 4.4 Options — every option names its consumer

| Option | Consumer | Behavior (per implementation) |
| --- | --- | --- |
| `basePath` | `isRpcRequest` detection | Path prefix that marks a request as RPC. Defaults to `/grpc`. A request to a non-prefix path with a non-RPC content type is left to Hono. |
| `reflection` | `grpc-reflection.ts` | `true` (default) registers `grpc.reflection.v1.ServerReflection` + v1alpha; `false` registers neither. |
| `health` | `grpc-health-bridge.ts` | `true` (default) registers `grpc.health.v1.Health` bridged to `CAPABILITIES.HEALTH` when present, else `SERVING`; `false` registers nothing. |
| `services` | `GrpcService.register` | A convenience list of `{ definition, implementation }` pairs registered at startup, so a small app need not resolve the service and call `addService` itself. Empty by default. |
| `connectModule` | `connect-loader.ts` | An injected `ConnectModule` (the Connect + Protobuf-ES modules), defaulting to the lazy `import()`. The test seam that lets unit tests avoid the network. |
| `logger` | `GrpcPlugin.register` | Optional structured logger for the no-seam warning and load errors; resolved from `CAPABILITIES.LOGGER` when `optionalDependencies` brings it in. |

## 5. Implementation files

### 5.1 `packages/common`

| File | Purpose |
| --- | --- |
| `src/services/grpc.ts` | New. The whole gRPC contract group (§4.1): `IGrpcService`, `GrpcServiceDefinition`, `GrpcCallContext`, `GrpcServiceStatus`, `RpcFetchHandler`. |
| `src/runtime.ts` | Edit. Add the optional `setRpcHandler?(handler: RpcFetchHandler): void` member to `IHttpAdapter`, importing the handler type — exactly as it imports `WebSocketUpgradeRouter` today. |
| `src/tokens.ts` | Edit. Add `GRPC: 'grpc'` to `CAPABILITIES`. |
| `src/index.ts` | Edit. Re-export the new contract group. |

### 5.2 `packages/runtime`

| File | Purpose |
| --- | --- |
| `src/adapters/shared/rpc-detection.ts` | New. `RPC_MEDIA_TYPES` + `isRpcRequest(headers, basePath): boolean` — the single shared RPC-request check. |
| `src/adapters/shared/rpc-interceptor-store.ts` | New. `RpcInterceptorStore` — hold the handler, consult it, return `null` to fall through, convert a throw to a 500. Mirrors `UpgradeRouterStore`. |
| `src/adapters/deno/deno-http-adapter.ts` | Edit. Hold a store, expose `setRpcHandler`, consult it in `createFetchHandler` after `#tryUpgrade` and before `mapWebRequestToFrameworkRequest`. |
| `src/adapters/node/node-http-adapter.ts` | Edit. Hold a store, expose `setRpcHandler`, consult it inside the `fetch` callback before the mapping. |
| `src/adapters/bun/bun-http-adapter.ts` | Edit. Hold a store, expose `setRpcHandler`, consult it in the `fetch` callback before the mapping. |
| `src/adapters/workers/cf-http-adapter.ts` | Edit. Hold a store, expose `setRpcHandler`, consult it in `fetch`. |
| `src/index.ts` | Edit. Export `isRpcRequest`, `RPC_MEDIA_TYPES`, `RpcInterceptorStore`, `RpcFetchHandler`. |

### 5.3 `packages/grpc-plugin`

| File | Purpose |
| --- | --- |
| `src/index.ts` | Barrel exports (§4.3). |
| `src/plugin/grpc-plugin.ts` | `GrpcPlugin` factory: resolve the adapter, build the service, install the interceptor via `setRpcHandler`, register health + reflection, register the health indicator and `onClose`. |
| `src/services/grpc-service.ts` | `GrpcService` — owns the deferred service list, resolves the Connect router, exposes `addService`, builds the fetch handler. |
| `src/transports/connect-loader.ts` | `adaptConnectModule` / `loadConnectModule` — the inject-or-lazy seam and the named missing-module error. |
| `src/transports/connect-fetch-bridge.ts` | The two pure converters: web `Request` to Connect universal request, universal response to web `Response`. |
| `src/transports/connect-router-builder.ts` | Builds the `ConnectRouter`, registers services + reflection + health, and yields the universal handler. |
| `src/health/grpc-health-bridge.ts` | The `grpc.health.v1.Health` implementation delegating to `CAPABILITIES.HEALTH`. |
| `src/reflection/grpc-reflection.ts` | Registers Connect server reflection (v1 + v1alpha) over the built router. |
| `src/interfaces/index.ts` | `GrpcPluginOptions` (§4.4). |
| `src/errors/grpc-errors.ts` | `GrpcUnavailableError`. |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file | src covered | Key assertions (and the signature each call type-checks against) |
| --- | --- | --- |
| `common/test/unit/grpc-contract.test.ts` | `common/src/services/grpc.ts`, `tokens.ts` | `CAPABILITIES.GRPC === 'grpc'` and survives `createCapabilityToken`; `RpcFetchHandler` accepts a `Request` and returns `Promise<Response \| null>`. |
| `runtime/test/unit/rpc-detection.test.ts` | `shared/rpc-detection.ts` | Every `RPC_MEDIA_TYPES` entry matches; prefix hit/miss; a plain JSON request to a non-prefix path returns `false`; calls `isRpcRequest(headers, basePath): boolean`. |
| `runtime/test/unit/rpc-interceptor-store.test.ts` | `shared/rpc-interceptor-store.ts` | Store-then-consult returns the handler's `Response`; no handler returns `null`; a non-RPC request returns `null`; a throwing handler surfaces as a 500 Response, not a crash. |
| `runtime/test/unit/deno-http-adapter-rpc.test.ts` | `deno-http-adapter.ts` | A gRPC request is served by the interceptor and the framework handler records zero calls; a non-RPC request falls through to the framework handler; a `null` return falls through. |
| `runtime/test/unit/node-http-adapter-rpc.test.ts` | `node-http-adapter.ts` | Same three cases inside the `fetch` callback; the upgrade path is untouched. |
| `runtime/test/unit/bun-http-adapter-rpc.test.ts` | `bun-http-adapter.ts` | Same three cases on the Bun `fetch` callback. |
| `runtime/test/unit/cf-http-adapter-rpc.test.ts` | `cf-http-adapter.ts` | Same three cases on the Workers `fetch` entry. |
| `grpc-plugin/test/unit/connect-loader.test.ts` | `transports/connect-loader.ts` | `adaptConnectModule(fakeModule)` adapts the router builder; absent module throws the named error with the exact install command. |
| `grpc-plugin/test/unit/connect-fetch-bridge.test.ts` | `transports/connect-fetch-bridge.ts` | Unary input bytes pass through unchanged; a streaming universal response becomes a streaming web `Response`; status + trailers survive both converters. |
| `grpc-plugin/test/unit/connect-real-import.test.ts` | the lazy `import('npm:@connectrpc/connect@^2.1.2')` + `npm:@bufbuild/protobuf` lines | Guarded REAL import; asserts the modules satisfy `ConnectModuleLike`. Skipped when absent. |
| `grpc-plugin/test/unit/grpc-service.test.ts` | `services/grpc-service.ts` | `addService` defers then flushes to the router; `basePath`/`services` options wire through; the built handler returns `null` for a non-RPC request. |
| `grpc-plugin/test/unit/grpc-health-bridge.test.ts` | `health/grpc-health-bridge.ts` | Each `HealthStatus` maps to the matching gRPC enum; absent health capability reports `SERVING`; `health: false` registers nothing. |
| `grpc-plugin/test/unit/grpc-reflection.test.ts` | `reflection/grpc-reflection.ts` | Registered services appear in the reflection list; `reflection: false` registers nothing. |
| `grpc-plugin/test/unit/grpc-plugin.test.ts` | `plugin/grpc-plugin.ts`, `errors` | Registers under the token; installs the interceptor on a fake adapter; health `available` both ways; adapter without `setRpcHandler` logs the warning and health reports `available: false`; `onClose` tears down. |
| `grpc-plugin/test/unit/barrel-exports.test.ts` | `src/index.ts`, `interfaces/index.ts` | Every §4.3 symbol is exported and defined (the websocket-plugin barrel precedent). |
| `grpc-plugin/test/integration/grpc-integration.test.ts` | plugin ↔ kernel wiring | Service resolves from `CAPABILITIES.GRPC` in a real kernel app; duplicate registration throws; a non-RPC request still routes normally through the Hono pipeline. |
| `grpc-plugin/test/e2e/grpc-unary-e2e.test.ts` | the REAL path, end to end | On Deno: register a trivial unary service, `app.start({ port: 0 })`, call it through `app.fetch` with a Connect client, assert the typed response. This is the "exercise the REAL path once" evidence. |
| `grpc-plugin/test/e2e/grpc-streaming-e2e.test.ts` | the REAL streaming path | A server-streaming method yields framed messages in order; a bidi method echoes; the gRPC status trailer is present; reflection lists the service. |

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m49-grpc-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/grpc-plugin/src packages/runtime/src
```

## 8. Risks & mitigations

- **The `IHttpAdapter` widening is a committed public contract change.** → It is optional, so every
  existing implementation (including third-party ones) still type-checks; §3.9 defines the
  documented degraded behavior when it is absent, and that path is tested.
- **Connect is absent in a deployment.** → `loadConnectModule` throws a named error stating the
  exact install command; the branch around the import is unit-tested through `adaptConnectModule`,
  and the import line has the guarded real-import test (AI_GUIDELINES §12.2).
- **The universal-handler fetch bridge could mis-handle trailers on some runtime.** → The bridge is
  pure and unit-tested on representative shapes (§3.3), and the streaming e2e asserts the gRPC
  status trailer is present on Deno; the Connect-protocol path (HTTP/1.1, trailers in body) is the
  primary real path so HTTP/2 trailer support is not a correctness gate for the common case.
- **gRPC-over-HTTP/2 needs TLS in dev (h2c varies by runtime).** → The e2e uses the Connect
  protocol over HTTP/1.1 as the exercised path and documents that real gRPC clients connect over
  HTTP/2+TLS; no test depends on a TLS cert being present in CI.
- **Bun and Workers cannot be executed by this repo's Deno test runner.** → Both adapters are driven
  entirely through injected host seams with fakes, exactly as the existing `BunHttpAdapter` and
  `CloudflareWorkersHttpAdapter` tests do; the real path is proven on Deno by the e2e.
- **Reflection enumerating app internals.** → `reflection` defaults on for DX but is a single
  option to disable; it reflects only services the app registered with the plugin, nothing else.
- **Handler leak on shutdown.** → `onClose` aborts any in-flight streams via the stored
  `AbortController` and drops the Connect router; the plugin unit test asserts the teardown
  (AI_GUIDELINES §14.5).

## 9. Out of scope

- **A `honoe generate grpc-service` CLI schematic.** A service stub needs generated Protobuf-ES
  types from `buf generate` / `protoc-gen-es`, which is app-level build tooling the CLI does not
  run (the same boundary that keeps Vite out of the plugin graph, AI_GUIDELINES §12.2). Owned by a
  future CLI extension; the plugin ships with no schematic.
- **Auth/telemetry/metrics/multi-tenancy bridging into the gRPC call path.** The interceptor runs
  before the kernel pipeline, so `authMiddleware` (M16), OTel auto-instrumentation (M24b),
  Prometheus collectors (M19), and tenant resolution (M32) do not automatically apply to RPC calls.
  Apps read Connect metadata inside their service implementation for now; a future milestone owns
  gRPC-aware interceptors bridging these capabilities.
- **The browser/client SDK for calling these endpoints.** Owned by M35 (`sdk`); Connect/gRPC-Web
  clients are generated by the app's own toolchain.
- **AsyncAPI documentation of gRPC endpoints.** Owned by a future documentation milestone (M38);
  OpenAPI 3.1 has no RPC operation model.
- **Code generation of `.proto` files or TypeScript service descriptors.** Owned entirely by the
  consuming application via `buf`; the plugin consumes generated definitions, it does not produce
  them.
