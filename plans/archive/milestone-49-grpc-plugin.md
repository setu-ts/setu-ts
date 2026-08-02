# Milestone 49 — gRPC Plugin (`@hono-enterprise/grpc-plugin`)

> **Status:** Planning. Branch: `feat/m49-grpc-plugin`. `main` is protected — all work
> (implementation + fixes) stays on this one branch until it merges via a single PR.

## 0. Objective & scope

Provide **gRPC** as an optional plugin so a Hono Enterprise application can co-serve gRPC family
APIs — the gRPC, Connect, and gRPC-Web protocols — on the **same port and the same fetch handler**
as its existing Hono routes, with no separate listener, no raw socket, and identical behavior on
Node, Deno, Bun, and Cloudflare Workers. The plugin registers an `IGrpcService` under a new
`CAPABILITIES.GRPC = 'grpc'` token; applications register Protobuf service implementations, and get
server reflection and a gRPC Health v1 service bridged to the existing health plugin (M20).

The runtime is **Connect-ES** (`@connectrpc/connect` core plus the Protobuf-ES runtime
`@bufbuild/protobuf`) because it is **fetch-native**: it operates on the web `Request`/`Response`
the HTTP adapter already owns. Like the WebSocket plugin (M46), gRPC must bypass
`IRequest`/`IResponse` (which pre-read the body and cannot express trailers), so it hooks the same
HTTP-adapter seam — one new **optional** `IHttpAdapter.setRpcHandler?(handler)` member. Unlike
WebSocket, Connect is pure fetch, so it needs **no per-runtime upgraders**: a single interceptor
serves all four runtimes.

- **In scope:** the `common` gRPC contract + `GRPC` token + the `IHttpAdapter.setRpcHandler?`
  widening; a shared fetch-RPC interceptor store in `runtime`; the four adapters consulting it
  before body mapping; the `grpc-plugin` package (Connect loader + path-dispatching fetch bridge,
  service registry, embedded descriptor sets, `grpc.reflection.v1.ServerReflection`,
  `grpc.health.v1.Health` bridged to M20, options, errors); and the full unit + integration +
  real-path e2e test tree. Public surface, PUBLIC_API.md, ARCHITECTURE.md, README.md, ROADMAP.md,
  and `scripts/release-packages.ts` updated in the same PR.
