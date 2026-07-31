/**
 * GrpcPlugin — registers an {@linkcode IGrpcService} under
 * `CAPABILITIES.GRPC` and installs the gRPC fetch handler on the HTTP adapter.
 *
 * @module
 */

import type {
  IHttpAdapter,
  IPlugin,
  IPluginContext,
  IGrpcService,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import { GrpcService } from '../services/grpc-service.ts';
import type { GrpcPluginOptions } from '../interfaces/index.ts';
import type { ConnectRuntime } from '../interfaces/connect-runtime.ts';
import { getFallbackConnectRuntime } from '../transports/connect-loader.ts';
import { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';

/** Plugin name. */
const PLUGIN_NAME = 'grpc-plugin';

export function GrpcPlugin(options: GrpcPluginOptions = {}): IPlugin {
  let connectRuntime: ConnectRuntime;
  if (options.connectModule) {
    connectRuntime = options.connectModule;
  } else {
    connectRuntime = getFallbackConnectRuntime();
  }

  return {
    name: PLUGIN_NAME,
    version: '0.3.0',
    optionalDependencies: ['logger', CAPABILITIES.HEALTH],
    provides: [CAPABILITIES.GRPC],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      const adapter = ctx.services.get<IHttpAdapter>(CAPABILITIES.HTTP_ADAPTER);
      const canSetRpcHandler = typeof adapter.setRpcHandler === 'function';

      const grpcService = new GrpcService(
        connectRuntime,
        EmbeddedDescriptors,
        options,
        adapter,
        canSetRpcHandler,
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

      ctx.health.register('grpc', async (): Promise<{ status: 'up'; data: any }> => ({
        status: 'up',
        data: {
          available: grpcService.available,
          serviceCount: grpcService['services'].length,
        },
      }));

      ctx.lifecycle.onClose(() => {
        (grpcService as any).dispatchMap = null;
      });
    },
  };
}