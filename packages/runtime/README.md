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

In-process oversized `FormData` requests on Node still reject with the same 413. On a Node host, a
request with no socket peer (an in-process `app.fetch()`, on any adapter `platform` selects) that
carries undici's exact generated multipart content type releases the reader lock instead of
cancelling: undici's in-memory producer can enqueue after cancel and throw an uncaught
`ERR_INVALID_STATE`. A request with a peer, every other body, and every request on Bun, Deno or
Workers keep cancellation, so an oversized socket upload stops draining. Two cases also release, and
the 413 still holds in both: socket traffic an application forwards through `app.fetch()` itself,
which has no peer, and a Worker without a global `navigator` (`no_global_navigator`, or a
compatibility date before 2022-03-21), which is detected as Node. No Blob or `inject()` workaround
is required.

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

A streamed body that fails on an HTTP/2 stream resets that stream with `INTERNAL_ERROR`, so the
client sees a failure rather than a clean end of a truncated response; on HTTP/1.1 the connection is
destroyed.

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

## Chosen DNS servers (since 0.14.0)

`IRuntimeServices.createDnsResolver(options)` returns a new `IDnsResolver` on Node, Bun and Deno;
Workers omits the member. `DnsResolverOptions` has readonly `servers: readonly string[]` and
`timeoutMs: number` fields. Invalid options throw `RangeError` at creation.

```typescript
import type { IRuntimeServices } from '@setu-ts/common';

declare const runtime: IRuntimeServices;

const resolver = runtime.createDnsResolver?.({
  servers: ['127.0.0.1:5353', '[::1]:5353'],
  timeoutMs: 3000,
});
const addresses = await resolver?.resolveHost('billing.internal');
```

Servers must be a nonempty list of IPv4 literals, IPv4 with a port, bare IPv6 literals, or bracketed
IPv6 with a port. Ports are plain decimal digits from 1 to 65535, defaulting to 53. Hostnames,
whitespace, empty strings and IPv6 zone indices (`%eth0`) are refused; duplicates are accepted. An
unbracketed `::1:5353` is itself an IPv6 address on port 53, not a port suffix.

`timeoutMs` is an integer from 0 to 2_147_483_647. A positive value bounds a whole `resolveSrv` call
or a whole `resolveHost` call covering both A and AAAA, using an independent timer and cancellation
per call. Each server attempt gets `max(1, ceil(timeoutMs / servers.length))` ms. An event loop
stalled by application work can delay timers. A timeout from the resolver's own timers carries
`code: 'ETIMEOUT'`: on the error `resolveSrv` throws, and on each member of `error.cause.errors` for
`resolveHost` (an attempt Deno ends itself is `TimedOut`, with no `code`); already answered address
families are still returned. The default `runtime.dns` continues using the host resolver without
this added bound.

Node and Bun try the servers in order, one attempt per server, each through its own
`node:dns/promises` `Resolver` with `tries: 1` and one server. The resolver ends each attempt at its
share with its own timer (c-ares itself never ends an attempt before about 250 ms, and Bun rounds
attempts up to whole seconds), then moves to the next server after any error except `ENOTFOUND` or
`ENODATA`, which are the zone's own answer. With zero, no own timer is installed: each attempt runs
to the runtime's default attempt timeout (on Node about 2 s per server, about 3 s for the first
lookup in a process).

Deno takes one name server per call, so it tries servers in order, rotating on any error except
`NotFound`. Each attempt is aborted at its share when the bound is positive. Deno 2.9.6 itself ends
a signalled attempt at about 2 s even if the share is longer; that earlier timeout is `TimedOut`. It
reports NXDOMAIN, no records and SERVFAIL alike as `NotFound`, so SERVFAIL does not rotate. With
zero, no signal is passed and Deno's own timeout is about 15 s per server.

On all four resolver implementations (default and chosen-server), `resolveHost` concatenates A then
AAAA. When both fail, the outer error has an `AggregateError` cause with `errors` in A-then-AAAA
order. A single successful family still wins, even if it returns an empty list.

## Architecture

