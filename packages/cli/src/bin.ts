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

/**
 * Writes the floor refusal.
 *
 * @param message - The refusal from nodeFloorRefusal
 * @returns The exit code, 1
 */
function refuse(message: string): number {
  process.stderr.write(`${message}\n`);
  return 1;
}

/**
 * Loads the command modules and runs one invocation.
 *
 * @returns The invocation's exit code
 */
async function start(): Promise<number> {
  const { nodeProcess, nodeRuntime, runMain } = await import('./main.ts');
  return await runMain(nodeRuntime(), nodeProcess());
}

const refusal = nodeFloorRefusal(process.versions, 'Deno' in globalThis);
process.exitCode = refusal === undefined ? await start() : refuse(refusal);
