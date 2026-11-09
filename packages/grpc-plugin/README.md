# @setu-ts/grpc-plugin

gRPC plugin for Setu-TS — enables co-serving of gRPC, Connect, and gRPC-Web protocols on the same
port as ordinary Hono routes. The plugin registers an `IGrpcService` under `CAPABILITIES.GRPC`; the
kernel resolves that service from the registry and dispatches RPC traffic itself — after the
middleware pipeline, before route matching — so gRPC rides the same auth, metrics, and shutdown
drain as every other route. No adapter seam is involved: `GrpcService.available` is unconditionally
`true`, and `Application.inject()` reaches gRPC handlers exactly as it reaches ordinary routes.

## Features

- Supports all four RPC kinds: unary, server-streaming, client-streaming, and bidi (bidi needs
  HTTP/2). Streamed responses reach the client message by message, and client- and bidi-streaming
  requests reach the procedure while the client is still sending
- Connect protocol (`application/connect+json`, `application/connect+proto`)
- gRPC-Web protocol (`application/grpc-web+json`, `application/grpc-web+proto`)
- Native gRPC (`application/grpc`, `+proto`, `+json`) on Node and Bun with
  `RuntimePlugin({ http2 })` — so `grpcurl`, `ghz` and grpc-go/grpc-java clients reach the server
  directly. Elsewhere it is refused with a Trailers-Only `UNIMPLEMENTED` — see
  [Limitations](#limitations)
- Server reflection (v1, default ON), reachable over Connect and gRPC-Web everywhere, and from stock
  `grpcurl`/`grpcui` wherever native gRPC is served
- gRPC Health v1 service bridged to M20 health plugin (default ON)
- Zero runtime dependencies in the source — Connect-ES is loaded lazily behind a structural facade
- Module loading works on Node, Deno, Bun, and Cloudflare Workers without modification

## Installation

The Connect and Protobuf-ES modules are lazy-loaded on first use. Install them with the package
manager that matches your runtime:

```bash
# Deno
deno add npm:@connectrpc/connect@^2.1.2 npm:@bufbuild/protobuf@^2.7.0
# npm
npm i @connectrpc/connect @bufbuild/protobuf
# Bun
bun add @connectrpc/connect @bufbuild/protobuf
```

## Usage

Pass your services through the plugin's **`services` option**. Plugins register during
`app.start()`, so `CAPABILITIES.GRPC` does not exist until `start()` resolves — resolving it before
`start()` throws `No service registered for capability 'grpc'`. (`createApplication()` returns a
descriptor, not a running application; there is no `new Application()` / `app.use()` API.)

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GrpcPlugin } from '@setu-ts/grpc-plugin';
import type { GrpcServiceDefinition } from '@setu-ts/grpc-plugin';

// Your generated descriptor + implementation (illustrative stand-ins).
declare const MyServiceDefinition: GrpcServiceDefinition;
declare const myServiceImpl: Record<string, unknown>;

const app = createApplication({
  plugins: [
    RuntimePlugin(),
    GrpcPlugin({
      services: [{ definition: MyServiceDefinition, implementation: myServiceImpl }],
    }),
  ],
});

await app.start({ port: 3000 });
```

## Options

The `GrpcPlugin` accepts optional configuration:

- `basePath`: Base path under which gRPC services are served (defaults to `/` — the root, so a
  client pointed at `http://host:3000` reaches its procedures without a path prefix). Detection is
  still segment-aware: with the default, `/grpcfoo` and other prefix-adjacent routes stay yours.
- `reflection`: Whether to enable server reflection (defaults to `true`)
- `health`: Whether to enable gRPC Health v1 service (defaults to `true`)
- `services`: Initial services to register at startup
- `connectModule`: Injected Connect runtime module (for testing)
- `interceptors`: Application Connect interceptors, forwarded to Connect router construction
  (`createConnectRouter({ interceptors })`). Composed after the built-in handler-error logging, so a
  handler throw is logged before an application interceptor observes it. Absent: none installed
  (defaults to `[]`)
- `readMaxBytes`: The largest request message a procedure accepts, in bytes (defaults to 4 MiB, the
  receive limit grpc-go and grpc-js default to). Connect applies it per message on gRPC, gRPC-Web
  and Connect streaming, and to the whole body of a unary Connect request; a larger message is
  refused with `RESOURCE_EXHAUSTED`. It is the bound on a streamed request:
  `RuntimePlugin({ maxBodyBytes })` is a total, so it bounds only the buffered bodies of unary and
  server-streaming calls. An integer from 1 to `4294967295`; anything else throws at `GrpcPlugin()`

