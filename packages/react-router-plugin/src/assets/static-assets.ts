/**
 * Static asset handler — serves built client assets over IFileSystem.
 *
 * @module
 * @since 0.1.0
 */

import type { IFileSystem, RouteHandler } from '@hono-enterprise/common';

/**
 * Content-type map for common file extensions.
 *
 * @since 0.1.0
 */
const CONTENT_TYPES: Record<string, string> = {
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.cjs': 'text/javascript',
  '.css': 'text/css',
  '.html': 'text/html',
  '.htm': 'text/html',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.woff2': 'font/woff2',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.woff': 'font/woff',
};

/**
 * Immutable Cache-Control header value for built assets.
 *
 * @since 0.1.0
 */
const CACHE_CONTROL_IMMUTABLE = 'public, max-age=31536000, immutable';

/**
 * Creates a static-asset `RouteHandler` that serves files from a directory
 * using the injected `IFileSystem`.
 *
 * Returns `404` when `fs` is absent or the requested file is missing.
 *
 * @param options - Configuration
 * @returns A route handler function
 * @since 0.1.0
 */
export function createStaticAssetHandler(options: {
  fs: IFileSystem;
  assetsDir: string;
  assetUrlPrefix: string;
}): RouteHandler {
  const { fs, assetsDir, assetUrlPrefix } = options;

  return async (ctx) => {
    // Decode the URL path to get the file system path.
    let decodedPath: string;
    try {
      decodedPath = decodeURIComponent(ctx.request.path);
    } catch {
      return ctx.response.status(400).send(new TextEncoder().encode('Bad Request'));
    }

    // Strip the URL prefix to get the relative file path.
    const relativePath = decodedPath.startsWith(assetUrlPrefix)
      ? decodedPath.slice(assetUrlPrefix.length)
      : decodedPath;

    if (relativePath === '' || relativePath === '/') {
      return ctx.response.status(404).send(null);
    }

    const fullPath = `${assetsDir}/${relativePath}`;

    // Determine content type from extension.
    const ext = extractExtension(fullPath);
    const contentType = CONTENT_TYPES[ext] ?? 'application/octet-stream';

    // Read the file.
    let bytes: Uint8Array;
    try {
      bytes = await fs.readFile(fullPath);
    } catch {
      return ctx.response.status(404).send(null);
    }

    return ctx.response
      .header('Content-Type', contentType)
      .header('Cache-Control', CACHE_CONTROL_IMMUTABLE)
      .send(bytes);
  };
}

/**
 * Extracts the file extension (lowercased) from a path.
 *
 * @param path - The file path
 * @returns The extension including the dot, or empty string
 * @since 0.1.0
 */
function extractExtension(path: string): string {
  const lastDot = path.lastIndexOf('.');
  if (lastDot === -1) return '';
  return path.slice(lastDot).toLowerCase();
}
