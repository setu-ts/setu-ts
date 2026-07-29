/**
 * RealtimeBackplanePlugin — registers an `IRealtimeBackplane` under
 * `CAPABILITIES.REALTIME_BACKPLANE`.
 *
 * @module
 * @since 0.2.0
 */

import type {
  HealthCheckResult,
  IPlugin,
  IPluginContext,
  IRealtimeBackplane,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { RealtimeBackplanePluginOptions } from '../interfaces/index.ts';
import { createBackplane } from '../transports/backplane-factory.ts';

/** Plugin name — matches the package name without the scope. */
const PLUGIN_NAME = 'realtime-backplane-plugin';

/**
 * Creates the RealtimeBackplanePlugin.
 *
 * Registers a transport under `CAPABILITIES.REALTIME_BACKPLANE`, which the
 * WebSocket and SSE plugins resolve **optionally** — so adding this plugin is
 * what turns their in-process rooms and channels into cluster-wide ones, and
 * removing it returns them to in-process behavior with no code change.
 *
 * Its priority is above normal so the transport is connected before the
 * consumers register and subscribe.
 *
 * @example
 * ```typescript
 * import { RealtimeBackplanePlugin } from '@hono-enterprise/realtime-backplane-plugin';
 *
 * app.register(RealtimeBackplanePlugin({
 *   transport: 'redis',
 *   url: 'redis://localhost:6379',
 * }));
 * app.register(WebSocketPlugin());
 * ```
 * @param options - Transport configuration; defaults to the in-process
 * `'memory'` transport
 * @returns The plugin instance
 * @since 0.2.0
 */
export function RealtimeBackplanePlugin(
  options: RealtimeBackplanePluginOptions = { transport: 'memory' },
): IPlugin {
  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    provides: [CAPABILITIES.REALTIME_BACKPLANE],
    // Resolved by the messaging arm; absent for every other transport.
    optionalDependencies: [CAPABILITIES.MESSAGING],
    priority: PLUGIN_PRIORITY.HIGH,

    async register(ctx: IPluginContext): Promise<void> {
      const backplane = createBackplane(options, ctx.services, ctx.runtime.uuid());

      // Awaited, so the subscription is live before the first request and
      // before either consumer plugin registers its handler.
      await backplane.connect();

      ctx.services.register<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE, backplane);

      ctx.health.register(
        'realtime-backplane',
        (): Promise<HealthCheckResult> =>
          Promise.resolve({
            status: 'up',
            data: {
              transport: options.transport ?? 'memory',
              origin: backplane.origin,
            },
          }),
      );

      ctx.lifecycle.onClose(async () => {
        await backplane.close();
      });
    },
  };
}
