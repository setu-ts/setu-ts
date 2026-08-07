/**
 * Path resolution utilities for static file serving.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';
import { isLexicallyContained } from '@setu-ts/common';

/**
 * Options for path resolution.
 *
 * @since 0.1.0
 */
export type ResolvePathOptions = {
  /** The filesystem to use */
  fs: IFileSystem;
  /** The root directory to serve from */
  root: string;
  /** The URL prefix to strip */
  urlPrefix: string;
  /** The index file to serve for directories */
  index: string;
  /** The fallback file to serve for missing paths */
  fallback?: string;
};

/**
 * Resolves a request path to a filesystem path.
 *
 * @param options - Resolution options
 * @param requestPath - The decoded request path
 * @returns The resolved filesystem path, or null if not found
 * @since 0.1.0
 */
export async function resolvePath(
  options: ResolvePathOptions,
  requestPath: string,
): Promise<string | null> {
  const { fs, root, urlPrefix, index, fallback } = options;

  // Strip the URL prefix
  const relativePath = requestPath.startsWith(urlPrefix)
    ? requestPath.slice(urlPrefix.length)
    : requestPath;

  // Normalize the path
  const normalizedPath = relativePath === '' ? '/' : relativePath;

  // Reject path traversal
  if (!isLexicallyContained(normalizedPath)) {
    return null;
  }

  // Resolve the filesystem path
  const fullPath = normalizedPath === '/' ? root : `${root}/${normalizedPath}`;

  // Check if it's a directory
  try {
    const stat = await fs.stat(fullPath);

    if (stat.isDirectory) {
      // Serve index file if configured
      if (index) {
        const indexPath = `${fullPath}/${index}`;
        const indexStat = await fs.stat(indexPath).catch(() => null);
        if (indexStat?.isFile) {
          return indexPath;
        }
      }
      // Return the directory itself (will 404 if no index)
      return fullPath;
    }

    // It's a file
    return fullPath;
  } catch {
    // File doesn't exist
    if (fallback) {
      // Check if fallback is a file
      const fallbackPath = `${root}/${fallback}`;
      try {
        const fallbackStat = await fs.stat(fallbackPath);
        if (fallbackStat.isFile) {
          return fallbackPath;
        }
      } catch {
        // Fallback doesn't exist
      }
    }
    return null;
  }
}
