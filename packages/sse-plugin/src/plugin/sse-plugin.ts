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
  ISseService,
} from '@hono-enterprise/common';
import type { IRuntimeServices } from '@hono-enterprise/common';
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
    optionalDependencies: ['logger'],
    provides: [CAPABILITIES.SSE],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void | Promise<void> {
      // Resolve runtime services from the context (mirror sibling plugins).
      const runtime = ctx.runtime as IRuntimeServices;

      // Build and register the SSE service, threading the real runtime in.
      const sseService = new SseService(options, runtime);
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

      // Register shutdown hook: close all connections and clear channels.
      ctx.lifecycle.onClose(() => {
        sseService.closeAll();
      });
    },
  };
}