Cross-runtime operations (UUID, random bytes, SubtleCrypto, `now`, `hrtime`, timers) are identical
across Node 22+, Deno, and Bun because they rely on web-standard APIs on `globalThis` (the
framework's floor is Node 22; `globalThis.crypto` alone would have put it at 19). They are
implemented once in `src/services/cross-runtime.ts`.

Divergent operations (platform, version, hostname, env, exit, fs, workers, dns, createDnsResolver)
are implemented per-adapter via dependency injection: each factory accepts a `*Host` interface
describing only what it needs, defaulting to the real runtime global via a single boundary cast.
This makes every adapter fully unit-testable on Deno by passing a fake host — no real Node/Bun, no
OS permissions.

## Reserved drain response

The response header `x-setu-unprocessed: shutdown` (`UNPROCESSED_HEADER` and `UNPROCESSED_SHUTDOWN`,
since 0.14.0) is reserved for the kernel's pre-pipeline shutdown answer. No request lifecycle hook,
middleware or handler ran; an error responder may format the answer. Its meaning is independent of
status (503 by default), and covers the Setu server, not work done by a proxy. Compare the value
exactly; other values are reserved. The kernel does not remove the header from other responses. An
application that sets it claims the request was not processed, and a client that honours the marker
may send that request again.

## Scope

This package provides the runtime services abstraction **and** the HTTP server adapters. Every
adapter implements `IHttpAdapter` and is registered under `CAPABILITIES.HTTP_ADAPTER` by
`RuntimePlugin`; `app.start({ port })` throws when none is registered for the detected platform.

Platform coverage is not uniform, and the gaps are deliberate rather than pending: on Cloudflare
Workers `fs` is `undefined` (no edge filesystem), `workers`, `dns` and `createDnsResolver` are
omitted, and `exit()` throws — there is no process to end.

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

## Runtime differences, stated (since 0.14.0)

| Behaviour                                       | Node                                  | Bun                                          | Deno                                         |
| ----------------------------------------------- | ------------------------------------- | -------------------------------------------- | -------------------------------------------- |
| Uncaught exception or rejection                 | `onFatalError` observes, crash kept   | `onFatalError` observes, crash kept          | `onFatalError` observes, crash kept          |
| A pending timer and process exit (`unrefTimer`) | the handle's `unref()`                | the handle's `unref()`                       | the handle's `unref()`                       |
| Drain start (`beginDrain`)                      | HTTP/2 `GOAWAY`, idle HTTP/1.1 closed | through the Node adapter when `http2` is set | none; stated once at `listen` with `http2`   |
| Refused WebSocket upgrade                       | the pipeline's response, whole        | the pipeline's response                      | the pipeline's response                      |
| WebSocket per-message ceiling                   | none (the sink's limit)               | 16 MiB, reported once if the limit is higher | 64 MiB, reported once if the limit is higher |
| Quiet response stream                           | stays open                            | stays open (idle timeout off for streams)    | stays open                                   |
| Response stream that fails                      | connection cut, nothing printed       | connection cut, nothing printed              | connection cut, nothing printed              |

A failed stream is logged once by the kernel, `Response stream failed`, through the application's
logger. On Node a refused upgrade is written by `writeRawUpgradeResponse` (internal); the exported
`rejectRawUpgrade(socket, status)` still answers the fixed refusals, with the reason phrase from a
status table and an empty one for a status the table does not name.

On Deno, `request.signal` aborts after every successful response (Deno's legacy behaviour), and the
first read of it prints Deno's own notice once per process ("Deno.serve: request.signal aborts on
successful responses (legacy behavior)…"). Running Deno with `--unstable-no-legacy-abort` removes
the notice and that post-response abort; the signal still aborts when a client disconnects before
the response (measured on Deno 2.9.6). The kernel reads it for gRPC and Connect calls (which pass it
to the call), for a request that calls `ctx.defer` (until the response is handed back), and for
every streamed body, so a client that leaves cancels the source; the request logger reads it on
every request it logs. A Deno application that logs requests or streams responses therefore prints
the notice. On Node and Bun, an error the application handles itself is not reported by
`onFatalError`: an `unhandledRejection` listener handles a rejection, an `uncaughtException`
listener or a capture callback (`process.setUncaughtExceptionCaptureCallback`) a throw (on Node both
a rejection too; Bun never hands either one, so that rejection still ends the process and is
reported). Deno cannot tell, and reports it. On Bun the observer assumes the default
`--unhandled-rejections` mode; under `warn` or `none` it reports the first rejection as fatal and
observes no later one. The ceiling and Deno's drain statements go through the adapter's
`reportError` channel.

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
