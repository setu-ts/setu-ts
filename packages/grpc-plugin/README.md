# @setu-ts/grpc-plugin

gRPC plugin for Setu-TS — enables co-serving of gRPC, Connect, and gRPC-Web protocols on the same
port as ordinary Hono routes. The plugin registers an `IGrpcService` under `CAPABILITIES.GRPC`; the
kernel resolves that service from the registry and dispatches RPC traffic itself — after the
middleware pipeline, before route matching — so gRPC rides the same auth, metrics, and shutdown
drain as every other route. No adapter seam is involved: `GrpcService.available` is unconditionally
`true`, and `Application.inject()` reaches gRPC handlers exactly as it reaches ordinary routes.

## Features

- Supports all four RPC kinds: unary, server-streaming, client-streaming, and bidi (HTTP/2 required)
- Connect protocol (`application/connect+json`, `application/connect+proto`)
- gRPC-Web protocol (`application/grpc-web+json`, `application/grpc-web+proto`)
- Native gRPC-binary requests (`application/grpc`, `application/grpc+proto`,
  `application/grpc+json`) are refused with a Trailers-Only `UNIMPLEMENTED` response — see
  [Limitations](#limitations)
- Server reflection (v1, default ON), reachable over Connect and gRPC-Web — **not** from stock
  `grpcurl`/`grpcui`, which speak native `application/grpc` (see Limitations)
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
      services: [
        { definition: MyServiceDefinition, implementation: myServiceImpl },
      ],
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

```typescript
GrpcPlugin({
  basePath: '/my-grpc',
  reflection: true,
  health: true,
  services: [
    { definition: MyServiceDescriptor, implementation: MyServiceImpl },
  ],
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
whole server" and returns the mapped aggregate: `up → SERVING`, `down → NOT_SERVING`, and
`degraded → NOT_SERVING`. Since M70c the bridge agrees with the health plugin's `/ready`, which
already withdraws a degraded replica from its Service (503) — reporting `SERVING` here would leave
the two health faces of one process disagreeing, with gRPC clients load-balancing onto a replica
HTTP has taken out of rotation. A `service` naming something this server does not serve answers
`SERVICE_UNKNOWN`. `List` and `Watch` are left to Connect's automatic `unimplemented` responder.

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

- **Bidi streaming needs a genuinely full-duplex transport** — HTTP/2, or in-process `app.fetch`.
  The plugin deliberately leaves Connect's `httpVersion` option unset, because `IHttpAdapter`
  surfaces no negotiated version and guessing `'1.1'` would make Connect refuse bidi even on
  transports that support it. The consequence is that a bidi call over a real HTTP/1.1 socket fails
  at the transport rather than with a clean `505`. In practice this is benign — gRPC clients speak
  HTTP/2 — but note it also applies to this plugin's OWN `grpc.reflection.v1.ServerReflection`,
  whose sole method is bidi-streaming. Unary, server-streaming and client-streaming are unaffected
  on every runtime.
- **Application injection**: `Application.inject()` reaches gRPC handlers — the kernel dispatches
  gRPC from the service registry, not through the HTTP adapter, so an injected request is routed
  exactly like an adapter-delivered one. `app.fetch()` with a web `Request` works too, for streaming
  procedures.
- **No client SDK**: This plugin only provides server-side gRPC serving. Client-side gRPC calls are
  handled by generated Connect/gRPC client code in the application.
- **Native gRPC-binary is refused by design**: requests with a native gRPC content type
  (`application/grpc`, `application/grpc+proto`, `application/grpc+json`) are answered with a
  **Trailers-Only `UNIMPLEMENTED`** response — HTTP `200`, `content-type: application/grpc`, and
  `grpc-status: 12` in the headers. The native wire protocol depends on HTTP/2 trailers for status
  signaling, and no fetch-based server runtime exposes them to a `Response` (Deno's `Deno.serve`
  surfaces no trailers; Node's and Bun's fetch handlers do not either). Module loading itself is
  unaffected — the plugin loads its Connect dependency on every runtime it runs on — but a fetch
  `Response` carries trailers nowhere, so the protocol cannot be served honestly. Serving half of
  the protocol — reflection and health resolve, every real call fails with "missing status" — is
  worse than refusing it cleanly: clients see an explicit, well-formed `UNIMPLEMENTED` instead of an
  opaque transport error after a successful handshake. Measured with real `grpcurl` v1.9.3: a unary
  native call reports `target server does not expose service …` and exits 1. A **bidi** native call
  still hangs rather than reporting the refusal — including `grpcurl list`, whose reflection call is
  bidi-streaming — for the transport reason the bidi bullet above gives, not because of this
  refusal; it hangs identically with the refusal removed. **Use Connect or gRPC-Web instead**; both
  work completely for unary, server-streaming and client-streaming over both HTTP/1.1 and HTTP/2;
  bidi additionally requires HTTP/2, per the bidi bullet above. Every non-JS gRPC client can speak
  Connect or gRPC-Web, but **not through `grpcurl`** — its `-format` flag selects the message
  encoding (`json`/`text`), not the wire protocol, and it implements native gRPC only. Use
  `buf curl --protocol connect` (or `--protocol grpcweb`), a generated Connect client, or a web
  client; for an existing native-gRPC fleet, put Envoy's `grpc_web` filter in front.

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

Generated from the package barrel by `deno task docs:exports`; `deno task check:docs` fails when it
drifts.