```typescript
GrpcPlugin({
  basePath: '/my-grpc',
  reflection: true,
  health: true,
  services: [{ definition: MyServiceDescriptor, implementation: MyServiceImpl }],
  interceptors: [myInterceptor],
});
```

## Reflection and Health

Reflection (`grpc.reflection.v1.ServerReflection`, default ON) answers `list_services`,
`file_by_filename`, `file_containing_symbol` and `all_extension_numbers_of_type`. Symbols resolve
for services, their methods, messages, nested types, enums and extensions — of the plugin's own two
protos AND of every registered application service's `DescFile` plus its transitive `dependencies`.
Nothing else is exposed. `file_containing_extension` answers `UNIMPLEMENTED` (the framework
registers no extensions); an unknown filename, symbol or type answers `NOT_FOUND`. Set
`reflection: false` to register nothing.

Health (`grpc.health.v1.Health`, default ON) implements `Check` only, resolving
`CAPABILITIES.HEALTH` optionally — absent, it answers `SERVING`. An empty `service` field means "the
whole server" and returns the mapped readiness aggregate: `up → SERVING`, `down → NOT_SERVING`, and
`degraded → NOT_SERVING`. Since **M119b** the bridge reads the readiness report (`checkReady()`), so
it agrees with the health plugin's `/ready`: an indicator that counts toward `/health` but not
`/ready` (the `mail` indicator, by default) does not turn the server `NOT_SERVING`. `degraded` still
maps to `NOT_SERVING` because the health plugin already withdraws a degraded replica from its
Service (503) — reporting `SERVING` here would leave the two health faces of one process
disagreeing, with gRPC clients load-balancing onto a replica HTTP has taken out of rotation. A
`service` naming something this server does not serve answers `SERVICE_UNKNOWN`. `List` and `Watch`
are left to Connect's automatic `unimplemented` responder.

## Errors

| Error                  | Thrown when                                                                                                                                                                                                        |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `GrpcRuntimeLoadError` | Any of the four Connect/Protobuf-ES specifiers cannot be imported                                                                                                                                                  |
| `GrpcDescriptorError`  | An embedded descriptor set cannot be decoded or lacks its expected service                                                                                                                                         |
| `GrpcUnavailableError` | **Deprecated — never thrown since M70a.** Retained as published surface only; gRPC dispatch no longer depends on any adapter capability, so `handleRequest` is always serviceable and `available` is always `true` |

## Limitations

- **Detection is prefix-only.** A request is RPC when its path starts with `basePath`. Content-type
  sniffing is deliberately NOT used: Connect's real unary content types include `application/json`
  and `application/proto`, so matching them would hijack ordinary application routes. Point your
  client's base URL at `basePath`. Paths outside it — including prefix-adjacent ones like `/grpcfoo`
  — fall through to Hono untouched.

- **What each runtime serves** (since `0.13.0`):

  | Runtime and listener                                             | Connect, gRPC-Web | Server streams as sent | Client and bidi streaming     | Native gRPC, reflection via `grpcurl`      |
  | ---------------------------------------------------------------- | ----------------- | ---------------------- | ----------------------------- | ------------------------------------------ |
  | Node, default (HTTP/1.1)                                         | yes               | yes                    | client yes, bidi no           | refused                                    |
  | Node, `RuntimePlugin({ http2: true })`                           | yes, h1 and h2c   | yes                    | yes over HTTP/2               | yes over HTTP/2                            |
  | Node, `RuntimePlugin({ http2: { key, cert } })`                  | yes, h1 and h2    | yes                    | yes over HTTP/2               | yes over HTTP/2                            |
  | Bun, default (`Bun.serve`)                                       | yes               | yes                    | client yes, bidi no           | refused                                    |
  | Bun with `http2` (served by `node:http2`)                        | as Node           | yes                    | as Node                       | as Node                                    |
  | Deno (`Deno.serve`, h1 and h2c; TLS with `http2: { key, cert }`) | yes               | yes                    | yes over HTTP/2               | refused — `Deno.serve` writes no trailers  |
  | Cloudflare Workers                                               | yes               | yes                    | client yes; bidi not verified | refused — no trailers on a Worker response |

  Native gRPC reports each call's status in HTTP/2 trailers, so it is served only where the adapter
  can write them: the Node adapter on an HTTP/2 connection (`IRequest.responseTrailers`). On the
  shared cleartext port, an HTTP/1.1 request for a native procedure is still refused, since a native
  client never speaks HTTP/1.1. Bidi needs a full-duplex transport: over HTTP/1.1 Connect's own bidi
  check is left unset (the adapter reports no negotiated version), so a bidi call there fails at the
  transport rather than with a clean `505`.

