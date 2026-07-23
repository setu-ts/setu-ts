/**
 * React Router plugin configuration options and type definitions.
 *
 * @module
 * @since 0.1.0
 */

import type { IRequestContext } from '@hono-enterprise/common';
export type { IRequestContext } from '@hono-enterprise/common';

/**
 * React Router request handler — the callable returned by
 * `createRequestHandler(build, mode)`.
 *
 * @since 0.1.0
 */
export type SsrRequestHandler = (
  request: Request,
  loadContext: unknown,
) => Promise<Response>;

/**
 * Function signature for building the React Router `loadContext` from the
 * kernel request context. The default exposes `services` and `user`; an
 * override replaces it wholesale.
 *
 * @since 0.1.0
 */
export type LoadContextFunction = (
  ctx: IRequestContext,
) => Record<string, unknown>;

/**
 * Options for the React Router plugin.
 *
 * @since 0.1.0
 */
export interface ReactRouterPluginOptions {
  /**
   * Path to the React Router Vite server build (default export = `ServerBuild`).
   * @since 0.1.0
   */
  readonly serverBuildPath: string;

  /**
   * Injectable seam for lazy loading the RR handler. When omitted, the default
   * performs `await import(serverBuildPath)` + `await import('npm:react-router@7')`.
   * @since 0.1.0
   */
  readonly loadRequestHandler?: (
    serverBuildPath: string,
    mode: string,
  ) => Promise<SsrRequestHandler>;

  /**
   * Filesystem root of the built client bundle. Omit to disable static-asset
   * serving (no asset route registered).
   * @since 0.1.0
   */
  readonly assetsDir?: string;

  /**
   * URL prefix for the static-asset route. Default `/assets/`.
   * @since 0.1.0
   */
  readonly assetUrlPrefix?: string;

  /**
   * Mount prefix for the SSR catch-all route. Default `/`.
   * MUST match the app's `react-router.config.ts` `basename` for flat/nested
   * routes to resolve.
   * @since 0.1.0
   */
  readonly basename?: string;

  /**
   * Override the default `loadContext` bridge ({ services, user }).
   * @since 0.1.0
   */
  readonly getLoadContext?: LoadContextFunction;

  /**
   * Mode passed to `createRequestHandler(build, mode)`.
   * @since 0.1.0
   */
  readonly mode?: 'production' | 'development';
}
