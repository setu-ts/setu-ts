# @setu-ts/grpc-plugin — Connect and gRPC-Web services

**Add it:** `setu add grpc` adds it with its `@connectrpc/connect` and `@bufbuild/protobuf` peers,
and prints `GrpcPlugin({ services: [] })` for `setu.config.ts`; an outbound client also needs
`@connectrpc/connect-node`, and runs on Node and Bun only: on Workers `grpcClient()` throws a
TypeError, and on Deno the client can crash the process when a peer leaves. Provides
`CAPABILITIES.GRPC` (`IGrpcService`).

## Serve generated service descriptors

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

- `basePath` defaults to `/`; a prefix needs a matching client URL.
- `reflection` and `health` default to `true`.
- Native `application/grpc` is refused with gRPC status 12 (HTTP 200); Connect and gRPC-Web are
  served.
- A duplicate service type name throws; no implementation means reflection only.
- Server answers succeed, thrown handler errors too; no answer, unavailable, unimplemented, deadline
  and peer cancel fail. Abort, pre-send faults and early ENHANCE_YOUR_CALM resets report nothing, as
  do headers over a peer's advertised limit and 8 KiB, or over 64 KiB refused on an open session
  with no known limit; at or under 8 KiB the instance fails.
- Marked drain 503s resent once; discover pods.
- Stream cancel aborts `ctx.signal`, then awaits cleanup unbounded.
- The health bridge serves with no health capability; aggregate degraded is not serving.

## Other options

- `interceptors` adds Connect interceptors.
- `connectModule` injects a loaded runtime; `adaptConnectModule` adapts modules.
- `GrpcRuntimeLoadError`: missing runtime; `GrpcDescriptorError`: bad descriptors;
  `GrpcHeaderListTooLargeError`: caller headers too large; `GrpcExcessiveLoadError`: an
  ENHANCE_YOUR_CALM reset, not resent.
