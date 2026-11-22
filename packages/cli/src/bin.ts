#!/usr/bin/env node
/**
 * The `setu` executable.
 *
 * The one module that runs on load, reached only through the package's `bin`
 * (AI_GUIDELINES §11.5). It sets `process.exitCode` rather than calling
 * `process.exit`, so output still being written to a pipe is not cut off.
 *
 * @module
 */

import process from 'node:process';
import { nodeFloorRefusal } from './utils/node-version.ts';

const refusal = nodeFloorRefusal(process.versions, 'Deno' in globalThis);
if (refusal !== undefined) {
  process.stderr.write(`${refusal}\n`);
  process.exitCode = 1;
} else {
  const { nodeProcess, nodeRuntime, runMain } = await import('./main.ts');
  process.exitCode = await runMain(nodeRuntime(), nodeProcess());
}
