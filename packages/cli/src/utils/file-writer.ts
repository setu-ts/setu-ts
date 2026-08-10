/**
 * Path joining and the ordered, overwrite-safe write of generated files.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';

/**
 * One file a schematic asks the command layer to create.
 */
export interface GeneratedFile {
  /** Path to write, relative to the command's target directory. */
  readonly path: string;
  /** The file contents. */
  readonly contents: string;
  /**
   * Marks a file the CLI owns outright and regenerates, exempting it from the
   * overwrite refusal in {@linkcode findExisting}.
   *
   * Set on exactly one emitted file today: the `src/modules/index.ts` aggregate
   * barrel, which has to list every module and therefore has to be rewritten
   * whenever one is added. Every other path keeps the refusal.
   *
   * Declared per FILE rather than as a `--force` flag on the command,
   * deliberately: a flag would lift the check for all fourteen schematics, so a
   * mistyped `setu g service user` could clobber hand-written work. A schematic
   * naming the files it owns keeps the exemption to paths the CLI wrote in the
   * first place, and {@linkcode findExisting} is the single chokepoint every
   * write passes through, so it cannot be bypassed elsewhere.
   *
   * Omitted or `false` → current behavior, byte-identical.
   */
  readonly managed?: boolean;
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
 * Resolves a command's target directory to an absolute path.
 *
 * A relative `--dir` must be anchored to the CLI's working directory here, at
 * the command boundary, so that EVERY downstream consumer agrees on the same
 * location. Filesystem calls would resolve a relative path against the process
 * CWD on their own, but `import()` of a custom schematic would not: prefixing
 * `/` to a relative path resolves it against the filesystem ROOT, which made
 * `--dir some/project` look for schematics in `/some/project`.
 *
 * @param cwd - The CLI's working directory (absolute)
 * @param dir - The `--dir` value, when supplied
 * @returns An absolute, separator-normalized directory
 */
export function resolveDir(cwd: string, dir?: string): string {
  if (dir === undefined || dir === '') return joinPath(cwd);
  return dir.startsWith('/') ? joinPath(dir) : joinPath(cwd, dir);
}

/**
 * Converts a filesystem path to an absolute `file:` URL suitable for `import()`.
 *
 * Callers must pass an already-absolute path — {@linkcode resolveDir} is what
 * guarantees that. A relative path would be resolved against the filesystem
 * root, which is the M34 defect this helper centralizes so it cannot recur in
 * two places.
 *
 * @param path - An absolute filesystem path
 * @returns The `file:` URL
 */
export function toFileUrl(path: string): string {
  return new URL(path.startsWith('/') ? path : `/${path}`, 'file://').href;
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
 * Returns the first path planned more than once, if any.
 *
 * The overwrite check probes the filesystem, so it cannot see two entries with
 * the same path inside a single plan; those would both be written, the last
 * silently winning. A template emitting `deno.json` would overwrite the
 * framework's, and a workspace member's discovery module emitted by both its
 * host and the regeneration pass would overwrite itself.
 *
 * @param files - The planned files, in write order
 * @returns The duplicated path, or undefined when every path is distinct
 */
export function firstDuplicatePath(files: readonly GeneratedFile[]): string | undefined {
  const seen = new Set<string>();
  for (const file of files) {
    if (seen.has(file.path)) return file.path;
    seen.add(file.path);
  }
  return undefined;
}

/**
 * Returns the paths in `files` that already exist on `fs` and would be
 * overwritten.
 *
 * A file marked {@linkcode GeneratedFile.managed} is skipped: the CLI generated
 * it and regenerates it, so rewriting it destroys nothing the developer authored.
 *
 * @param fs - The filesystem to probe
 * @param files - The planned files
 * @returns The subset of unmanaged paths that already exist, in plan order
 */
export async function findExisting(
  fs: IFileSystem,
  files: readonly GeneratedFile[],
): Promise<readonly string[]> {
  const existing: string[] = [];
  for (const file of files) {
    if (file.managed === true) continue;
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
