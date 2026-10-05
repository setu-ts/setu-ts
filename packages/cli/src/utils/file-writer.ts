/**
 * Path joining and the ordered, overwrite-safe write of generated files.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';
import { isMissingPath } from './filesystem-errors.ts';
import { InterruptedError, throwIfInterrupted } from './interruption.ts';
import { escapeName } from './names.ts';

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

/** Raised when a path the CLI would touch resolves outside the project through a link. */
export class PathEscapesProjectError extends Error {
  /**
   * @param message - The single-line, escaped explanation
   */
  constructor(message: string) {
    super(message);
    this.name = 'PathEscapesProjectError';
  }
}

/** `/`-separated, with `.` and `..` resolved lexically, so prefix comparison is sound. */
function normalizeAbsolute(path: string): string {
  const parts: string[] = [];
  for (const part of path.replaceAll('\\', '/').split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') parts.pop();
    else parts.push(part);
  }
  return `/${parts.join('/')}`;
}

/**
 * A path as the filesystem resolves it: `realPath` of its deepest existing
 * ancestor, with the not-yet-existing remainder appended. A missing component
 * that its parent nevertheless LISTS is a dangling link — writing through it
 * would create its target — so it is reported, never treated as absent.
 */
async function canonicalPath(fs: IFileSystem, path: string): Promise<string> {
  if (fs.realPath === undefined) {
    throw new PathEscapesProjectError(
      `Cannot verify that ${escapeName(path)} stays inside the project: this filesystem ` +
        'cannot resolve links, so nothing is written.',
    );
  }
  const suffix: string[] = [];
  let probe = normalizeAbsolute(path);
  for (;;) {
    try {
      const real = normalizeAbsolute(await fs.realPath(probe));
      return suffix.length === 0 ? real : normalizeAbsolute(`${real}/${suffix.join('/')}`);
    } catch (cause) {
      if (!isMissingPath(cause)) {
        throw new PathEscapesProjectError(
          `Cannot resolve ${escapeName(probe)}: ${escapeName(failureMessage(cause))}.`,
        );
      }
      const parent = dirName(probe);
      if (parent === probe || parent === '') {
        return normalizeAbsolute(`${probe}/${suffix.join('/')}`);
      }
      const name = probe.slice(parent === '/' ? 1 : parent.length + 1);
      try {
        if ((await fs.readdir(parent)).includes(name)) {
          throw new PathEscapesProjectError(
            `${escapeName(probe)} is a link to something that does not exist; Setu will not ` +
              'write through it. Remove the link, then run this again.',
          );
        }
      } catch (listing) {
        if (listing instanceof PathEscapesProjectError) throw listing;
        // An unlistable parent resolves on the next step or fails there.
      }
      suffix.unshift(name);
      probe = parent;
    }
  }
}

/**
 * Refuses a path that does not resolve to exactly its place under `root` — one
 * reached through a symbolic link, whether the link points outside the project or
 * merely elsewhere inside it. A project reached through a linked PARENT directory
 * is fine: the root is resolved the same way, so only links INSIDE it are refused.
 *
 * @param fs - The filesystem to resolve through
 * @param root - The project or workspace root (absolute)
 * @param target - The path about to be read for a move or written (absolute)
 * @throws {PathEscapesProjectError} When the target leaves `root` or cannot be verified
 */
