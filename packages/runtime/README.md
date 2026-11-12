# @setu-ts/runtime

Each adapter supplies `IRuntimeServices.reportError`: one JSON line to stderr on Node, Bun and Deno,
or the platform log channel on Workers. Serialization and write failures never escape. The kernel
and `errorHandler` use it only without a registered logger, for unhandled errors and handled 5xx
respectively; handled 4xx stays silent without a logger.

RuntimePlugin and runtime adapters providing `IRuntimeServices` for Node.js, Deno, Bun, and
Cloudflare Workers.

This package implements the runtime-independence seam: every runtime-specific operation the
framework needs is abstracted behind `IRuntimeServices` (defined in `@setu-ts/common`) and provided
here under the `CAPABILITIES.RUNTIME` token by the `RuntimePlugin`. No other package ever touches
`process`, `Deno`, `Bun`, or `node:`/`deno:`/`bun:` modules directly.

## Installation

```bash
# npm (pnpm add / yarn add / bun add work the same way)
npm install @setu-ts/runtime

# Deno
deno add npm:@setu-ts/runtime
```

## Local diagnostics listener

`RuntimePlugin` provides `CAPABILITIES.LOCAL_DIAGNOSTICS_LISTENER` for an explicitly activated local
diagnostics connector on Deno and Node. It binds one additional `127.0.0.1` port (1024–65535), keeps
the application listener separate, and exposes only an idempotent `close()` handle. Bun and Workers
refuse before binding.

