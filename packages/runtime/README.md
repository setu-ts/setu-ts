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
| Plugin          | `RuntimePlugin`, `RuntimeOptions`                                                      |
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
| `RuntimeAdapterFactories`              | interface |
| `RuntimeOptions`                       | interface |
| `UpgradeEmitter`                       | interface |
| `WebSocketLike`                        | interface |
| `WebWorkerGlobals`                     | interface |
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