export async function assertInsideProject(
  fs: IFileSystem,
  root: string,
  target: string,
): Promise<void> {
  // `\\` is an ordinary filename character on POSIX, so rewriting it into a
  // separator would check a different path from the one then written. The CLI
  // never plans one below a root, so any there is project-supplied: refused.
  const below = target.startsWith(root) ? target.slice(root.length) : target;
  if (below.includes('\\')) {
    throw new PathEscapesProjectError(
      `${escapeName(target)} contains a backslash below ${escapeName(root)}; Setu refuses ` +
        'such paths because they name a different file on each platform.',
    );
  }
  const lexicalRoot = normalizeAbsolute(root);
  const lexicalTarget = normalizeAbsolute(target);
  const prefix = lexicalRoot === '/' ? '/' : `${lexicalRoot}/`;
  if (!lexicalTarget.startsWith(prefix)) {
    throw new PathEscapesProjectError(
      `${escapeName(target)} is outside ${escapeName(root)}; nothing is written.`,
    );
  }
  const relative = lexicalTarget.slice(prefix.length);
  const realRoot = await canonicalPath(fs, lexicalRoot);
  const realTarget = await canonicalPath(fs, lexicalTarget);
  if (realTarget !== normalizeAbsolute(`${realRoot}/${relative}`)) {
    throw new PathEscapesProjectError(
      `${escapeName(target)} resolves to ${escapeName(realTarget)} through a symbolic link; ` +
        'Setu will not read or write through links inside a project. Replace the link with ' +
        'the files it points at, or remove it, then run this again.',
    );
  }
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

/**
 * Builds recovery guidance when every collision is debris beneath one directory
 * the current command intended to create.
 *
 * The caller supplies that directory explicitly: deriving it from a common
 * path prefix could recommend deleting an established source directory.
 */
export function interruptedRunRetryHint(
  existing: readonly string[],
  wouldCreateDirectory: string,
): string | undefined {
  if (existing.length === 0) return undefined;
  const directory = wouldCreateDirectory.replace(/\/+$/, '');
  const prefix = `${directory}/`;
  if (!existing.every((path) => path.startsWith(prefix))) return undefined;
  return `If an earlier run was interrupted before this change, delete ${
    escapeName(directory)
  } and run this again.`;
}

/** One attempted write, recorded before the filesystem can partially modify it. */
interface FileUndo {
  readonly path: string;
  readonly before: Uint8Array | undefined;
}

/** The observable result of one planned file write. */
export interface WriteOutcome {
  readonly path: string;
  readonly outcome: 'created' | 'updated' | 'unchanged';
}

function outcomeFor(
  path: string,
  before: Uint8Array | undefined,
  after: Uint8Array,
): WriteOutcome {
  return {
    path,
    outcome: before === undefined
      ? 'created'
      : before.length === after.length && before.every((byte, index) => byte === after[index])
      ? 'unchanged'
      : 'updated',
  };
}

/** Creates missing parents individually so only directories we created are removed. */
async function ensureDirectory(
  fs: IFileSystem,
  path: string,
  created: string[],
  known: Set<string>,
  signal?: AbortSignal,
): Promise<void> {
  throwIfInterrupted(signal);
  if (path === '' || path === '/' || known.has(path)) return;
  try {
    await fs.stat(path);
    known.add(path);
    return;
  } catch (cause) {
    if (!isMissingPath(cause)) throw cause;
  }
  await ensureDirectory(fs, dirName(path), created, known, signal);
  throwIfInterrupted(signal);
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

/** Classifies a write plan without mutating the filesystem. */
export async function classifyFiles(
  fs: IFileSystem,
  files: readonly GeneratedFile[],
): Promise<readonly WriteOutcome[]> {
  const encoder = new TextEncoder();
  const outcomes: WriteOutcome[] = [];
  for (const file of files) {
    outcomes.push(
      outcomeFor(file.path, await previousBytes(fs, file.path), encoder.encode(file.contents)),
    );
  }
  return outcomes;
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
 * concurrent editors. A handled interruption signal reaches the same rollback;
 * SIGKILL, power loss, and other unhandled termination cannot execute it.
 *
 * @param fs - The filesystem to write through
 * @param files - The files to create
 * @param options - Cooperative interruption signal checked between writes
 * @throws The original failure, or an AggregateError naming incomplete recovery
 */
export async function writeFiles(
  fs: IFileSystem,
  files: readonly GeneratedFile[],
  options: { readonly root: string; readonly signal?: AbortSignal },
): Promise<readonly WriteOutcome[]> {
  // Every target is checked BEFORE the first write, so a link anywhere in the
  // plan refuses the whole batch with nothing written.
  for (const file of files) await assertInsideProject(fs, options.root, file.path);
  const encoder = new TextEncoder();
  const directories: string[] = [];
  const known = new Set<string>();
  const attempted: FileUndo[] = [];
  const outcomes: WriteOutcome[] = [];
  try {
    for (const file of files) {
      throwIfInterrupted(options.signal);
      await ensureDirectory(fs, dirName(file.path), directories, known, options.signal);
      const before = await previousBytes(fs, file.path);
      attempted.push({ path: file.path, before });
      await fs.writeFile(file.path, encoder.encode(file.contents));
      throwIfInterrupted(options.signal);
      outcomes.push(outcomeFor(file.path, before, encoder.encode(file.contents)));
    }
    return outcomes;
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

/**
 * Journals a relocation and its write batches as one interruption recovery unit.
 *
 * Only paths mutated by the operation are restored. Directory removal is limited
 * to empty directories: callers must never recursively delete populated trees.
 * Ordinary returned refusals retain the caller's existing recovery policy.
 *
 * @param fs - The underlying filesystem
 * @param operation - Performs relocation and writes through the journaled filesystem
 * @param signal - Interruption observed before and after each mutation
 * @returns The operation's result after its final interruption check
 */
export async function withFileTransaction<T>(
  fs: IFileSystem,
  operation: (journaled: IFileSystem) => Promise<T>,
  signal?: AbortSignal,
): Promise<T> {
  const files = new Map<string, FileUndo>();
  const created: string[] = [];
  const removed: string[] = [];
  const known = new Set<string>();
  const remember = async (path: string): Promise<void> => {
    if (!files.has(path)) files.set(path, { path, before: await previousBytes(fs, path) });
  };
  const journaled: IFileSystem = {
    // Adapters may implement their methods on a prototype and rely on `this`.
    readFile: fs.readFile.bind(fs),
    stat: fs.stat.bind(fs),
    readdir: fs.readdir.bind(fs),
    ...(fs.realPath === undefined ? {} : { realPath: fs.realPath.bind(fs) }),
    ...(fs.readStream === undefined ? {} : { readStream: fs.readStream.bind(fs) }),
    async writeFile(path, data) {
      throwIfInterrupted(signal);
      await remember(path);
      await fs.writeFile(path, data);
      throwIfInterrupted(signal);
    },
    async mkdir(path, options) {
      throwIfInterrupted(signal);
      if (options?.recursive === true) {
        await ensureDirectory(fs, path, created, known, signal);
      } else {
        await fs.mkdir(path, options);
        created.push(path);
      }
      throwIfInterrupted(signal);
    },
    async rm(path, options) {
      throwIfInterrupted(signal);
      const stat = await fs.stat(path);
      if (stat.isDirectory) {
        // Never let the journal remove unrecorded file contents.
        const directories: string[] = [];
        const collect = async (directory: string): Promise<void> => {
          for (const name of await fs.readdir(directory)) {
            const child = joinPath(directory, name);
            if (!(await fs.stat(child)).isDirectory) {
              throw new Error(`Refusing to remove unrecorded file ${child}`);
            }
            await collect(child);
          }
          directories.push(directory);
        };
        await collect(path);
        await fs.rm(path, options);
        removed.push(...directories);
        known.delete(path);
      } else {
        await remember(path);
        await fs.rm(path, options);
      }
      throwIfInterrupted(signal);
    },
  };
  try {
    throwIfInterrupted(signal);
    const result = await operation(journaled);
    throwIfInterrupted(signal);
    return result;
  } catch (cause) {
    const failures: Error[] = [];
    const recover = async (path: string, action: () => Promise<void>): Promise<void> => {
      try {
        await action();
      } catch (error) {
        failures.push(new Error(`${path}: ${failureMessage(error)}`, { cause: error }));
      }
    };
    for (const path of [...removed].reverse()) {
      await recover(path, () => fs.mkdir(path, { recursive: true }));
    }
    for (const undo of [...files.values()].reverse()) {
      await recover(undo.path, () => restoreFile(fs, undo));
    }
    for (const path of [...created].reverse()) {
      await recover(path, async () => {
        try {
          await fs.rm(path);
        } catch (error) {
          if (!isMissingPath(error)) throw error;
        }
      });
    }
    // A nested write batch rolls back through this abort-aware journal, so its
    // aggregate can wrap the interruption even when outer recovery also fails.
    const originalCause = cause instanceof AggregateError && cause.cause instanceof InterruptedError
      ? cause.cause
      : cause;
    if (failures.length > 0) {
      throw new AggregateError(
        [cause, ...failures],
        `${failureMessage(cause)}; rollback incomplete: ${failures.map(failureMessage).join('; ')}`,
        { cause: originalCause },
      );
    }
    throw originalCause;
  }
}
