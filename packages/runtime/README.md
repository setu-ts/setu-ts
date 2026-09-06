# @setu-ts/runtime

RuntimePlugin and runtime adapters providing `IRuntimeServices` for Node.js, Deno, Bun, and
Cloudflare Workers.

This package implements the runtime-independence seam: every runtime-specific operation the
framework needs is abstracted behind `IRuntimeServices` (defined in `@setu-ts/common`) and provided
here under the `CAPABILITIES.RUNTIME` token by the `RuntimePlugin`. No other package ever touches
`process`, `Deno`, `Bun`, or `node:`/`deno:`/`bun:` modules directly.

## Installation

```bash
# Deno
deno add jsr:@setu-ts/runtime

# npm / pnpm / yarn / bun (via JSR's npm compatibility layer)
npx jsr add @setu-ts/runtime
```

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
rather than a masked `500`.

`adapters` and `httpAdapters` are marked `@internal` — they exist so unit tests can run without OS
permissions or real runtime globals, not as application configuration.

`env` matters only on Workers: the edge has no ambient environment, so without it `runtime.env` is
empty and `ConfigPlugin` reads nothing. Object bindings (KV, R2, D1, …) are filtered out here and
published separately by `CloudflarePlugin`.

## Architecture

Cross-runtime operations (UUID, random bytes, SubtleCrypto, `now`, `hrtime`, timers) are identical
across Node 18+, Deno, and Bun because they rely on web-standard APIs on `globalThis`. They are
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
| `RequestBodyTooLargeError`             | class     |
| `toReadyState`                         | function  |
| `toTransportError`                     | function  |
| `toWsReadyState`                       | function  |
| `BunHttpAdapter`                       | class     |
| `CloudflareWorkersHttpAdapter`         | class     |
| `DenoHttpAdapter`                      | class     |
| `NodeHttpAdapter`                      | class     |
| `NodeUpgradeCoordinator`               | class     |
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
| `HttpAdapterOptions`                   | interface |
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

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.
