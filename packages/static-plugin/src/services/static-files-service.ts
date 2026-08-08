/**
 * Static files service implementation.
 *
 * @module
 */

import type { HandlerResult, IRequestContext } from '@setu-ts/common';
import type { IStaticFiles, StaticPluginOptions } from '../interfaces/index.ts';
import { createStaticHandler } from '../handler/static-handler.ts';

/**
 * Static files service that serves files from a configured root directory.
 *
 * @since 0.1.0
 */
export class StaticFilesService implements IStaticFiles {
  private readonly handler: ReturnType<typeof createStaticHandler>;

  /**
   * Creates a new StaticFilesService.
   *
   * @param options - Plugin options including the filesystem
   */
  constructor(options: StaticPluginOptions) {
    this.handler = createStaticHandler({
      fs: options.fs!,
      root: options.root,
      urlPrefix: options.urlPrefix ?? '/',
      index: options.index ?? 'index.html',
      fallback: options.fallback,
      cacheControl: options.cacheControl,
      etag: options.etag ?? true,
      ranges: options.ranges ?? true,
      compressed: options.compressed ?? true,
      maxBufferBytes: options.maxBufferBytes ?? 1_048_576,
    });
  }

  /**
   * Serves the static file addressed by the request context.
   *
   * Delegates to the same handler the plugin mounts on `GET`/`HEAD`, so this
   * entry point and the routes cannot diverge.
   *
   * @param ctx - The request context
   * @returns The handler result for the resolved file
   * @since 0.1.0
   */
  serve(ctx: IRequestContext): Promise<HandlerResult> {
    return Promise.resolve(this.handler(ctx));
  }
}
