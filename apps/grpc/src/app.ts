import * as protobuf from '@bufbuild/protobuf';
import * as wkt from '@bufbuild/protobuf/wkt';
import * as connect from '@connectrpc/connect';
import * as protocol from '@connectrpc/connect/protocol';
import { adaptConnectModule, GrpcPlugin } from '@hono-enterprise/grpc-plugin';
import type { ConnectModuleLike, GrpcServiceDefinition } from '@hono-enterprise/grpc-plugin';
import { createApplication } from '@hono-enterprise/kernel';
import type { IKernelApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { ECHO_DESCRIPTOR_BASE64 } from './descriptor.ts';

const runtime = adaptConnectModule({
  connect,
  // Connect's concrete handler function is intentionally narrower than the
  // plugin's structural input port, but it implements the same runtime seam.
  protocol: protocol as unknown as ConnectModuleLike['protocol'],
  protobuf,
  wkt,
});
const registry = runtime.reviveDescriptorSet(ECHO_DESCRIPTOR_BASE64);
const echoService = runtime.getService(registry, 'example.EchoService');

if (echoService === undefined) {
  throw new Error('The embedded EchoService descriptor is invalid.');
}

/** Builds a shared-port HTTP and Connect server with a real descriptor-backed Echo service. */
export function createGrpcApp(): IKernelApplication {
  const app = createApplication({
    plugins: [
      RuntimePlugin(),
      GrpcPlugin({
        connectModule: runtime,
        services: [{
          definition: echoService as GrpcServiceDefinition,
          implementation: {
            echo: (request: { message: string }) => ({ response: `echo: ${request.message}` }),
            ping: () => ({ pong: true }),
          },
        }],
      }),
    ],
  });
  app.router.get('/health', (ctx) => ctx.response.json({ status: 'ok' }));
  return app;
}
