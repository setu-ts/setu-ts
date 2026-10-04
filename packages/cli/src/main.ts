/**
 * The `setu` executable entry point.
 *
 * This module owns the process boundary, while {@linkcode runMain} keeps that
 * boundary import-safe and directly testable.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import { runCli } from './cli.ts';
import { EXIT_ERROR } from './constants.ts';
import { createTerminalPrompter } from './prompt.ts';

/** @ignore Runtime capabilities used by the executable boundary. */
export interface MainRuntime {
  readonly fs?: IFileSystem;
  readonly now: () => number;
  readonly onSignal?: (signal: 'SIGINT', handler: () => void) => void;
}

/** @ignore Host process operations used by the executable boundary. */
export interface MainProcess {
  readonly args: readonly string[];
  readonly cwd: () => string;
  readonly isTerminal: () => boolean;
  readonly prompt: (message: string) => string | null;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  readonly portAvailable: (port: number) => Promise<boolean>;
}

/** @ignore Runs the CLI boundary and returns the code the host should exit with. */
export async function runMain(runtime: MainRuntime, process: MainProcess): Promise<number> {
  const interruption = new AbortController();
  runtime.onSignal?.('SIGINT', () => interruption.abort());

  if (runtime.fs === undefined) {
    process.error('setu requires filesystem access. Re-run with --allow-read --allow-write.');
    return EXIT_ERROR;
  }

  const prompter = process.isTerminal()
    ? createTerminalPrompter(
      process.isTerminal,
      process.prompt,
      process.log,
      interruption.signal,
    )
    : undefined;

  return await runCli(process.args, {
    fs: runtime.fs,
    cwd: process.cwd(),
    now: runtime.now,
    log: process.log,
    error: process.error,
    interrupt: interruption.signal,
    ...(prompter === undefined ? {} : { ask: prompter }),
    portAvailable: process.portAvailable,
  });
}

/** @ignore Builds the real Deno process adapter used by the executable invocation. */
export function denoProcess(): MainProcess {
  return {
    args: Deno.args,
    cwd: Deno.cwd,
    isTerminal: () => Deno.stdin.isTerminal(),
    prompt: (message) => prompt(message),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
    portAvailable: (port) => {
      try {
        const listener = Deno.listen({ hostname: '127.0.0.1', port });
        listener.close();
        return Promise.resolve(true);
      } catch {
        return Promise.resolve(false);
      }
    },
  };
}

if (import.meta.main) {
  Deno.exit(await runMain(createDenoRuntimeServices(), denoProcess()));
}
