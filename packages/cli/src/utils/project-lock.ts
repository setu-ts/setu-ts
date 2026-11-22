/** Exclusive CLI read-plan-write ownership of one project or workspace. @module */
import type { IFileSystem } from '@setu-ts/common';
import { workspaceMemberOf } from '../app-loader.ts';
import { EXIT_ERROR, EXIT_OK } from '../constants.ts';
import { joinPath, readExistingText } from './file-writer.ts';
import { detectProject } from './project-detector.ts';
import { escapeName } from './names.ts';
import { memberPath } from './member-path.ts';

/** Filesystem metadata supplied by the executable's process boundary. */
export interface IProjectLockFileSystem extends IFileSystem {
  /** The invoking process; absent for callers without a process boundary. */
  readonly invokingPid?: number;
}

/** Command dependencies consumed by lock acquisition and refusal. */
export interface IProjectLockDependencies {
  readonly fs: IFileSystem;
  readonly error: (message: string) => void;
  /** Undefined or a failing probe conservatively selects the live-owner message. */
  readonly isProcessAlive?: (pid: number) => boolean;
}

/** A lock refusal or failure to acquire/release the command's own lock. */
export class ProjectLockError extends Error {
  /** @param message - The refusal including its lock path. */
  constructor(message: string) {
    super(message);
    this.name = 'ProjectLockError';
  }
}

/** Reads owner metadata solely for a refusal; malformed metadata is unknown. */
async function readOwner(
  fs: IFileSystem,
  path: string,
): Promise<{ pid: number; command: string } | undefined> {
  try {
    const value: unknown = JSON.parse((await readExistingText(fs, path)) ?? 'null');
    if (typeof value !== 'object' || value === null || !('pid' in value) || !('command' in value))
      return undefined;
    const { pid, command } = value;
    return typeof pid === 'number' &&
      Number.isSafeInteger(pid) &&
      pid > 0 &&
      typeof command === 'string' &&
      command.length > 0
      ? { pid, command }
      : undefined;
  } catch {
    // A missing, unreadable or invalid owner never authorizes takeover.
    return undefined;
  }
}

/** Chooses a conservative live-owner classification when the host cannot probe it. */
function ownerIsAlive(isAlive: ((pid: number) => boolean) | undefined, pid: number): boolean {
  try {
    return isAlive?.(pid) ?? true;
  } catch {
    return true;
  }
}

/**
 * Holds one non-reentrant lock until the command callback settles.
 *
 * Existing locks are never removed or rewritten. The filesystem carries the PID
 * supplied by the process boundary; callers without a PID publish an unknown
 * owner and are still mutually exclusive.
 *
 * @param fs - Filesystem, optionally carrying the invoking PID
 * @param lockRoot - Project directory or shared workspace root
 * @param isAlive - Host probe used only to choose the refusal message
 * @param command - The command name recorded as the owner (`add`, `generate`, `sync`)
 * @param fn - Command callback, invoked only after owner publication
 * @param report - Receives a release failure when the callback failed or did not complete
 * @param completed - Whether a resolved result means the command completed (default: always)
 * @returns The callback result
 * @throws {ProjectLockError} If ownership cannot be acquired, or released after a completed command
 * @throws The callback's own error, which a release failure never replaces
 */
export async function withProjectLock<T>(
  fs: IProjectLockFileSystem,
  lockRoot: string,
  isAlive: ((pid: number) => boolean) | undefined,
  command: string,
  fn: () => Promise<T>,
  report?: (message: string) => void,
  completed: (result: T) => boolean = () => true,
): Promise<T> {
  const parent = joinPath(lockRoot, '.setu-ts');
  const lock = joinPath(parent, 'write.lock');
  try {
    await fs.mkdir(parent, { recursive: true });
  } catch (cause) {
    // A file where `.setu-ts` belongs is not a held lock; name the real failure.
    throw new ProjectLockError(
      `Cannot acquire ${escapeName(lock)}: ${escapeName(cause instanceof Error ? cause.message : String(cause))}`,
    );
  }
  try {
    await fs.mkdir(lock);
  } catch (cause) {
    if (!(cause instanceof Error && 'code' in cause && cause.code === 'EEXIST')) {
      throw new ProjectLockError(
        `Cannot acquire ${escapeName(lock)}: ${escapeName(cause instanceof Error ? cause.message : String(cause))}`,
      );
    }
    const owner = await readOwner(fs, joinPath(lock, 'owner.json'));
    const details = owner === undefined ? '' : ` (${escapeName(owner.command)}, pid ${owner.pid})`;
    if (owner !== undefined && !ownerIsAlive(isAlive, owner.pid)) {
      throw new ProjectLockError(
        // The probe follows the read, so the lock may have changed hands since: the
        // user confirms before deleting it.
        `A setu command${details} that is no longer running may have left ${escapeName(lock)}.\nConfirm no setu command is running in this project, then delete it and run this again.`,
      );
    }
    throw new ProjectLockError(
      `Another setu command${details} is changing this project; run this again when it finishes.\nIf no setu command is running, delete ${escapeName(lock)} and run this again.`,
    );
  }
  let result: T;
  try {
    try {
      await fs.writeFile(
        joinPath(lock, 'owner.json'),
        new TextEncoder().encode(JSON.stringify({ pid: fs.invokingPid ?? null, command })),
      );
    } catch (cause) {
      throw new ProjectLockError(
        `Failed to write ${escapeName(lock)}/owner.json: ${escapeName(cause instanceof Error ? cause.message : String(cause))}`,
      );
    }
    result = await fn();
  } catch (failure) {
    // The command's own failure wins; a release failure is still reported beside it.
    try {
      await releaseProjectLock(fs, lock);
    } catch (release) {
      report?.((release as Error).message);
    }
    throw failure;
  }
  if (completed(result)) {
    // A lock left behind blocks the next command, so failing to release fails this one;
    // the message says the command's own work is done, so it is not run again.
    await releaseProjectLock(fs, lock, true);
    return result;
  }
  // A refused or failed command keeps its own status; the release failure is reported beside it.
  try {
    await releaseProjectLock(fs, lock);
  } catch (release) {
    report?.((release as Error).message);
  }
  return result;
}

