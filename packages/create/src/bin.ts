#!/usr/bin/env node
/**
 * The `npm create @setu-ts` executable: `setu new` with the caller's arguments.
 *
 * Reached only through the package's `bin` (AI_GUIDELINES §11.5). Like `setu`,
 * it sets `process.exitCode` rather than calling `process.exit`, so output
 * still being written to a pipe is not cut off.
 *
 * @module
 */

import process from 'node:process';
import { nodeFloorRefusal } from '@setu-ts/cli/node-version';

const refusal = nodeFloorRefusal(process.versions, 'Deno' in globalThis);
if (refusal !== undefined) {
  process.stderr.write(`${refusal}\n`);
  process.exitCode = 1;
} else {
  const { nodeProcess, nodeRuntime, runMain } = await import('@setu-ts/cli/main');
  const { createArgs } = await import('./index.ts');
  const host = nodeProcess();
  process.exitCode = await runMain(nodeRuntime(), {
    ...host,
    args: createArgs(host.args),
  });
}