Node uses `node:http` directly, preserves raw request-target spellings, checks duplicate singleton
header lines, and applies explicit parser/time limits and a 32-connection cap. Parser errors answer
a fixed bare `400` with no body. A port conflict rejects startup; shutdown destroys open
connections. See
[the protocol](https://github.com/setu-ts/setu-ts/blob/main/docs/diagnostics-protocol.md#transport)
for the refusal families and trust limits.

## What's Inside

| Area            | Exports                                                                                |
| --------------- | -------------------------------------------------------------------------------------- |
| Plugin          | `RuntimePlugin`, `RuntimeOptions`, `HttpAdapterOptions`, `RequestBodyTooLargeError`    |
| Detection       | `detectRuntime`, `GlobalScope`                                                         |
| Deno adapter    | `createDenoRuntimeServices`, `DenoHost`, `DenoFileInfo`, `DenoDirEntry`                |
| Node adapter    | `createNodeRuntimeServices`, `NodeHost`, `NodeFsInfo`                                  |
| Bun adapter     | `createBunRuntimeServices`, `BunHost`, `BunFileInfo`                                   |
| Workers adapter | `createCloudflareRuntimeServices`, `CloudflareRuntimeOptions`                          |
| HTTP adapters   | `DenoHttpAdapter`, `NodeHttpAdapter`, `BunHttpAdapter`, `CloudflareWorkersHttpAdapter` |

## Usage

Register the plugin in every application — it is mandatory:

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';

const app = createApplication({
  plugins: [RuntimePlugin()],
});

app.router.get('/info', (ctx) => {
  const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
  return ctx.response.json({
    platform: runtime.platform(),
    requestId: runtime.uuid(),
  });
});

await app.start({ port: 3000 });
```

Force a specific platform (useful for testing):

```typescript
RuntimePlugin({ platform: 'node' });
```

## Options

| Option         | Type                      | Default           | Description                                                                   |
| -------------- | ------------------------- | ----------------- | ----------------------------------------------------------------------------- |
| `platform`     | `RuntimePlatform`         | `detectRuntime()` | Force a platform instead of auto-detecting.                                   |
| `env`          | `Record<string, unknown>` | —                 | Cloudflare Workers `env`. Only its **string** entries populate `runtime.env`. |
| `adapters`     | `RuntimeAdapterFactories` | —                 | Internal: override runtime adapter factories.                                 |
| `httpAdapters` | `HttpAdapterFactories`    | built-in four     | Internal: override HTTP adapter factories.                                    |
| `maxBodyBytes` | `number`                  | — (unbounded)     | Cap on the request-body read, enforced where the body is consumed.            |
| `http2`        | `true \| Http2TlsOptions` | — (HTTP/1.1)      | Serve HTTP/2 beside HTTP/1.1 on one port; see [HTTP/2](#http2).               |

### Bounding the request body

```typescript
RuntimePlugin({ maxBodyBytes: 10 * 1024 * 1024 });
```

Omitted, no framework read cap is imposed; the native runtime may still impose its own limit.

This is the layer no request header can switch off.
`HttpSecurityPlugin({ requestSize: { maxBodySize } })` refuses on a **declared** `Content-Length`
before anything is read, which is cheaper and reports earlier; a **chunked** request declares no
length, and since the body read became lazy it happens inside the handler, after every middleware
has returned. So the middleware bounds declared lengths and this option bounds the read itself.
There are two knobs because the request mapping runs before any plugin and there is no channel
between them: `mapWebRequestToFrameworkRequest` receives a `Request` and nothing else. Set both, and
set `maxBodyBytes` to the same value as `maxBodySize`: a higher one admits an undeclared body larger
than `maxBodySize`.

A body past the cap rejects with `RequestBodyTooLargeError`, branded with a `413` HTTP status hint,
so an application running `errorHandler` answers `413 Payload Too Large` in its configured format
rather than a masked `500`. Without `errorHandler`, the kernel also honors this 4xx hint using its
default response format and warns; only unhinted and 5xx-hinted failures keep its opaque 500.

**`0` refuses every request that carries a body** — it does NOT disable the check, which is what `0`
means for `maxDepth`/`maxNodes`/`maxBatchSize` elsewhere in this framework. Omitting the option is
the one way to say unbounded. A value that is not a non-negative integer throws at
`RuntimePlugin(...)`; `NaN` in particular would make every comparison against the cap `false` and
silently disable the bound, and `Number()` of an unset environment variable is exactly `NaN`.

For in-process oversized-upload tests on Node 24 or Node 26 (up to 26.12.0), build the multipart
request body from a `Blob` or use `inject()` instead of
`app.fetch(new Request(..., { body: formData }))` with a file. Those releases bundle undici
7.20.0–8.11.2, whose `FormData` request body throws an uncaught `ERR_INVALID_STATE` when the runtime
cancels it after the cap is exceeded; undici 8.12.0 fixes it, and no released Node bundles that yet.
Node 22, Bun and Deno are unaffected, as are real-socket uploads and `inject()`. The runtime still
cancels oversized bodies to enforce the read bound.

A client- or bidi-streaming gRPC call is the exception: the kernel hands its unread body to the
procedure, and `GrpcPlugin({ readMaxBytes })` bounds each message instead. A total cap would end
every long-lived stream.

### HTTP/2

```typescript
import { readFileSync } from 'node:fs';

RuntimePlugin({ http2: true }); // cleartext: h2c and HTTP/1.1 on one port
RuntimePlugin({
  http2: { key: readFileSync('tls/key.pem', 'utf8'), cert: readFileSync('tls/cert.pem', 'utf8') },
}); // TLS, ALPN h2 or HTTP/1.1
```

With `http2: true`, each new connection is classified by its first bytes: the HTTP/2 client preface
goes to an HTTP/2 server, anything else to HTTP/1.1 at the first byte that differs, the way
`Deno.serve` and Go's `http.Server` with unencrypted HTTP/2 behave. Browsers, plain `fetch`, health
probes and WebSocket upgrades keep working on the port gRPC clients use. A connection that has not
shown which protocol it speaks within 10 s is closed. With `{ key, cert }` (PEM), TLS negotiates
`h2` or `http/1.1` by ALPN on one port.

| Runtime | `true`                                                   | `{ key, cert }`        |
| ------- | -------------------------------------------------------- | ---------------------- |
| Node    | shared-port h2c and HTTP/1.1                             | TLS, `h2` and HTTP/1.1 |
| Bun     | as Node: served by the Node adapter on `node:http2`      | as Node                |
| Deno    | no change: `Deno.serve` already answers h2c and HTTP/1.1 | passed to `Deno.serve` |
| Workers | ignored: the edge terminates HTTP/2 and HTTP/3           | ignored                |

On Bun the option swaps `Bun.serve` for the Node adapter, so WebSockets there need the optional `ws`
peer, as on Node. As on Node, `@hono/node-server` then installs its own `Request` and `Response`
globals, which a native `Bun.serve` server started later in the same process does not accept: run
one listener kind per process. `close()` sends `GOAWAY` to every open HTTP/2 session, so a client
that keeps its session open cannot hold the listener past shutdown. An HTTP/2 session with no stream
open for 75 s is closed the same way (a stream open but silent, such as a server stream waiting for
events, keeps it, as does a request whose body never ends — as in grpc-go, nothing bounds an open
stream), and HTTP/1.1 on the shared port keeps `node:http`'s own `headersTimeout` (60 s) and
`requestTimeout` (300 s), as on the plain listener.

An HTTP/2 request on the Node adapter carries `IRequest.responseTrailers: true`, and a streamed
response's trailers (`IResponse.stream(body, { trailers })`) are written after its last chunk. That
is what native gRPC needs; see the grpc-plugin README. Every served request's URL takes its scheme
from the listener (`https` only under TLS), never from the client's `:scheme` or an absolute-form
request line, so `requestOriginOf` cannot be told a plain connection is secure.

### Reporting a failed WebSocket handshake

<!-- version:history -->

`HttpAdapterOptions` accepts `reportError?: (record: Readonly<Record<string, unknown>>) => void`
(`@since 0.10.0`). `RuntimePlugin` supplies one resolved at CALL time: the registered logger's
`error`, else `IRuntimeServices.reportError`, and a throwing logger never fails the report. The Node
adapter calls it at most once per distinct message per handle when a server-side handshake fails —
`ws` is missing or throws — before answering `500`; Deno, Workers and Bun ignore the option.
Omitted, the refusal is silent as before.

`adapters` and `httpAdapters` are marked `@internal` — they exist so unit tests can run without OS
permissions or real runtime globals, not as application configuration.

`env` matters only on Workers: the edge has no ambient environment, so without it `runtime.env` is
empty and `ConfigPlugin` reads nothing. Object bindings (KV, R2, D1, …) are filtered out here and
published separately by `CloudflarePlugin`.

## Architecture

Cross-runtime operations (UUID, random bytes, SubtleCrypto, `now`, `hrtime`, timers) are identical
across Node 22+, Deno, and Bun because they rely on web-standard APIs on `globalThis` (the
framework's floor is Node 22; `globalThis.crypto` alone would have put it at 19). They are
implemented once in `src/services/cross-runtime.ts`.

Divergent operations (platform, version, hostname, env, exit, fs, workers, dns) are implemented
per-adapter via dependency injection: each factory accepts a `*Host` interface describing only what
it needs, defaulting to the real runtime global via a single boundary cast. This makes every adapter
fully unit-testable on Deno by passing a fake host — no real Node/Bun, no OS permissions.

## Scope

This package provides the runtime services abstraction **and** the HTTP server adapters. Every
adapter implements `IHttpAdapter` and is registered under `CAPABILITIES.HTTP_ADAPTER` by
`RuntimePlugin`; `app.start({ port })` throws when none is registered for the detected platform.

Platform coverage is not uniform, and the gaps are deliberate rather than pending: on Cloudflare
Workers `fs` is `undefined` (no edge filesystem), `workers` and `dns` are omitted, and `exit()`
throws — there is no process to end.

See the repository's
[`PUBLIC_API.md`](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#runtimeplugin-setu-tsruntime)
for the full API contract and
[`ARCHITECTURE.md`](https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md) for how this
package fits the plugin architecture.

## Bind failures and client body-read failures

`IHttpAdapter.listen(port, hostname?)` resolves only after the socket is bound and rejects with the
native bind error on failure. The default Node host waits for listening/error, so a taken port
rejects startup with `code: 'EADDRINUSE'`. An injected `NodeServeHost.serve` must honor the same
obligation; its close-only handle does not let the adapter observe binding itself.

`RequestBodyReadError` retains the native cause and carries status 400 with the fixed detail
`The request body could not be read; the client closed the connection.` Logging through the shared
serializer includes only the cause's class and fixed detail, never native request data. These client
faults log at warn and do not increment the HTTP metrics 5xx errors counter.

`RequestBodyTooLargeError(maxBodyBytes?: number)` carries status 413. A configured limit is kept in
`maxBodyBytes`; a Bun native-size refusal with no framework cap uses `Infinity` for an unknown
native bound and the generic detail `Request body exceeds the runtime maximum size.` Bun answers
that client itself with an empty `413`, so the detail reaches the handler, logs and metrics but not
the response body. Existing configured-cap detail is unchanged. Even without `errorHandler`, the
kernel now serves 4xx hints with standard titles and explicit details at warn; unhinted and
5xx-hinted failures retain its opaque 500/error fallback. The body cap's omission does not remove a
native runtime's own limit.

## Exports

### `@setu-ts/runtime`

| Export                                 | Kind      |
| -------------------------------------- | --------- |
| `adaptWsModule`                        | function  |
| `asUpgradeEmitter`                     | function  |
| `bindCloudflareSocketToSink`           | function  |
| `bindDenoSocketToSink`                 | function  |
| `bindWsSocketToSink`                   | function  |
| `buildBunHost`                         | function  |
| `buildNodeHost`                        | function  |
| `createBunRuntimeServices`             | function  |
| `createBunWebSocketHandlers`           | function  |
| `createCloudflareRuntimeServices`      | function  |
| `createDefaultCloudflareWebSocketHost` | function  |
| `createDenoDnsResolver`                | function  |
| `createDenoRuntimeServices`            | function  |
| `createNodeDnsResolver`                | function  |
| `createNodeRuntimeServices`            | function  |
| `createNodeWorkerHost`                 | function  |
| `createRuntimeServices`                | function  |
| `createUpgradeRequest`                 | function  |
| `createWebSocketTransport`             | function  |
| `createWebWorkerHost`                  | function  |
| `createWsTransport`                    | function  |
| `detectRuntime`                        | function  |
| `isWebSocketUpgradeRequest`            | function  |
| `loadWsModule`                         | function  |
| `normalizeFrame`                       | function  |
| `rejectRawUpgrade`                     | function  |
| `RuntimePlugin`                        | function  |
| `toReadyState`                         | function  |
| `toTransportError`                     | function  |
| `toWsReadyState`                       | function  |
| `BunHttpAdapter`                       | class     |
| `CloudflareWorkersHttpAdapter`         | class     |
| `DenoHttpAdapter`                      | class     |
| `NodeHttpAdapter`                      | class     |
| `NodeUpgradeCoordinator`               | class     |
| `RequestBodyReadError`                 | class     |
| `RequestBodyTooLargeError`             | class     |
| `RpcInterceptorStore`                  | class     |
| `BunFileInfo`                          | interface |
| `BunHost`                              | interface |
| `BunModules`                           | interface |
| `BunServeHost`                         | interface |
| `BunServer`                            | interface |
| `BunServerWebSocket`                   | interface |
| `BunSocketData`                        | interface |
| `BunWebSocketHandlers`                 | interface |
| `CloudflareEnv`                        | interface |
| `CloudflareRuntimeOptions`             | interface |
| `CloudflareServerSocket`               | interface |
| `CloudflareWebSocketHost`              | interface |
| `CloudflareWebSocketPair`              | interface |
| `CreateRuntimeServicesOptions`         | interface |
| `DenoDirEntry`                         | interface |
| `DenoDnsHost`                          | interface |
| `DenoFileInfo`                         | interface |
| `DenoHost`                             | interface |
| `DenoServeHost`                        | interface |
| `DenoServer`                           | interface |
| `DenoSrvRecord`                        | interface |
| `DenoWebSocketLike`                    | interface |
| `DenoWebSocketUpgrade`                 | interface |
| `GlobalScope`                          | interface |
| `Http2TlsOptions`                      | interface |
| `HttpAdapterFactories`                 | interface |
| `HttpAdapterOptions`                   | interface |
| `NodeDnsModule`                        | interface |
| `NodeFsInfo`                           | interface |
| `NodeHost`                             | interface |
| `NodeIncomingMessage`                  | interface |
| `NodeModules`                          | interface |
| `NodeServeHost`                        | interface |
| `NodeServer`                           | interface |
| `NodeWorkerLike`                       | interface |
| `NodeWorkerModules`                    | interface |
| `RawUpgradeSocket`                     | interface |
| `RuntimeAdapterFactories`              | interface |
| `RuntimeOptions`                       | interface |
| `UpgradeEmitter`                       | interface |
| `WebSocketLike`                        | interface |
| `WebWorkerGlobals`                     | interface |
| `WebWorkerHostOptions`                 | interface |
| `WebWorkerLike`                        | interface |
| `WsModuleLike`                         | interface |
| `WsServerLike`                         | interface |
| `WsSocketLike`                         | interface |

### `@setu-ts/runtime/worker`

| Export             | Kind     |
| ------------------ | -------- |
| `defineWorkerTask` | function |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.
