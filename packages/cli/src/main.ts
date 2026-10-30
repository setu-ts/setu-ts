/**
 * The `setu` process boundary on Node.
 *
 * {@linkcode runMain} owns everything a run needs from its host and returns the
 * exit code; {@linkcode nodeProcess} is the real host. The executable entry,
 * `src/bin.ts`, joins the two, and is the only module that runs on load.
 *
 * @module
 */

import process from 'node:process';
import { createServer } from 'node:net';
import type { IFileSystem } from '@setu-ts/common';
import { runCli } from './cli.ts';
import { EXIT_ERROR } from './constants.ts';
import { createTerminalPrompter } from './prompt.ts';
import { createLineReader } from './terminal-line.ts';
import { logicalCwdFor } from './utils/logical-cwd.ts';
import { createCommandRunner, type CommandRunner } from './utils/run-command.ts';

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
  /**
   * Reads one answer, resolving `null` when there is none — EOF, an
   * interrupt, or the signal aborting first.
   */
  readonly prompt: (message: string, signal?: AbortSignal) => Promise<string | null>;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  readonly portAvailable: (port: number) => Promise<boolean>;
  /** Runs an external tool for `setu workspace build|deploy` (M122). */
  readonly runCommand?: CommandRunner;
  /** Releases anything the host opened for the run (the terminal reader). */
  readonly dispose?: () => void;
}

/** @ignore Runs the CLI boundary and returns the code the host should exit with. */
export async function runMain(runtime: MainRuntime, host: MainProcess): Promise<number> {
  const interruption = new AbortController();
  runtime.onSignal?.('SIGINT', () => interruption.abort());

  if (runtime.fs === undefined) {
    host.error('setu requires filesystem access.');
    return EXIT_ERROR;
  }

  const prompter = host.isTerminal()
    ? createTerminalPrompter(host.isTerminal, host.prompt, host.log, interruption.signal)
    : undefined;
  const cwd = host.cwd();
  const logicalCwd = logicalCwdFor(cwd);

  try {
    return await runCli(host.args, {
      fs: runtime.fs,
      cwd,
      ...(logicalCwd === undefined ? {} : { logicalCwd }),
      now: runtime.now,
      log: host.log,
      error: host.error,
      interrupt: interruption.signal,
      ...(prompter === undefined ? {} : { ask: prompter }),
      portAvailable: host.portAvailable,
      ...(host.runCommand === undefined ? {} : { runCommand: host.runCommand }),
    });
  } finally {
    host.dispose?.();
  }
}

/**
 * @ignore Builds the real Node process adapter used by the executable.
 *
 * A Ctrl+C typed at a question arrives inside `readline` as a keystroke, not as
 * a process signal, so it is delivered as one: emitting the `SIGINT` EVENT runs
 * the handler {@linkcode runMain} registered, which aborts the run exactly as an
 * outside signal would, so there is one interrupt path rather than two. It is
 * an event, never `process.kill`: a real signal terminates the process outright
 * on Windows, and on any platform where no handler was registered.
 *
 * @param onInterrupt - Replaces the event; for tests
 */
export function nodeProcess(onInterrupt: () => void = emitInterrupt): MainProcess {
  const reader = createLineReader({
    input: process.stdin,
    output: process.stdout,
    terminal: process.stdin.isTTY === true,
    onInterrupt,
  });
  return {
    args: process.argv.slice(2),
    cwd: () => process.cwd(),
    isTerminal: () => process.stdin.isTTY === true,
    prompt: (message, signal) => reader.read(message, signal),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
    portAvailable: (port) => portIsFree(port),
    runCommand: createCommandRunner(),
    dispose: () => reader.close(),
  };
}

/**
 * @ignore Delivers an interrupt to this process's `SIGINT` handlers as an event.
 *
 * Never a real signal: `process.kill(process.pid, 'SIGINT')` terminates the
 * process outright on Windows, and on any platform where no handler was
 * registered, before output drains or cleanup runs.
 */
export function emitInterrupt(): void {
  process.emit('SIGINT', 'SIGINT');
}

/** Whether nothing is listening on a loopback port, decided by binding it. */
function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.once('error', () => resolve(false));
    try {
      server.listen({ host: '127.0.0.1', port }, () => {
        server.close(() => resolve(true));
      });
    } catch {
      // An out-of-range port throws synchronously rather than emitting
      // `'error'`; it is not a port anything can bind either.
      resolve(false);
    }
  });
}
