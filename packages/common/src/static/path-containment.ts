/**
 * Path containment utilities for static file serving.
 *
 * @module
 */

import type { IFileSystem } from '../runtime.ts';

/**
 * Checks if a relative path is lexically contained within a root.
 *
 * This is a simple lexical check that rejects paths containing '..' segments.
 * For symlink-safe containment, use {@linkcode assertRealPathContained}.
 *
 * @param relativePath - The relative path to check
 * @returns True if the path is contained, false otherwise
 * @since 0.1.0
 */
export function isLexicallyContained(relativePath: string): boolean {
  // Reject empty paths
  if (!relativePath || relativePath === '/') {
    return false;
  }

  // Reject path traversal attempts
  if (relativePath.includes('..')) {
    return false;
  }

  // Reject absolute paths
  if (relativePath.startsWith('/') || relativePath.startsWith('\\')) {
    return false;
  }

  return true;
}

/**
 * Asserts that a target path is contained within a root by comparing canonical paths.
 *
 * This function uses the filesystem's realPath capability to resolve symlinks
 * and compare canonical paths, preventing symlink-based traversal attacks.
 *
 * @param fs - The filesystem to use for path resolution
 * @param root - The root directory (must be an absolute path)
 * @param target - The target path to check (must be an absolute path)
 * @returns True if the target is contained within the root
 * @throws {Error} If the target is not contained within the root or cannot be resolved
 * @since 0.1.0
 */
export async function assertRealPathContained(
  fs: Pick<IFileSystem, 'realPath' | 'stat'>,
  root: string,
  target: string,
): Promise<boolean> {
  // If realPath is not available, fall back to lexical check
  if (!fs.realPath) {
    // For lexical check, we need to ensure both paths are normalized
    const normalizedRoot = root.replace(/\\/g, '/');
    const normalizedTarget = target.replace(/\\/g, '/');

    if (!isLexicallyContained(normalizedTarget.replace(normalizedRoot + '/', ''))) {
      return false;
    }
    return true;
  }

  try {
    const realRoot = await fs.realPath(root);
    const realTarget = await fs.realPath(target);

    // Check if target starts with root
    if (realTarget === realRoot) {
      return true;
    }

    // Check if target is a child of root
    const prefix = realRoot.endsWith('/') ? realRoot : realRoot + '/';
    return realTarget.startsWith(prefix);
  } catch {
    // If we can't resolve the path, it's not contained
    return false;
  }
}
