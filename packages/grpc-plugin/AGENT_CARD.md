# @setu-ts/grpc-plugin — Connect and gRPC-Web services

**Add it:** `setu add grpc` adds it and prints `GrpcPlugin({ services: [] })` for `setu.config.ts`;
install `@connectrpc/connect` and `@bufbuild/protobuf` too. It provides `CAPABILITIES.GRPC`
(`IGrpcService`).

## Serve generated service descriptors

Pass your generated descriptor and implementation into this config helper:

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
- The health bridge reports serving without a health capability; an aggregate degraded status is not
  serving.

## Other options

- `interceptors` installs application Connect interceptors.
- `connectModule` injects an already-loaded runtime; `adaptConnectModule` adapts loaded modules.
- `GrpcRuntimeLoadError` reports a missing runtime; `GrpcDescriptorError` reports invalid
  descriptors.