- **Request bodies.** A unary or server-streaming call's single request message is buffered under
  `RuntimePlugin({ maxBodyBytes })`. A client- or bidi-streaming call gets the unread body stream,
  bounded per message by `readMaxBytes` — unless middleware already read the body, in which case it
  is dispatched from that read.

- **Timing and `inject()`.** A streamed reply leaves the pipeline at its first byte, so the request
  logger, metrics and the telemetry span time a streaming RPC to its first message, as they do SSE;
  time a whole call in a Connect interceptor (`interceptors`). `Application.inject()` reaches unary
  and client-streaming procedures, whose replies are buffered; a server-streaming or bidi reply is a
  stream, which `inject()` refuses — use `app.fetch()` with a web `Request` and read the body.
- **No client SDK**: This plugin only provides server-side gRPC serving. Client-side gRPC calls are
  handled by generated Connect/gRPC client code in the application.

<!-- version:history -->

- **Native gRPC before `0.13.0`** was refused on every runtime, because the kernel wrote replies
  through a fetch `Response`, which carries no trailers, and Node served HTTP/1.1 only. Where it is
  still refused (see the table above), the answer is a **Trailers-Only `UNIMPLEMENTED`** — HTTP
  `200`, `content-type: application/grpc`, `grpc-status: 12` in the headers — decided from the
  request headers before the body is read, so a half-open native stream gets it without hanging.
  There, use Connect or gRPC-Web (`buf curl --protocol connect` or `--protocol grpcweb`, a generated
  Connect client, or Envoy's `grpc_web` filter in front of a native fleet); `grpcurl` implements
  native gRPC only.

## Health Indicator

The plugin registers a health indicator named `'grpc'` whose `data` reports:

- `available`: whether gRPC dispatch is available — unconditionally `true` since M70a, because the
  kernel resolves `IGrpcService` from the service registry and dispatches after the middleware
  pipeline; the previous adapter-based seam (and the `GrpcUnavailableError` that guarded it) is
  retired
- `serviceCount`: how many application services are registered

## Development

To regenerate embedded descriptor constants (when upgrading protos):

```bash
# From grpc/grpc-proto at the desired commit
protoc -Iproto --include_imports \
  --descriptor_set_out=health.binpb proto/grpc/health/v1/health.proto
protoc -Iproto --include_imports \
  --descriptor_set_out=reflection.binpb proto/grpc/reflection/v1/reflection.proto

base64 -w0 < health.binpb      # 1168 chars
base64 -w0 < reflection.binpb  # 2332 chars
```

## See Also

- [PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md#api-reference-setu-tsgrpc-plugin)
  — the `grpc-plugin` Options / Exports / Notes section
- [ARCHITECTURE.md](https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md) — §7 the
  `IHttpAdapter` seam, §18 why the plugin does not hang off the kernel
- [ROADMAP.md](https://github.com/setu-ts/setu-ts/blob/main/ROADMAP.md) — Milestone 49

## Exports

| Export                  | Kind      |
| ----------------------- | --------- |
| `adaptConnectModule`    | function  |
| `GrpcPlugin`            | function  |
| `GrpcDescriptorError`   | class     |
| `GrpcRuntimeLoadError`  | class     |
| `GrpcService`           | class     |
| `GrpcUnavailableError`  | class     |
| `CAPABILITIES`          | const     |
| `ConnectModuleLike`     | interface |
| `GrpcPluginOptions`     | interface |
| `GrpcServiceDefinition` | interface |
| `IGrpcService`          | interface |
| `GrpcServingStatus`     | type      |
| `RpcFetchHandler`       | type      |

Generated from the package barrel by `pnpm run docs:exports`; `pnpm run check:docs` fails when it
drifts.
