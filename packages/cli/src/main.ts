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

const runtime = createDenoRuntimeServices();

if (runtime.fs === undefined) {
  console.error('setu requires filesystem access. Re-run with --allow-read --allow-write.');
  Deno.exit(EXIT_ERROR);
}

Deno.exit(
  await runCli(Deno.args, {
    fs: runtime.fs,
    cwd: Deno.cwd(),
    now: () => runtime.now(),
    log: (message) => console.log(message),
    error: (message) => console.error(message),
  }),
);
