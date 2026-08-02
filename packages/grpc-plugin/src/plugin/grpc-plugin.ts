/**
 * {@linkcode GrpcPlugin} — registers an {@linkcode IGrpcService} under
 * `CAPABILITIES.GRPC` and installs the gRPC fetch handler into the HTTP
 * adapter's RPC interceptor seam.
 *
 * @module
 */

import type {
  IGrpcService,
  IHealthService,
  IHttpAdapter,
  IPlugin,
  IPluginContext,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import { GrpcService } from '../services/grpc-service.ts';
import type { GrpcPluginOptions } from '../interfaces/index.ts';
import { loadConnectModule } from '../transports/connect-loader.ts';
import { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

/** Plugin name; `PluginResolver` throws if it is registered twice. */
const PLUGIN_NAME = 'grpc-plugin';

/**
 * Creates the gRPC plugin.
 *
 * `register()` is async because the Connect runtime is loaded through a real
 * lazy `import()` (AI_GUIDELINES §12.2). When the resolved HTTP adapter
 * predates the `setRpcHandler?` widening the plugin still registers, the health
 * indicator reports `available: false`, and a warning is logged — an
 * application does not fail to start because of it.
 *
 * @param options - See {@linkcode GrpcPluginOptions}.
 */
export function GrpcPlugin(options: GrpcPluginOptions = {}): IPlugin {
  return {
    name: PLUGIN_NAME,
    version: '0.1.0-alpha.3',
    optionalDependencies: ['logger', CAPABILITIES.HEALTH],
    provides: [CAPABILITIES.GRPC],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      const connectRuntime = options.connectModule ?? await loadConnectModule();

      const adapter = ctx.services.get<IHttpAdapter>(CAPABILITIES.HTTP_ADAPTER);

      let healthService: IHealthService | undefined;
      try {
        healthService = ctx.services.get<IHealthService>(CAPABILITIES.HEALTH);
      } catch {
        // No health plugin registered — the bridge answers SERVING.
      }

      const grpcService = new GrpcService({
        connectRuntime,
        embeddedDescriptors: EmbeddedDescriptors,
        options,
        adapter,
        healthService,
      });

      ctx.services.register<IGrpcService>(CAPABILITIES.GRPC, grpcService);

      if (grpcService.available) {
        // Guarded by `available`, which is exactly this typeof check.
        adapter.setRpcHandler?.(grpcService.createFetchHandler());
      } else {
        ctx.logger?.warn(
          'grpc-plugin: the HTTP adapter does not implement setRpcHandler, so gRPC ' +
            'requests will not be served. Services are still registered and ' +
            'handleRequest() throws GrpcUnavailableError.',
        );
      }

      ctx.health.register('grpc', () =>
        Promise.resolve({
          status: 'up' as const,
          data: {
            available: grpcService.available,
            serviceCount: grpcService.serviceCount,
          },
        }));

      ctx.lifecycle.onClose(() => {
        grpcService.close();
      });
    },
  };
}
