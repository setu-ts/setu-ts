import * as protobuf from '@bufbuild/protobuf';
import * as wkt from '@bufbuild/protobuf/wkt';
import * as connect from '@connectrpc/connect';
import * as protocol from '@connectrpc/connect/protocol';
import { createConnectTransport } from '@connectrpc/connect-web';
import { adaptConnectModule, GrpcPlugin } from '@setu-ts/grpc-plugin';
import type { ConnectModuleLike, GrpcServiceDefinition } from '@setu-ts/grpc-plugin';
import { createApplication } from '@setu-ts/kernel';
import type { IKernelApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
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

interface EchoClient {
  echo(
    request: { readonly message: string },
  ): Promise<{ readonly response: string }>;
}

/** Creates a Connect client for the descriptor-backed Echo service. */
export function createEchoClient(baseUrl: string): EchoClient {
  const client = connect.createClient(
    echoService as unknown as protobuf.DescService,
    createConnectTransport({ baseUrl }),
  );
  return client as unknown as EchoClient;
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
            echo: (request: { message: string }) => ({
              response: `echo: ${request.message}`,
            }),
            ping: () => ({ pong: true }),
          },
        }],
      }),
    ],
  });
  app.router.get('/health', (ctx) => ctx.response.json({ status: 'ok' }));
  return app;
}
