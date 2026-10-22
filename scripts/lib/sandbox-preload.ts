/**
 * `--import` entry for the documentation sandboxes: installs the builtin guards
 * before any document code runs. The logic lives in `sandbox.ts`, where it is
 * unit-tested; this entry is exercised end to end by the gates' own tests.
 *
 * @module
 */

import { registerHooks } from 'node:module';
import { installSandboxGuards } from './sandbox.ts';

installSandboxGuards(registerHooks, process);