/**
 * Removes the command's own lock and names any filesystem failure.
 *
 * @param fs - Filesystem holding the lock
 * @param lock - The lock directory
 * @param completed - True when the command itself finished, so only cleanup failed
 */
async function releaseProjectLock(fs: IFileSystem, lock: string, completed = false): Promise<void> {
  try {
    await fs.rm(lock, { recursive: true });
  } catch (cause) {
    const reason = escapeName(cause instanceof Error ? cause.message : String(cause));
    throw new ProjectLockError(
      completed
        ? `The command completed, but its lock ${escapeName(lock)} could not be removed: ${reason}\nDo not run the command again; delete ${escapeName(lock)} before the next setu command.`
        : `Cannot release ${escapeName(lock)}: ${reason}`,
    );
  }
}

/**
 * Locks only detected projects, sharing a workspace lock between its members.
 * A target that is not a readable project runs the command unlocked, so the
 * command reports its own refusal and no lock directory is created there.
 *
 * @param deps - Filesystem, host liveness probe and error sink
 * @param dir - Resolved target directory
 * @param enabled - False for dry runs and informational command paths
 * @param command - The command name recorded as the owner
 * @param fn - Command implementation; it performs no nested acquisition
 * @returns The command status, or exit 1 for a lock refusal
 */
export async function runWithProjectLock(
  deps: IProjectLockDependencies,
  dir: string,
  enabled: boolean,
  command: string,
  fn: () => Promise<number>,
): Promise<number> {
  if (!enabled) return fn();
  const project = await detectProject(deps.fs, dir);
  if (project.kind === 'none' || project.kind === 'unreadable') return fn();
  try {
    // The lexical path first (a member linked out of its workspace still locks the
    // workspace), then the real path (an alias of a member locks its workspace too).
    const real = await canonicalDir(deps.fs, dir);
    const root =
      project.kind === 'workspace-root'
        ? real
        : (((await workspaceMemberOf(deps.fs, dir)) ?? (await workspaceMemberOf(deps.fs, real)))
            ?.root ?? real);
    const lock = (lockRoot: string, body: () => Promise<number>) =>
      withProjectLock(
        deps.fs,
        lockRoot,
        deps.isProcessAlive,
        command,
        body,
        deps.error,
        (status) => status === EXIT_OK,
      );
    // A member linked to a project outside its workspace is also locked where a
    // command run at its real path would lock (that path's own workspace, if any),
    // after this one, so the two still exclude each other. Compared canonically: a
    // root reached through a link is still the same directory.
    // Compared with one separator: `realPath` returns native paths (`C:\ws\apps\api`).
    const canonicalRoot = memberPath(await canonicalDir(deps.fs, root));
    const realPath = memberPath(real);
    if (realPath === canonicalRoot || realPath.startsWith(`${canonicalRoot}/`)) {
      return await lock(root, fn);
    }
    const realRoot = (await workspaceMemberOf(deps.fs, real))?.root ?? real;
    return await lock(root, () => lock(realRoot, fn));
  } catch (cause) {
    if (!(cause instanceof ProjectLockError)) throw cause;
    deps.error(cause.message);
    return EXIT_ERROR;
  }
}

/**
 * The real path of a project directory where the host can resolve one.
 *
 * @param fs - Filesystem, optionally able to resolve symlinks
 * @param dir - The resolved target directory
 * @returns The canonical directory, or `dir` when it cannot be resolved
 */
async function canonicalDir(fs: IFileSystem, dir: string): Promise<string> {
  try {
    return (await fs.realPath?.(dir)) ?? dir;
  } catch {
    return dir;
  }
}
