/**
 * @module
 *
 * gRPC plugin for Hono Enterprise — enables co-serving of gRPC, Connect, and
 * gRPC-Web protocols on the same port as ordinary Hono routes. The plugin
 * registers an {@linkcode IGrpcService} under `CAPABILITIES.GRPC` and installs
 * a fetch handler into the HTTP adapter's RPC interceptor seam.
 *
 * @example
 * ```typescript
 * import { createApplication } from '@hono-enterprise/kernel';
 * import { RuntimePlugin } from '@hono-enterprise/runtime';
 * import { GrpcPlugin } from '@hono-enterprise/grpc-plugin';
 * import { CAPABILITIES, type IGrpcService } from '@hono-enterprise/common';
 *
 * const app = createApplication({
 *   plugins: [RuntimePlugin(), GrpcPlugin()],
 * });
 *
 * const grpc = app.services.get<IGrpcService>(CAPABILITIES.GRPC);
 * // Add service definitions and implementations here...
 *
 * await app.start({ port: 3000 });
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
} from '@hono-enterprise/common';
export { CAPABILITIES } from '@hono-enterprise/common';

// `ConnectRuntime` and the structural Connect facades are deliberately NOT
// exported: they are an internal port (plan §3.2), and publishing them would
// commit the plugin to a shape that tracks Connect's own API.
