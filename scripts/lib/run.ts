import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, open, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';

/** Captured subprocess streams; inherited streams are empty. */
export interface RunResult {
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Repository process options. An explicit environment replaces the parent environment. */
export interface RunOptions {
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly stdin?: string | Uint8Array;
  readonly timeoutMs?: number;
  readonly inherit?: boolean;
  /** Regular files make Node child writes synchronous, surviving process.exit()
   * even if the parent cannot consume output until the child has closed. */
  readonly capture?: 'file';
}

/** Largest deadline a Node timer honours. */
export const MAX_TIMEOUT_MS = 2 ** 31 - 1;

/** Run one command; a deadline kills its whole process group and returns code 124. */
export async function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const { timeoutMs } = options;
  // Above 2^31 - 1 ms a Node timer fires after 1 ms, so an oversized deadline would kill the
  // child at once; NaN, zero and negatives are caller mistakes. Fractions are fine: callers derive
  // a remaining budget from the monotonic clock, and the timer truncates.
  if (timeoutMs !== undefined && !(timeoutMs > 0 && timeoutMs <= MAX_TIMEOUT_MS)) {
    throw new RangeError(`timeoutMs must be in (0, ${MAX_TIMEOUT_MS}]`);
  }
  if (options.capture !== 'file' || options.inherit) return execute(command, args, options);
  const scratch = resolve(import.meta.dirname, '../../.tmp');
  await mkdir(scratch, { recursive: true });
  const directory = await mkdtemp(resolve(scratch, 'capture-'));
  try {
    const stdout = await open(resolve(directory, 'stdout'), 'w');
    try {
      const stderr = await open(resolve(directory, 'stderr'), 'w');
      try {
        const result = await execute(command, args, options, [stdout.fd, stderr.fd]);
        return {
          ...result,
          stdout: await readFile(resolve(directory, 'stdout'), 'utf8'),
          stderr: await readFile(resolve(directory, 'stderr'), 'utf8'),
        };
      } finally {
        await stderr.close();
      }
    } finally {
      await stdout.close();
    }
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

function execute(
  command: string,
  args: readonly string[],
  options: RunOptions,
  files?: readonly [number, number],
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, [...args], {
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      ...(options.env === undefined ? {} : { env: options.env }),
      // Its own process group only when a deadline must kill the whole tree; otherwise
      // the child stays in the caller's group, so a Ctrl+C at the terminal reaches it.
      detached: options.timeoutMs !== undefined,
      stdio: [
        options.stdin === undefined ? (options.inherit ? 'inherit' : 'ignore') : 'pipe',
        files?.[0] ?? (options.inherit ? 'inherit' : 'pipe'),
        files?.[1] ?? (options.inherit ? 'inherit' : 'pipe'),
      ],
    });
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    child.stdout?.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk;
    });
    const timer =
      options.timeoutMs === undefined
        ? undefined
        : setTimeout(() => {
            timedOut = true;
            const failure = killGroup(child.pid);
            if (failure !== undefined) reject(failure);
          }, options.timeoutMs);
    child.on('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ code: timedOut ? 124 : (code ?? 1), stdout, stderr });
    });
    // A child that exits before consuming its input is handled by its exit status.
    child.stdin?.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code !== 'EPIPE') reject(error);
    });
    if (options.stdin !== undefined) child.stdin?.end(options.stdin);
  });
}

/**
 * Kills a detached child's whole process group. A group that has already exited
 * (`ESRCH`) is not a failure; any other error is returned for the caller to raise.
 *
 * @param pid - The group leader's pid, absent when the spawn itself failed
 * @param kill - The signal sender (injected by tests)
 * @returns The error to raise, or undefined
 */
export function killGroup(
  pid: number | undefined,
  kill: (pid: number, signal: NodeJS.Signals) => unknown = process.kill,
): unknown {
  if (pid === undefined) return undefined;
  try {
    kill(-pid, 'SIGKILL');
    return undefined;
  } catch (error) {
    return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ESRCH'
      ? undefined
      : error;
  }
}

/** Whether optional filesystem input was absent; other failures must propagate. */
export function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
