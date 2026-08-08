/**
 * @module
 *
 * Static file serving plugin for the Setu-TS framework.
 *
 * Provides configurable static file serving with support for:
 * - Conditional requests (ETag, If-None-Match, If-Modified-Since)
 * - Range requests (partial content)
 * - Precompressed sidecar negotiation (.br, .gz)
 * - Directory index resolution
 * - SPA fallback
 * - Streaming for large files
 *
 * @example
 * ```typescript
 * import { StaticPlugin } from '@setu-ts/static-plugin';
 *
 * app.register(StaticPlugin({
 *   root: './public',
 *   urlPrefix: '/assets',
 * }));
 * ```
 *
 * @since 0.1.0
 */

export { StaticPlugin } from './plugin/static-plugin.ts';
export { StaticFilesService } from './services/static-files-service.ts';
export { createStaticHandler } from './handler/static-handler.ts';
export type { IStaticFiles, StaticPluginOptions } from './interfaces/index.ts';
