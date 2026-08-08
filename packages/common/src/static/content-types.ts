/**
 * Content-type mapping for static file serving.
 *
 * @module
 */

/**
 * Maps file extensions to content types.
 *
 * @since 0.1.0
 */
const CONTENT_TYPES: Readonly<Record<string, string>> = {
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
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.map': 'application/json',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.eot': 'application/vnd.ms-fontobject',
  '.md': 'text/markdown',
  '.pdf': 'application/pdf',
  '.zip': 'application/zip',
  '.gz': 'application/gzip',
  '.br': 'application/brotli',
  '.bmp': 'image/bmp',
  '.csv': 'text/csv',
  '.ics': 'text/calendar',
} as const;

/**
 * Returns the content type for a file based on its extension.
 *
 * @param path - The file path
 * @returns The content type, or 'application/octet-stream' if unknown
 * @since 0.1.0
 */
export function contentTypeFor(path: string): string {
  const dotIndex = path.lastIndexOf('.');
  if (dotIndex === -1) {
    return 'application/octet-stream';
  }
  const ext = path.slice(dotIndex).toLowerCase();
  return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}
