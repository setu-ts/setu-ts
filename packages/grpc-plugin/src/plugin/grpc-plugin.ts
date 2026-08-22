/**
 * {@linkcode GrpcPlugin} — registers an {@linkcode IGrpcService} under
 * `CAPABILITIES.GRPC`. gRPC dispatch is now handled by the kernel terminal
 * handler after the middleware pipeline runs (M70a), so this plugin no longer
 * calls `adapter.setRpcHandler`.
 *
 * @module
 */

import type {
  IGrpcService,
  IHealthService,
  ILogger,
  IPlugin,
  IPluginContext,
} from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import { GrpcService } from '../services/grpc-service.ts';
import type { GrpcPluginOptions } from '../interfaces/index.ts';
import { loadConnectModule } from '../transports/connect-loader.ts';
import { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';
import denoJson from '../../deno.json' with { type: 'json' };

/** Plugin name; `PluginResolver` throws if it is registered twice. */
const PLUGIN_NAME = 'grpc-plugin';

/**
 * Creates the gRPC plugin.
 *
 * `register()` is async because the Connect runtime is loaded through a real
 * lazy `import()` (AI_GUIDELINES §12.2). The kernel now resolves `IGrpcService`
 * from the service registry and dispatches gRPC after the middleware pipeline,
 * so `adapter.setRpcHandler` is no longer called.
 *
 * @param options - See {@linkcode GrpcPluginOptions}.
 */
export function GrpcPlugin(options: GrpcPluginOptions = {}): IPlugin {
  return {
    name: PLUGIN_NAME,
    version: denoJson.version,
    optionalDependencies: ['logger', CAPABILITIES.HEALTH],
    provides: [CAPABILITIES.GRPC],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      const connectRuntime = options.connectModule ?? await loadConnectModule();

      let healthService: IHealthService | undefined;
      try {
        healthService = ctx.services.get<IHealthService>(CAPABILITIES.HEALTH);
      } catch {
        // No health plugin registered — the bridge answers SERVING.
      }

      // The logger is resolved at RPC-call time, not captured here (M52b): a
      // logger registered by a plugin that registers after gRPC is still seen,
      // and a logger that is removed is not. Guarded so a broken registry
      // degrades to "no logging" rather than a failed registration.
      const resolveLogger = (): ILogger | undefined => {
        try {
          return ctx.services.has(CAPABILITIES.LOGGER)
            ? ctx.services.get<ILogger>(CAPABILITIES.LOGGER)
            : undefined;
        } catch {
          return undefined;
        }
      };

      const grpcService = new GrpcService({
        connectRuntime,
        embeddedDescriptors: EmbeddedDescriptors,
        options,
        healthService,
        resolveLogger,
      });

      ctx.services.register<IGrpcService>(CAPABILITIES.GRPC, grpcService);

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
