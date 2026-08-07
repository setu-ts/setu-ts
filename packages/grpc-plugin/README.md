# @setu-ts/grpc-plugin

gRPC plugin for Setu-TS — enables co-serving of gRPC, Connect, and gRPC-Web protocols on the same
port as ordinary Hono routes. The plugin registers an `IGrpcService` under `CAPABILITIES.GRPC` and
installs a fetch handler into the HTTP adapter's RPC interceptor seam.

## Features

- Supports all four RPC kinds: unary, server-streaming, client-streaming, and bidi (HTTP/2 required)
- Connect protocol (`application/connect+json`, `application/connect+proto`)
- gRPC protocol (`application/grpc+json`, `application/grpc+proto`)
- gRPC-Web protocol (`application/grpc-web+json`, `application/grpc-web+proto`)
- Server reflection (v1, default ON) for grpcurl, grpcui, and other tools
- gRPC Health v1 service bridged to M20 health plugin (default ON)
- Zero runtime dependencies — Connect-ES is loaded lazily behind a structural facade
- Works on Node, Deno, Bun, and Cloudflare Workers without modification

## Usage

```typescript
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GrpcPlugin } from '@setu-ts/grpc-plugin';
import { CAPABILITIES, type IGrpcService } from '@setu-ts/common';

const app = createApplication({
  plugins: [RuntimePlugin(), GrpcPlugin()],
});

const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
// Add your service definitions and implementations here...

await app.start({ port: 3000 });
```

## Options

The `GrpcPlugin` accepts optional configuration:

- `basePath`: Base path under which gRPC services are served (defaults to `/grpc`)
- `reflection`: Whether to enable server reflection (defaults to `true`)
- `health`: Whether to enable gRPC Health v1 service (defaults to `true`)
- `services`: Initial services to register at startup
- `connectModule`: Injected Connect runtime module (for testing)

```typescript
GrpcPlugin({
  basePath: '/my-grpc',
  reflection: true,
  health: true,
  services: [
    { definition: MyServiceDescriptor, implementation: MyServiceImpl },
  ],
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
`degraded → SERVING` (degraded means impaired but still serving; reporting `NOT_SERVING` would make
Kubernetes withdraw the replica exactly when the app is functional but under stress). A `service`
naming something this server does not serve answers `SERVICE_UNKNOWN`. `List` and `Watch` are left
to Connect's automatic `unimplemented` responder.

## Errors

| Error                  | Thrown when                                                                    |
| ---------------------- | ------------------------------------------------------------------------------ |
| `GrpcRuntimeLoadError` | Any of the four Connect/Protobuf-ES specifiers cannot be imported              |
| `GrpcDescriptorError`  | An embedded descriptor set cannot be decoded or lacks its expected service     |
| `GrpcUnavailableError` | `handleRequest` is called while the adapter does not implement `setRpcHandler` |

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
- **Application injection**: The `Application.inject()` method bypasses the HTTP adapter seam and
  cannot reach gRPC handlers. Use `app.fetch()` for testing gRPC endpoints.
- **No client SDK**: This plugin only provides server-side gRPC serving. Client-side gRPC calls are
  handled by generated Connect/gRPC client code in the application.
- **gRPC-binary trailers on Deno**: Native gRPC-binary protocol (`application/grpc`) relies on
  HTTP/2 response trailers (specifically the `grpc-status` trailer) for proper status signaling.
  Deno's `Deno.serve` does not expose HTTP/2 trailers, so native gRPC-binary responses may not work
  correctly on Deno. This is a **platform limitation**, not a plugin bug—the plugin correctly
  forwards `Response.trailers` when available. Connect-JSON and gRPC-Web protocols work on all
  runtimes. For native gRPC-binary, Node.js or Bun may provide better trailer support depending on
  their HTTP/2 implementations.

## Health Indicator

The plugin registers a health indicator named `'grpc'` whose `data` reports:

- `available`: whether the HTTP adapter implements the `setRpcHandler?` seam
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

- [PUBLIC_API.md](https://github.com/setu-ts/setu-ts/blob/main/PUBLIC_API.md) — the `grpc-plugin`
  Options / Exports / Notes section
- [ARCHITECTURE.md](https://github.com/setu-ts/setu-ts/blob/main/ARCHITECTURE.md) — §7 the
  `IHttpAdapter` seam, §18 why the plugin does not hang off the kernel
- [ROADMAP.md](https://github.com/setu-ts/setu-ts/blob/main/ROADMAP.md) — Milestone 49
