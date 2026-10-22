import * as protobuf from '@bufbuild/protobuf';
import * as wkt from '@bufbuild/protobuf/wkt';
import * as connect from '@connectrpc/connect';
import * as protocol from '@connectrpc/connect/protocol';
import { adaptConnectModule } from '@setu-ts/grpc-plugin';
import type {
  ConnectModuleLike,
  GrpcPluginOptions,
  GrpcServiceDefinition,
} from '@setu-ts/grpc-plugin';
import { ECHO_DESCRIPTOR_BASE64 } from './echo.descriptor.ts';

/** The Connect runtime the plugin serves through, assembled from the installed packages. */
export const connectModule = adaptConnectModule({
  connect,
  // Connect's concrete handler type is narrower than the plugin's structural port,
  // but it implements the same runtime seam.
  protocol: protocol as unknown as ConnectModuleLike['protocol'],
  protobuf,
  wkt,
});

const descriptors = connectModule.reviveDescriptorSet(ECHO_DESCRIPTOR_BASE64);
const echoService = connectModule.getService(descriptors, 'example.EchoService');
if (echoService === undefined) {
  throw new Error('The embedded descriptor set declares no example.EchoService.');
}

/** The `example.EchoService` descriptor, shared by the server and the client. */
export const ECHO_SERVICE: GrpcServiceDefinition = echoService as GrpcServiceDefinition;

type GrpcServiceRegistration = NonNullable<GrpcPluginOptions['services']>[number];

/** The server-side implementation of `example.EchoService`. */
export const echoServiceRegistration: GrpcServiceRegistration = {
  definition: ECHO_SERVICE,
  implementation: {
    echo: (request: { message: string }) => ({ response: `echo: ${request.message}` }),
    ping: () => ({ pong: true }),
  },
};
