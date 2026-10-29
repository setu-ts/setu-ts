/**
 * Runs an external tool — `docker`, `kind`, `kubectl`, `git` — for the workspace commands.
 *
 * Injected through `CliDependencies` the way the port probe is, so the commands can be driven by a
 * recorder in tests and by this implementation in `main.ts`. No shell is involved: arguments reach
 * the tool exactly as given, and nothing a manifest contains can be interpreted as shell syntax.
 *
 * @module
 */

import { spawn } from 'node:child_process';

/** How one command runs. */
export interface RunCommandOptions {
  /** The directory it runs in. */
  readonly cwd: string;
  /**
   * Written to the child's stdin, which is then closed. This is how secret values reach `kubectl`:
   * never on the argument list, which other local users can read.
   */
  readonly input?: string;
  /**
   * Show the child's output on this terminal as it runs (image builds, rollouts) instead of
   * capturing it. A streamed result carries empty `stdout` and `stderr`.
   */
  readonly stream?: boolean;
}

/** What one command produced. */
export interface RunCommandResult {
  /** The exit code; 127 when the executable was not found. */
  readonly code: number;
  /** Captured standard output, or empty when streamed. */
  readonly stdout: string;
  /** Captured standard error, or empty when streamed. */
  readonly stderr: string;
}

/** Runs one command to completion. */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: RunCommandOptions,
) => Promise<RunCommandResult>;

/** The exit code a shell reports for a command it could not find. */
export const COMMAND_NOT_FOUND = 127;

/**
 * Creates the real runner over `node:child_process`.
 *
 * A missing executable resolves to {@linkcode COMMAND_NOT_FOUND} with a message naming it rather
 * than rejecting, so a workspace command can say "docker is not installed" instead of crashing.
 *
 * @param spawnImpl - The spawn function; tests pass a fake to reach the error branch
 * @returns The runner
 */
export function createCommandRunner(spawnImpl: typeof spawn = spawn): CommandRunner {
  return (command, args, options) =>
    new Promise((resolve) => {
      const child = spawnImpl(command, [...args], {
        cwd: options.cwd,
        stdio: [
          options.input === undefined ? 'ignore' : 'pipe',
          options.stream === true ? 'inherit' : 'pipe',
          options.stream === true ? 'inherit' : 'pipe',
        ],
      });
      let stdout = '';
      let stderr = '';
      child.stdout?.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
      child.stderr?.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
      child.once('error', (error: NodeJS.ErrnoException) => {
        resolve({
          code: error.code === 'ENOENT' ? COMMAND_NOT_FOUND : 1,
          stdout,
          stderr: error.code === 'ENOENT' ? `${command}: not found on PATH` : error.message,
        });
      });
      child.once('close', (code) => resolve({ code: code ?? 1, stdout, stderr }));
      // A child that exits without reading its stdin (kubectl refusing its arguments) makes the
      // write fail with EPIPE; unhandled, that error would crash the CLI instead of the command
      // reporting its exit code (measured).
      child.stdin?.on('error', () => {});
      if (options.input !== undefined) child.stdin?.end(options.input);
    });
}
