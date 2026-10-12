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
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { nodeProcess, runMain } from './main.ts';

process.exitCode = await runMain(createNodeRuntimeServices(), nodeProcess());
