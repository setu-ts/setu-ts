/**
 * Path joining and the ordered, overwrite-safe write of generated files.
 *
 * @module
 */

import type { IFileSystem } from '@hono-enterprise/common';

/**
 * One file a schematic asks the command layer to create.
 */
export interface GeneratedFile {
  /** Path to write, relative to the command's target directory. */
  readonly path: string;
  /** The file contents. */
  readonly contents: string;
}

/**
 * Joins path segments with `/`, collapsing repeated and trailing separators.
 *
 * Generated paths are always relative and always `/`-separated, so this is
 * sufficient and keeps the package free of a `node:path` import (which would
 * be a runtime-specific API outside `packages/runtime`).
 *
 * @param segments - Path segments; empty segments are ignored
 * @returns The joined path
 */
export function joinPath(...segments: readonly string[]): string {
  const parts: string[] = [];
  for (const segment of segments) {
    for (const part of segment.split('/')) {
      if (part !== '') parts.push(part);
    }
  }
  const joined = parts.join('/');
  return segments[0]?.startsWith('/') ? `/${joined}` : joined;
}

/**
 * Returns the parent directory of a path, or `''` when it has no parent.
 *
 * @param path - The path to inspect
 * @returns The parent directory
 */
export function dirName(path: string): string {
  const index = path.lastIndexOf('/');
  if (index <= 0) return index === 0 ? '/' : '';
  return path.slice(0, index);
}

/**
 * Returns the paths in `files` that already exist on `fs`.
 *
 * @param fs - The filesystem to probe
 * @param files - The planned files
 * @returns The subset of paths that already exist, in plan order
 */
export async function findExisting(
  fs: IFileSystem,
  files: readonly GeneratedFile[],
): Promise<readonly string[]> {
  const existing: string[] = [];
  for (const file of files) {
    try {
      await fs.stat(file.path);
      existing.push(file.path);
    } catch {
      // Absent (or unreadable) — nothing to overwrite.
    }
  }
  return existing;
}

/**
 * Writes every file in order, creating parent directories first.
 *
 * The caller is responsible for the overwrite check ({@linkcode findExisting});
 * this function writes unconditionally so that the "check everything, then
 * write everything" ordering lives in exactly one place — the command layer.
 *
 * @param fs - The filesystem to write through
 * @param files - The files to create
 */
export async function writeFiles(
  fs: IFileSystem,
  files: readonly GeneratedFile[],
): Promise<void> {
  const encoder = new TextEncoder();
  const created = new Set<string>();

  for (const file of files) {
    const dir = dirName(file.path);
    if (dir !== '' && !created.has(dir)) {
      await fs.mkdir(dir, { recursive: true });
      created.add(dir);
    }
    await fs.writeFile(file.path, encoder.encode(file.contents));
  }
}
