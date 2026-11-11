# Milestone 139b — gRPC over HTTP/2: streaming, listeners and trailers (`@setu-ts/common`, `kernel`, `runtime`, `grpc-plugin`)

> **Status:** Planning. Branch: `feat/m139b-grpc-http2`. `develop` and `main` are protected — all
> work (implementation + fixes) stays on this one branch until it merges via a single PR. Ships in
> `0.13.0` with M139g.

## 0. Objective & scope

Make Setu a real gRPC server on Node and Bun, and stop it holding gRPC streams back on every
runtime. Four layers, in dependency order: the kernel streams RPC response bodies (V12-39) and,
where it is safe, request bodies; the Node adapter gains an HTTP/2 listener that keeps HTTP/1.1 and
WebSocket upgrades on the same port (V12-40); a response-trailers seam lets the grpc-plugin answer
native `application/grpc` wherever the connection can carry trailers. While probing the listener,
this plan found that a client chooses the scheme of `request.url` (V12-51, registered 2026-11-09);
the adapters now take the scheme from their own listener. The boundary: Setu serves HTTP/2 itself on
Node, Bun and Deno; HTTP/3 and TLS-only HTTP/1.1 are not offered, and the CLI scaffolds do not
change.

- **In scope:** V12-39 (streamed RPC responses), streamed RPC request bodies for client- and
  bidi-streaming procedures, `RuntimePlugin({ http2 })` on Node, Bun and Deno, response trailers
  (`common` + Node adapter), native gRPC in grpc-plugin, a per-message read bound for streamed RPC
  bodies, V12-40 (README made true), V12-51 (listener-owned scheme), the `apps/grpc-workspace`
  orders → billing call over HTTP/2, docs, and the paired benchmark rerun.
- **NOT this milestone:** HTTP/3 (QUIC) — no stable server in Node 24, Bun or Deno's `Deno.serve`,
  and every deployment target terminates it at a proxy or CDN; no ROADMAP entry, deliberately. A
  `setu new`/`generate app` flag that writes `http2` into a scaffold — a follow-up proposed to the
  maintainer after the benchmark rerun (§3.9). Typed capability lookups — M139g, which ships beside
  this letter in `0.13.0`.

### 0.1 Compared with

| Question                                    | Frameworks and how they answer                                                                                                                                                                                                                                                                                                                                                                                                      | This plan                                                     |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------- |
| Cleartext HTTP/2 and HTTP/1.1 on one port?  | **Yes:** Go 1.24 `http.Server.Protocols` with `SetHTTP1` + `SetUnencryptedHTTP2` (replacing the deprecated `x/net/http2/h2c` wrapper); Deno's `Deno.serve` (probed, §1). **No:** Kestrel `Http1AndHttp2` without TLS serves HTTP/1.1 only (h2c needs a separate HTTP/2-only endpoint); Fastify/NestJS `http2: true` is h2c only, `allowHTTP1` applies over TLS; grpc-js serves HTTP/2 only; Node `allowHTTP1` is TLS-only (probed). | One port, both, like Go and Deno (§3.4)                       |
| HTTP/2 over TLS?                            | Every framework above: ALPN `h2` + `http/1.1` on one TLS port (Fastify `https.allowHTTP1`, Kestrel, Go, Deno `cert`/`key`).                                                                                                                                                                                                                                                                                                         | Same, with PEM `key`/`cert` (§3.4)                            |
| Bound on a streamed gRPC request            | grpc-go and grpc-js: per-message receive limit, 4 MiB default. Connect-ES: `readMaxBytes`, default `0xffffffff` (probed, §1).                                                                                                                                                                                                                                                                                                       | Per message, 4 MiB default, the grpc-go/grpc-js figure (§3.2) |
| Scheme of a request on a plaintext listener | Go: `r.TLS == nil` decides, not the request line. node-server and Deno: the client's `:scheme` / absolute-form (probed, §1).                                                                                                                                                                                                                                                                                                        | The listener decides (§3.5)                                   |

## 1. Contracts verified from SOURCE (not names)

Probe scripts for every "probed" row are kept in
`~/setu-benchmarks/2026-11-07-grpc-local-b287da060/node/src/h2probe/m139b/` (README there), beside
the benchmark's own `setu.mjs`/`trailers.mjs`. Versions: Node 24.22.1, Bun 1.4.4, Deno 2.9.6,
`@hono/node-server` 2.1.6, `@connectrpc/connect` 2.2.0, grpcurl on `PATH`, ghz in the run dir
`bin/`.

