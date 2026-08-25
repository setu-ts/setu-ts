/**
 * The `setu` executable entry point.
 *
 * This is the one module that owns the process boundary: `Deno.args`,
 * `Deno.cwd()`, `console`, the real filesystem, and the single `Deno.exit`.
 * Everything else takes those as injected dependencies and is therefore
 * testable without terminating the test runner.
 *
 * @module
 */

import { createDenoRuntimeServices } from '@setu-ts/runtime';
import { runCli } from './cli.ts';
import { EXIT_ERROR } from './constants.ts';
import { createTerminalPrompter } from './prompt.ts';

const runtime = createDenoRuntimeServices();

if (runtime.fs === undefined) {
  console.error('setu requires filesystem access. Re-run with --allow-read --allow-write.');
  Deno.exit(EXIT_ERROR);
}

// Prompting is supplied ONLY behind isTerminal(): a human's non-interactive
// shell, CI, and every script fall through to the documented defaults rather
// than being asked anything. This is the SECOND line of defense — the primary
// guarantee is that `ask` is optional and no programmatic caller passes it, and
// the third is `prompt()`'s own measured null return on a non-terminal.
const prompter = Deno.stdin.isTerminal()
  ? createTerminalPrompter(() => Deno.stdin.isTerminal(), prompt, console.log)
  : undefined;

Deno.exit(
  await runCli(Deno.args, {
    fs: runtime.fs,
    cwd: Deno.cwd(),
    now: () => runtime.now(),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
    ...(prompter === undefined ? {} : { ask: prompter }),
    portAvailable: (port: number): Promise<boolean> => {
      try {
        const listener = Deno.listen({ hostname: '127.0.0.1', port });
        listener.close();
        return Promise.resolve(true);
      } catch {
        return Promise.resolve(false);
      }
    },
  }),
);
