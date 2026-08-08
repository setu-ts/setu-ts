/**
 * Static file serving plugin interfaces.
 *
 * @module
 */

import type { HandlerResult, IFileSystem, IRequestContext } from '@setu-ts/common';

/**
 * Options for configuring the StaticPlugin.
 *
 * @since 0.1.0
 */
export type StaticPluginOptions = {
  /**
   * Required. The filesystem directory to serve files from.
   */
  root: string;

  /**
   * The filesystem to use for file operations.
   */
  fs?: IFileSystem;

  /**
   * URL prefix for static routes (default: '/').
   */
  urlPrefix?: string;

  /**
   * Index file to serve when a directory is requested (default: 'index.html').
   * Set to empty string '' to disable index resolution.
   */
  index?: string;

  /**
   * Fallback file to serve for missing paths when Accept includes text/html (default: undefined).
   * Used for SPA fallback.
   */
  fallback?: string;

  /**
   * Cache-Control header configuration (default: function returning immutable for hashed assets, must-revalidate for others).
   * - A string is used verbatim for all responses.
   * - A function is called per request with the root-relative path.
   */
  cacheControl?: string | ((relativePath: string) => string);

  /**
   * Enable ETag generation (default: true).
   */
  etag?: boolean;

  /**
   * Enable Range request handling (default: true).
   */
  ranges?: boolean;

  /**
   * Enable precompressed sidecar negotiation (default: true).
   */
  compressed?: boolean;

  /**
   * Maximum file size to read fully into memory (default: 1MB).
   * Files larger than this will use streaming when available.
   */
  maxBufferBytes?: number;
};

/**
 * Static files service interface.
 *
 * @since 0.1.0
 */
export interface IStaticFiles {
  /**
   * Serves the static file addressed by the request context, applying the same
   * conditional-request, Range, and encoding negotiation the mounted routes use
   * — this and the route handler are one implementation, so both honour the
   * plugin's configuration identically.
   *
   * Answers `404` rather than throwing when the path resolves to nothing, and
   * when the runtime provides no file system (edge platforms), since a missing
   * asset is a not-found and not an error.
   *
   * @param ctx - The request context
   * @returns The handler result for the resolved file
   * @since 0.1.0
   */
  serve(ctx: IRequestContext): Promise<HandlerResult>;
}
