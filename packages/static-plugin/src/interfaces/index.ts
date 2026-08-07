/**
 * Static file serving plugin interfaces.
 *
 * @module
 */

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
   * Serves a static file at the given path.
   *
   * @param ctx - The request context
   * @returns A HandlerResult with the file response or error
   */
  serve(ctx: unknown): Promise<unknown>;
}
