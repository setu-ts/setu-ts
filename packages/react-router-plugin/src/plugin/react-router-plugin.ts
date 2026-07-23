/**
 * ReactRouterPlugin — registers an `ISsrService` under `CAPABILITIES.SSR`.
 *
 * @module
 * @since 0.1.0
 */

import type {
  HealthCheckResult,
  IPlugin,
  IPluginContext,
  ISsrService,
  RouteHandler,
} from '@hono-enterprise/common';
// IRuntimeServices type used via ctx.runtime (non-optional property)
import { CAPABILITIES, PLUGIN_PRIORITY } from '@hono-enterprise/common';
import type { ReactRouterPluginOptions } from '../interfaces/index.ts';
import { createStaticAssetHandler } from '../assets/static-assets.ts';
import { SsrService } from '../services/ssr-service.ts';
import { loadRequestHandler } from '../handler/server-build.ts';

/** Plugin name. */
const PLUGIN_NAME = 'react-router-plugin';

/** Default asset URL prefix. */
const DEFAULT_ASSET_URL_PREFIX = '/assets/';

/** Default basename. */
const DEFAULT_BASENAME = '/';

/** Default mode. */
const DEFAULT_MODE = 'production';

/** All HTTP verbs for the catch-all. */
const ALL_VERBS = [
  'GET',
  'POST',
  'PUT',
  'PATCH',
  'DELETE',
  'HEAD',
  'OPTIONS',
] as const;

/**
 * Joins a prefix with `/*`, handling trailing slashes safely.
 *
 * `'/'` → `'/*'`, `'/app/'` → `'/app/*'`, `'/app'` → `'/app/*'`.
 *
 * @param prefix - The path prefix
 * @returns The wildcard-joined pattern
 * @since 0.1.0
 */
function joinWildcard(prefix: string): string {
  return `${prefix.replace(/\/+$/, '')}/*`;
}

/**
 * Creates the ReactRouterPlugin.
 *
 * Registers an `ISsrService` under `CAPABILITIES.SSR`, mounts a catch-all
 * route (all 7 HTTP verbs) for SSR, optionally registers a static-asset route,
 * and registers a `react-router` health indicator.
 *
 * @example
 * ```typescript
 * import { ReactRouterPlugin } from '@hono-enterprise/react-router-plugin';
 *
 * app.register(ReactRouterPlugin({
 *   serverBuildPath: './build/server/index.js',
 *   assetsDir: './build/client/assets',
 * }));
 * ```
 * @param options - Plugin configuration
 * @returns The plugin instance
 * @since 0.1.0
 */
export function ReactRouterPlugin(options: ReactRouterPluginOptions): IPlugin {
  return {
    name: PLUGIN_NAME,
    version: '0.1.0',
    optionalDependencies: ['runtime'],
    provides: [CAPABILITIES.SSR],
    priority: PLUGIN_PRIORITY.NORMAL,

    // Async register — awaited by the kernel (IPlugin.register returns void | Promise<void>).
    async register(ctx: IPluginContext): Promise<void> {
      const runtime = ctx.runtime;

      // Resolve the RR handler via the injectable seam.
      const mode = options.mode ?? DEFAULT_MODE;
      const getLoadRequestHandler = options.loadRequestHandler ??
        loadRequestHandler;
      const handler = await getLoadRequestHandler(
        options.serverBuildPath,
        mode,
      );

      // Build and register the SSR service.
      const ssrService = new SsrService(handler, options.getLoadContext);
      ctx.services.register<ISsrService>(CAPABILITIES.SSR, ssrService);

      // Register the SSR catch-all route for all 7 verbs. The route handler is
      // built once (hoisted) and captures the service — no per-request lookup.
      const basename = options.basename ?? DEFAULT_BASENAME;
      const catchAllPattern = joinWildcard(basename);
      const renderRoute: RouteHandler = (routeCtx) => ssrService.render(routeCtx);

      for (const verb of ALL_VERBS) {
        switch (verb) {
          case 'GET':
            ctx.router.get(catchAllPattern, renderRoute);
            break;
          case 'POST':
            ctx.router.post(catchAllPattern, renderRoute);
            break;
          case 'PUT':
            ctx.router.put(catchAllPattern, renderRoute);
            break;
          case 'PATCH':
            ctx.router.patch(catchAllPattern, renderRoute);
            break;
          case 'DELETE':
            ctx.router.delete(catchAllPattern, renderRoute);
            break;
          case 'HEAD':
            ctx.router.head(catchAllPattern, renderRoute);
            break;
          case 'OPTIONS':
            ctx.router.options(catchAllPattern, renderRoute);
            break;
        }
      }

      // Register static-asset route (only when assetsDir is provided).
      if (options.assetsDir != null) {
        const assetUrlPrefix = options.assetUrlPrefix ??
          DEFAULT_ASSET_URL_PREFIX;

        if (runtime.fs != null) {
          const assetRoutePattern = joinWildcard(assetUrlPrefix);
          const assetHandler = createStaticAssetHandler({
            fs: runtime.fs,
            assetsDir: options.assetsDir,
            assetUrlPrefix,
          });
          ctx.router.get(assetRoutePattern, assetHandler);
        }
        // When runtime.fs is absent, no asset route is registered (404-degrade on edge).
      }

      // Register health indicator (§3.8).
      ctx.health.register(
        'react-router',
        (): Promise<HealthCheckResult> =>
          Promise.resolve({
            status: 'up',
            data: {
              mode,
              serverBuildPath: options.serverBuildPath,
            },
          }),
      );

      // NO onClose hook — the handler is stateless (no socket, pool, timer, or subscription).
    },
  };
}
