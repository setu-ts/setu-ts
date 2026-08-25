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
} from '@setu-ts/common';
// IRuntimeServices type used via ctx.runtime (non-optional property)
import { CAPABILITIES, PLUGIN_PRIORITY } from '@setu-ts/common';
import type { ReactRouterPluginOptions } from '../interfaces/index.ts';
import { createPublicFileHandler, createStaticAssetHandler } from '../assets/static-assets.ts';
import { SsrService } from '../services/ssr-service.ts';
import { assertSsrRuntime, loadRequestHandler } from '../handler/server-build.ts';
import denoJson from '../../deno.json' with { type: 'json' };

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
 * Derives the client-build ROOT from the configured assets dir. Vite lays out
 * hashed bundles at `<root>/assets/*` and copies `public/` into `<root>/`
 * itself, so the root holding `robots.txt` / `favicon.ico` is the assets
 * directory's PARENT. Probing `assetsDir` directly looked for
 * `./build/client/assets/robots.txt` and missed every public file.
 *
 * Returns `undefined` when the parent cannot be named WITHOUT widening the
 * served root far past the build directory. Three derivations are refused
 * rather than used, because each one hands the public-file handler a root that
 * contains the whole application rather than the build output:
 *
 * - no separator (`'assets'`) — the input names no parent at all;
 * - `''` (from `'/assets'`) — the filesystem root;
 * - a parent built only from `.` / `..` segments (`'.'` from `'./assets'`,
 *   `'..'` from `'../assets'`) — the process working directory or a directory
 *   ABOVE it, so every readable file beside the server, `.env` included,
 *   becomes one unauthenticated GET away.
 *
 * The containment guard cannot catch these: the derived root legitimately
 * CONTAINS those files, so containment holds while the root itself is wrong.
 * A caller wanting a build root at one of those locations names it with a
 * deeper `assetsDir` (`'./build/client/assets'`).
 *
 * @param assetsDir - The configured assets directory (`<root>/assets`)
 * @returns The client-build root directory (`<root>`), or `undefined` when it
 * cannot be derived without widening the root
 * @since 0.2.0
 */
function clientBuildRoot(assetsDir: string): string | undefined {
  const trimmed = assetsDir.replace(/\/+$/, '');
  const lastSlash = trimmed.lastIndexOf('/');
  if (lastSlash === -1) {
    return undefined;
  }
  const parent = trimmed.slice(0, lastSlash);
  if (parent === '') {
    return undefined;
  }
  // Every segment being `.`/`..` means the parent names the working directory
  // or one above it, never a build output directory.
  const onlyDotSegments = parent.split('/').every((seg) => seg === '.' || seg === '..');
  return onlyDotSegments ? undefined : parent;
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
 * import { ReactRouterPlugin } from '@setu-ts/react-router-plugin';
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
    version: denoJson.version,
    optionalDependencies: ['runtime'],
    provides: [CAPABILITIES.SSR],
    priority: PLUGIN_PRIORITY.NORMAL,

    // Async register — awaited by the kernel (IPlugin.register returns void | Promise<void>).
    async register(ctx: IPluginContext): Promise<void> {
      const runtime = ctx.runtime;

      // Resolve the RR handler and its context-provider factory via the
      // injectable seam. Both come from one `react-router` module object.
      const mode = options.mode ?? DEFAULT_MODE;
      const getLoadRequestHandler = options.loadRequestHandler ??
        loadRequestHandler;
      // Validated at registration: a seam returning the pre-0.2.0 bare handler
      // would otherwise register cleanly and 500 on every request instead.
      const { handler, createLoadContext } = assertSsrRuntime(
        await getLoadRequestHandler(options.serverBuildPath, mode),
      );

      // Build and register the SSR service.
      const ssrService = new SsrService(
        handler,
        createLoadContext,
        options.populateLoadContext,
      );
      ctx.services.register<ISsrService>(CAPABILITIES.SSR, ssrService);

      // Register the SSR catch-all route for all 7 verbs. The route handler is
      // built once (hoisted) and captures the service — no per-request lookup.
      const basename = options.basename ?? DEFAULT_BASENAME;
      const catchAllPattern = joinWildcard(basename);
      const renderRoute: RouteHandler = (routeCtx) => ssrService.render(routeCtx);

      // M70n X5-5: Vite copies `public/` into the client-build ROOT — the
      // PARENT of the assets dir — outside `assetUrlPrefix`, so `/robots.txt`
      // and `/favicon.ico` would otherwise reach this SSR catch-all and answer
      // an HTML-shaped miss under a 200-shaped page. When enabled, a GET
      // naming an existing build-root file is served with `must-revalidate`
      // caching (those files are not content-hashed); every miss falls through
      // to SSR unchanged.
      let getRoute = renderRoute;
      if (
        options.publicFiles !== false && options.assetsDir != null &&
        runtime.fs != null
      ) {
        // Probe the client-build ROOT, not the assets subdir — `public/`
        // copies land beside `assets/`, not inside them. A root that cannot be
        // derived without widening past the build directory is REFUSED: the
        // handler is not registered and the reason is named, because silently
        // serving the working directory is worse than not serving
        // `/robots.txt`.
        const publicRoot = clientBuildRoot(options.assetsDir);
        if (publicRoot === undefined) {
          ctx.logger?.warn(
            'react-router: publicFiles is on but the client-build root cannot be derived from ' +
              'assetsDir without widening the served root to the working directory or the ' +
              'filesystem root; public files are NOT served',
            {
              assetsDir: options.assetsDir,
              hint:
                "Point assetsDir at the assets directory INSIDE the build output (e.g. './build/" +
                "client/assets'), or set publicFiles: false to silence this.",
            },
          );
        } else {
          const servePublicFile = createPublicFileHandler({
            fs: runtime.fs,
            assetsDir: publicRoot,
          });
          getRoute = async (routeCtx) => (await servePublicFile(routeCtx)) ?? renderRoute(routeCtx);
        }
      }

      for (const verb of ALL_VERBS) {
        switch (verb) {
          case 'GET':
            ctx.router.get(catchAllPattern, getRoute);
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
