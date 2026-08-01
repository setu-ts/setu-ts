# @hono-enterprise/grpc-plugin

gRPC plugin for Hono Enterprise — enables co-serving of gRPC, Connect, and gRPC-Web protocols on the
same port as ordinary Hono routes. The plugin registers an `IGrpcService` under `CAPABILITIES.GRPC`
and installs a fetch handler into the HTTP adapter's RPC interceptor seam.

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
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { GrpcPlugin } from '@hono-enterprise/grpc-plugin';
import { CAPABILITIES, type IGrpcService } from '@hono-enterprise/common';

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

## Limitations

- **Bidi streaming**: Requires HTTP/2. Over HTTP/1.1, Connect may refuse bidi connections with
  `505 Connection: Close`. In practice, this is not a concern since gRPC clients typically speak
  HTTP/2.
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

The plugin registers a health indicator named `'grpc'` that reports:

- `available`: Whether the HTTP adapter supports the RPC interceptor seam
- `basePath`: The configured base path
- `reflection`: Whether reflection is enabled
- `health`: Whether the health service is enabled
- `serviceCount`: Number of registered services

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

- [Milestone 49 Plan](../../plans/milestone-49-grpc-plugin.md)
- [PUBLIC_API.md](../../../PUBLIC_API.md) — gRPC section
- [ARCHITECTURE.md](../../../ARCHITECTURE.md) — §7 and §18 updates
