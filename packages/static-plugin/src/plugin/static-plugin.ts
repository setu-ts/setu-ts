/**
 * Static file serving plugin.
 *
 * @module
 */

import type { IPlugin, IPluginContext } from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
import type { StaticPluginOptions } from '../interfaces/index.ts';
import { StaticFilesService } from '../services/static-files-service.ts';
import { createStaticHandler } from '../handler/static-handler.ts';

/**
 * Creates a StaticPlugin that serves static files from a configured root directory.
 *
 * @param options - Plugin options
 * @returns A plugin configuration
 * @since 0.1.0
 */
export function StaticPlugin(options: StaticPluginOptions): IPlugin {
  return {
    name: 'static-plugin',
    version: '0.1.0',
    provides: [CAPABILITIES.STATIC_FILES],
    register(ctx: IPluginContext): void {
      const { root, urlPrefix = '/' } = options;

      // Create the service
      const service = new StaticFilesService(options);

      // Register the service
      ctx.services.register(CAPABILITIES.STATIC_FILES, service);

      // Check if filesystem is available
      if (!ctx.runtime.fs) {
        // Workers degradation: register degraded indicator but no route
        ctx.health.register('static-files', () => ({
          status: 'degraded' as const,
          detail: 'no file system on this runtime',
        }));
        return;
      }

      // Create the handler
      const handler = createStaticHandler({
        fs: ctx.runtime.fs,
        root,
        urlPrefix,
        index: options.index ?? 'index.html',
        fallback: options.fallback,
        cacheControl: options.cacheControl,
        etag: options.etag ?? true,
        ranges: options.ranges ?? true,
        compressed: options.compressed ?? true,
        maxBufferBytes: options.maxBufferBytes ?? 1_048_576,
      });

      // Mount on both GET and HEAD
      ctx.router.get(`${urlPrefix}*`, handler);
      ctx.router.head(`${urlPrefix}*`, handler);

      // Register health indicator
      ctx.health.register('static-files', async () => {
        try {
          const stat = await ctx.runtime.fs!.stat(root);
          if (stat.isDirectory) {
            return { status: 'up' as const };
          }
          return { status: 'down' as const, detail: 'root is not a directory' };
        } catch (error) {
          return { status: 'down' as const, detail: String(error) };
        }
      });
    },
  };
}
