/**
 * CLI executable entry point. This is the only file that calls Deno.exit().
 *
 * @module
 */

import { runCli } from './cli.ts';

// The wrapper is intentionally minimal to allow testing without process termination.
// All logic lives in runCli; this just invokes it and exits with the return code.
Deno.exit(await runCli(Deno.args));
