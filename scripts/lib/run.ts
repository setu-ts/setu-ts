import { spawn } from 'node:child_process';

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
}

/** Run one command; a deadline kills its whole process group and returns code 124. */
export function run(
  command: string,
  args: readonly string[],
  options: RunOptions = {},
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
        options.inherit ? 'inherit' : 'pipe',
        options.inherit ? 'inherit' : 'pipe',
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
            if (child.pid !== undefined) {
              try {
                process.kill(-child.pid, 'SIGKILL');
              } catch (error) {
                if (!(
                  typeof error === 'object' &&
                  error !== null &&
                  'code' in error &&
                  error.code === 'ESRCH'
                ))
                  reject(error);
              }
            }
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

/** Whether optional filesystem input was absent; other failures must propagate. */
export function isNotFound(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT';
}
