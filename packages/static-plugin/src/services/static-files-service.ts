/**
 * Static files service implementation.
 *
 * @module
 */

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
   * @param options - Plugin options
   */
  constructor(options: StaticPluginOptions) {
    this.handler = createStaticHandler({
      fs: {} as never,
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
   * Serves a static file at the given path.
   *
   * @param ctx - The request context
   * @returns A HandlerResult with the file response or error
   */
  serve(ctx: unknown): Promise<unknown> {
    return this.handler(ctx as Parameters<typeof this.handler>[0]) as Promise<unknown>;
  }
}