| Reference                                   | Source (file:line)                                                                                                                  | Verified surface / fact                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| ------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `#sendRpcResponse`                          | `packages/kernel/src/application/application.ts:2061`                                                                               | `await response.arrayBuffer()` then `builder.send(new Uint8Array(snapshot))`; one writer for the refusal (`:2022`) and the dispatched reply (`:2047`) — the V12-39 buffering                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `#tryGrpc` request read                     | `packages/kernel/src/application/application.ts:2037`                                                                               | `await ctx.request.bytes()` before dispatch; reconstructs `new Request(ctx.request.url, { method, headers: ctx.request.headers, body })`; refusal decided from headers first (`:2015`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `IRequest`                                  | `packages/common/src/http.ts:36`                                                                                                    | `method`, `url`, `path`, `headers`, `ip?`, `user?`, `tenant?`, `locale?`, `signal?`, `raw?: Request` (`:110`), `json`, `text`, `bytes` (`:134`), `formData?`. No body stream, no consumed flag, no transport information                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `IResponse.stream` / `snapshot`             | `packages/common/src/http.ts:313`, `:334`; union at `:1112`                                                                         | `stream(body: ReadableStream<Uint8Array>): HandlerResult`; `ResponseSnapshot` streaming arm `{ streaming: true, status, headers, body, responseInit? }` — no trailers anywhere in `common` (`grep -rni trailer packages/common/src` is empty)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `ResponseBuilder.stream`                    | `packages/kernel/src/context/response.ts:187`, `snapshot()` `:200`                                                                  | the kernel's only `IResponse` implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `MockResponse.stream`                       | `packages/testing/src/mock-context.ts:371`                                                                                          | the second first-party `IResponse` implementation                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `IGrpcService`                              | `packages/common/src/services/grpc.ts:87`                                                                                           | `addService`, `claims?(request)`, `refuses?(request): Response \| null`, `handleRequest(request): Promise<Response>`, `available`. A fetch `Response` has no trailer member, so `handleRequest` cannot carry them                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Request mapping                             | `packages/runtime/src/adapters/shared/fetch-mapping.ts:183-190`, `:276-297`                                                         | `raw` is the undisturbed native `Request`; the body is read lazily through `raw.arrayBuffer()` or `readBounded(raw, maxBodyBytes)` (`:324`, reads `raw.body`), so a read through `IRequest` disturbs `raw`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| `InjectedRequest`                           | `packages/kernel/src/application/inject-body.ts:170-215`                                                                            | `bytes()` returns its own `#bodyBytes`, never reads `raw`; `raw` keeps the same body undisturbed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| node-server `bodyUsed`                      | `@hono/node-server` 2.1.6 `dist/index.mjs:534-538` (probed by reading)                                                              | lightweight Request: `bodyUsed` is `true` once consumed directly, otherwise defers to the cached undici Request if one exists, else `false` — it never materializes the request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| node-server `serve` / `getRequestListener`  | `dist/index.mjs:1339`; `dist/index.d.mts:101`                                                                                       | `serve()` calls `(options.createServer \|\| createServer)(options.serverOptions \|\| {}, listener)`; `getRequestListener(fetch)` is exported                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| node-server scheme                          | `dist/index.mjs:601-617`                                                                                                            | absolute-form request target → `new URL(target)`; HTTP/2 → `incoming.scheme` (client `:scheme`); else `socket.encrypted`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `NodeHttpAdapter`                           | `packages/runtime/src/adapters/node/node-http-adapter.ts:542`, `listen` `:563`; host `:91-117`; fetch `:451`, `#finishFetch` `:486` | `listen(port, hostname?)` → `host.serve({ fetch, port, hostname })`; the fetch receives node-server's `env` with `incoming`/`outgoing`; the default host lazy-imports `@hono/node-server` (`:144-146`)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `asUpgradeEmitter`                          | `packages/runtime/src/adapters/node/node-ws-upgrader.ts:274-300`                                                                    | probes the served handle for `on('upgrade')`; already typed for node-server's `http`/`http2` union                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `BunHttpAdapter`, `DenoHttpAdapter`         | `bun/bun-http-adapter.ts:300`; `deno/deno-http-adapter.ts:276`, `listen` `:302`                                                     | Bun serves through `Bun.serve`; Deno through `Deno.serve({ port, hostname, … })` with no TLS options passed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `HttpAdapterOptions`                        | `packages/runtime/src/adapters/shared/adapter-options.ts:15`                                                                        | `maxBodyBytes?`, `reportError?` — the grouped options object every adapter takes                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `RuntimeOptions`                            | `packages/runtime/src/plugin/runtime-plugin.ts:30-80`; factory `:151`; `defaultHttpAdapters` `:133`                                 | `platform?`, `adapters?` (`@internal`), `httpAdapters?` (`@internal`), `env?`, `maxBodyBytes?`; the adapter is chosen per platform                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `requestOriginOf`                           | `packages/common/src/request-origin.ts:29-35`                                                                                       | without a published trusted-proxy origin, the protocol and host come from `new URL(ctx.request.url)` — the V12-51 reader                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| grpc-plugin dispatch                        | `transports/rpc-dispatcher.ts:93-115`; `transports/connect-router-builder.ts:160-170`; `transports/connect-loader.ts:115-126`       | the dispatch map holds `createFetchHandler(handler)` per path; `httpVersion` is deliberately unset (a bidi refusal gate); `createConnectRouter(options)` forwards options                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| grpc-plugin options                         | `packages/grpc-plugin/src/interfaces/index.ts:20-63`                                                                                | `basePath?`, `reflection?`, `health?`, `services?`, `connectModule?`, `interceptors?` — no read bound                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| Connect universal types                     | `@connectrpc/connect` 2.2.0 `protocol/universal.d.ts:51-56`; `universal-fetch.d.ts:30`; `universal-handler.d.ts:103-120`            | `UniversalServerResponse { status, header?, body?: AsyncIterable<Uint8Array>, trailer? }`; `universalServerRequestFromFetch(req, options)`; handler has `method: DescMethod`, `requestPath`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| `DescMethod.methodKind`                     | `@bufbuild/protobuf` 2.16.0 `descriptors.d.ts:606`                                                                                  | `'unary' \| 'server_streaming' \| 'client_streaming' \| 'bidi_streaming'`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Connect `readMaxBytes`                      | `connect/dist/esm/protocol/limit-io.js:21-44`; `universal-handler.js:35`                                                            | router/handler option; default `0xffffffff`; enforced per enveloped message, and on the whole body of a unary Connect request                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| Probed: cleartext `allowHTTP1`              | `m139b/allow.mjs`                                                                                                                   | `http2.createServer({ allowHTTP1: true })`: h2c answers, HTTP/1.1 gets nothing                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Probed: preface sniff                       | `m139b/direct.mjs`                                                                                                                  | re-emitting a peeked `net.Socket` into `node:http2` FAILS when the socket is resumed first (grpcurl: "the connection is draining"): `resume()` emits the unshifted bytes to no listener. **Corrected 2026-11-10:** left paused, Node's session reads them on the next tick (`setupHandle`, nodejs/node#35475) — probed `scratch unshift/probe.mjs`, h2 and h1 both served, real peer address. Bun 1.4.4 does not read buffered bytes (GOAWAY), so Bun keeps a JS `Duplex` that replays them. HTTP/1.1 takes the socket directly. Node AND Bun: h1, h2c, upgrade (101), 5 streams in a row, preface timeout closes a 1-byte stall at 5.03 s. Without a socket `error` listener, a client hang-up crashes the process (EPIPE on Node, "Protocol error" on Bun) |
| Probed: native gRPC trailers                | `m139b/direct.mjs` + grpcurl                                                                                                        | Node and Bun, direct and sniffed: unary OK, server stream 3/3, unary `PermissionDenied` (Trailers-Only, status in headers), mid-stream `Aborted` after 2 messages (status in trailers)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| Probed: full duplex                         | `m139b/duplex-*.mjs`                                                                                                                | node-server over `node:http2` echoes request chunks before the request ends, Node and Bun                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| Probed: TLS                                 | `m139b/tls.mjs`, `tlsup.mjs`, `wsprobe.mjs`, `deno-tls.ts`                                                                          | `http2.createSecureServer({ key, cert, allowHTTP1: true })` on Node and Bun: h2, h1, `upgrade` event, and a full `ws` handshake (`echo:hi`). `Deno.serve({ cert, key })`: h2, h1.1, WebSocket 101                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| Probed: Deno cleartext                      | `m139b/deno-plain.ts`                                                                                                               | h2c prior knowledge → HTTP/2, plain → HTTP/1.1, one port                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Probed: V12-51                              | `m139b/scheme-*.mjs`, `deno-url.ts`, `abs-*.mjs`                                                                                    | `:scheme: https` over h2c → `request.url` `https://…` on node-server and Deno; `GET https://evil.example/p HTTP/1.1` on node-server → `https://evil.example/p`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| Probed: connect-node over h2c               | `m139b/connect-node-cli.mjs` against `direct.mjs`                                                                                   | `createConnectTransport({ httpVersion: '2', baseUrl: 'http://…' })` reaches the shared port (prior knowledge); a refused connection is `Code.Unavailable` (14)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| node-server listener defaults               | `dist/index.mjs:1028`, `:1332-1339`                                                                                                 | `serve()` → `createAdaptorServer` → `getRequestListener(fetch, { hostname, overrideGlobalObjects, autoCleanupIncoming })`; the global `Response` override applies unless `overrideGlobalObjects === false`, so a listener built with `{ hostname }` matches what `serve()` builds today                                                                                                                                                                                                                                                                                                                                                                                                                                                                      |
| Client IP source                            | `packages/runtime/src/adapters/node/node-http-adapter.ts:451-456`                                                                   | `mapWebRequestToFrameworkRequest(request, maxBodyBytes, env?.incoming?.socket?.remoteAddress)` — on HTTP/2 that socket is the session's, i.e. the Duplex                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Probed: peer address on the Duplex          | `m139b/ip-probe.mjs`, `ip-probe2.mjs`                                                                                               | Node hides a Duplex's `remoteAddress` behind its JS-stream socket (Bun does not); the `session` event fires synchronously inside `emit('connection')` on both, so a per-session record works. Since the 2026-11-10 correction only the Bun replay path needs it; Node's socket reports its own peer                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Probed: Deno full duplex                    | `m139b/deno-duplex.ts`                                                                                                              | `Deno.serve` over h2c echoes request chunks before the request ends                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| Found implementing: `inject()` and streams  | `packages/kernel/src/application/application.ts` `inject`                                                                           | `inject()` throws on a streaming body, so an `IGrpcService` without `handleRpc` keeps the buffered write (§3.3), and a streaming RPC reply is read through `app.fetch()`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| Found implementing: kernel re-wraps streams | `application.ts` `#settleRequest` (three `response.stream(...)` calls)                                                              | the empty-chunk guard and deferred cleanup re-call `stream(body)`, which would drop trailers; `ResponseBuilder.streamOptions` carries them across                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| NOT probed                                  | —                                                                                                                                   | **Measured 2026-11-10 (ghz, 64 calls, 8 s, server 8-15):** through the Duplex Setu h2c served 1.5k rps against 6.1k for the same app over TLS and 9.7k for connect-node h2c — every byte crossed a JS stream. Handing Node the socket itself (above) costs nothing: connect-node behind the sniff 9.1k vs plain h2c 9.1-9.4k; Setu h2c 6.5-7.4k. The paired rerun (§7) carries the numbers                                                                                                                                                                                                                                                                                                                                                                   |

## 2. Committed-doc conflicts — resolved here, shipped as named doc deliverables

| #   | Conflict                                                                                                                                                               | Resolution (picked side)                                                                                   | Doc deliverable (same PR)                                                                    |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| C1  | grpc-plugin README says Connect and gRPC-Web work "over both HTTP/1.1 and HTTP/2"; Node serves HTTP/1.1 only (V12-40)                                                  | The code changes to make it true on Node and Bun with `http2`; the README states which runtime serves what | grpc-plugin README "Limitations" rewritten as a runtime × capability table (§3.8)            |
| C2  | grpc-plugin README and `grpc-binary-refusal.ts` module doc say native gRPC works on no runtime; kernel comment at `application.ts:2028` says trailers "do not survive" | Native gRPC is served where `IRequest.responseTrailers` is true; refused elsewhere                         | README, both module docs, `docs/examples.md:766`, and every hit of the §3.8 sweep            |
| C2b | grpc-plugin README says server streaming is "unaffected on every runtime" — true of the result, false of delivery (V12-39)                                             | Delivery fixed; the sentence is replaced by the table                                                      | README (C1)                                                                                  |
| C3  | PUBLIC_API.md:14298 lists `RuntimeOptions` as (`platform`, `env`); the source also has `maxBodyBytes`                                                                  | Source wins                                                                                                | Row lists `platform`, `env`, `maxBodyBytes`, `http2`                                         |
| C4  | ROADMAP M139 sequence names only M139a as security-audited; M139b reads raw sockets, takes TLS material and changes the request scheme                                 | M139b is audited too (§3.10)                                                                               | ROADMAP M139 "Sequence" paragraph and the M139b gate name the audit                          |
| C5  | ROADMAP M139b says an app "can inject such a host through `RuntimePlugin({ httpAdapters })` today"; `httpAdapters` is `@internal` (`runtime-plugin.ts`)                | It stays internal; `http2` is the public route                                                             | None beyond the ROADMAP status flip — the ROADMAP text records a probe, not a recommendation |
| C6  | ROADMAP M139b lists rows V12-39, V12-40; this plan adds V12-51                                                                                                         | Folded in: same adapters, same listener                                                                    | ROADMAP M139 table and M139b row list add V12-51; CHANGELOG "Fixed" names it                 |
| C7  | CLAUDE.md: "load Node builtins in `packages/runtime` with static `node:` imports"; the Workers bundle must not evaluate `node:http2` at startup                        | Both: static imports inside `node-http2-listener.ts`, that module loaded lazily by the adapter (§3.4)      | None — the rule holds; the plan records why the module, not the builtin, is lazy             |

## 3. Design decisions

### 3.1 Streamed RPC responses (V12-39)

- **Decision:** `#sendRpcResponse(ctx, reply)` takes an `RpcReply` (§3.3). It writes status and
  headers exactly as today (`appendHeader` per entry). Then:
  - **Bodyless** (`response.body === null`, the Trailers-Only refusal): `builder.send()`.
  - **Buffered** (`reply.streaming === false` and no `reply.trailers`): today's `arrayBuffer()` +
    `send`. This is a unary procedure; its measured 76% must not regress.
  - **Otherwise:** `builder.stream(response.body, reply.trailers ? { trailers } : undefined)`.

  One function, one write path for both exits, as today.

- **Why:** server-streaming and bidi replies must flow as produced. A unary reply is one message;
  streaming it adds a stream pipe per request on node-server for nothing.
- **Test home:** `kernel/test/integration/grpc-dispatch-streaming.test.ts` — a fake `IGrpcService`
  whose stream enqueues chunk 2 only after the test has read chunk 1 (deadlocks if buffered); unary
  reply asserts `snapshot().streaming === false`; refusal asserts empty body and headers.

### 3.2 Streamed RPC request bodies, and their bound

- **Decision:** a new optional `IGrpcService.streamsRequest?(request): boolean`. The plugin answers
  `true` when the path's procedure is `client_streaming` or `bidi_streaming`; it reads
  `DescMethod.methodKind` from the router handler, kept in the dispatch map entry. The kernel
  streams the body only when `streamsRequest(raw) === true` **and** `raw.bodyUsed === false`. It
  then builds
  `new Request(ctx.request.url, { method, headers: ctx.request.headers, body: raw.body, duplex: 'half' })`.
  Every other case keeps today's `ctx.request.bytes()` path, so the runtime's `maxBodyBytes` still
  bounds unary and server-streaming bodies. Neither `Request` carries `raw.signal`: the kernel puts
  it on `RpcTransport.signal` (§3.3), and the plugin hands it to Connect's universal request as the
  call's signal. Today the dispatch carries none, and once replies stream, a server stream that
  never ends (a watch) would otherwise outlive its client. Corrected 2026-11-10: the first build put
  `signal: raw.signal` on the `Request`, and undici following it cost 8–11% of unary throughput
  (5-pass A/B: 90.1% of 0.12.0 with it, 97.7% without). `duplex` is not in the DOM `RequestInit`
  type the kernel compiles against, so the kernel declares a local
  `RequestInit & { duplex?: 'half' }`; it must not pull in `@types/node`.
  - **Bound for streamed bodies:** `GrpcPluginOptions.readMaxBytes`, default `4 * 1024 * 1024`,
    passed to `createConnectRouter({ readMaxBytes })`. It applies per message, on every procedure,
    and on the whole body of a unary Connect request.
  - `maxBodyBytes` cannot bound a streamed body: it is a total, which would kill every long-lived
    bidi stream, and the kernel cannot see its value. The runtime README and the
    `HttpAdapterOptions.maxBodyBytes` JSDoc say so.
- **Why:** `raw.bodyUsed` is the web-standard consumed flag. It is cheap on node-server (§1), and
  every `IRequest` body read goes through `raw` (fetch-mapping) or leaves `raw` intact (inject). So
  it needs no new `IRequest` member.
  - Gating on the procedure kind keeps unary and server-streaming requests on the bounded,
    benchmarked path. Only procedures whose body is a stream pay for `raw.body` materialization.
  - 4 MiB matches the default per-message receive limit of grpc-go and grpc-js.
  - The transport signal forwards client cancellation to every call, unary included, as Hono,
    connect-node, grpc-js and ASP.NET Core do; it costs a property on a plain object.
- **Test home:** `grpc-dispatch-streaming.test.ts` (streamed when undisturbed and kind is streaming;
  buffered after middleware read `ctx.request.bytes()`; buffered when `streamsRequest` is absent or
  false; a body over `maxBodyBytes` on a unary call still 413s; aborting the raw request's signal
  aborts `transport.signal` on BOTH paths and not the dispatched request's). `connect-real-import`
  proves a handed signal cancels a real Connect call through both entry points. `grpc-plugin`
  `grpc-http2-service.test.ts` (`streamsRequest` per kind) and `connect-router-builder.test.ts`
  (`readMaxBytes` reaches the router, default and configured).

### 3.3 The trailers seam and `IGrpcService`

- **Decision:** in `common`:
  - `IRequest.responseTrailers?: boolean`: set by the adapter, `true` only when the connection this
    request arrived on can carry trailers on its response.
  - `StreamOptions { readonly trailers?: Promise<Headers> }`.
  - `IResponse.stream(body, options?: StreamOptions)`.
  - The streaming `ResponseSnapshot` arm gains `readonly trailers?: Promise<Headers>`.
  - `RpcTransport { readonly trailers: boolean; readonly signal?: AbortSignal }` — `signal` added
    2026-11-10 (§3.2).
  - `RpcCall { method, url, path, headers: Headers, body: Uint8Array | ReadableStream<Uint8Array> }`
    and
    `RpcReply { status, headers: Headers, body: Uint8Array | ReadableStream<Uint8Array> | null, streaming, trailers? }`
    — plain objects, no fetch `Request` or `Response` (§3.11, 2026-11-10; the first build used
    `RpcReply { response: Response, … }` and `handleRpc(request: Request, …)`).
  - `IGrpcService.handleRpc?(call, transport): Promise<RpcReply>`.
  - `IGrpcService.refuses?(request, transport?)`.

  The kernel computes `transport = { trailers: ctx.request.responseTrailers === true }` and passes
  it to `refuses` and `handleRpc`. When an implementor has no `handleRpc`, the kernel calls
  `handleRequest` and treats it as `{ response, streaming: false }` — exactly today's buffered
  write. Streaming it would make `inject()`, which throws on a streaming body (`application.ts`
  `inject`), fail on calls that answered before; a third-party implementor opts into streaming by
  adding `handleRpc`.

  In grpc-plugin, `handleRequest(request)` is `handleRpc(request, { trailers: false })` returning
  `.response`: one implementation, two entry points.
  - **Native `application/grpc` with `transport.trailers`:** the plugin runs the router's universal
    handler directly. It calls `universalServerRequestFromFetch`, then the handler, then
    `nativeGrpcReply(universalResponse)`. That turns the body iterable into a `ReadableStream` and
    resolves `trailers` from `universalResponse.trailer` after the last chunk. This is the
    benchmark's `trailers.mjs` shape, moved out of the adapter.
  - **Native without trailers:** today's Trailers-Only `UNIMPLEMENTED`, unchanged.

- **Why:**
  - A fetch `Response` cannot carry trailers, so the seam has to sit beside it.
  - Trailers are per connection, not per adapter: on the shared Node port an HTTP/1.1 request cannot
    carry them and an HTTP/2 one can. Only the adapter knows, so the bit rides on the `IRequest` it
    maps.
  - gRPC trailers are only known after the last message, hence a promise.
  - `streaming` comes from the procedure kind, which the plugin owns.
- **Test home:** `common/test/unit/grpc-contract.test.ts` (type-level: a pre-0.13 `IGrpcService` and
  `IResponse` implementor still satisfies the interfaces). `kernel` `response.test.ts`
  (`stream(body, { trailers })` → snapshot carries the same promise; plain `stream(body)` → no
  `trailers` key). `grpc-dispatch-streaming.test.ts` (transport bit true/false reaches `refuses` and
  `handleRpc`; legacy implementor). grpc-plugin `grpc-http2-service.test.ts` (both entry points
  under a non-default config: `basePath: '/rpc'`, `readMaxBytes: 1024`, identical responses),
  `grpc-binary-refusal.test.ts`.

### 3.4 `RuntimePlugin({ http2 })` — the listener

- **Decision:** `RuntimeOptions.http2?: true | Http2TlsOptions`, where
  `Http2TlsOptions { readonly key: string; readonly cert: string }` are PEM. It is threaded through
  `HttpAdapterOptions.http2`. Per implementation:

| Runtime | `true` (cleartext)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | `{ key, cert }` (TLS)                                                                                                               | `responseTrailers`          |
| ------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Node    | New internal `node-http2-listener.ts`: one `net.Server`. It reads at most 24 bytes; the first byte that differs from the preface `PRI * HTTP/2.0\r\n\r\nSM\r\n\r\n` routes to a `node:http` server (socket re-emitted directly), a full match routes to a `node:http2` server: on Node the socket itself, unshifted and left paused; on Bun, whose `node:http2` ignores buffered bytes, through a JS `Duplex` that replays them (§1, corrected 2026-11-10). The client IP cannot ride on the Duplex: Node wraps a JS stream in an internal socket that reports no peer whatever properties the Duplex carries (probed, `m139b/ip-probe.mjs`; Bun keeps them). On the Bun replay path, without a fix every h2c request would have no IP and `ipSecurity`, rate limits and the trusted-proxy walk see none. So the listener records the real socket's address per HTTP/2 session from the `session` event, which fires synchronously inside the `connection` hand-off (probed, `m139b/ip-probe2.mjs`, Node and Bun), and stamps it on each request under an internal `PEER_ADDRESS` symbol (`node-peer.ts`, no `node:` imports) that the adapter reads before `socket.remoteAddress`. Both servers share one `getRequestListener(fetch, { hostname })` — the options `serve()` passes today (`createAdaptorServer`, node-server `dist/index.mjs:1332`); `upgrade` is attached to the HTTP/1.1 server. Preface timeout 10 s, then `destroy()`. An `error` listener on every accepted socket and every Duplex. `close()` closes the outer server and both inner servers | `serve({ createServer: http2.createSecureServer, serverOptions: { key, cert, allowHTTP1: true } })`; `upgrade` on the secure server | `true` on an HTTP/2 request |
| Bun     | `RuntimePlugin` constructs the **Node** adapter on Bun when `http2` is set (§1: both modes, trailers, full duplex and `ws` all measured on Bun); unset, `Bun.serve` as today. WebSockets then go through the Node upgrader, so a Bun app with `http2` and WebSockets needs the optional `ws` peer installed, as a Node app does; its absence answers through the existing named `ws` load error                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | as Node                                                                                                                             | as Node                     |
| Deno    | No change — `Deno.serve` already serves h2c and HTTP/1.1 on one port (§1)                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | `Deno.serve({ …, cert, key })`                                                                                                      | never set (no trailer API)  |
| Workers | Ignored, documented: the edge terminates HTTP/2 and HTTP/3; there is no listener                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | Ignored, same                                                                                                                       | never set                   |

`node-http2-listener.ts` imports `node:net`, `node:http`, `node:http2` and `node:stream` statically,
as CLAUDE.md prescribes for builtins in `packages/runtime`. The Node adapter loads that MODULE with
an awaited relative `import('./node-http2-listener.ts')`, only when `http2` is set and inside
`listen()`. That keeps it out of the module graph a Worker evaluates at startup: `RuntimePlugin`
already reaches `node:http` statically (`diagnostics/node-local-diagnostics-listener.ts:1`, imported
from `runtime-plugin.ts:19`), but whether workerd's `nodejs_compat` provides `node:http2` was not
checked, and a lazy relative import makes the question moot. It is not a bare-package optional
dependency, so the M113d `try`/`catch` and `OptionalDependencyUnavailableError` do not apply (C7).
The TLS mode imports `node:http2` the same way.

- **Why:** this is the Go 1.24 and Deno camp (§0.1). One port keeps Kubernetes probes, browsers,
  plain `fetch` and WebSockets working on the port a gRPC client uses, with no second port to
  configure. The Kestrel/Fastify camp would make `http2: true` silently drop HTTP/1.1, which V12-40
  already names as the trap. The 10 s preface bound and the `error` listeners are what make reading
  raw sockets safe; both came out of the probe.
- **Test home:** `runtime/test/unit/node-http2-listener.test.ts` (fake sockets: routing at the first
  differing byte, at a split preface across chunks, at exactly 24 bytes; timeout; error after
  routing; close). `runtime/test/e2e/node-http2-listener-e2e.test.ts` (real Node listener, both
  modes: h1, h2c or h2, `fetch`, WebSocket upgrade through the real `ws`, a 1-byte stall closed by
  the bound, a client reset leaving the server serving, and `ctx.request.ip` equal to the client's
  address on h1, h2c and h2). The TLS mode uses a committed self-signed `localhost` key and
  certificate under `packages/runtime/test/fixtures/tls/`, marked test-only in a README beside them
  — Node cannot mint a certificate, and generating one with `openssl` at test time would skip where
  it is absent (the repository already commits test PEMs, e.g. `auth-plugin/test/unit/pem.test.ts`).
  `runtime-plugin.test.ts` (Bun + `http2` → Node adapter; Workers ignores).
  `deno-http-adapter.test.ts` (fake host receives `cert`/`key`) plus a Deno-lane real TLS test.
  `cf-http-adapter.test.ts`.

### 3.5 The listener owns the scheme (V12-51)

- **Decision:** the adapter passes its listener's scheme (`'https'` under TLS, else `'http'`) to
  `mapWebRequestToFrameworkRequest`. When `raw.url`'s scheme differs, the mapped `url` replaces only
  the scheme; host, path and query are unchanged. The check is a `startsWith` on the common path, so
  a rewrite costs only on a lying request.
  - Node and Bun on the Node adapter: always. Bun on `Bun.serve`: always `'http'` (no TLS is
    configured there). Deno: `'https'` iff `cert` is set.
  - Workers and `inject()`: unchanged; the platform URL and the caller's URL are authoritative.
- **Why:** only the listener knows whether the connection is encrypted; a client's `:scheme` or
  absolute-form target is a claim (§1). `requestOriginOf` already prefers a trusted-proxy origin, so
  proxied deployments are unaffected. Host is left alone because it is the `Host` header's
  semantics, which every server accepts from the client.
- **Test home:** `fetch-mapping.test.ts` (table: listener `http`/`https` × request `http`/`https` →
  mapped scheme). `node-http2-listener-e2e.test.ts` (`:scheme: https` over h2c and an absolute-form
  `https://` target over HTTP/1.1 both reach the handler as `http://`). Deno-lane test (same over
  `Deno.serve` h2c).

### 3.6 Native gRPC in grpc-plugin

- **Decision:**
  - The connect runtime port gains `universalServerRequestFromFetch` (loaded from
    `@connectrpc/connect/protocol`, already one of the four loaded modules).
  - Each dispatch-map entry becomes `{ fetch, universal, kind }`, with `fetch` built once at router
    time as today.
  - `rpc-dispatcher` routes a native content type to the universal path when `transport.trailers` is
    true, else to the refusal.
  - Reflection (bidi) and health then answer native clients: grpcurl `list` and `describe` work with
    no `-proto`.
- **Why:** Connect's `createFetchHandler` drops `trailer` (§1, benchmark `trailers.mjs`); the
  universal handler is the layer that still has it.
- **Test home:** `rpc-dispatcher.test.ts`, `connect-loader.test.ts`, `connect-real-import.test.ts`
  (the real `universalServerRequestFromFetch` import), and
  `grpc-plugin/test/e2e/grpc-native-h2-e2e.test.ts`. The e2e uses a real Node `http2: true` app with
  `@connectrpc/connect-node`'s `createGrpcTransport` as the native client: unary OK, server stream
  delivered as sent, non-zero status mid-stream in trailers, client-streaming, bidi echo, reflection
  `ListServices`, and HTTP/1.1 `fetch` on the same port getting the refusal for native and success
  for Connect.

### 3.7 The workspace example

- **Decision:**
  - billing's `setu.config.ts` passes `RuntimePlugin({ http2: true })`, declared in
    `test/grpc-workspace-example.test.ts` `MAY_DIFFER` with its reason.
  - orders' `billing.client.ts` uses `@connectrpc/connect-node`'s
    `createConnectTransport({ baseUrl, httpVersion: '2', defaultTimeoutMs })`: Connect protocol over
    one reused HTTP/2 session, replacing `connect-web`'s fetch transport.
  - orders' 503 mapping keeps `Unavailable` and `DeadlineExceeded`. Its `Unknown`/`fetch failed` arm
    is removed: connect-node reports a refused connection as `Unavailable` (code 14, probed, §1),
    and the outage test asserts it.
- **Why:** the 73%-of-NestJS cross-member number was measured against grpc-js over one HTTP/2
  connection; this makes the comparison like for like. The Connect protocol keeps the example's
  error mapping and tests.
- **Test home:** the example's own tests and the example gate; the benchmark rerun (§7).

### 3.8 Documentation

- **Decision:**
  - grpc-plugin README "Limitations" becomes a table: rows Node, Node + `http2`, Bun, Bun + `http2`,
    Deno, Deno + TLS, Workers; columns Connect, gRPC-Web, server streaming as sent, client/bidi
    streaming, native gRPC, reflection via grpcurl.
  - The runtime README documents `http2`: both modes, the shared port, the 10 s preface bound,
    Workers ignoring it, Bun switching servers (and needing `ws` for WebSockets), `maxBodyBytes` not
    bounding streamed RPC bodies.
  - PUBLIC_API.md gets every §4 symbol.
  - CHANGELOG `[Unreleased]`, under 0.13.0: Added (`http2`, trailers seam, native gRPC,
    `readMaxBytes`), Changed (RPC replies stream; middleware snapshots of RPC replies are
    `streaming: true`), Fixed (V12-39, V12-40, V12-51).
  - A sweep,
    `grep -rnE "native gRPC|application/grpc\b|HTTP/2 trailers|trailers do not" docs packages/*/README.md website apps/*/README.md`,
    with every hit reconciled.
- **Why:** C1–C4.
- **Test home:** `pnpm run check:docs` and the website build.

### 3.9 CLI scaffolds

- **Decision:** no scaffold writes `http2` in this milestone. The README and the gRPC guide show the
  one-line opt-in.
- **Why:** it changes the listener of every scaffolded service, and its cost is unmeasured until the
  §7 rerun. Once measured, the maintainer decides whether `generate app --rpc grpc` should default
  to it. That proposal is the follow-up named in §0.
- **Test home:** none — nothing in `packages/cli` changes, so the scaffold boot gate is unaffected.

### 3.10 Security audit

- **Decision:** the committed tree is audited before merge, per CLAUDE.md, by a fresh agent handed
  only the milestone, branch, commit, this plan and the reports. Obligations:
  - The preface read is bounded in bytes and time, and an unrouted socket costs no more than an idle
    `node:http` connection (whose own `headersTimeout` is 60 s).
  - No accepted socket lacks an `error` listener.
  - The client IP on an h2c request is the peer's real address, not absent (the per-session record).
  - The scheme cannot be chosen by the client (V12-51, all three paths).
  - TLS key material never reaches a log or error (`reportError` records, `serializeError`).
  - A streamed request body is bounded per message.
  - `responseTrailers` cannot be set from request input.
  - The native path's error statuses carry no stack or message beyond Connect's own masking.
- **Why:** raw-socket protocol detection, TLS material and the origin scheme are all trust-boundary
  inputs.
- **Test home:** the audit record in the PR, with positive and negative controls.

#### 3.10.1 Design security review (2026-11-11, written after implementation)

The obligations above were all §3.10 held when §3.11–§3.13 were added, and they name no assets or
attackers. The first committed-tree audit (commit `8f5b75a5c`) failed on that (its F10) and on nine
findings below. **This review was written after the code, in response to that audit** — it is not a
pre-implementation threat model, and the maintainer decides whether it stands as one. It is what the
re-audit holds the tree against.

- **Reviewed flow.**
  1. _Serving_ (§3.4–§3.6): an accepted TCP socket → preface classification (bounded) → `node:http`
     (HTTP/1.1) or a `node:http2` session (h2c, or TLS with ALPN) → node-server's request listener →
     the kernel → `GrpcPlugin`'s Connect router → reply, with trailers on HTTP/2 only.
  2. _Fast path_ (§3.11): `RpcCall` / `RpcReply` are in-process objects between the kernel and the
     plugin. No new input crosses a boundary; the request's body and headers are those of flow 1.
  3. _Calling_ (§3.12): application code → `grpcClient(services, definition, target, options)` →
     `GrpcClients` → target (absolute URL, or a discovery pick each call) → a transport and HTTP/2
     session cached per origin → connect-node → the remote server; its reply, error or reset comes
     back to the caller, and a refused stream is sent once more.
  4. _Injection_ (§3.13): `@Module({ providers })` factory entries run once at boot, against the
     container or the registry.
  5. _Generation_ (§3.12 CLI): `setu.workspace.json` → each caller's rendered
     `src/transport/index.ts`.
- **Assets.** The serving member's availability (sockets, sessions, memory, handler concurrency);
  the TLS private key; credentials a caller holds (headers, and any it puts in a URL); **the
  integrity of a call** — a unary RPC the server ran must never run again because the client guessed
  it had not; the trace context; the capability registry (a factory must not displace an installed
  capability); the integrity of generated source.
- **Attackers.**
  - **A1 — a network client** of a serving member: any bytes on the port, over h2c, HTTP/1.1 or TLS,
    including half-open and idle connections.
  - **A2 — anything answering at a target**: a hostile, compromised or merely failing server. It
    chooses the reply size, error codes and text, headers, resets and `GOAWAY`.
  - **A3 — an end user** of a caller whose input a downstream service echoes into its error text,
    which then reaches the caller's client (indirect control of A2's error text).
  - **A4 — whoever edits `setu.workspace.json`** (by hand or in a pull request); the CLI renders it
    into code other members run.
  - Out of scope: the application author choosing targets. A target built from request data is the
    application's decision (no SSRF guard; the README says so), bounded only in what it can grow.
- **Approved budgets.** Preface 10 s. HTTP/1.1 on the shared port: Node's `headersTimeout` 60 s and
  `requestTimeout` 300 s, as on the plain listener. An HTTP/2 session with no stream open: 75 s,
  then `GOAWAY` (a silent open stream keeps it). Request message and reply message: `readMaxBytes`,
  default 4 MiB. Clients: 256 per definition. Origins: 64 cached sessions; an evicted session is
  forgotten, never closed by the client, and connect-node closes it after 60 s with no stream
  (`idleConnectionTimeoutMs`, under the server's 75 s), so evicted sessions are bounded by the
  origins evicted in the last 60 s plus those with streams open, each stream by its deadline;
  `close()` closes the rest. Client session memory: 64 MB (the server keeps Node's default; §3.12).
  Retry: one, unary only, within what is left of the deadline.
- **Obligations on the audit** (in addition to the eight above): 9. The retry resends only a call
  the server provably did not process: Node's `ERR_HTTP2_STREAM_ERROR` naming
  `NGHTTP2_REFUSED_STREAM`, connect-node's own reading of the reset code (its exact text with no
  response metadata), and Bun's `ERR_HTTP2_GOAWAY_SESSION` — never an error a server sent, whatever
  its text (A2, A3). 10. The retry runs within what is left of the deadline — the call's own, or the
  configured one the transport applied. 11. No credential in a target is accepted, so none reaches
  error text (A3 makes error text reachable from outside). 12. Every reply message is bounded by
  `readMaxBytes` (A2). 13. Every client cache is bounded, and eviction never fails a call in
  flight. 14. `traceparent` comes only from a validated active span, never overrides the call's own,
  and no other header is added. 15. HTTP/1.1 on `http2: true` is held to the plain listener's
  timeouts, and an HTTP/2 session with no stream open is closed (A1); an open stream, silent or
  unfinished, is not bounded by the listener (R1, accepted as grpc-go does). 16. A factory provider
  cannot replace an existing capability or token, and its refusals name only the declared
  tokens. 17. A manifest member name is one `setu generate app` could write (kebab-case, identifier-
  and path-safe), so it cannot inject source (A4); the orphan refusal covers callers. 18. The
  Workers refusal names no target.
- **Findings of the first audit, and their dispositions.**

  | #   | Severity | Finding                                                                                                                  | Disposition                                                                                                                 |
  | --- | -------- | ------------------------------------------------------------------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
  | F1  | Medium   | The retry matched the refusal text anywhere, so a server's error was resent                                              | Fixed: connect-node's arm needs the exact `rawMessage` and empty metadata (obligation 9)                                    |
  | F2  | Medium   | URL userinfo reached error text                                                                                          | Fixed: a target with credentials is refused, unechoed (obligation 11)                                                       |
  | F3  | Medium   | HTTP/1.1 on `http2: true` had no header or request timeout                                                               | Fixed: the outer server's `listening` is forwarded to the HTTP/1.1 server                                                   |
  | F4  | Medium   | Idle HTTP/2 sessions were never closed                                                                                   | Fixed: 75 s with no stream open, then `GOAWAY`, on both cleartext and TLS                                                   |
  | F5  | Low      | An HTTP/1.1 line claiming `HTTP/2.0` was offered trailers                                                                | Fixed: trailers only on an `Http2ServerRequest`'s stream                                                                    |
  | F6  | Low      | With no per-call deadline the retry got a fresh one                                                                      | Fixed: the configured deadline counts (obligation 10)                                                                       |
  | F7  | Low      | Replies were unbounded (connect-node's 4 GiB default)                                                                    | Fixed: `readMaxBytes` on every client transport (obligation 12)                                                             |
  | F8  | Low      | Origin eviction cancelled calls in flight                                                                                | Fixed: the client never closes an evicted session; connect-node closes it once idle (60 s)                                  |
  | F9  | Low      | A crafted member name injected code into generated files                                                                 | Fixed: names refused at manifest read unless `generate app` could write them (obligation 17)                                |
  | F10 | Blocking | No design review for §3.11–§3.13                                                                                         | Stands (maintainer decision, 2026-11-11): this section, written after the code and reviewed by four re-audits               |
  | R1  | Medium   | A stream whose request half never ends keeps a session past the idle bound                                               | Accepted (maintainer, 2026-11-11), as grpc-go does; obligation 15 amended                                                   |
  | R2  | Low      | Draining-set overflow aborted busy sessions (64 + 64 budget)                                                             | Superseded: no draining set (see the design change below)                                                                   |
  | R3  | Low      | A token in a URL target's query or fragment reached the refusal text                                                     | Fixed: query and fragment refused unechoed; a URL target is named by its origin only                                        |
  | L1  | Low      | The idle-bound comment described a mechanism the code does not rely on                                                   | Fixed: the comment says what the re-arm does                                                                                |
  | N1  | Low      | `state()` reads only the current connection, so a GOAWAY'd busy one was aborted                                          | Superseded by the design change below                                                                                       |
  | N2  | Low      | An eviction in the same turn as a call's lookup closed the session under it                                              | Superseded by the design change below                                                                                       |
  | N3  | Low      | Sessions created while connect-node loaded escaped `close()`                                                             | Superseded by the design change below                                                                                       |
  | N4  | Low      | A non-URL target was echoed whole (CR/LF included) and reached discovery                                                 | Fixed: a service-name grammar, refused unechoed; an unparsable URL refused unechoed                                         |
  | N5  | Low      | A `clients` key with credentials was echoed in an option error                                                           | Fixed: keys checked as targets; a URL key named by its origin                                                               |
  | L2  | Low      | The idle-bound comment said frames restart it                                                                            | Fixed: only stream activity does                                                                                            |
  | T1  | Low      | A stream dropped unread, aborted or past its deadline held an evicted session                                            | Superseded by the design change below                                                                                       |
  | L3  | Low      | `OriginEntry.retired` was written and never read                                                                         | Superseded by the design change below                                                                                       |
  | L4  | Low      | The F8 row described the replaced design                                                                                 | Fixed: the row names the call count                                                                                         |
  | U1  | Low      | A stream with Connect's `timeoutMs <= 0` (no deadline) was released at once                                              | Superseded below; a no-deadline unary call is retried with none                                                             |
  | E1  | Low      | A session looked up while connect-node loaded read `closed` at eviction, was pruned, then connected: `close()` missed it | Fixed: an evicted session is looked at only after the idle bound, when `closed` means closed                                |
  | E2  | Low      | A connection told to shut down with a stream on it is invisible to `state()`                                             | Accepted: after the bound, only a stream outliving 60 s on such a connection escapes `close()`, and it ends at its deadline |
  | E4  | Low      | The prune scanned every evicted session on every eviction                                                                | Fixed: the scan stops at the first entry younger than the bound; each entry is looked at once per bound                     |

  R1–L1 are from the re-audit at `fad19bed9`, which confirmed F1–F9 fixed; N1–L2 from the second
  re-audit at `843db7f6c`, which confirmed F1–F9, R2 and R3; T1–L4 from the third at `d3feea628`,
  which confirmed N1–N5 and L2; U1 from the fourth at `70884758d`, which confirmed T1–L4.

  **Design change after the fourth re-audit.** Four re-audits in a row each found a Low defect in
  the previous round's fix, all in one place: deciding when the client may close a session it has
  evicted, from information connect-node does not give reliably (`state()` describes only the
  current connection; a stream's end is the application's). The client now never closes an evicted
  session. It forgets it, and connect-node's own idle timer — which runs only while the session has
  no stream and restarts when the last one closes — closes it after `CLIENT_IDLE_TIMEOUT_MS` (60 s).
  The call count, the stream wrapper and its abort and deadline release are gone. What remains is a
  set of evicted sessions for `close()` to reach, pruned of those connect-node has already closed.
  Obligation 13 holds by construction: nothing the client runs closes a session a call is on. The
  final audit (`a6ef41edb`) found that the prune read `closed` as "connect-node closed it", which a
  session not yet connected also reads (E1); an evicted session is now looked at only once the idle
  bound has passed since its eviction. **R1 is accepted** (maintainer decision, 2026-11-11, option
  (c)). The budget "a silent open stream keeps the session" lets a client hold a connection with one
  `HEADERS` frame and no `END_STREAM` to any route that reads its body (every unary gRPC method),
  where the HTTP/1.1 listener's `requestTimeout` (300 s) would end the same unfinished request. It
  is accepted as grpc-go accepts it: `MaxConnectionIdle` counts only time with no stream open, and
  nothing bounds an open stream by default. The alternatives were rejected: a per-stream
  request-half bound would have to exempt client- and bidi-streaming procedures, which the listener
  cannot tell apart without knowing the route, and an inactivity bound on the request half would
  also end a silent bidi stream. The cost is bounded per connection by HTTP/2's own stream limit and
  recovers when the client disconnects; obligation 15 now says what is bounded.

### 3.11 RPC call and reply without fetch objects (2026-11-10)

- **Decision:** the kernel and the plugin exchange plain objects, not a fetch `Request` and
  `Response`.
  - The kernel builds `RpcCall` from the live context: `method`, `url` and `path` from
    `ctx.request`, `headers` = `ctx.request.headers` (so a middleware that edited a header is still
    seen), and `body` = `ctx.request.bytes()` or, for a client- or bidi-streaming procedure whose
    body nothing read, `raw.body` (§3.2 unchanged).
  - `#sendRpcResponse` writes `RpcReply`: a `Uint8Array` body with `send`, a `ReadableStream` body
    with `stream` (trailers attached when present), `null` with `send()`. A refusal `Response` from
    `refuses()` (contract unchanged since 0.6.0) and a legacy `handleRequest` `Response` are turned
    into an `RpcReply` by one kernel function, buffered as before.
  - In grpc-plugin, one dispatch core takes `RpcCall`. Every procedure, Connect, gRPC-Web and
    native, runs through the router's universal handler with a universal request built directly from
    `RpcCall` and `transport.signal`. A single-message reply is gathered into a `Uint8Array`; a
    streaming one becomes a `ReadableStream`; native adds the trailers (`nativeGrpcReply`).
  - `GrpcService.handleRequest(request)` converts the `Request` to an `RpcCall` (body read as bytes,
    or kept as a stream for a streaming procedure), calls the same core with `{ trailers: false }`,
    and converts the reply back to a `Response`: one implementation, two entry points. The
    deprecated `createFetchHandler()` goes through `handleRequest`.
  - The internal Connect port keeps `handleUniversal(handler, universalRequest)` only;
    `createFetchHandler` and `universalServerRequestFromFetch` leave the port.
- **Why:** CPU profiles of Connect unary over HTTP/1.1 (one pinned core, 2026-11-10): Setu spent
  74.5 µs per call against connect-node's 55.2 µs. The largest share was undici: `new Request` in
  `#rpcRequest` (4.6% of CPU, through `@hono/node-server`'s global `Request`), copying headers into
  it, Connect's `universalServerResponseToFetch` building a `Response`, then `arrayBuffer()` reading
  it back through a web stream. A prototype of this decision in the benchmark build won all five
  alternating rounds, median 22.6k against 17.3k rps (+30%, taken while another session's suite
  ran). W2 traces show orders and billing alternate on one HTTP/2 connection, so W2 throughput is
  about 1.1 core-seconds divided by their combined CPU per request: cutting billing's CPU per call
  raises it directly.
- **Test home:** `grpc-dispatch-streaming.test.ts` (an `RpcCall` reaches `handleRpc` with the
  middleware-edited header, bytes for unary and the unread stream for a streaming procedure; each
  `RpcReply` body kind is written correctly; a refusal and a legacy `handleRequest` reply still
  answer). grpc-plugin `rpc-dispatcher.test.ts`, `grpc-http2-service.test.ts` (both entry points
  under `basePath: '/rpc'`, identical status, headers and body), `rpc-call.test.ts`,
  `connect-loader.test.ts`, `connect-real-import.test.ts` (a real unary, server-streaming and
  client-streaming call through the universal path).

### 3.12 The calling side: a gRPC client owned by the plugin (2026-11-10)

- **Problem:** `grpc-plugin` only served. A member calling another built a raw Connect client by
  hand (`apps/grpc-workspace/apps/orders/src/clients/billing.client.ts`), so every application
  re-implemented connection reuse (the example opened a session per request until `4fcd7b5d0`),
  discovery lookup on every call, the deadline, session shutdown and trace propagation, and the
  framework could not change the client underneath. The maintainer's direction (2026-11-10): the
  plugin serves and calls, and ships in M139b.
- **Decision — contract (`common/services/grpc.ts`):**
  - `GrpcClientOptions { basePath?, protocol?: 'connect' | 'grpc' | 'grpc-web', httpVersion?: '2' | '1.1', timeoutMs? }`.
  - `IGrpcService.client?(definition: GrpcServiceDefinition, target: string, options?: GrpcClientOptions): unknown`
    — optional, so an implementor written before it still conforms. `unknown` because `common` names
    no Connect type; the plugin's typed helper narrows it.
- **Decision — plugin surface (`grpc-plugin`):**
  - `grpcClient(services, definition, target, options?)` returns Connect's `Client<TDef>`: it
    resolves `IGrpcService` under `CAPABILITIES.GRPC` and calls `client()`. A registry without
    `client` (another implementor) → `TypeError` naming the missing member.
  - `GrpcPluginOptions.serve` (default `true`). `false` registers the capability for calling only:
    `claims()` is `false` for every request, no dispatch map, no health or reflection service, so a
    REST member pays nothing per request for a gRPC mount it does not have.
  - `GrpcPluginOptions.clients: Record<target, GrpcClientOptions>` — per-target defaults, so the CLI
    can write billing's `basePath` into orders' config and the call site names only the target.
    Per-call `options` override the per-target entry, which overrides the defaults.
  - Validated at `GrpcPlugin()`: `basePath` empty or starting with `/` and not ending with `/`;
    `protocol` and `httpVersion` in their sets; `timeoutMs` an integer 1…2 147 483 647. A bad value
    → `TypeError` naming the option and target. The same validation runs for per-call options.
- **Decision — defaults:** `protocol: 'connect'`, `httpVersion: '2'`, binary format,
  `timeoutMs: 5000`, `basePath: ''`. Connect over HTTP/2 is the measured cheapest path through a
  Connect server (2026-11-10: native gRPC from grpc-js cost billing 183 µs against 67 µs); a
  deadline is bounded by default because an unbounded call is the M101a "calls that hang" defect. A
  per-call `{ timeoutMs }` (Connect's call option) still overrides.
- **Decision — target and instance choice:** `target` is an absolute `http(s)://` URL (fixed origin)
  or a logical service name resolved through `IServiceDiscovery` on every call (`pick(target)`), so
  load balancing and ejection work per call. A name with no discovery capability → `TypeError` at
  `client()`. `pick` returning `null` → the call rejects with
  `ConnectError(Code.Unavailable, 'no instance of "<target>" is available')`. After each call the
  client reports to discovery: `failure` when the call failed with `Unavailable` (connection
  refused, reset, GOAWAY — the instance's fault), `success` otherwise, including application errors
  such as `InvalidArgument` (the instance answered).
- **Decision — transport and connections:** one delegating Connect `Transport` per `client()` call;
  per origin a cached connect-node transport (`createConnectTransport` / `createGrpcTransport` /
  `createGrpcWebTransport`) sharing one `Http2SessionManager` per origin for HTTP/2. Client objects
  are cached per (definition, target, effective options) so `grpcClient()` per request costs a map
  lookup. Origins are bounded at 64 per plugin; the least recently used origin's session is aborted
  when a 65th arrives (instances churn under discovery).
- **Decision — loading:** `@connectrpc/connect-node` is a new optional peer, imported lazily on the
  first call (a serving-only member never loads it), through the existing loader with a literal
  awaited `import()` in its own `try` (M113d). Missing → the call rejects with
  `GrpcRuntimeLoadError` naming `npm install @connectrpc/connect-node`. Workers have no
  connect-node; a Workers caller gets that error — calling over service bindings is out of scope
  (§9).
- **Decision — refused streams (found by the scenario suite, 2026-11-10):** a server that has sent
  `GOAWAY` while shutting down refuses a stream already on the wire with `REFUSED_STREAM`, which RFC
  9113 §8.7 defines as "not processed" and gRPC maps to `UNAVAILABLE`. connect-node reads the reset
  code as `Unavailable`, but reports Node's stream-error event for the same refusal as `Internal`:
  measured, the first call after an instance stopped answered `Internal`, was reported to discovery
  as a success, and the next call went to the dead instance again. The client therefore recognises
  the refusal by its two exact shapes (Node's `ERR_HTTP2_STREAM_ERROR` naming
  `NGHTTP2_REFUSED_STREAM` anywhere in the cause chain, and connect-node's reset-code message),
  reports it as the instance's failure, rejects it as `Unavailable` with the original as `cause`,
  and sends a **unary** call once more on a fresh pick — gRPC's transparent retry (gRFC A6), safe
  because the server never saw it. A streaming call is not retried: its input may already be
  consumed.
- **Decision — runtimes (measured 2026-11-11):** Node and Bun pass the client driver (unary over
  Connect, native gRPC, gRPC-Web and HTTP/1.1; every streaming kind; deadline, cancellation,
  failover, close). Bun reports a stream it could not open after `GOAWAY` as
  `ERR_HTTP2_GOAWAY_SESSION`, which is treated as unsent, like `REFUSED_STREAM`. On Workers the
  client is refused with a `TypeError` naming the alternatives (`workerd`: HTTP/2 `Internal`
  "http2.connect method is not implemented", HTTP/1.1 hangs to its deadline). On Deno 2.9.6 the
  process crashes natively in its `node:http2`/`node:http` client when the peer goes away (5 of 6
  runs against a Deno server, also with connect-node alone), so Deno is documented as not yet safe
  for the client; serving on Deno is unaffected.
- **Decision — session memory (measured 2026-11-11):** with sixteen 1 MB messages in flight on one
  connection, streams were reset with `ENHANCE_YOUR_CALM`. The cap that bit was the **client's**
  session (`maxSessionMemory`, Node's default 10 MB): a raw `node:http2` client at the default lost
  6 of 16 against Setu's server, the same client at 64 lost none, and the server's own cap at 10 was
  never reached — not even with a handler that waits before reading — because HTTP/2 flow control
  stops a client sending past its window before the server reads. So the client's sessions get
  `maxSessionMemory: 64` (`CLIENT_MAX_SESSION_MEMORY_MB`; with 10 the plugin's client lost 6 of 16)
  and the server keeps Node's default: a server-side setting with no measurable effect is not added.
- **Decision — review fixes (2026-11-11):** a discovery backend that fails rejects the call as
  `Unavailable` (`could not resolve "<target>"`, cause kept), not with the backend's own error; each
  definition caches at most 256 clients (least recently used evicted); the refused-stream retry gets
  what is left of the call's deadline, measured on the runtime's monotonic clock, and none once it
  is spent; and `setu workspace rpc <member> http` applies the orphan check to every caller whose
  gRPC targets it empties, refusing while that caller's code imports the plugin or resolves
  `CAPABILITIES.GRPC`, unless `--force`.
- **Decision — trace propagation:** when `CAPABILITIES.TELEMETRY` resolves to a service with
  `activeSpanContext`, an interceptor sets `traceparent` from it with `contextToTraceparent`, unless
  the call already carries one.
- **Decision — lifecycle:** the plugin's `onClose` aborts every session; a call after close rejects
  with `ConnectError(Code.Unavailable, 'the gRPC client is closed')` and opens nothing.
- **Decision — CLI:** the transport module of a member whose `dependsOn` names an `rpc: "grpc"`
  member renders `GrpcPlugin({ serve: false, clients: { billing: { basePath: '/grpc' } } })` (a gRPC
  member that also calls gets `GrpcPlugin({ basePath: '/grpc', clients: … })`). The planner
  re-renders every member after `setu workspace rpc`, `generate app` and `setu sync`, so a target
  switching style updates its callers.
- **Decision — example:** orders registers `GrpcPlugin({ serve: false, clients })` through its
  transport module; `src/clients/billing.client.ts` and the per-URL map go; `createOrders` takes
  `grpcClient(services, BillingService, 'billing')`. The app's own error mapping (InvalidArgument →
  400, Unavailable/DeadlineExceeded → 503) stays: it is the workspace's contract, not the plugin's.
  `apps/grpc`'s `echo.client.ts` is the smoke's outside caller, not a member, and is unchanged.
- **Also (dead surface found in verification):** `RpcReply.streaming` is set by every producer and
  read by nothing — the kernel branches on the body's type. It is removed before release (it is new
  in 0.13.0).
- **Test home:** grpc-plugin `grpc-client.test.ts` (option merge and validation; target URL vs name;
  `pick` per call and `report` per outcome; null pick → `Unavailable`; cache hit per key; origin
  bound evicts and aborts the oldest; `traceparent` set, kept when present, absent without
  telemetry; close aborts sessions and refuses later calls; missing connect-node → load error);
  `grpc-plugin.test.ts` (`serve: false` claims nothing and registers no services; option
  validation); `connect-real-import.test.ts` (the real connect-node load, a unary and a
  server-streaming call through `grpcClient` against a real `GrpcPlugin` over h2c, discovery
  ejection after a refused instance); CLI `transport-module.test.ts` and the workspace e2e (orders
  boots and quotes through the plugin client); the example's own tests and
  `test/grpc-workspace-example.test.ts`.

### 3.13 The client by injection (2026-11-10)

- **Problem:** with the DI container and decorators, a class should take the client by injection, as
  a NestJS class takes `ClientGrpc`. `@Module({ providers })` took classes only (`Constructor[]`),
  so a value no class constructs had no declarative home; registering it from a plugin's
  `register()` was both clumsy and late for the container's boot-time graph check.
- **Decision — `common`:** `ModuleFactoryProvider<T> extends FactoryProvider<T>` with
  `provide: string | InjectionToken<T>` and `scope?`. In `common` because grpc-plugin returns it and
  no plugin imports another.
- **Decision — `decorator-plugin`:** `ModuleOptions.providers` takes
  `(Constructor | ModuleFactoryProvider)[]`. Factory entries register before every class, so a class
  can inject one. With a container: `container.register(provide, { useFactory, inject? }, scope?)`,
  skipped when the token is already registered (a test override keeps its place). Without one: the
  factory runs once with dependencies read from the service registry, string tokens only; a typed
  token (entry or dependency) or a missing required dependency is a `TypeError` naming the provider.
  `@Inject` names string tokens, so a class injects an entry provided under a string; a
  `createToken` token suits `container.resolve`.
- **Decision — `grpc-plugin`:** `grpcClientProvider(provide, definition, target, options?)` returns
  `{ provide, useFactory: (grpc) => client, inject: [CAPABILITIES.GRPC], scope: 'singleton' }`. It
  and `grpcClient()` share one function that asks `IGrpcService.client`, so the container's client
  is the plugin's cached client for the same arguments. Options and target are validated when it is
  called, not on first injection.
- **Decision — CLI:** none. The CLI cannot know an application's service descriptor, and a
  class-based caller already gets the client-only `GrpcPlugin` from its transport module.
- **Test home:** decorator-plugin `module-factory-providers.test.ts` (real `DiContainer`: injected
  into a class, typed token, override kept, scope; registry mode: built once, optional dependency,
  existing value kept, the three refusals); grpc-plugin `grpc-client-di-e2e.test.ts` (a decorated
  service injects the client, a route calls a real server through it, the container's client is
  `grpcClient()`'s; options refused at declaration).

## 4. Exported surface — every symbol names its consumer

**Breaking for implementors:** none — every new member is optional (`stream`'s new parameter is
optional, so an implementation with one parameter still conforms; `refuses`'s new parameter
likewise). Behavior changes (RPC replies stream; a streamed request is bounded by `readMaxBytes`,
not `maxBodyBytes`) ship in minor `0.13.0` with M139g, under "Changed".

| Exported symbol                             | Kind                     | Consumer / real code path that READS it                                                             |
| ------------------------------------------- | ------------------------ | --------------------------------------------------------------------------------------------------- |
| `IRequest.responseTrailers`                 | member (`common`)        | kernel `#tryGrpc` builds `RpcTransport` from it; set by `fetch-mapping` for the Node adapter        |
| `StreamOptions`                             | type (`common`)          | `IResponse.stream`'s parameter; written by kernel `#sendRpcResponse`                                |
| `IResponse.stream(body, options?)`          | member change            | kernel `ResponseBuilder`, testing `MockResponse`; called by `#sendRpcResponse`                      |
| `ResponseSnapshot` streaming `trailers`     | member (`common`)        | Node adapter `#finishFetch` writes them with `outgoing.addTrailers` after the last chunk            |
| `RpcTransport`                              | type (`common`)          | kernel → `IGrpcService.refuses` / `handleRpc`; grpc-plugin `rpc-dispatcher` branches on `.trailers` |
| `RpcCall`                                   | type (`common`)          | kernel `#rpcCall` builds it; grpc-plugin's dispatch core reads every field                          |
| `RpcReply`                                  | type (`common`)          | kernel `#sendRpcResponse` branches on `.body` and `.trailers`                                       |
| `IGrpcService.handleRpc`                    | member (`common`)        | kernel `#tryGrpc`; `GrpcService.handleRequest` delegates to it                                      |
| `IGrpcService.streamsRequest`               | member (`common`)        | kernel `#tryGrpc` request-body decision                                                             |
| `IGrpcService.refuses(request, transport?)` | member change            | kernel `#tryGrpc`; `GrpcService.refuses` refuses native only when `!transport?.trailers`            |
| `RuntimeOptions.http2`                      | option (`runtime`)       | `RuntimePlugin` → `HttpAdapterOptions.http2` → Node/Deno adapters; Bun adapter selection            |
| `Http2TlsOptions`                           | type (`runtime`)         | `RuntimeOptions.http2`; Node `serverOptions`, Deno `serve` options                                  |
| `HttpAdapterOptions.http2`                  | member (`runtime`)       | `NodeHttpAdapter.listen`, `DenoHttpAdapter.listen`                                                  |
| `GrpcPluginOptions.readMaxBytes`            | option (`grpc-plugin`)   | `connect-router-builder` → `createConnectRouter({ readMaxBytes })`                                  |
| `GrpcClientOptions`                         | type (`common`)          | `IGrpcService.client`, `GrpcPluginOptions.clients`; read by grpc-plugin's client merge              |
| `IGrpcService.client`                       | member (`common`)        | grpc-plugin `grpcClient()`; implemented by `GrpcService.client`                                     |
| `grpcClient`                                | function (`grpc-plugin`) | orders `createOrders` in the example; the CLI's generated call sites                                |
| `ModuleFactoryProvider`                     | type (`common`)          | `ModuleOptions.providers` (decorator-plugin `registerFactory`); returned by `grpcClientProvider`    |
| `grpcClientProvider`                        | function (`grpc-plugin`) | an application's `@Module({ providers })`; the DI e2e test                                          |
| `GrpcPluginOptions.serve`                   | option (`grpc-plugin`)   | `GrpcService.claims`, plugin `register` (no dispatch map, health or reflection when `false`)        |
| `GrpcPluginOptions.clients`                 | option (`grpc-plugin`)   | client option merge, per target                                                                     |

Internal, not barrel-exported: `node-http2-listener.ts` (`createHttp2Listener`), `nativeGrpcReply`,
the dispatch-map entry shape, the 10 s preface constant.

### 4.1 Options — every option names its consumer

| Option                             | Consumer                                  | Behavior (per implementation)                                                                                                                                      |
| ---------------------------------- | ----------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `RuntimeOptions.http2: true`       | Node / Bun adapter; Deno; Workers         | Node, Bun: shared-port h2c + HTTP/1.1 listener. Deno: no change (already both). Workers: ignored, documented, tested                                               |
| `RuntimeOptions.http2: {key,cert}` | Node / Bun adapter; Deno adapter; Workers | Node, Bun: TLS, ALPN `h2` + `http/1.1`. Deno: `Deno.serve({ cert, key })`. Workers: ignored. Empty `key` or `cert` → `TypeError` at `RuntimePlugin()` construction |
| `GrpcPluginOptions.readMaxBytes`   | Connect router                            | Default 4 MiB; per message, and whole unary Connect body; an integer outside 1…`0xffffffff` → `TypeError` at `GrpcPlugin()` construction (Connect's own range)     |
| `GrpcPluginOptions.serve`          | `GrpcService`, plugin `register`          | Default `true`. `false`: `claims()` false for every request; no dispatch map, health or reflection service; `client()` works. Non-boolean → `TypeError`            |
| `GrpcPluginOptions.clients`        | client option merge                       | Per-target `GrpcClientOptions`; each validated at `GrpcPlugin()` as in §3.12                                                                                       |
| `GrpcClientOptions.basePath`       | client transport `baseUrl`                | Default `''`; appended to the target's origin                                                                                                                      |
| `GrpcClientOptions.protocol`       | client transport factory                  | Default `'connect'`; `'grpc'` → `createGrpcTransport`; `'grpc-web'` → `createGrpcWebTransport`                                                                     |
| `GrpcClientOptions.httpVersion`    | client transport                          | Default `'2'` (shared `Http2SessionManager` per origin); `'1.1'` → no session manager                                                                              |
| `GrpcClientOptions.timeoutMs`      | client transport `defaultTimeoutMs`       | Default `5000`; per-call `{ timeoutMs }` overrides                                                                                                                 |

## 5. Implementation files

| File                                                                                                                       | Purpose                                                                                                            |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------ |
| `packages/common/src/http.ts`                                                                                              | `IRequest.responseTrailers`, `StreamOptions`, `stream(body, options?)`, snapshot `trailers`                        |
| `packages/common/src/services/grpc.ts`                                                                                     | `RpcTransport`, `RpcReply`, `handleRpc?`, `streamsRequest?`, `refuses?` parameter                                  |
| `packages/common/src/index.ts`                                                                                             | barrel: `StreamOptions`, `RpcTransport`, `RpcReply`                                                                |
| `packages/kernel/src/application/application.ts`                                                                           | `#tryGrpc` (§3.2, §3.3), `#sendRpcResponse` (§3.1)                                                                 |
| `packages/kernel/src/context/response.ts`                                                                                  | `stream(body, options?)`, snapshot `trailers`                                                                      |
| `packages/testing/src/mock-context.ts`                                                                                     | `MockResponse.stream(body, options?)` records `trailers`                                                           |
| `packages/runtime/src/adapters/shared/adapter-options.ts`                                                                  | `HttpAdapterOptions.http2`, `Http2TlsOptions`                                                                      |
| `packages/runtime/src/adapters/shared/fetch-mapping.ts`                                                                    | listener scheme (§3.5), `responseTrailers`                                                                         |
| `packages/runtime/src/adapters/node/node-http2-listener.ts` (new)                                                          | shared-port sniffing listener (§3.4)                                                                               |
| `packages/runtime/src/adapters/node/node-http-adapter.ts`                                                                  | `http2` modes, trailers write, scheme, `responseTrailers` from `env.incoming`                                      |
| `packages/runtime/src/adapters/deno/deno-http-adapter.ts`                                                                  | TLS `cert`/`key`, scheme                                                                                           |
| `packages/runtime/src/adapters/bun/bun-http-adapter.ts`                                                                    | scheme `'http'`                                                                                                    |
| `packages/runtime/src/plugin/runtime-plugin.ts`                                                                            | `http2` option, validation, Bun → Node adapter selection                                                           |
| `packages/runtime/src/index.ts`                                                                                            | barrel: `Http2TlsOptions`                                                                                          |
| `packages/grpc-plugin/src/interfaces/index.ts`                                                                             | `readMaxBytes`                                                                                                     |
| `packages/grpc-plugin/src/interfaces/connect-runtime.ts`                                                                   | port gains `universalServerRequestFromFetch`                                                                       |
| `packages/grpc-plugin/src/transports/connect-loader.ts`                                                                    | adapts it                                                                                                          |
| `packages/grpc-plugin/src/transports/connect-router-builder.ts`                                                            | `readMaxBytes`; dispatch entries `{ fetch, universal, kind }`                                                      |
| `packages/grpc-plugin/src/transports/rpc-dispatcher.ts`                                                                    | native routing on `transport.trailers`                                                                             |
| `packages/grpc-plugin/src/transports/grpc-binary-refusal.ts`                                                               | module doc; refusal unchanged in shape                                                                             |
| `packages/grpc-plugin/src/transports/native-grpc-reply.ts` (new)                                                           | universal response → `ReadableStream` + trailers promise                                                           |
| `packages/grpc-plugin/src/transports/rpc-call.ts` (new)                                                                    | §3.11 conversions: `RpcCall` ↔ universal request, universal response → `RpcReply`, fetch edges for `handleRequest` |
| `packages/grpc-plugin/src/services/grpc-service.ts`                                                                        | `handleRpc`, `streamsRequest`, `refuses(transport)`, `handleRequest` delegation                                    |
| `packages/grpc-plugin/src/client/grpc-client.ts` (new)                                                                     | §3.12: option merge and validation, delegating transport, origin cache, trace interceptor, close                   |
| `packages/grpc-plugin/src/client/grpc-client-helper.ts` (new)                                                              | §3.12: exported `grpcClient()` typed over Connect's `Client`                                                       |
| `packages/cli/src/workspace/transport-module.ts` + planner                                                                 | §3.12: client-only `GrpcPlugin` for members that depend on a gRPC member                                           |
| `apps/grpc-workspace/apps/orders/**`                                                                                       | §3.12: plugin client; `billing.client.ts` removed                                                                  |
| `packages/grpc-plugin/src/plugin/grpc-plugin.ts`                                                                           | `readMaxBytes` validation                                                                                          |
| `packages/grpc-plugin/package.json`                                                                                        | devDependency `@connectrpc/connect-node` (test client only; §16.3 approval asked in the PR)                        |
| `apps/grpc-workspace/apps/billing/setu.config.ts`, `apps/orders/src/clients/billing.client.ts`, `apps/orders/package.json` | §3.7                                                                                                               |
| `test/grpc-workspace-example.test.ts`                                                                                      | `MAY_DIFFER` entry for billing's config                                                                            |
| READMEs, `PUBLIC_API.md`, `CHANGELOG.md`, `docs/`, website, `ROADMAP.md`, `CLAUDE.md`                                      | §2, §3.8; status flip                                                                                              |

## 6. Test plan (every `src/` file mapped; per-file 90% bar)

| Test file                                                                               | src covered                                             | Key assertions (and the signature each call type-checks against)                                                                                                                                                                                      |
| --------------------------------------------------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `common/test/unit/grpc-contract.test.ts` (extend)                                       | `services/grpc.ts`, `http.ts` (types)                   | `expectTypeOf`: a 0.12-shape implementor (no `handleRpc`, `refuses(request)`, `stream(body)`) is assignable to `IGrpcService` / `IResponse`                                                                                                           |
| `kernel/test/integration/grpc-dispatch-streaming.test.ts` (new)                         | `application.ts` `#tryGrpc`, `#sendRpcResponse`         | §3.1 deadlock-if-buffered stream; unary buffered; refusal; §3.2 four body cases + 413; §3.3 transport bit both ways; legacy `handleRequest`-only implementor                                                                                          |
| `kernel/test/unit/response.test.ts` (extend)                                            | `context/response.ts`                                   | `stream(body, { trailers })` → same promise on snapshot; `stream(body)` → no `trailers` key                                                                                                                                                           |
| `testing/test/unit/mock-context.test.ts` (extend)                                       | `mock-context.ts`                                       | trailers recorded                                                                                                                                                                                                                                     |
| `runtime/test/unit/fetch-mapping.test.ts` (extend)                                      | `fetch-mapping.ts`                                      | §3.5 scheme table; `responseTrailers` set only when the adapter says so                                                                                                                                                                               |
| `runtime/test/unit/node-http2-listener.test.ts` (new)                                   | `node-http2-listener.ts`                                | §3.4 routing (split preface, first differing byte, exact 24), timeout, error before and after routing, close                                                                                                                                          |
| `runtime/test/e2e/node-http2-listener-e2e.test.ts` (new)                                | `node-http-adapter.ts`, `node-http2-listener.ts`        | both modes on real sockets: h1, h2c/h2, `fetch`, `ws` upgrade, stall closed, reset survives, trailers on the wire (raw `http2.connect` reads `trailers` event), V12-51 both paths                                                                     |
| `runtime/test/unit/node-http-adapter.test.ts` (extend)                                  | `node-http-adapter.ts`                                  | fake host receives `createServer`/`serverOptions` for TLS; trailers written only for h2 `outgoing` with `addTrailers`; rejected trailers promise errors the stream; `http2` unset never imports the listener module (spy on the injected loader seam) |
| `runtime/test/unit/deno-http-adapter.test.ts` (extend) + Deno lane                      | `deno-http-adapter.ts`                                  | `cert`/`key` reach the fake host; scheme; real `Deno.serve` TLS answers h2 and h1                                                                                                                                                                     |
| `runtime/test/unit/bun-http-adapter.test.ts` (extend)                                   | `bun-http-adapter.ts`                                   | scheme `'http'` on a lying request                                                                                                                                                                                                                    |
| `runtime/test/unit/cf-http-adapter.test.ts` (extend)                                    | (Workers path)                                          | `http2` ignored                                                                                                                                                                                                                                       |
| `runtime/test/unit/runtime-plugin.test.ts` (extend)                                     | `runtime-plugin.ts`                                     | Bun + `http2` → Node adapter; validation `TypeError`s; option threaded                                                                                                                                                                                |
| `grpc-plugin/test/unit/grpc-http2-service.test.ts` (new)                                | `grpc-service.ts`                                       | `streamsRequest` per kind; both entry points identical under non-default config                                                                                                                                                                       |
| `grpc-plugin/test/unit/rpc-dispatcher.test.ts` (extend)                                 | `rpc-dispatcher.ts`                                     | native + trailers → universal path; native without → refusal; Connect/gRPC-Web unchanged                                                                                                                                                              |
| `grpc-plugin/test/unit/grpc-http2-service.test.ts` (same file)                          | `native-grpc-reply.ts`                                  | chunks pass through; trailers resolve after the last chunk; empty trailer; iterator throw rejects                                                                                                                                                     |
| `grpc-plugin/test/unit/rpc-call.test.ts` (new)                                          | `rpc-call.ts`                                           | body iterable per shape; signal only when handed; single reply gathered, chunks joined, no body → `null`; cancel returns the iterator; fetch edges round-trip                                                                                         |
| `grpc-plugin/test/unit/connect-router-builder.test.ts` (extend)                         | `connect-router-builder.ts`                             | `readMaxBytes` default and configured reach the fake router; entries carry `kind`                                                                                                                                                                     |
| `grpc-plugin/test/unit/connect-loader.test.ts` + `connect-real-import.test.ts` (extend) | `connect-loader.ts`, `connect-runtime.ts`               | adapter maps `universalServerRequestFromFetch`; real import resolves it                                                                                                                                                                               |
| `grpc-plugin/test/unit/grpc-client.test.ts` (new)                                       | `client/grpc-client.ts`, `client/grpc-client-helper.ts` | §3.12 list: merge, validation, URL vs name, pick and report, null pick, cache, origin bound, traceparent, close, load error                                                                                                                           |
| `cli/test/unit/transport-module.test.ts` (extend) + workspace e2e                       | `transport-module.ts`                                   | client-only `GrpcPlugin` rendered from `dependsOn`; orders boots and quotes through it                                                                                                                                                                |
| `grpc-plugin/test/unit/grpc-plugin.test.ts` (extend)                                    | `grpc-plugin.ts`                                        | `readMaxBytes` range validation                                                                                                                                                                                                                       |
| `grpc-plugin/test/unit/grpc-binary-refusal.test.ts` (keep)                              | `grpc-binary-refusal.ts`                                | unchanged assertions                                                                                                                                                                                                                                  |
| `grpc-plugin/test/e2e/grpc-native-h2-e2e.test.ts` (new)                                 | end to end                                              | §3.6 list                                                                                                                                                                                                                                             |
| `grpc-plugin/test/e2e/grpc-streaming-e2e.test.ts` (extend)                              | end to end                                              | Connect server stream over HTTP/1.1: first message arrives before the second is produced                                                                                                                                                              |
| example tests + `test/grpc-workspace-example.test.ts`                                   | `apps/grpc-workspace`                                   | orders → billing over HTTP/2; 503 on billing down; gate declares the config diff                                                                                                                                                                      |

Bun package suites are a recorded smoke (AI_GUIDELINES §4.5): the e2e listener test and
`grpc-native-h2-e2e` are also run under Bun once, by hand, and recorded in the PR.

## 7. Verification gates

```bash
git branch --show-current   # MUST be feat/m139b-grpc-http2
pnpm run check:plan
pnpm run fmt:check && pnpm run lint && pnpm run check && pnpm run test:tooling
pnpm test:coverage common kernel runtime grpc-plugin testing   # per-file table, ANSI-stripped
pnpm run test:deno-lane
pnpm run ci:local          # final commit; then the two publish gates
pnpm run release:publish --dry-run && pnpm run release:verify 0.13.0
```

The ROADMAP gate, each item with its evidence in the PR:

- A Connect server stream through the kernel delivers each message as sent, on HTTP/1.1 and HTTP/2.
  Timings come from the benchmark's `h2probe/client.mjs` against `setu.mjs`, run with the local
  build.
- A bidi call and a reflection request are answered over HTTP/2:
  `grpcurl -plaintext localhost:N list` with no `-proto`.
- ghz and grpcurl reach unary and server-streaming procedures with `OK`, and a non-zero
  `grpc-status` arrives in the trailers (mid-stream `Aborted`).
- HTTP/1.1, plain `fetch` and a WebSocket upgrade are still served on the HTTP/2 port.
- The native refusal is unchanged on Deno and Workers.
- **Paired benchmark rerun.** Run it only when no suite is running (check `pgrep`), with
  `setup-grpc.sh local:<this worktree>`, `SERVER_CORES=8-15 LOAD_CORES=16-31`, and `PASSES=21`
  against the 2026-11-07 numbers:
  - unary Connect JSON as a **paired** regression check, this branch vs `develop`: `setup-grpc.sh`
    takes one Setu build today, so it first gains the `<new> [<baseline>]` form `setup.sh` already
    has (a harness edit, outside the repository). A sign test that finds the branch slower on unary
    blocks the merge until explained; the Setu ÷ connect-node ratio (76.1% on 2026-11-07) is
    reported beside it, not used as the threshold, because it compares runs on different days;
  - streaming;
  - the new Setu `http2: true` vs `connect-node-h2c` on h2c;
  - ghz native unary, Setu vs connect-node-h2c;
  - with `setup-grpc-workspace.sh`, the orders → billing pair against the NestJS comparator.

  Raw measurements are sorted before medians are read.

- The security audit (§3.10).

## 8. Risks & mitigations

- **The JS `Duplex` hand-off costs HTTP/2 throughput on the cleartext port** → it did, fourfold (§1,
  measured 2026-11-10). Node now hands HTTP/2 the socket itself; only Bun replays. The rerun
  compares Setu h2c with connect-node-h2c.
- **Bun's `node:http2` diverges from Node's under load or on edge cases** → Bun is measured in the
  recorded smoke; `Bun.serve` remains the default when `http2` is unset.
- **A client that sends a body on a request `streamsRequest` claims, after middleware has read it**
  → `bodyUsed` sends it down the buffered path; tested (§3.2).
- **Open HTTP/2 sessions hold the listener past shutdown** — found implementing: an HTTP/2 server's
  `close()` only stops new connections, and connect-node and grpc-js keep their session open. → Both
  modes track sessions and send `GOAWAY` (`session.close()`) on close; the cleartext listener also
  closes idle HTTP/1.1 keep-alives. The e2e asserts a held session receives `GOAWAY` in both modes;
  the kernel's existing shutdown bound covers streams in flight.
- **Middleware that inspects RPC replies now sees `streaming: true`** (cache, idempotency, logger) →
  each already handles a streaming snapshot (`cache-middleware.ts:106,129`,
  `idempotency-plugin/src/core/record.ts:106`); named under "Changed" in the CHANGELOG.
- **Request timings end before a streamed reply does.** `#observeProtocol` (`application.ts:1399`),
  the request logger, metrics and the telemetry span measure until the handler returns, which for a
  streamed reply is time to first byte, as for SSE today. Accepted and documented in the grpc-plugin
  README: per-RPC duration belongs in a Connect interceptor (the existing `interceptors` option),
  not in the HTTP request timing.
- **Trailers dropped by a third-party `IResponse`** → only the kernel's builder writes RPC replies,
  and `responseTrailers` is set only by first-party adapters that write them.

## 9. Out of scope

- HTTP/3 / QUIC — no stable server on the supported runtimes; proxies and CDNs terminate it.
- TLS for HTTP/1.1 alone (`https` without `http2`) — not asked for; the TLS mode serves HTTP/1.1
  anyway.
- A scaffold or `generate app` flag for `http2` — proposed after the rerun (§3.9).
- Response trailers for ordinary routes — the seam is public, but no first-party route writes them;
  the gRPC plugin is the one consumer.
- Typed capability lookups — M139g.
