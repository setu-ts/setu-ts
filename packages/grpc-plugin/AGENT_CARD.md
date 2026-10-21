# @setu-ts/grpc-plugin — Connect and gRPC-Web beside your routes

`setu add grpc` pins the package and prints `GrpcPlugin({ services: [] })` for `setu.config.ts`.
Install `@connectrpc/connect` and `@bufbuild/protobuf`; both are lazy-loaded on first use. The
plugin registers `CAPABILITIES.GRPC` during `app.start()`, and the kernel dispatches RPC after the
middleware pipeline.

```ts
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { GrpcPlugin } from '@setu-ts/grpc-plugin';
import type { GrpcServiceDefinition } from '@setu-ts/grpc-plugin';

declare const userDefinition: GrpcServiceDefinition;
declare const userImplementation: Record<string, unknown>;

export const app = createApplication({
  plugins: [
    RuntimePlugin(),
    GrpcPlugin({
      services: [{ definition: userDefinition, implementation: userImplementation }],
      basePath: '/',
    }),
  ],
});
```

Register more services after boot through the capability; `addService` refuses a duplicate type
name:

```ts
import { CAPABILITIES } from '@setu-ts/common';
import type { GrpcServiceDefinition, IGrpcService } from '@setu-ts/common';
import type { IKernelApplication } from '@setu-ts/kernel';

export async function addAuditService(app: IKernelApplication, definition: GrpcServiceDefinition) {
  await app.start({ port: 3000 });
  app.services.get<IGrpcService>(CAPABILITIES.GRPC).addService(definition);
}
```

- Options: `basePath` (`'/'`; RPC is claimed by path prefix, so a client's base URL must point at
  it), `reflection` and `health` (both on), `services`, `connectModule`, and `interceptors` (applied
  after the built-in handler-error logging).
- Only Connect and gRPC-Web are served. A native `application/grpc` request is refused with a
  Trailers-Only unimplemented response (`grpc-status: 12`), so `grpcurl` cannot reach this server;
  `buf curl --protocol connect` can.
- Bidi streaming needs HTTP/2, or in-process `app.fetch`. Unary, server-streaming and
  client-streaming work on every transport.
- Health reads `CAPABILITIES.HEALTH` when that plugin is registered and answers serving without it;
  a degraded aggregate counts as not serving.
- `GrpcRuntimeLoadError` means a Connect/Protobuf-ES module could not be imported;
  `GrpcDescriptorError` means a descriptor would not decode. `GrpcUnavailableError` is exported but
  never thrown since the kernel dispatches RPC itself.
