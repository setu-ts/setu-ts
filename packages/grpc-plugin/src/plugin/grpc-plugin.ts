/**
 * GrpcPlugin — registers an {@linkcode IGrpcService} under
 * `CAPABILITIES.GRPC` and installs the gRPC fetch handler on the HTTP adapter.
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
import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';
import { getFallbackConnectRuntime, loadConnectModule } from '../transports/connect-loader.ts';
import { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

/** Plugin name. */
const PLUGIN_NAME = 'grpc-plugin';

export function GrpcPlugin(options: GrpcPluginOptions = {}): IPlugin {
  let connectRuntime: ConnectRuntime;

  // If a custom connectModule is provided via options, use it directly
  if (options.connectModule) {
    connectRuntime = options.connectModule;
  } else {
    // Otherwise, load Connect lazily at registration time
    connectRuntime = getFallbackConnectRuntime(); // Will be replaced during async register
  }

  return {
    name: PLUGIN_NAME,
    version: '0.3.0',
    optionalDependencies: ['logger', CAPABILITIES.HEALTH],
    provides: [CAPABILITIES.GRPC],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      // Load the Connect runtime lazily if not already loaded
      if (connectRuntime === getFallbackConnectRuntime()) {
        connectRuntime = await loadConnectModule();
      }

      const adapter = ctx.services.get<IHttpAdapter>(CAPABILITIES.HTTP_ADAPTER);
      const canSetRpcHandler = typeof adapter.setRpcHandler === 'function';

      // Optionally resolve the health capability
      let healthService: IHealthService | undefined;
      try {
        healthService = ctx.services.get<IHealthService>(CAPABILITIES.HEALTH);
      } catch {
        // Health capability not available — the health bridge will default to SERVING
      }

      const grpcService = new GrpcService(
        connectRuntime,
        EmbeddedDescriptors,
        options,
        adapter,
        healthService,
      );

      ctx.services.register<IGrpcService>(CAPABILITIES.GRPC, grpcService);

      if (canSetRpcHandler) {
        // We already checked that setRpcHandler exists, so non-null assertion is safe
        adapter.setRpcHandler!(grpcService.createFetchHandler());
      } else {
        ctx.logger?.warn(
          'grpc-plugin: HTTP adapter does not support the RPC interceptor seam. ' +
            'gRPC services are registered but will not handle incoming requests.',
        );
      }

      ctx.health.register('grpc', () =>
        Promise.resolve({
          status: 'up' as const,
          data: {
            available: grpcService.available,
            serviceCount: grpcService.servicesCount,
          },
        }));

      // Post-stop guard: set a stopped flag when the app closes
      ctx.lifecycle.onClose(() => {
        (grpcService as unknown as { setStopped: (v: boolean) => void }).setStopped(true);
      });
    },
  };
}
