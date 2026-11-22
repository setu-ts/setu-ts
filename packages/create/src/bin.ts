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
 * Loads `setu new` and runs it with the caller's arguments.
 *
 * @returns The invocation's exit code
 */
async function start(): Promise<number> {
  const { nodeProcess, nodeRuntime, runMain } = await import('@setu-ts/cli/main');
  const { createArgs } = await import('./index.ts');
  const host = nodeProcess();
  return await runMain(nodeRuntime(), { ...host, args: createArgs(host.args) });
}

const refusal = nodeFloorRefusal(process.versions, 'Deno' in globalThis);
process.exitCode = refusal === undefined ? await start() : refuse(refusal);
