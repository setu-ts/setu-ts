# @setu-ts/grpc-plugin — Connect and gRPC-Web services

**Add it:** `setu add grpc` adds it with its `@connectrpc/connect` and `@bufbuild/protobuf` peers,
and prints `GrpcPlugin({ services: [] })` for `setu.config.ts`; an outbound client also needs
`@connectrpc/connect-node`, and runs on Node and Bun only: on Cloudflare Workers `grpcClient()`
throws a TypeError, and on Deno the client can crash the process when a peer goes away. It provides
`CAPABILITIES.GRPC` (`IGrpcService`).

## Serve generated service descriptors

Register a generated descriptor and implementation:

```ts
import { GrpcPlugin } from '@setu-ts/grpc-plugin';
import type { GrpcServiceDefinition } from '@setu-ts/common';

export function rpcPlugin(definition: GrpcServiceDefinition, implementation: unknown) {
  return GrpcPlugin({
    services: [{ definition, implementation }],
    basePath: '/',
  });
}
```

## Add another service after startup

Call from a module initializer once services are available:

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { GrpcServiceDefinition, IGrpcService, IServiceRegistry } from '@setu-ts/common';

export function registerRpcService(
  services: IServiceRegistry,
  definition: GrpcServiceDefinition,
  implementation: unknown,
): void {
  services.get<IGrpcService>(CAPABILITIES.GRPC).addService(definition, implementation);
}
```

## Behaviour the types do not show

- `basePath` defaults to `/`; a prefixed deployment needs a matching client base URL.
- `reflection` and `health` default to `true`.
- Native `application/grpc` requests are refused with gRPC status 12 (HTTP 200); Connect and
  gRPC-Web are served.
- Registering the same service type name twice throws. Omitting the implementation registers a
  service for reflection only.
- Wire app answers succeed; other errors fail. Caller abort and pre-send faults (serialization,
  `writeMaxBytes`, a refused header, a list over the peer's advertised size) report nothing.
- Drain 503s are not resent. Discover pods to balance calls.
- Stream cancellation aborts `ctx.signal`, then awaits cleanup unbounded.
- The health bridge reports serving without a health capability; an aggregate degraded status is not
  serving.

## Other options

- `interceptors` installs application Connect interceptors.
- `connectModule` injects an already-loaded runtime; `adaptConnectModule` adapts loaded modules.
- `GrpcRuntimeLoadError`: missing runtime; `GrpcDescriptorError`: invalid descriptors;
  `GrpcHeaderListTooLargeError`: the cause of an over-limit header list.
