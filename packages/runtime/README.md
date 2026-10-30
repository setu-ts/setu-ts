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

### Bounding the request body

```typescript
RuntimePlugin({ maxBodyBytes: 10 * 1024 * 1024 });
```

Omitted, the read is unbounded — the released behaviour, byte for byte.

This is the layer no request header can switch off.
`HttpSecurityPlugin({ requestSize: { maxBodySize } })` refuses on a **declared** `Content-Length`
before anything is read, which is cheaper and reports earlier; a **chunked** request declares no
length, and since the body read became lazy it happens inside the handler, after every middleware
has returned. So the middleware bounds declared lengths and this option bounds the read itself.
There are two knobs because the request mapping runs before any plugin and there is no channel
between them: `mapWebRequestToFrameworkRequest` receives a `Request` and nothing else. Set both, and
set `maxBodyBytes` to the same value as `maxBodySize` or higher.

A body past the cap rejects with `RequestBodyTooLargeError`, branded with a `413` HTTP status hint,
so an application running `errorHandler` answers `413 Payload Too Large` in its configured format
rather than a masked `500`. With no `errorHandler` registered the brand has no reader and the
kernel's opaque `500` answers instead.

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
