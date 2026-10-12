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
import { nodeProcess, runMain } from '@setu-ts/cli/main';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { createArgs } from './index.ts';

const host = nodeProcess();
process.exitCode = await runMain(createNodeRuntimeServices(), {
  ...host,
  args: createArgs(host.args),
});
