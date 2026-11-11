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
  IRuntimeServices,
  IServiceDiscovery,
  ITelemetryService,
} from '@setu-ts/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import { GrpcService } from '../services/grpc-service.ts';
import type { GrpcPluginOptions } from '../interfaces/index.ts';
import { loadConnectModule } from '../transports/connect-loader.ts';
import { GrpcClients, validateClientOptions } from '../client/grpc-client.ts';
import { loadConnectNode } from '../client/connect-node-loader.ts';
import { EmbeddedDescriptors } from '../descriptors/embedded-descriptors.ts';
import { VERSION } from '../version.ts';

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
  const readMaxBytes = options.readMaxBytes;
  // Connect's own range. Checked here so a misconfiguration fails at startup
  // rather than on the first request (Connect validates lazily).
  if (
    readMaxBytes !== undefined &&
    (!Number.isInteger(readMaxBytes) || readMaxBytes < 1 || readMaxBytes > 0xffffffff)
  ) {
    throw new TypeError(
      `GrpcPlugin: readMaxBytes must be an integer from 1 to 4294967295, received ${String(readMaxBytes)}`,
    );
  }
  if (options.serve !== undefined && typeof options.serve !== 'boolean') {
    throw new TypeError(`GrpcPlugin: serve must be a boolean, received ${String(options.serve)}`);
  }
  if (options.serve === false && (options.services?.length ?? 0) > 0) {
    throw new TypeError('GrpcPlugin: serve: false serves nothing, so services must be empty');
  }
  for (const [target, clientOptions] of Object.entries(options.clients ?? {})) {
    validateClientOptions(clientOptions, `GrpcPlugin: clients[${JSON.stringify(target)}]`);
  }
  return {
    name: PLUGIN_NAME,
    version: VERSION,
    optionalDependencies: [
      'logger',
      CAPABILITIES.HEALTH,
      CAPABILITIES.SERVICE_DISCOVERY,
      CAPABILITIES.TELEMETRY,
    ],
    provides: [CAPABILITIES.GRPC],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      const connectRuntime = options.connectModule ?? (await loadConnectModule());

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

      // Resolved per call, as the logger is: a capability registered later is
      // still seen, and a broken registry degrades to "none" (§3.12).
      const optional = <T extends object>(token: string): T | undefined => {
        try {
          return ctx.services.has(token) ? ctx.services.get<T>(token) : undefined;
        } catch {
          return undefined;
        }
      };
      const clients = new GrpcClients({
        runtime: connectRuntime,
        loadNode: () => loadConnectNode(),
        discovery: () => optional<IServiceDiscovery>(CAPABILITIES.SERVICE_DISCOVERY),
        telemetry: () => optional<ITelemetryService>(CAPABILITIES.TELEMETRY),
        platform: () => optional<IRuntimeServices>(CAPABILITIES.RUNTIME)?.platform(),
        clock: () =>
          optional<IRuntimeServices>(CAPABILITIES.RUNTIME)?.hrtime() ?? performance.now(),
        targets: options.clients ?? {},
        ...(readMaxBytes === undefined ? {} : { readMaxBytes }),
      });

      const grpcService = new GrpcService({
        connectRuntime,
        embeddedDescriptors: EmbeddedDescriptors,
        options,
        healthService,
        resolveLogger,
        clients,
      });

      ctx.services.register<IGrpcService>(CAPABILITIES.GRPC, grpcService);

      ctx.health.register('grpc', () =>
        Promise.resolve({
          status: 'up' as const,
          data: {
            available: grpcService.available,
            serviceCount: grpcService.serviceCount,
          },
        }),
      );

      ctx.lifecycle.onClose(() => {
        grpcService.close();
      });
    },
  };
}
