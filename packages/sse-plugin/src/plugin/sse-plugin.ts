/**
 * SsePlugin — registers an `SseService` under `CAPABILITIES.SSE`.
 *
 * @module
 * @since 0.1.0
 */

import type {
  HealthCheckResult,
  IPlugin,
  IPluginContext,
  IRealtimeBackplane,
  ISseService,
} from '@hono-enterprise/common';
// IRuntimeServices type used via ctx.runtime (non-optional property)
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { SsePluginOptions } from '../interfaces/index.ts';
import { SseService } from '../services/sse-service.ts';

/** Plugin name. */
const PLUGIN_NAME = 'sse-plugin';

/**
 * Creates the SsePlugin.
 *
 * Registers an `ISseService` under `CAPABILITIES.SSE`. Single instance only
 * (duplicate registration throws at startup via the registry).
 *
 * @example
 * ```typescript
 * import { SsePlugin } from '@hono-enterprise/sse-plugin';
 *
 * app.register(SsePlugin({ heartbeatMs: 15000 }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function SsePlugin(options?: SsePluginOptions): IPlugin {
  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    optionalDependencies: ['logger', CAPABILITIES.REALTIME_BACKPLANE],
    provides: [CAPABILITIES.SSE],
    priority: PLUGIN_PRIORITY.NORMAL,

    async register(ctx: IPluginContext): Promise<void> {
      // Resolve runtime services from the context (mirror sibling plugins).
      const runtime = ctx.runtime; // IRuntimeServices (non-optional); cast was redundant

      // Optional: absent means channels broadcast in-process only, exactly as
      // before. `optionalDependencies` orders the backplane plugin ahead of
      // this one so its transport is connected by the time we subscribe.
      const backplane = ctx.services.has(CAPABILITIES.REALTIME_BACKPLANE)
        ? ctx.services.get<IRealtimeBackplane>(CAPABILITIES.REALTIME_BACKPLANE)
        : undefined;

      // Build and register the SSE service, threading the real runtime in.
      const sseService = new SseService(options, runtime, backplane, ctx.logger);
      ctx.services.register<ISseService>(CAPABILITIES.SSE, sseService);

      // Register health indicator (§3.9).
      ctx.health.register(
        'sse',
        (): Promise<HealthCheckResult> =>
          Promise.resolve({
            status: 'up',
            data: { connections: sseService.connectionCount },
          }),
      );

      const unsubscribe = backplane === undefined
        ? undefined
        : await backplane.subscribe((frame) => {
          sseService.deliverRemoteFrame(frame);
        });

      // Register shutdown hook: close all connections and clear channels.
      ctx.lifecycle.onClose(() => {
        // Unsubscribed before closing connections so a frame arriving during
        // shutdown cannot reach a half-torn-down service. The backplane's own
        // transport is closed by the plugin that owns it.
        unsubscribe?.();
        sseService.closeAll();
      });
    },
  };
}
