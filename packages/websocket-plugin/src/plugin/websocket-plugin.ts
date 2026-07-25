/**
 * WebSocketPlugin — registers a {@linkcode WebSocketService} under
 * `CAPABILITIES.WEBSOCKET`.
 *
 * @module
 * @since 0.1.0
 */

import type {
  HealthCheckResult,
  IHttpAdapter,
  IPlugin,
  IPluginContext,
  IWebSocketService,
} from '@hono-enterprise/common';
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { WebSocketPluginOptions } from '../interfaces/index.ts';
import { resolveOptions, WebSocketService } from '../services/websocket-service.ts';

/** Plugin name. */
const PLUGIN_NAME = 'websocket-plugin';

/**
 * Creates the WebSocketPlugin.
 *
 * Registers an {@linkcode IWebSocketService} under `CAPABILITIES.WEBSOCKET`.
 * Single instance only — the kernel's plugin resolver throws at startup on a
 * duplicate name or a duplicate capability provider.
 *
 * The plugin resolves the application's {@linkcode IHttpAdapter} and installs
 * its upgrade router there. When the adapter implements no upgrade seam, the
 * service still registers (so one codebase deploys everywhere) but reports
 * `available: false` and fails `route()` with a `WebSocketUnavailableError`.
 *
 * @example
 * ```typescript
 * import { WebSocketPlugin } from '@hono-enterprise/websocket-plugin';
 * import { CAPABILITIES, type IWebSocketService } from '@hono-enterprise/common';
 *
 * app.register(WebSocketPlugin({ heartbeatMs: 30_000, idleTimeoutMs: 90_000 }));
 *
 * const ws = app.services.get<IWebSocketService>(CAPABILITIES.WEBSOCKET);
 * ws.route('/ws/chat', {
 *   onOpen: (conn) => ws.room('lobby').add(conn),
 *   onMessage: (conn, data) => ws.room('lobby').broadcast(data, { except: conn }),
 * });
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @throws {Error} If `idleTimeoutMs` is set without a `heartbeatMs` to sweep on
 * @since 0.1.0
 */
export function WebSocketPlugin(options?: WebSocketPluginOptions): IPlugin {
  // Resolved eagerly so a contradictory configuration fails at construction,
  // not at the first upgrade.
  const resolved = resolveOptions(options);

  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    optionalDependencies: ['logger'],
    provides: [CAPABILITIES.WEBSOCKET],
    priority: PLUGIN_PRIORITY.NORMAL,

    register(ctx: IPluginContext): void {
      const adapter = ctx.services.get<IHttpAdapter>(CAPABILITIES.HTTP_ADAPTER);
      const canUpgrade = typeof adapter.setUpgradeRouter === 'function';

      const service = new WebSocketService(ctx.runtime, resolved, canUpgrade);
      ctx.services.register<IWebSocketService>(CAPABILITIES.WEBSOCKET, service);

      if (canUpgrade) {
        // Installed once at registration; the router itself reads the live
        // route table, so routes added later are picked up without reinstalling.
        adapter.setUpgradeRouter?.(service.createUpgradeRouter());
      }

      ctx.health.register(
        'websocket',
        (): Promise<HealthCheckResult> =>
          Promise.resolve({
            status: 'up',
            data: {
              available: service.available,
              connections: service.connectionCount,
              rooms: service.roomCount,
              routes: service.routeCount,
            },
          }),
      );

      ctx.lifecycle.onClose(() => {
        service.closeAll();
      });
    },
  };
}