- **NOT this milestone:** a `honoe generate grpc-service` CLI schematic (§9); auth / telemetry /
  metrics / multi-tenancy bridging into the gRPC call path (the interceptor runs before the kernel
  pipeline; §9 names the owning milestones); the browser client SDK (M35); `grpc.health.v1.Health`'s
  `List` and `Watch` methods (§3.6 — left to Connect's automatic `unimplemented` responder); codegen
  of the **application's** service descriptors (§9 — `buf` is app-level build tooling).

### 0.1 Approach and rejected alternatives

The gRPC delivery question is: how do you serve gRPC on a **Hono/fetch-based** runtime that also
runs on Node, Bun, and Workers? Three approaches were evaluated; **Connect-ES core is chosen**.

| Approach                                                                    | Runtime fit                                                                 | Co-serves with Hono                                                   | Streaming (all 4 RPC kinds)                                                                         | Protocols                                                         | Verdict                                                                                                                                                |
| --------------------------------------------------------------------------- | --------------------------------------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ |
| **Connect-ES core** (`@connectrpc/connect` + `@bufbuild/protobuf`) — CHOSEN | Fetch-native; one interceptor serves Node, Deno, Bun, Workers identically   | Yes — same `fetch` handler; returns `null` to fall through to Hono    | Unary, server-streaming, client-streaming everywhere; bidi subject to the HTTP-version gate in §3.8 | Connect, gRPC, gRPC-Web; interops with grpcurl/Envoy/grpc-gateway | **Ship.** Zero per-runtime code. Reflection and health are NOT shipped by Connect and are built here (§3.5–§3.7).                                      |
| `@grpc/grpc-js` + `@grpc/proto-loader`                                      | Node-only; binds a raw HTTP/2 socket (`node:http2`)                         | No — needs its own listener/port; cannot share the Hono fetch handler | Yes                                                                                                 | gRPC only (no Connect, no first-class gRPC-Web server)            | **Reject.** Breaks runtime independence (AI_GUIDELINES §4.1), violates §4.3 (no plugin may create an HTTP server), and cannot run on Deno/Bun/Workers. |
| `grpc-web` (server side)                                                    | Not a server runtime; a browser wire format needing Envoy/proxy translation | No — requires a sidecar proxy                                         | Unary + server-streaming only (gRPC-Web limit)                                                      | gRPC-Web only                                                     | **Reject.** Adds an operational dependency (Envoy) and lacks client-streaming/bidi. Connect serves gRPC-Web from the same handler for free.            |

**Why Connect core rather than a Connect framework adapter.** The
[`IHttpAdapter`](packages/common/src/runtime.ts#L292) contract is web-`fetch`-centric
(`fetch(request: Request): Promise<Response>`), so a runtime that already speaks
`Request`/`Response` slots in with one interceptor. Connect's published first-party adapters are
exactly `@connectrpc/connect-node`, `-fastify`, `-express`, `-next`, and `-web` (verified against
the npm registry, §1) — **none of them is fetch-native for a server**, and there is no first-party
Hono or Cloudflare Workers adapter to adopt or to reject. Core, however, already exports the whole
fetch seam from the `@connectrpc/connect/protocol` subpath (`createFetchHandler`,
`universalServerRequestFromFetch`, `universalServerResponseToFetch`), so the plugin needs no
converters of its own — only path-based dispatch across `router.handlers` (§3.4). The alternatives
above re-introduce the raw-socket server model M23 deliberately removed (`@grpc/grpc-js`) or demand
a proxy the framework cannot own (`grpc-web`).

### 0.2 Impact analysis — what gets touched

| Area                   | Change                                                                                                 | Paths                                                                                                                                                                                       |
| ---------------------- | ------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Workspace manifest     | Register the new package                                                                               | `deno.json` (add `"./packages/grpc-plugin"` to `workspace`)                                                                                                                                 |
| `common` contract      | New gRPC service types; new token; adapter widening                                                    | `packages/common/src/services/grpc.ts` (new), `packages/common/src/tokens.ts`, `packages/common/src/runtime.ts`, `packages/common/src/index.ts`                                             |
| `runtime` adapter seam | A shared fetch-RPC interceptor store; all four HTTP adapters consult it before the shared body mapping | `packages/runtime/src/adapters/shared/rpc-interceptor-store.ts` (new), `packages/runtime/src/adapters/{deno,node,bun,workers}/*-http-adapter.ts` (4 edits), `packages/runtime/src/index.ts` |
| New package            | Full plugin tree mirroring `websocket-plugin`                                                          | `packages/grpc-plugin/{deno.json,README.md,src/**}` + `test/{unit,integration,e2e}` (files in §5.3)                                                                                         |
| Public API             | New `grpc-plugin` section; widen the `IHttpAdapter` / Runtime listings; add the M49 seam note          | `PUBLIC_API.md`                                                                                                                                                                             |
| Architecture           | Move gRPC out of §18 "Future"; refresh the stale §7 `IHttpAdapter` block                               | `ARCHITECTURE.md` (§7 + §18)                                                                                                                                                                |
| Root README            | Move the existing gRPC row out of "Not yet built"                                                      | `README.md`                                                                                                                                                                                 |
| Roadmap                | New milestone entry + Progress Tracking row; reconcile the M14c aside                                  | `ROADMAP.md`                                                                                                                                                                                |
| Release list           | Add the new publishable package (Tier 4, alphabetical)                                                 | `scripts/release-packages.ts`                                                                                                                                                               |
| Cross-plugin interplay | Health (M20) bridged in-scope; auth/telemetry/metrics/multi-tenancy deferred (§9)                      | none (capability-token resolved at runtime)                                                                                                                                                 |
| CLI schematic          | Assessed — deferred (§9)                                                                               | `packages/cli/src/schematics/registry.ts` (no change this milestone)                                                                                                                        |

## 1. Contracts verified from SOURCE (not names)

Every external reference the design leans on, verified by opening the source and citing file:line,
or by fetching the published artifact. A name not read is not verified. In-repo citations were
re-checked against HEAD on `feat/m49-grpc-plugin`; npm facts were read from the **published
tarballs** of `@connectrpc/connect@2.1.2` and `@bufbuild/protobuf@2.13.0`, not from documentation.

| Reference                                            | Source (file:line)                                                                                                                                        | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `IHttpAdapter`                                       | `packages/common/src/runtime.ts:292-343`                                                                                                                  | Exactly five members today: `setHandler`, `fetch`, `listen`, `close`, and the optional `setUpgradeRouter?` at line 342 (since 0.2.0). A new optional `setRpcHandler?` is additive and follows the exact same precedent.                                                                                                                                                                                                                                                                                                                                                                                                               |
| `IRequest`                                           | `packages/common/src/http.ts:33-85`                                                                                                                       | Carries `method`/`url`/`path`/`headers`/`ip?`/`user?`/`tenant?`/`signal?`/`json`/`text`/`bytes`. Carries **no** native `Request` and exposes the body only through the three readers — so a gRPC handler provably cannot reach the raw streaming body or trailers through it.                                                                                                                                                                                                                                                                                                                                                         |
| `IResponse`                                          | `packages/common/src/http.ts:100-197`                                                                                                                     | Has `status`/`header`/`appendHeader`/`json`/`text`/`send`/`redirect`/`stream(ReadableStream<Uint8Array>)`/`snapshot()`. Has **no trailing-header** surface — gRPC status + trailers cannot be expressed, so gRPC cannot return through `IResponse`.                                                                                                                                                                                                                                                                                                                                                                                   |
| `mapWebRequestToFrameworkRequest`                    | `packages/runtime/src/adapters/shared/fetch-mapping.ts:26`, `arrayBuffer()` at `:37`                                                                      | Calls `await request.arrayBuffer()` on every request, **disturbing** the body. Combined with the `IRequest`/`IResponse` facts above, the gRPC interceptor MUST run before this call.                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `UpgradeRouterStore`                                 | `packages/runtime/src/adapters/shared/upgrade-router-store.ts:18-70`                                                                                      | The shared-store pattern: hold a callback, consult it, return `null` to fall through, convert a throwing callback to a safe rejection. `consult` additionally pre-filters with `isWebSocketUpgradeRequest(request.headers)` — protocol detection needing no app config. `RpcInterceptorStore` mirrors the holder, **not** the pre-filter (§3.4).                                                                                                                                                                                                                                                                                      |
| Deno adapter fetch path                              | `packages/runtime/src/adapters/deno/deno-http-adapter.ts:154-168`                                                                                         | `createFetchHandler` consults `#tryUpgrade` first, then `mapWebRequestToFrameworkRequest`. The gRPC consult slots in between — after the upgrade short-circuit, before the body is read. `fetch()` at `:250` and `listen()` at `:255` both go through `createFetchHandler`, so one insertion covers both entry paths.                                                                                                                                                                                                                                                                                                                 |
| Workers adapter fetch path                           | `packages/runtime/src/adapters/workers/cf-http-adapter.ts:66-80`                                                                                          | Identical shape to Deno: `#tryUpgrade` then the mapping. `fetch()` at `:139` reuses it.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Bun adapter fetch path                               | `packages/runtime/src/adapters/bun/bun-http-adapter.ts:139`, serve path at `:161`, `fetch()` at `:230`                                                    | `createFetchHandler` is shared by the serve callback and `fetch()`; the serve path wraps it only to attempt `server.upgrade` first.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Node adapter fetch path                              | `packages/runtime/src/adapters/node/node-http-adapter.ts:211-220`                                                                                         | `createFetchHandler` maps the body **immediately** — there is no upgrade consult here, because Node's WebSocket upgrade lives on the raw `upgrade` event (`attachUpgradeListener`, `:127`). gRPC is ordinary HTTP traffic, so the consult goes at the top of this `fetch` callback. Used by `listen()` at `:260` and `fetch()` at `:275`.                                                                                                                                                                                                                                                                                             |
| `IRouterApi`                                         | `packages/common/src/plugin.ts:74-141`                                                                                                                    | Exposes the seven verbs, `group`, and `listRoutes` only — **no** raw-fetch or catch-all registration. So gRPC cannot mount on the kernel router; the adapter seam is the only path.                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `Application.fetch`                                  | `packages/kernel/src/application/application.ts:388-396`                                                                                                  | Delegates straight to `adapter.fetch(request)`. Covers `listen` and the Workers `export default { fetch }` entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `Application.inject`                                 | `packages/kernel/src/application/application.ts:398`, `#handleRequest` call at `:437`                                                                     | **`inject()` does NOT reach the adapter.** It synthesizes an `IRequest` and calls `#handleRequest` directly, so an RPC request presented to `inject()` is never intercepted. It also throws on a streaming response body (`:443-449`). Both facts force every RPC test to drive `app.fetch(webRequest)`.                                                                                                                                                                                                                                                                                                                              |
| `CAPABILITIES` + token grammar                       | `packages/common/src/tokens.ts:101,103,105,148,169`                                                                                                       | No `GRPC` key exists; `HTTP_ADAPTER: 'http-adapter'`, `SSE: 'sse'`, `WEBSOCKET: 'websocket'`, `HEALTH: 'health'` (`:67`) do. `TOKEN_PATTERN` (`:148`) is dot-segmented kebab-case; colons are illegal. `'grpc'` is one valid lowercase segment.                                                                                                                                                                                                                                                                                                                                                                                       |
| `PluginResolver` duplicate detection                 | `packages/kernel/src/registry/plugin-resolver.ts`                                                                                                         | Duplicate plugin names and duplicate capability providers throw at startup. `GrpcPlugin` is single-instance, claiming the bare `grpc` token exactly once (§3.10).                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `IPluginContext` / `IHealthApi`                      | `packages/common/src/plugin.ts:185-193`, `:440`                                                                                                           | `ctx.health` is an `IHealthApi` whose single method is `register(name, indicator)`. `ctx.logger` is optional (undefined with no logger capability) — the M46 precedent uses `ctx.logger?.info(...)`, not a plugin option (§3.11).                                                                                                                                                                                                                                                                                                                                                                                                     |
| `IHealthService` / `HealthStatus`                    | `packages/common/src/services/health.ts:93-114`, `packages/common/src/types.ts:62`                                                                        | `IHealthService.check(): Promise<HealthReport>`; `HealthStatus = 'up' \| 'down' \| 'degraded'`. Three states against gRPC Health v1's four-value enum — the mapping is a design decision, made in §3.6.                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `@connectrpc/connect`                                | npm registry + tarball `connect-2.1.2.tgz`                                                                                                                | Latest `2.1.2`. **Zero runtime dependencies**; peer `@bufbuild/protobuf: ^2.7.0`. Exports map is exactly `.`, `./protocol`, `./protocol-grpc`, `./protocol-connect`, `./protocol-grpc-web`.                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| Connect ships **no** reflection or health            | tarball file listing                                                                                                                                      | `tar tzf connect-2.1.2.tgz \| grep -iE 'reflect\|health'` returns **nothing**, and `@connectrpc/connect-reflection` is a 404 on npm. Neither `grpc.reflection.v1.ServerReflection` nor `grpc.health.v1.Health` is provided by Connect — both are built in this milestone (§3.5–§3.7).                                                                                                                                                                                                                                                                                                                                                 |
| Connect's first-party adapter set                    | npm registry (HTTP status per package)                                                                                                                    | `connect-node`, `connect-fastify`, `connect-express`, `connect-next`, `connect-web` all resolve `200`. `@connectrpc/connect-hono` and `@connectrpc/connect-cloudflare-workers` **do not exist** (`404`). No framework adapter is adopted or rejected; core is used directly.                                                                                                                                                                                                                                                                                                                                                          |
| `ConnectRouter`                                      | `connect/dist/esm/router.d.ts`                                                                                                                            | `service: <T extends DescService>(service: T, implementation: Partial<ServiceImpl<T>>, options?) => this`. Registration requires a real `DescService` from `@bufbuild/protobuf` — which is why the plugin's own health and reflection services need descriptors (§3.5). Documented behavior: "If you omit a method, the router adds a method that responds with an error code `unimplemented`" — this is what covers `Health.Watch` (§3.7).                                                                                                                                                                                           |
| `@connectrpc/connect/protocol` fetch seam            | `connect/dist/esm/protocol/universal-fetch.d.ts:18,30,34` and `.js:27-34,64`                                                                              | `createFetchHandler(uHandler, options?): (req: Request) => Promise<Response>` already performs the whole conversion via `universalServerRequestFromFetch` / `universalServerResponseToFetch`. It returns `Object.assign(handleFetch, uHandler)`, so the result **retains** `requestPath`/`service`/`method`/`allowedMethods`. `options.httpVersion` defaults to `''`.                                                                                                                                                                                                                                                                 |
| `UniversalHandler`                                   | `connect/dist/esm/protocol/universal-handler.d.ts:87-107`                                                                                                 | Carries `requestPath` — "the request path of the procedure, **without any prefixes**", e.g. `/foo.FooService/Bar`. This is the key the dispatch map is built from (§3.4).                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| Bidi HTTP-version gate                               | `connect/dist/esm/protocol/universal-handler.js:88`                                                                                                       | A `bidi_streaming` method is refused with `505` when `request.httpVersion.startsWith('1.')`. With the default `httpVersion: ''` the gate does **not** fire. Governs §3.8.                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `@bufbuild/protobuf`                                 | npm registry + tarball `protobuf-2.13.0.tgz`                                                                                                              | Latest `2.13.0`, **zero dependencies**, no peers. Root re-exports `./registry.js` and `./descriptors.js`; subpaths include `./wkt` and `./reflect`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| Runtime descriptor reconstruction                    | `protobuf/dist/esm/registry.d.ts:87`, `descriptors.d.ts:76`, `wkt/gen/google/protobuf/descriptor_pb.d.ts:35,236`                                          | `createFileRegistry(fileDescriptorSet): FileRegistry` exists; `FileRegistry` adds `files` + `getFile(fileName)` to `Registry`'s `get`/`getService`/`getMessage`; `DescFile.proto` is the raw `FileDescriptorProto`. `FileDescriptorSetSchema` and `FileDescriptorProtoSchema` live in the `./wkt` subpath. Together with root `fromBinary`/`toBinary`/`create`, this is the complete toolkit for §3.5 — descriptors from embedded bytes at runtime, with **no generated code committed as TypeScript**.                                                                                                                               |
| Embedded descriptor sets — **executed, not assumed** | `protoc` 35.1 over `grpc/grpc-proto` `grpc/health/v1/health.proto` + `grpc/reflection/v1/reflection.proto`, revived with real `@bufbuild/protobuf@2.13.0` | The full §3.3 path was run before this plan relied on it. `--descriptor_set_out` produces 874 B / 1747 B (base64 1168 / 2332 chars); `fromBinary(FileDescriptorSetSchema, …)` → `createFileRegistry` → `getService` returns `kind: 'service'` for both. **`grpc.health.v1.Health` declares THREE RPCs** — `Check` (unary), `List` (unary), `Watch` (server_streaming) — not the two an older reading assumes (§3.6). `grpc.reflection.v1.ServerReflection` declares one, `ServerReflectionInfo` (**bidi_streaming**, which §3.7/§3.8 must account for). Both files report `dependencies.length === 0`, so each set is self-contained. |
| BSR module pages are **not** usable as evidence      | `curl` against `buf.build`                                                                                                                                | `buf.build/grpc/health` and `buf.build/grpc/reflection` return `200` — but so does `buf.build/bogus/doesnotexist9`. The BSR web app answers `200` for any path, so a page status proves nothing about a module's existence. `buf` is also absent from this toolchain. Hence §3.3's provenance command is `protoc` over the canonical GitHub protos, both of which were verified to fetch and compile.                                                                                                                                                                                                                                 |
| Connect RPC media types                              | `connect/dist/esm/protocol-{connect,grpc,grpc-web}/*.js`                                                                                                  | The real set is `application/connect+json`, `application/connect+proto`, `application/grpc+json`, `application/grpc+proto`, `application/grpc-web+json`, `application/grpc-web+proto`, `application/json`, `application/proto` (plus the bare `application/grpc` and `application/grpc-web`). **`application/json` and `application/proto` are Connect unary content types**, so content-type sniffing cannot separate RPC from ordinary traffic — this is why detection is path-prefix-only (§3.4).                                                                                                                                  |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #  | Conflict                                                                                                                                                                                                                                                                                                                                                                            | Resolution (picked side)                                                                                                                                                                                      | Doc deliverable (same PR)                                                                                                                                                                                                                                                       |
| -- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| C1 | gRPC is already listed in `ARCHITECTURE.md` **§18 Future Evolution** — in the mermaid diagram (`:2410` `gRPC[gRPC Plugin]` under `subgraph Future`, `Kernel --> gRPC` at `:2418`) and in the "Future Additions" table (`:2486`, "New plugin that provides gRPC server **and client**"). Shipping it makes both stale, and the table row overstates scope: the client is M35's (§9). | Remove gRPC from the Future diagram and table; add a short note in the M46 style (`:2427`) recording that the plugin does not hang off the kernel — it depends on `common` and the `http-adapter` capability. | Delete the `gRPC[gRPC Plugin]` node and the `Kernel --> gRPC` edge; delete the Future Additions row; add the §18 note naming the seam and stating the client is out of scope.                                                                                                   |
| C2 | `ARCHITECTURE.md` §7's `IHttpAdapter` block (`:896-910`) shows **four** members and never mentions `setUpgradeRouter?` — it was never refreshed when M46 landed. M49 adds a third seam to a block already one behind.                                                                                                                                                               | Refresh the block once, to the real five-plus-one shape.                                                                                                                                                      | Update the §7 code block to include `setUpgradeRouter?` **and** `setRpcHandler?`, with one sentence each naming the WebSocket and gRPC consumers and the before-the-body-mapping ordering requirement.                                                                          |
| C3 | `README.md` already has a gRPC row (`:173`) in the **"Not yet built"** table, `🚧 Planned`, described as "Client and server support for microservice communication".                                                                                                                                                                                                                | The server ships; the client does not.                                                                                                                                                                        | Move the row into the shipped capability table as `✅` with the `grpc-plugin` package name, and reword to the server scope. Confirm "Not yet built" retains only the GraphQL row.                                                                                               |
| C4 | `PUBLIC_API.md` has no gRPC group; the Runtime type row (`:5431`) and the four HTTP adapter rows (`:5592-5595`) list no RPC interceptor; the adapter-widening notes stop at the M46 entry (`:5696`).                                                                                                                                                                                | The widening is deliberate and public.                                                                                                                                                                        | Add the gRPC type group to the `common` table; add `setRpcHandler?` to the `IHttpAdapter` listing; add an "M49 added a sixth, OPTIONAL member: `setRpcHandler?(handler)`" note directly after the M46 one; add the full `grpc-plugin` section (Options / Exports / Notes).      |
| C5 | `ROADMAP.md:1792` (the M14c aside) commits to "Direct point-to-point typed RPC (gRPC/Connect over **the kernel catch-all**) is a separate future milestone". This plan rejects the catch-all route — `IRouterApi` cannot register one (§1), and the mapping would disturb the body.                                                                                                 | The adapter seam supersedes the catch-all idea.                                                                                                                                                               | Correct the M14c aside to name the adapter seam and cross-reference Milestone 49, so the two committed statements agree.                                                                                                                                                        |
| C6 | `ROADMAP.md` has no gRPC milestone.                                                                                                                                                                                                                                                                                                                                                 | Add it.                                                                                                                                                                                                       | New "Milestone 49" section in the ROADMAP style, plus a "Progress Tracking" row, flipped to `✅` in this same PR per CLAUDE.md.                                                                                                                                                 |
| C7 | `scripts/release-packages.ts` enumerates publishable packages explicitly (alpha.3 published 38, M48 raised it to 42).                                                                                                                                                                                                                                                               | The new package must publish.                                                                                                                                                                                 | Add `packages/grpc-plugin` to Tier 4 in alphabetical position and run `deno task release:verify`. Note it publishes for the FIRST time, so the next release must run `release:create-packages` and `release:link-repos` before publishing (tokenless OIDC needs the repo link). |

## 3. Design decisions

### 3.1 Where gRPC is intercepted

- **Decision:** Inside each HTTP adapter's `fetch` path, **after** the WebSocket upgrade
  short-circuit (where one exists) and **before** `mapWebRequestToFrameworkRequest` reads the body.
  One new optional member on `IHttpAdapter`: `setRpcHandler?(handler: RpcFetchHandler): void`, where
  `RpcFetchHandler = (request: Request) => Promise<Response | null>`. A `Response` return means the
  request was handled as gRPC/Connect/gRPC-Web; `null` means "not an RPC request" and the adapter
  falls through to the ordinary Hono pipeline unchanged.
- **Why:** Verified in §1 — `IRequest`/`IResponse` cannot express a gRPC exchange (no raw body
  stream, no trailers), and the shared mapping disturbs the body. The adapter is the only component
  holding the native `Request` and owning the serve loop. A single optional member keeps the
  widening minimal and matches the `setUpgradeRouter?` (M46), `fs?` (M44), `workers?` (M45)
  precedents. gRPC is ordinary HTTP traffic (no protocol upgrade), so it needs no raw socket event
  like Node WebSocket did — it rides the `fetch` callback on every runtime.
- **Known limit, stated not hidden:** `Application.inject()` bypasses the adapter entirely (§1), so
  RPC is unreachable through `inject()`. This is documented in the plugin README and PUBLIC_API
  notes, and it is why every RPC test drives `app.fetch`.
- **Test home:** `runtime/test/unit/rpc-interceptor-store.test.ts` and the four
  `*-http-adapter-rpc.test.ts` files (§6).

### 3.2 The Connect runtime and how it loads

- **Decision:** Use Connect-ES **core** plus the Protobuf-ES runtime, loaded **inject-or-lazy**
  through an injected `connectModule` option defaulting to a lazy `import()` of **four** specifiers:
  `npm:@connectrpc/connect@^2.1.2`, `npm:@connectrpc/connect@^2.1.2/protocol`,
  `npm:@bufbuild/protobuf@^2.7.0`, and `npm:@bufbuild/protobuf@^2.7.0/wkt`. The four are adapted
  through one structural `adaptConnectModule(mod)` facade producing an internal `ConnectRuntime`
  port, so the rest of the plugin never touches a Connect or Protobuf-ES type. The plugin's
  `deno.json` carries **zero** Connect dependencies.
- **Why:** AI_GUIDELINES §12.2 forbids a heavy runtime driver as a hard plugin dependency. Four
  specifiers rather than two because the fetch seam lives in the `./protocol` subpath and
  `FileDescriptorSetSchema` lives in `./wkt` (both verified in §1) — naming only the two roots would
  have produced a loader that cannot reach the functions the design depends on. `^2.7.0` is the peer
  range Connect 2.1.2 actually declares (latest is 2.13.0).
- **The named port (this is the seam, not an implementation detail).** `ConnectRuntime` is declared
  in `src/interfaces/connect-runtime.ts` and is **not** exported from `src/index.ts`:
  `createRouter(options)`, `createFetchHandler(uHandler)`, `fromBinary(schema, bytes)`,
  `toBinary(schema, message)`, `create(schema, init)`, `createFileRegistry(fdSet)`,
  `fileDescriptorSetSchema`, `fileDescriptorProtoSchema`. Everything downstream consumes this port.
- **Test home:** `grpc-plugin/test/unit/connect-loader.test.ts` drives `adaptConnectModule` with a
  hand-built fake module (all branches: each of the four modules missing in turn, each producing the
  named error with the exact install command); `grpc-plugin/test/unit/connect-real-import.test.ts`
  is the guarded REAL import of all four specifiers, asserting they satisfy `ConnectRuntime`,
  skipped when the packages are absent.

### 3.3 Descriptors without committed generated code

- **Decision:** The plugin needs real `DescService` values for its own two services
  (`grpc.health.v1.Health`, `grpc.reflection.v1.ServerReflection`), because `ConnectRouter.service`
  is `<T extends DescService>` (§1). It obtains them by embedding each proto's `FileDescriptorSet`
  as a **base64 string constant** in `src/descriptors/embedded-descriptors.ts` and reconstructing
  descriptors at runtime through the `ConnectRuntime` port:
  `fromBinary(fileDescriptorSetSchema, decoded)` then `createFileRegistry(fdSet)` then
  `getService('grpc.health.v1.Health')`.
- **Why:** This is the only route that satisfies three constraints at once. Committing
  `protoc-gen-es` **TypeScript** output would make `@bufbuild/protobuf` a real import-time
  dependency of the package, breaking the zero-dependency rule and §3.13. Generating at build time
  would put a proto compiler in the publish path, which §9 forbids. Base64 bytes are inert data with
  no imports, and every API needed to revive them is already reachable through the lazy seam.
- **Provenance and drift control — the bytes are a committed generated artifact, and that is called
  out rather than implied.** Each constant's JSDoc records the exact producing command, the upstream
  commit the `.proto` was taken from, and the date. The command is `protoc`, not `buf`, and the
  inputs are the canonical protos from [`grpc/grpc-proto`](https://github.com/grpc/grpc-proto)
  rather than a BSR module:

  ```bash
  # from grpc/grpc-proto at <commit>; protoc 35.1 verified
  protoc -Iproto --include_imports \
    --descriptor_set_out=health.binpb proto/grpc/health/v1/health.proto
  protoc -Iproto --include_imports \
    --descriptor_set_out=reflection.binpb proto/grpc/reflection/v1/reflection.proto
  base64 -w0 < health.binpb        # 1168 chars, from 874 bytes
  base64 -w0 < reflection.binpb    # 2332 chars, from 1747 bytes
  ```

  A unit test decodes each constant and asserts the expected fully-qualified service name plus its
  method names and kinds, so a truncated or swapped constant fails loudly instead of degrading into
  an empty router.
- **Verified end to end before this plan committed to it (§1).** The two descriptor sets were built
  with the command above and revived with the real `@bufbuild/protobuf@2.13.0`:
  `fromBinary(FileDescriptorSetSchema, bytes)` → `createFileRegistry(fdSet)` → `getService(...)`
  returned `kind: 'service'` for both, with the method names and kinds recorded in §1. Both files
  report `dependencies.length === 0`, so each descriptor set is **self-contained** — no
  `descriptor.proto` or other well-known-type file has to be bundled or resolved, and the
  single-argument `createFileRegistry(fileDescriptorSet)` overload suffices with no resolver
  callback.
- **Application services are unaffected:** the app passes its own generated `DescService` straight
  to `addService`, and the plugin stays generic over it (§3.13). No descriptor reconstruction is
  involved on that path.
- **Test home:** `grpc-plugin/test/unit/embedded-descriptors.test.ts` (constants decode; expected
  service and method names present) and `grpc-plugin/test/unit/descriptor-registry.test.ts` (the
  revive path over a fake `ConnectRuntime`; a corrupt-bytes input throws the named error).

### 3.4 Request routing — path prefix only, dispatch by `requestPath`

- **Decision:** A request is RPC when its path starts with the configured `basePath` (default
  `/grpc`). **Content-type sniffing is deliberately not used.** Within the prefix, dispatch is an
  exact-match `Map<string, FetchHandlerFn>` built **once at registration time**, keyed by
  `basePath + handler.requestPath` over `router.handlers.map(rt.createFetchHandler)`. A prefixed
  path with no map entry answers `404`; a path outside the prefix returns `null` and falls through
  to Hono.
- **Why:** Connect's real unary content types include `application/json` and `application/proto`
  (§1). Matching them would classify every ordinary JSON POST as RPC and hijack the application's
  own routes; omitting them would make content-type detection incomplete and arbitrary. Since a
  Connect/gRPC client is configured with a base URL, the prefix is sufficient and unambiguous — so
  the honest design is prefix-only, and the plan states this rather than shipping a half-complete
  media-type list. Dispatch by `requestPath` is exact-match, needing no `:param` matcher: the
  kernel's matcher is internal (`packages/kernel/src/router/route-matcher.ts`, not exported), and
  hand-rolling a second one is duplication CLAUDE.md forbids. `createFetchHandler` preserves
  `requestPath` on its result (§1), so the map is built from the handlers themselves with no
  parallel bookkeeping. Variable data (tenant, request id) travels in Connect request metadata,
  never in the path.
- **Where detection lives — and why it is NOT in the runtime store.** `RpcInterceptorStore` is a
  pure holder: it calls the installed handler and converts a throw to a `500`, with no pre-filter.
  This differs from `UpgradeRouterStore`, which pre-filters on `isWebSocketUpgradeRequest(headers)`
  — and the asymmetry is the point. Upgrade detection reads a protocol header and needs no
  configuration; RPC detection needs the application's `basePath`, which is a **plugin option** and
  has no route across the `common` boundary that `setRpcHandler?(handler)` provides. Putting
  detection in the store would force one of two bad trades: widen the signature to carry `basePath`,
  or duplicate the option in `runtime`. Consequently `runtime` exports **no** `isRpcRequest` and
  **no** `RPC_MEDIA_TYPES` (both were dead surface once detection moved); the cost is one
  `startsWith` per request inside the plugin's handler, which is why the map is hoisted to
  registration time (AI_GUIDELINES §14).
- **Test home:** `grpc-plugin/test/unit/rpc-dispatcher.test.ts` — prefix hit and miss; exact
  `requestPath` dispatch; a prefixed unknown path answers `404`; a non-prefixed path returns `null`;
  a request carrying `application/json` to a non-prefixed path returns `null` (the regression this
  decision exists to prevent); `basePath` with and without a trailing slash normalize identically.

### 3.5 Serving Connect on the fetch handler

- **Decision:** Build the `ConnectRouter` once during `register()`, register the app's services plus
  health and reflection onto it, then map every `UniversalHandler` through the port's
  `createFetchHandler` into the dispatch map of §3.4. The plugin writes **no** request/response
  converters.
- **Why:** `@connectrpc/connect/protocol` already exports the exact conversion the framework needs
  (§1), including trailer and streaming handling that a hand-rolled converter would have to
  re-derive per protocol. Writing our own would be reimplementing a dependency's tested code — the
  duplication smell CLAUDE.md's self-review checklist names. What Connect does _not_ provide is
  dispatch across handlers under a prefix, which is precisely the plugin's job.
- **`httpVersion` is deliberately left unset.** `createFetchHandler`'s option defaults to `''` (§1)
  and the only thing it gates is the bidi refusal in §3.8. `IHttpAdapter` surfaces no negotiated
  HTTP version, so any value the plugin invented would be a guess — and guessing `'1.1'` would
  refuse bidi even on HTTP/2 and in-process. Leaving it unset is recorded here as a decision, with
  its consequence in §3.8.
- **Test home:** `grpc-plugin/test/unit/connect-router-builder.test.ts` — over a fake
  `ConnectRuntime`, the builder registers exactly the expected services for each option combination,
  and the returned map is keyed `basePath + requestPath`; the real handler is exercised in the e2e.

### 3.6 gRPC Health v1 bridge (interplay with M20)

- **Decision:** With `health: true` (default) the plugin registers `grpc.health.v1.Health` from the
  embedded descriptors, implementing **`Check` only**. `Check` resolves `CAPABILITIES.HEALTH`
  optionally: present, it awaits `IHealthService.check()` and maps the report; absent, it answers
  `SERVING`. A `service` field naming an unknown service answers `SERVICE_UNKNOWN`; the empty string
  means "the whole server" and is the mapped aggregate.
- **The `HealthStatus` mapping, decided here because the enum widths differ (§1):**
  `'up' → SERVING (1)`, `'down' → NOT_SERVING (2)`, and **`'degraded' → SERVING (1)`**. Degraded
  means impaired but still serving; mapping it to `NOT_SERVING` would make Kubernetes withdraw the
  replica from its Service exactly when the application is functional but under stress, shedding
  capacity in the wrong direction. No new option is introduced for this — a `degradedAsServing`
  toggle would be an option with a single caller and no demonstrated consumer.
- **`List` and `Watch` are intentionally unimplemented.** The current `grpc.health.v1.Health`
  declares **three** RPCs, not two — `Check` (unary), `List` (unary), and `Watch` (server-streaming)
  — confirmed by reviving the descriptor set (§1). `ConnectRouter.service` documents that an omitted
  method gets an automatic `unimplemented` responder (§1), which is the correct gRPC answer and
  needs no code. `Watch` would need change notifications `IHealthService` does not expose. `List`
  enumerates statuses per _gRPC service name_, but the framework's health report is keyed by
  indicator name (§1) — those are different namespaces, and inventing a mapping between them would
  report service health the plugin cannot actually observe. Recorded in §0 scope, the README, and
  PUBLIC_API notes.
- **Why bridge at all:** operators probe `grpc.health.v1.Health/Check`; a status disconnected from
  the rest of the app's health is a silent lie. Resolving through the capability token keeps the
  plugin decoupled (no import of the health plugin), matching how OpenAPI and metrics already
  consume health, and `optionalDependencies: ['health']` orders the health plugin ahead of it.
- **Test home:** `grpc-plugin/test/unit/grpc-health-bridge.test.ts` — each of the three
  `HealthStatus` values maps to the decided enum value; absent health capability answers `SERVING`;
  an unknown `service` answers `SERVICE_UNKNOWN`; `health: false` registers nothing; a rejecting
  `check()` answers `NOT_SERVING` rather than escaping.

### 3.7 Server reflection

- **Decision:** With `reflection: true` (default) the plugin registers
  `grpc.reflection.v1.ServerReflection` from the embedded descriptors, implementing
  `ServerReflectionInfo` over a `FileRegistry` built from every registered service's `.file` and its
  transitive `dependencies`, plus the plugin's own two files. Supported request variants:
  `list_services` (registry iteration), `file_by_filename` (`getFile`), `file_containing_symbol`
  (`get`, then that descriptor's `.file`), and `all_extension_numbers_of_type` (registry scan for
  extensions whose extendee matches). `file_containing_extension` answers a
  `ServerReflectionResponse.error_response` with `UNIMPLEMENTED`, documented — the framework
  registers no extensions, so there is nothing to return. Each served file is re-serialized with
  `toBinary(fileDescriptorProtoSchema, descFile.proto)`.
- **Why this is buildable without codegen:** the app's generated `DescService` already carries
  `.file` (a `DescFile` with `.proto` and `.dependencies`), verified in §1, so reflecting the app's
  services needs nothing the app is not already handing over. Only the reflection service's _own_
  descriptor needs embedding, which §3.3 covers. Reflection is the highest-value gRPC DX feature
  (grpcurl, grpcui, Postman with no manual `.proto`), and defaulting it on matches the OpenAPI
  plugin serving Swagger UI by default (M21).
- **Reflection is bidi-only, so it inherits §3.8's transport requirement — this is the one place
  that constraint bites a default-on feature.** `ServerReflectionInfo` is the service's sole method
  and its kind is `bidi_streaming`, confirmed by reviving the descriptor set (§1); there is no unary
  fallback in v1. Reflection therefore works over HTTP/2 and over in-process `app.fetch`, but not
  over a real HTTP/1.1 socket. In practice this is benign — `grpcurl` and `grpcui` speak gRPC over
  HTTP/2, which is the only transport that ever reaches reflection — but it must be stated rather
  than discovered: an operator probing a plaintext HTTP/1.1 listener will see reflection fail while
  unary RPCs on the same port succeed. Documented in the README, PUBLIC_API notes, and beside the
  `reflection` option.
- **v1alpha is not registered.** It would need a second embedded descriptor set for a deprecated
  API; `grpcurl` has spoken v1 since 1.9. Named in §9 so its absence is a decision, not a gap.
- **Test home:** `grpc-plugin/test/unit/grpc-reflection.test.ts` — each supported variant returns
  the expected payload over a fake registry; `file_containing_extension` returns the `UNIMPLEMENTED`
  error response; an unknown symbol returns `NOT_FOUND`; `reflection: false` registers nothing. The
  real bidi path is asserted in `grpc-reflection-e2e.test.ts` through in-process `app.fetch`, which
  is full-duplex (§3.8).

### 3.8 Streaming, trailers, and the bidi HTTP-version gate

- **Decision:** Unary, server-streaming, and client-streaming are supported on every runtime over
  web `ReadableStream`. **Bidi streaming works wherever the transport is genuinely full-duplex** —
  in-process `app.fetch` and HTTP/2 — and Connect answers `505` with `Connection: close` when it can
  see an HTTP/1.x request. Because the plugin leaves `httpVersion` unset (§3.5), Connect cannot see
  the version and does not refuse; a bidi call over a real HTTP/1.1 socket therefore fails at the
  transport rather than with a clean `505`. This is recorded as a named limitation in the README and
  PUBLIC_API notes, with the guidance that bidi deployments terminate HTTP/2. **Note this is not
  only an application concern:** the plugin's own `grpc.reflection.v1.ServerReflection` is
  bidi-streaming (§3.7), so reflection is subject to the same requirement.
- **Why:** The framework's streaming primitive `IResponse.stream()` (M42) already proved web
  `ReadableStream` is native to all four runtimes, and Connect rides the same primitive. The version
  gate is a verified upstream behavior (§1), not a guess, and the alternative — inventing an
  `httpVersion` value — would break bidi on transports that support it. `IHttpAdapter` exposing no
  negotiated version is the real root cause; widening it for this is out of scope and named in §9.
- **Trailers:** Connect encodes gRPC-Web and Connect-protocol trailers in the body (HTTP/1.1-safe)
  and emits real trailing headers for the gRPC protocol where the runtime's fetch supports them. The
  dispatcher forwards whatever `createFetchHandler` produces, unmodified.
- **Test home:** `grpc-plugin/test/e2e/grpc-streaming-e2e.test.ts` — a server-streaming method
  yields framed messages in order through `app.fetch`; a client-streaming method accumulates; a bidi
  method echoes over a streaming request body (valid in-process, per the gate above); the gRPC
  status trailer is present.

### 3.9 Behavior when the adapter cannot serve RPC

- **Decision:** The plugin probes `typeof adapter.setRpcHandler === 'function'`. When absent it
  still registers the service and the health indicator (reporting `available: false`),
  `addService(...)` still succeeds, and `register()` logs a warning via `ctx.logger?.warn` that RPC
  requests will not be served. `GrpcUnavailableError` is thrown only by an explicit
  `service.handleRequest(...)` call in that state, so a misconfiguration surfaces on use as well as
  at startup.
- **Why:** A custom third-party adapter predating this widening must not crash an application at
  startup. Surfacing unavailability at registration rather than silently at first request is the
  honest default, and it mirrors the M45 `WorkerPoolUnavailableError` / M46
  `WebSocketUnavailableError` degraded paths so one codebase deploys everywhere.
- **Test home:** `grpc-plugin/test/unit/grpc-plugin.test.ts` — a fake adapter without
  `setRpcHandler` registers cleanly, health reports `available: false`, the documented warning is
  logged, and `handleRequest` rejects with `GrpcUnavailableError`.

### 3.10 Plugin instance count and token ownership

- **Decision:** `GrpcPlugin` is single-instance, `name: 'grpc-plugin'`,
  `provides: [CAPABILITIES.GRPC]`, `optionalDependencies: ['logger', 'health']`, priority `NORMAL`,
  and an **async** `register()` (the Connect import is awaited).
- **Why:** `PluginResolver` throws on duplicate plugin names and duplicate capability providers
  (§1), and two competing RPC routers on one server has no coherent meaning. `register()` must be
  async because the lazy `import()` is real, not a global hook (AI_GUIDELINES §12.2, and the
  precedent set by M31's `FlagProvider.start()` and M47's backplane subscription).
- **Test home:** `grpc-plugin/test/integration/grpc-integration.test.ts` — the service resolves from
  `CAPABILITIES.GRPC` in a real kernel app, registering the plugin twice throws at startup, and a
  non-RPC request still routes normally through the Hono pipeline.

### 3.11 Options surface — no `logger` option

- **Decision:** Options are exactly `basePath`, `reflection`, `health`, `services`, and
  `connectModule` (§4.4). Logging goes through `ctx.logger?.…`.
- **Why:** M46 resolves its logger from the context with `optionalDependencies: ['logger']`
  ([websocket-plugin.ts:84](packages/websocket-plugin/src/plugin/websocket-plugin.ts#L84)) and takes
  no logger option. An option duplicating that would have exactly one write site and no behavior no
  other path already provides — the dead-surface defect CLAUDE.md's checklist names.

### 3.12 No `GrpcCallContext`

- **Decision:** `common` declares **no** gRPC call-context type. Service method implementations
  receive Connect's own `HandlerContext`, and applications close over whatever they need — including
  the services registry, which they already hold when they call `addService`.
- **Why:** An implementation's signature is fixed by Connect's `ServiceImpl<T>` / `MethodImpl<M>`,
  which the plugin does not control and cannot rewrite without wrapping every method in a shim that
  would have to reproduce Connect's typing. A `GrpcCallContext` exported from `common` would have no
  code path that constructs or reads it — a declaration whose only references are itself. Bridging
  framework concerns into the call path is §9's, and it is the milestone that should introduce a
  context type if one is warranted.

### 3.13 External-type policy for Connect and Protobuf-ES

- **Decision:** Declare minimal structural facades in the plugin (`ConnectModuleLike`,
  `ConnectRuntime`, `ConnectRouterLike`, `UniversalHandlerLike`, `FileRegistryLike`) and adapt the
  imported modules through `adaptConnectModule`. Never `import type` from `@connectrpc/connect` or
  `@bufbuild/protobuf`. `GrpcServiceDefinition` in `common` is an opaque structural constraint
  (`{ readonly typeName: string; readonly method: Readonly<Record<string, unknown>> }`) that the
  app's real generated `DescService` satisfies, and `addService<TDef extends GrpcServiceDefinition>`
  is generic over it.
- **Why:** A type dependency on a heavy gRPC library would force every consumer's type-check to
  resolve Connect, contradicting the zero-dependency-plugin rule. The structural-facade pattern is
  established by M29 (`ISesClient`, `ISmtpTransport`) and M46 (`adaptWsModule`). The constraint is
  deliberately shallow: it must accept a generated descriptor without describing one, so it asserts
  only the two fields the plugin itself reads.
- **Test home:** `grpc-plugin/test/unit/connect-loader.test.ts` (fake module through the facade) and
  the guarded real-import test (real modules satisfy the same shape).

## 4. Exported surface — every symbol names its consumer

### 4.1 `@hono-enterprise/common` (contract additions)

| Exported symbol               | Kind                           | Consumer / real code path that READS it                                                                                                                                                                                   |
| ----------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CAPABILITIES.GRPC`           | token                          | `GrpcPlugin.provides` + `ctx.services.register`; resolved by application code and the integration test.                                                                                                                   |
| `IGrpcService`                | interface                      | Implemented by `GrpcService`; the type argument of `ctx.services.get` in the integration and e2e tests and in application code.                                                                                           |
| `GrpcServiceDefinition`       | interface (generic constraint) | The `definition` parameter constraint of `IGrpcService.addService`; satisfied structurally by the app's generated descriptor. Its two fields are read by the router builder (`typeName` for dedup and reflection keying). |
| `GrpcServingStatus`           | type                           | The `'unknown' \| 'serving' \| 'not-serving' \| 'service-unknown'` union the health bridge maps `HealthStatus` onto before encoding the enum; read by `grpc-health-bridge.ts` and asserted in its test.                   |
| `RpcFetchHandler`             | type                           | The parameter type of `IHttpAdapter.setRpcHandler`; stored and called by all four adapters and by `RpcInterceptorStore`.                                                                                                  |
| `IHttpAdapter.setRpcHandler?` | method (widening)              | Called by `GrpcPlugin.register`; implemented by all four runtime adapters.                                                                                                                                                |

### 4.2 `@hono-enterprise/runtime` (interceptor addition)

| Exported symbol       | Kind  | Consumer / real code path that READS it                                                                                                                                                                  |
| --------------------- | ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `RpcInterceptorStore` | class | Held by each of the four adapter handles; `set` stores the handler, `consult` answers `Response` or `null`, a throw becomes a `500`. Exported so a custom adapter author needs only the runtime package. |

> `isRpcRequest` and `RPC_MEDIA_TYPES` are **deliberately not exported** — detection moved into the
> plugin (§3.4), so exporting them would ship two names nothing in the repo reads.

### 4.3 `@hono-enterprise/grpc-plugin`

| Exported symbol        | Kind     | Consumer / real code path that READS it                                                                                                     |
| ---------------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `GrpcPlugin`           | fn       | Registered by application code; driven by the integration and e2e tests.                                                                    |
| `GrpcService`          | class    | Registered under `CAPABILITIES.GRPC` by the plugin; exported so applications can compose it in tests without subclassing.                   |
| `adaptConnectModule`   | function | Called by the plugin's loader and directly by the unit test with a fake module.                                                             |
| `GrpcUnavailableError` | class    | Thrown by `GrpcService.handleRequest` with no adapter seam; asserted with `instanceof` in the plugin unit test.                             |
| `GrpcRuntimeLoadError` | class    | Thrown by `loadConnectModule` when any of the four specifiers cannot be imported; carries the install command. Asserted in the loader test. |
| `GrpcPluginOptions`    | type     | The parameter type of `GrpcPlugin`; every field consumed per §4.4.                                                                          |

### 4.4 Options — every option names its consumer

| Option          | Consumer                                              | Behavior (per implementation)                                                                                                                                                                                   |
| --------------- | ----------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `basePath`      | `rpc-dispatcher.ts`                                   | Path prefix that marks a request as RPC and prefixes every dispatch key. Defaults to `/grpc`; normalized to a single leading slash and no trailing slash. A path outside it returns `null` and is left to Hono. |
| `reflection`    | `connect-router-builder.ts` → `grpc-reflection.ts`    | `true` (default) registers `grpc.reflection.v1.ServerReflection`; `false` registers nothing.                                                                                                                    |
| `health`        | `connect-router-builder.ts` → `grpc-health-bridge.ts` | `true` (default) registers `grpc.health.v1.Health` (`Check` only) bridged to `CAPABILITIES.HEALTH` when present, else `SERVING`; `false` registers nothing.                                                     |
| `services`      | `GrpcService.register`                                | A convenience list of `{ definition, implementation }` pairs registered at startup, so a small app need not resolve the service and call `addService` itself. Empty by default.                                 |
| `connectModule` | `connect-loader.ts`                                   | An injected `ConnectModuleLike` (the four modules of §3.2), defaulting to the lazy `import()`. The seam that lets unit tests avoid the network.                                                                 |

## 5. Implementation files

### 5.1 `packages/common`

| File                   | Purpose                                                                                                                                                                                                                                                                         |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/services/grpc.ts` | New. The gRPC contract group (§4.1): `IGrpcService`, `GrpcServiceDefinition`, `GrpcServingStatus`, `RpcFetchHandler`.                                                                                                                                                           |
| `src/runtime.ts`       | Edit. Add the optional `setRpcHandler?(handler: RpcFetchHandler): void` member to `IHttpAdapter`, importing the handler type exactly as it imports `WebSocketUpgradeRouter` today. JSDoc states the before-the-body-mapping ordering requirement and the `inject()` limitation. |
| `src/tokens.ts`        | Edit. Add `GRPC: 'grpc'` to `CAPABILITIES`.                                                                                                                                                                                                                                     |
| `src/index.ts`         | Edit. Re-export the new contract group.                                                                                                                                                                                                                                         |

### 5.2 `packages/runtime`

| File                                           | Purpose                                                                                                                                                                                     |
| ---------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/adapters/shared/rpc-interceptor-store.ts` | New. `RpcInterceptorStore` — hold the handler, call it, return `null` to fall through, convert a throw to a `500`. Mirrors `UpgradeRouterStore`'s holder half, without a pre-filter (§3.4). |
| `src/adapters/deno/deno-http-adapter.ts`       | Edit. Hold a store, expose `setRpcHandler`, consult it in `createFetchHandler` after `#tryUpgrade` and before `mapWebRequestToFrameworkRequest`.                                            |
| `src/adapters/workers/cf-http-adapter.ts`      | Edit. Same insertion point (`:66`).                                                                                                                                                         |
| `src/adapters/bun/bun-http-adapter.ts`         | Edit. Same insertion point (`:139`), so both the serve callback and `fetch()` inherit it.                                                                                                   |
| `src/adapters/node/node-http-adapter.ts`       | Edit. Consult at the top of `createFetchHandler` (`:211`) — there is no upgrade consult on this path (§1).                                                                                  |
| `src/index.ts`                                 | Edit. Export `RpcInterceptorStore`.                                                                                                                                                         |

### 5.3 `packages/grpc-plugin`

| File                                       | Purpose                                                                                                                                                                           |
| ------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/index.ts`                             | Barrel exports (§4.3).                                                                                                                                                            |
| `src/plugin/grpc-plugin.ts`                | `GrpcPlugin` factory: load the Connect runtime, resolve the adapter, build the service, install the interceptor via `setRpcHandler`, register the health indicator and `onClose`. |
| `src/services/grpc-service.ts`             | `GrpcService` — owns the deferred service list, drives the router builder, exposes `addService` and `handleRequest`.                                                              |
| `src/interfaces/connect-runtime.ts`        | The internal `ConnectRuntime` port and the structural facades (§3.13). Not exported from `src/index.ts`.                                                                          |
| `src/interfaces/index.ts`                  | `GrpcPluginOptions` (§4.4).                                                                                                                                                       |
| `src/transports/connect-loader.ts`         | `adaptConnectModule` / `loadConnectModule` — the inject-or-lazy seam over the four specifiers and the named load error.                                                           |
| `src/transports/connect-router-builder.ts` | Builds the router, registers app services + health + reflection, maps `router.handlers` through `createFetchHandler` into the dispatch map.                                       |
| `src/transports/rpc-dispatcher.ts`         | `basePath` normalization, the prefix check, exact-match dispatch, `404` inside the prefix, `null` outside it.                                                                     |
| `src/descriptors/embedded-descriptors.ts`  | The two base64 `FileDescriptorSet` constants with their provenance JSDoc (§3.3).                                                                                                  |
| `src/descriptors/descriptor-registry.ts`   | Decode + `createFileRegistry` + service lookup; also builds the reflection registry from app services' `.file` and transitive `dependencies`.                                     |
| `src/health/grpc-health-bridge.ts`         | The `grpc.health.v1.Health` `Check` implementation and the `HealthStatus` mapping (§3.6).                                                                                         |
| `src/reflection/grpc-reflection.ts`        | The `ServerReflectionInfo` implementation and its four supported request variants (§3.7).                                                                                         |
| `src/errors/grpc-errors.ts`                | `GrpcUnavailableError`, `GrpcRuntimeLoadError`.                                                                                                                                   |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                               | src covered                                      | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------------------------------------- | ------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `common/test/unit/grpc-contract.test.ts`                | `common/src/services/grpc.ts`, `tokens.ts`       | `CAPABILITIES.GRPC === 'grpc'` and survives `createCapabilityToken`; `RpcFetchHandler` accepts a `Request` and returns `Promise<Response \| null>`; a hand-built object satisfies `GrpcServiceDefinition`.                                                                                                                                                                                                                                                                                                                                                                           |
| `runtime/test/unit/rpc-interceptor-store.test.ts`       | `shared/rpc-interceptor-store.ts`                | No handler returns `null`; store-then-consult returns the handler's `Response`; a handler returning `null` yields `null`; a throwing handler yields a `500` Response, not a crash; `set` twice replaces.                                                                                                                                                                                                                                                                                                                                                                             |
| `runtime/test/unit/deno-http-adapter-rpc.test.ts`       | `deno-http-adapter.ts`                           | A dispatched RPC request is served by the interceptor and the framework handler records zero calls; a `null` return falls through to the framework handler; the WebSocket upgrade still short-circuits ahead of RPC.                                                                                                                                                                                                                                                                                                                                                                 |
| `runtime/test/unit/node-http-adapter-rpc.test.ts`       | `node-http-adapter.ts`                           | Same three cases at the top of the `fetch` callback; the raw `upgrade` listener path is untouched.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `runtime/test/unit/bun-http-adapter-rpc.test.ts`        | `bun-http-adapter.ts`                            | Same three cases; asserted through both the serve callback and `fetch()`, since they share `createFetchHandler`.                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `runtime/test/unit/cf-http-adapter-rpc.test.ts`         | `cf-http-adapter.ts`                             | Same three cases on the Workers `fetch` entry.                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `grpc-plugin/test/unit/connect-loader.test.ts`          | `transports/connect-loader.ts`                   | `adaptConnectModule(fake)` yields a `ConnectRuntime` whose members delegate; each of the four modules missing in turn throws `GrpcRuntimeLoadError` naming that specifier and the install command.                                                                                                                                                                                                                                                                                                                                                                                   |
| `grpc-plugin/test/unit/connect-real-import.test.ts`     | the lazy `import()` lines                        | Guarded REAL import of all four specifiers; asserts they satisfy `ConnectRuntime` and that `createFetchHandler`'s result carries `requestPath`. Skipped when absent.                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `grpc-plugin/test/unit/embedded-descriptors.test.ts`    | `descriptors/embedded-descriptors.ts`            | Each constant is valid base64 and decodes to a `FileDescriptorSet` containing the expected service name; `grpc.health.v1.Health` declares exactly `Check`/`List`/`Watch` with kinds `unary`/`unary`/`server_streaming`; `grpc.reflection.v1.ServerReflection` declares exactly `ServerReflectionInfo` with kind `bidi_streaming`; both files report `dependencies.length === 0`. Asserting the method **set** (not a subset) is what catches an upstream proto gaining a method the bridge has not considered. Uses the real Protobuf-ES runtime, guarded like the real-import test. |
| `grpc-plugin/test/unit/descriptor-registry.test.ts`     | `descriptors/descriptor-registry.ts`             | Over a fake `ConnectRuntime`: the revive path calls `fromBinary` then `createFileRegistry` then `getService`; a missing service throws the named error; the reflection registry walks app services' `.file` and transitive `dependencies` without duplicating a shared dependency.                                                                                                                                                                                                                                                                                                   |
| `grpc-plugin/test/unit/rpc-dispatcher.test.ts`          | `transports/rpc-dispatcher.ts`                   | Prefix hit and miss; exact `requestPath` dispatch; unknown path inside the prefix answers `404`; non-prefixed path returns `null`; an `application/json` POST to a non-prefixed path returns `null`; `basePath` with and without a trailing slash normalize identically.                                                                                                                                                                                                                                                                                                             |
| `grpc-plugin/test/unit/connect-router-builder.test.ts`  | `transports/connect-router-builder.ts`           | Over a fake `ConnectRuntime`, each of the four `reflection`/`health` combinations registers exactly the expected service set; app `services` from options are registered; the returned map is keyed `basePath + requestPath`; a duplicate `typeName` throws rather than silently overwriting.                                                                                                                                                                                                                                                                                        |
| `grpc-plugin/test/unit/grpc-health-bridge.test.ts`      | `health/grpc-health-bridge.ts`                   | `'up' → serving`, `'down' → not-serving`, `'degraded' → serving`; absent health capability answers `serving`; unknown `service` answers `service-unknown`; a rejecting `check()` answers `not-serving`; `health: false` registers nothing.                                                                                                                                                                                                                                                                                                                                           |
| `grpc-plugin/test/unit/grpc-reflection.test.ts`         | `reflection/grpc-reflection.ts`                  | `list_services`, `file_by_filename`, `file_containing_symbol`, `all_extension_numbers_of_type` each return the expected payload over a fake registry; `file_containing_extension` returns the `UNIMPLEMENTED` error response; an unknown symbol returns `NOT_FOUND`; `reflection: false` registers nothing.                                                                                                                                                                                                                                                                          |
| `grpc-plugin/test/unit/grpc-service.test.ts`            | `services/grpc-service.ts`                       | `addService` defers before `register` then flushes to the router; `basePath` and `services` options wire through; `handleRequest` returns `null` for a non-RPC path and rejects with `GrpcUnavailableError` with no seam.                                                                                                                                                                                                                                                                                                                                                            |
| `grpc-plugin/test/unit/grpc-plugin.test.ts`             | `plugin/grpc-plugin.ts`, `errors/grpc-errors.ts` | Registers under the token; installs the interceptor on a fake adapter; health reports `available` both ways; an adapter without `setRpcHandler` logs the documented warning through `ctx.logger`; `onClose` tears down and aborts in-flight streams.                                                                                                                                                                                                                                                                                                                                 |
| `grpc-plugin/test/unit/barrel-exports.test.ts`          | `src/index.ts`, `src/interfaces/index.ts`        | Every §4.3 symbol is exported and defined (the websocket-plugin barrel precedent).                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `grpc-plugin/test/integration/grpc-integration.test.ts` | plugin ↔ kernel wiring                           | Service resolves from `CAPABILITIES.GRPC` in a real kernel app; duplicate registration throws at startup; a non-RPC request still routes normally through the Hono pipeline; `inject()` on an RPC path demonstrably does NOT reach the interceptor (pinning the §3.1 limitation rather than leaving it as prose).                                                                                                                                                                                                                                                                    |
| `grpc-plugin/test/e2e/grpc-unary-e2e.test.ts`           | the REAL path, end to end                        | On Deno with the real Connect runtime: register a unary service built from a fixture descriptor set, `app.start({ port: 0 })`, call it through `app.fetch` with a real Connect client, assert the typed response — then assert the same call outside `basePath` reaches an ordinary Hono route. The "exercise the REAL path once" evidence.                                                                                                                                                                                                                                          |
| `grpc-plugin/test/e2e/grpc-streaming-e2e.test.ts`       | the REAL streaming path                          | Server-streaming yields framed messages in order; client-streaming accumulates; bidi echoes over a streaming request body; the gRPC status trailer is present.                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `grpc-plugin/test/e2e/grpc-reflection-e2e.test.ts`      | the REAL reflection + health path                | Through `app.fetch` with a real client: reflection lists the registered service and returns its file descriptor; `Health/Check` answers `SERVING`, and answers `NOT_SERVING` once a registered indicator reports `down`.                                                                                                                                                                                                                                                                                                                                                             |

> Fixture descriptor sets for the e2e live under `test/fixtures/` (excluded from coverage) and are
> produced by the same `protoc` command recorded in §3.3.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m49-grpc-plugin, never main
deno task check:plan        # this plan lints clean
deno task fmt:check
deno task lint
deno task check
deno task test
deno task test:coverage     # read ANSI-stripped per-file table; >=90% branch/function/line every src file
# 42 packages publish today (verified: UNPUBLISHED_PACKAGES is empty), so this must report 43.
deno task release:verify 0.1.0-alpha.3   # 43 publishable packages, @module-first check 5
grep -rn "new Function\|eval(\| require(\|as any\|@ts-ignore\|Date.now()\|globalThis.__" packages/grpc-plugin/src packages/runtime/src
```

Evidence to paste when reporting done: the ANSI-stripped per-file coverage table, the grep result,
and the e2e output showing a real unary call and a real reflection listing returning data.

## 8. Risks & mitigations

- **The `IHttpAdapter` widening is a committed public contract change.** → It is optional, so every
  existing implementation (including third-party ones) still type-checks; §3.9 defines the
  documented degraded behavior when it is absent, and that path is tested.
- **The embedded descriptor constants are a committed generated artifact that can drift or
  corrupt.** → Provenance JSDoc records the producing command and version; a unit test decodes each
  constant and asserts the expected service and method names, so corruption fails the gate rather
  than producing an empty router.
- **Connect is absent in a deployment.** → `loadConnectModule` throws `GrpcRuntimeLoadError` naming
  the failing specifier and the install command; every branch is unit-tested through
  `adaptConnectModule`, and the four import lines have the guarded real-import test (AI_GUIDELINES
  §12.2).
- **Upstream `.proto` drift adds a method the bridge has not considered.** → `grpc.health.v1.Health`
  has already grown from two RPCs to three (`List`, §1). The embedded-descriptors test asserts the
  exact method **set**, so regenerating the constants against a newer upstream fails the gate and
  forces a decision instead of silently widening the auto-`unimplemented` surface.
- **Bidi streaming over a real HTTP/1.1 socket fails at the transport, not with a clean `505`.** →
  Root cause named in §3.8 (`IHttpAdapter` exposes no negotiated version, so `httpVersion` is
  deliberately unset); documented in the README and PUBLIC_API notes with the guidance to terminate
  HTTP/2 for bidi. Unary, server-streaming, and client-streaming are unaffected.
- **Prefix-only detection means a client posting RPC to `/` is not served.** → Deliberate (§3.4):
  the alternative hijacks ordinary `application/json` routes. Documented as the `basePath`
  requirement on the client's base URL, and the dispatcher test pins the fall-through.
- **Bun and Workers cannot be executed by this repo's Deno test runner.** → Both adapters are driven
  entirely through injected host seams with fakes, exactly as the existing `BunHttpAdapter` and
  `CloudflareWorkersHttpAdapter` tests do; the real path is proven on Deno by the three e2e files.
- **Reflection enumerating app internals.** → It reflects only services the app registered with the
  plugin plus the plugin's own two, nothing else; `reflection: false` disables it in one option.
- **Handler leak on shutdown.** → `onClose` aborts in-flight streams via the stored
  `AbortController` and drops the router and dispatch map; the plugin unit test asserts the teardown
  (AI_GUIDELINES §14.5).
- **First-time publish.** → `grpc-plugin` has never been published, so tokenless OIDC needs the repo
  link: the next release must run `release:create-packages` and `release:link-repos` before
  publishing (the M35 `sdk` precedent).

## 9. Out of scope

- **A `honoe generate grpc-service` CLI schematic.** A service stub needs generated Protobuf-ES
  types from `buf generate` / `protoc-gen-es`, app-level build tooling the CLI does not run (the
  boundary that keeps Vite out of the plugin graph, AI_GUIDELINES §12.2). Owned by a future CLI
  extension.
- **Codegen of the application's `.proto` files or service descriptors.** Owned entirely by the
  consuming app via `buf`. The two descriptor sets §3.3 embeds are the plugin's _own_ well-known
  service definitions, not app schemas, and they ship as inert base64 data rather than as a build
  step.
- **Auth / telemetry / metrics / multi-tenancy bridging into the gRPC call path.** The interceptor
  runs before the kernel pipeline, so `authMiddleware` (M16), OTel auto-instrumentation (M24b),
  Prometheus collectors (M19), and tenant resolution (M32) do not automatically apply to RPC calls.
  Apps read Connect metadata inside their service implementation for now; a future milestone owns
  gRPC-aware interceptors bridging these capabilities — and is the right home for a call-context
  type if one proves warranted (§3.12).
- **`grpc.health.v1.Health/List` and `/Watch`.** Left to Connect's automatic `unimplemented`
  responder (§3.6): a watch stream needs change notifications `IHealthService` does not expose, and
  `List` is keyed by gRPC service name where the framework's report is keyed by indicator name.
- **`grpc.reflection.v1alpha.ServerReflection`.** A second embedded descriptor set for a deprecated
  API; `grpcurl` has spoken v1 since 1.9 (§3.7).
- **Exposing the negotiated HTTP version through `IHttpAdapter`.** The clean fix for §3.8's bidi
  gate, but a second `common` widening this milestone does not need. Owned by a future runtime
  milestone.
- **The browser/client SDK for calling these endpoints.** Owned by M35 (`sdk`); Connect/gRPC-Web
  clients are generated by the app's own toolchain.
- **AsyncAPI documentation of gRPC endpoints.** Owned by the documentation milestone (M38); OpenAPI
  3.1 has no RPC operation model.
