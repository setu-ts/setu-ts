/**
 * @module
 *
 * React Router v7 plugin — embeds React Router framework mode as a first-party
 * plugin so a Hono Enterprise application can serve a React frontend with SSR
 * and file-based routing.
 *
 * @example
 * ```typescript
 * import { ReactRouterPlugin } from '@hono-enterprise/react-router-plugin';
 * import { CAPABILITIES, ISsrService } from '@hono-enterprise/common';
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
export { createStaticAssetHandler } from './assets/static-assets.ts';
export { assembleHandler, loadRequestHandler } from './handler/server-build.ts';
export { bridgeRequestToRR } from './handler/request-bridge.ts';
export type {
  LoadContextFunction,
  ReactRouterPluginOptions,
  SsrRequestHandler,
} from './interfaces/index.ts';

// Re-export common SSR contract for convenience.
export type { ISsrService } from '@hono-enterprise/common';
export { CAPABILITIES } from '@hono-enterprise/common';
