/**
 * Path joining and the ordered, overwrite-safe write of generated files.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';
import { isMissingPath } from './filesystem-errors.ts';

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
   * Used by generated seam barrels and workspace manifests, deployment files,
   * and discovery maps. A failed batch restores their previous bytes.
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
  if (dir === undefined || dir === '') return normalizeDots(joinPath(cwd));
  return normalizeDots(dir.startsWith('/') ? joinPath(dir) : joinPath(cwd, dir));
}

/**
 * Resolves `.` and `..` segments in an already-joined absolute path.
 *
 * {@linkcode joinPath} drops empty segments and keeps everything else verbatim,
 * which is right for the generated relative paths it mostly builds — but a
 * `--dir` value comes from a person, and `--dir .` is the obvious way to name the
 * current directory. Left unresolved it produced `/work/svc/.`, which every
 * filesystem call still honours (so nothing failed loudly) while every path
 * PRINTED carried a stray `/./` and, in `setu adopt`, the member name derived from
 * the last segment was literally `.`.
 *
 * A `..` that would climb above the root is dropped rather than escaping it,
 * matching what every filesystem does with `/..`.
 *
 * @param path - An absolute path, already separator-normalized
 * @returns The same path with `.` and `..` segments resolved
 */
function normalizeDots(path: string): string {
  const resolved: string[] = [];
  for (const part of path.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') {
      resolved.pop();
      continue;
    }
    resolved.push(part);
  }
  return path.startsWith('/') ? `/${resolved.join('/')}` : resolved.join('/');
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
    } catch (cause) {
      // Only a positive missing-path response is safe to treat as absent. An
      // access or I/O error must stop before the writer can touch this path.
      if (!isMissingPath(cause)) throw cause;
    }
  }
  return existing;
}

/** One attempted write, recorded before the filesystem can partially modify it. */
interface FileUndo {
  readonly path: string;
  readonly before: Uint8Array | undefined;
}

/** Creates missing parents individually so only directories we created are removed. */
async function ensureDirectory(
  fs: IFileSystem,
  path: string,
  created: string[],
  known: Set<string>,
): Promise<void> {
  if (path === '' || path === '/' || known.has(path)) return;
  try {
    await fs.stat(path);
    known.add(path);
    return;
  } catch (cause) {
    if (!isMissingPath(cause)) throw cause;
  }
  await ensureDirectory(fs, dirName(path), created, known);
  await fs.mkdir(path);
  created.push(path);
  known.add(path);
}

/** Captures bytes at the write boundary, never interpreting unreadability as absence. */
async function previousBytes(fs: IFileSystem, path: string): Promise<Uint8Array | undefined> {
  try {
    return (await fs.readFile(path)).slice();
  } catch (cause) {
    if (!isMissingPath(cause)) throw cause;
    return undefined;
  }
}

/** Restores even a write that rejected after truncating its target. */
async function restoreFile(fs: IFileSystem, undo: FileUndo): Promise<void> {
  const { before } = undo;
  if (before === undefined) {
    try {
      await fs.rm(undo.path);
    } catch (cause) {
      if (!isMissingPath(cause)) throw cause;
    }
    return;
  }
  const current = await previousBytes(fs, undo.path);
  // A read-only file can reject without changing anything. Do not turn that
  // into a spurious rollback failure by trying to rewrite the intact bytes.
  if (
    current?.length === before.length &&
    current.every((byte, index) => byte === before[index])
  ) return;
  await fs.writeFile(undo.path, before);
}

/** Describes both the original error and each path whose recovery failed. */
function failureMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/**
 * Writes every file in order and compensates for a caught filesystem failure.
 *
 * The caller owns the overwrite preflight. Each attempted write captures its
 * prior bytes; failure restores them, removes new files, and removes only this
 * batch's empty directories. This is not crash-atomic storage or a lock against
 * concurrent editors: process termination cannot execute asynchronous rollback.
 *
 * @param fs - The filesystem to write through
 * @param files - The files to create
 * @throws The original failure, or an AggregateError naming incomplete recovery
 */
export async function writeFiles(
  fs: IFileSystem,
  files: readonly GeneratedFile[],
): Promise<void> {
  const encoder = new TextEncoder();
  const directories: string[] = [];
  const known = new Set<string>();
  const attempted: FileUndo[] = [];
  try {
    for (const file of files) {
      await ensureDirectory(fs, dirName(file.path), directories, known);
      const before = await previousBytes(fs, file.path);
      attempted.push({ path: file.path, before });
      await fs.writeFile(file.path, encoder.encode(file.contents));
    }
  } catch (cause) {
    const failures: Error[] = [];
    const recover = async (path: string, action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        failures.push(new Error(`${path}: ${failureMessage(error)}`, { cause: error }));
      }
    };
    for (const undo of attempted.reverse()) {
      await recover(undo.path, () => restoreFile(fs, undo));
    }
    for (const path of directories.reverse()) {
      await recover(path, () => fs.rm(path));
    }
    if (failures.length > 0) {
      throw new AggregateError(
        [cause, ...failures],
        `${failureMessage(cause)}; rollback incomplete: ${failures.map(failureMessage).join('; ')}`,
        { cause },
      );
    }
    throw cause;
  }
}
