/** Exclusive CLI read-plan-write ownership of one project or workspace. @module */
import type { IFileSystem } from '@setu-ts/common';
import { workspaceMemberOf } from '../app-loader.ts';
import { EXIT_ERROR } from '../constants.ts';
import { joinPath, readExistingText } from './file-writer.ts';
import { detectProject } from './project-detector.ts';
import { escapeName } from './names.ts';

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
 * @param report - Receives a release failure when the callback itself failed
 * @returns The callback result
 * @throws {ProjectLockError} If ownership cannot be acquired, or released after a successful callback
 * @throws The callback's own error, which a release failure never replaces
 */
export async function withProjectLock<T>(
  fs: IProjectLockFileSystem,
  lockRoot: string,
  isAlive: ((pid: number) => boolean) | undefined,
  command: string,
  fn: () => Promise<T>,
  report?: (message: string) => void,
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
        `A setu command${details} that is no longer running left ${escapeName(lock)}; delete it and run this again.`,
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
  // A lock left behind blocks the next command, so failing to release fails this one.
  await releaseProjectLock(fs, lock);
  return result;
}

/** Removes the command's own lock and names any filesystem failure. */
async function releaseProjectLock(fs: IFileSystem, lock: string): Promise<void> {
  try {
    await fs.rm(lock, { recursive: true });
  } catch (cause) {
    throw new ProjectLockError(
      `Cannot release ${escapeName(lock)}: ${escapeName(cause instanceof Error ? cause.message : String(cause))}`,
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
    const root =
      project.kind === 'workspace-root'
        ? dir
        : ((await workspaceMemberOf(deps.fs, dir))?.root ?? dir);
    return await withProjectLock(deps.fs, root, deps.isProcessAlive, command, fn, deps.error);
  } catch (cause) {
    if (!(cause instanceof ProjectLockError)) throw cause;
    deps.error(cause.message);
    return EXIT_ERROR;
  }
}
