/**
 * @module
 *
 * React Router v7 plugin — embeds React Router framework mode as a first-party
 * plugin so a Setu-TS application can serve a React frontend with SSR
 * and file-based routing.
 *
 * @example
 * ```typescript
 * import { ReactRouterPlugin } from '@setu-ts/react-router-plugin';
 * import { CAPABILITIES, ISsrService } from '@setu-ts/common';
 *
 * const app = createApplication();
 * app.register(ReactRouterPlugin({
 *   serverBuildPath: './build/server/index.js',
 *   assetsDir: './build/client/assets',
 * }));
 * await app.start({ port: 3000 });
 * ```
 * @since 0.1.0
 */

export { ReactRouterPlugin } from './plugin/react-router-plugin.ts';
export { SsrService } from './services/ssr-service.ts';
export { createPublicFileHandler, createStaticAssetHandler } from './assets/static-assets.ts';
export {
  assembleHandler,
  assertSsrRuntime,
  createLoadContextFactory,
  loadRequestHandler,
} from './handler/server-build.ts';
export { bridgeRequestToRR } from './handler/request-bridge.ts';
export { contextKeyFor, servicesContext, userContext } from './handler/context-keys.ts';
export type {
  PopulateLoadContext,
  ReactRouterPluginOptions,
  RouterContextKey,
  RouterLoadContext,
  SsrRequestHandler,
  SsrRuntime,
} from './interfaces/index.ts';

// Re-export common contracts for convenience — and so the exported handlers'
// signatures (`IFileSystem`, `RouteHandler`, `IRequestContext`, `HandlerResult`)
// name types this package itself exports, keeping `deno doc --lint` clean.
export type {
  HandlerResult,
  IFileSystem,
  IRequestContext,
  ISsrService,
  RouteHandler,
} from '@setu-ts/common';
export { CAPABILITIES } from '@setu-ts/common';
