/**
 * @module
 *
 * gRPC plugin for Setu-TS — enables co-serving of Connect and gRPC-Web
 * protocols (native `application/grpc` is refused with a Trailers-Only
 * `UNIMPLEMENTED`) on the same port as ordinary Hono routes. The plugin
 * registers an {@linkcode IGrpcService} under `CAPABILITIES.GRPC`; since M70a
 * the kernel dispatches RPC from its terminal handler after the middleware
 * pipeline, so no HTTP-adapter interceptor is involved.
 *
 * @example
 * ```typescript
 * import { createApplication } from '@setu-ts/kernel';
 * import { RuntimePlugin } from '@setu-ts/runtime';
 * import { GrpcPlugin } from '@setu-ts/grpc-plugin';
 * import { CAPABILITIES, type IGrpcService } from '@setu-ts/common';
 *
 * const app = createApplication({
 *   plugins: [RuntimePlugin(), GrpcPlugin()],
 * });
 *
 * await app.start({ port: 3000 });
 *
 * // The plugin registers CAPABILITIES.GRPC during start(), so resolve it
 * // only AFTER start() resolves — before that, the capability does not exist.
 * const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
 * ```
 */

// Re-export the plugin factory
export { GrpcPlugin } from './plugin/grpc-plugin.ts';

// Re-export the service class
export { GrpcService } from './services/grpc-service.ts';

// Re-export errors
export {
  GrpcDescriptorError,
  GrpcRuntimeLoadError,
  GrpcUnavailableError,
} from './errors/grpc-errors.ts';

/**
 * The pure adapter over already-imported Connect/Protobuf-ES modules. Exported
 * so an application that already bundles Connect can hand the modules in via
 * {@linkcode GrpcPluginOptions.connectModule} instead of paying for the lazy
 * `import()`.
 */
export { adaptConnectModule } from './transports/connect-loader.ts';
export type { ConnectModuleLike } from './transports/connect-loader.ts';

// Re-export options type
export type { GrpcPluginOptions } from './interfaces/index.ts';

// Re-export common contracts for convenience
export type {
  GrpcServiceDefinition,
  GrpcServingStatus,
  IGrpcService,
  RpcFetchHandler,
} from '@setu-ts/common';
export { CAPABILITIES } from '@setu-ts/common';

// `ConnectRuntime` and the structural Connect facades are deliberately NOT
// exported: they are an internal port (plan §3.2), and publishing them would
// commit the plugin to a shape that tracks Connect's own API.
