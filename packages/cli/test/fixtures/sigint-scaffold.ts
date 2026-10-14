/**
 * Real process-boundary fixture, run on Node through `tsx` exactly as the `setu`
 * binary runs: it scaffolds through `runMain` + `nodeProcess` and reports two
 * moments a test can deliver SIGINT at.
 *
 * - `handled` / `unhandled`: pauses after the seventeenth real write and prints
 *   `WRITE17`. `unhandled` drops the runtime's signal registration, so Node's
 *   default SIGINT termination is the permanent negative control.
 * - `prompt`: answers as an interactive terminal and prints `PROMPTING` while a
 *   question waits on stdin, so the interrupt arrives with a prompt pending.
 *
 * Usage: `node --import <source hooks> --import tsx/esm sigint-scaffold.ts <root> <mode>`
 *
 * @module
 */
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { nodeProcess, runMain } from '../../src/main.ts';

const [root, mode] = process.argv.slice(2);
if (root === undefined || mode === undefined) throw new Error('usage: <root> <mode>');

const runtime = createNodeRuntimeServices();
const fs = runtime.fs!;
let writes = 0;
const slowed = {
  ...runtime,
  fs: {
    ...fs,
    async writeFile(path: string, data: Uint8Array): Promise<void> {
      await fs.writeFile(path, data);
      writes += 1;
      if (writes === 17) {
        console.log('WRITE17');
        await new Promise<void>((resolve) => runtime.setTimeout(resolve, 250));
      }
    },
  },
};
const { onSignal, ...unhandled } = slowed;
if (onSignal === undefined) throw new Error('SIGINT fixture requires runtime signal support');
const selected = mode === 'unhandled' ? unhandled : { ...unhandled, onSignal };

const boundary = nodeProcess();
const host =
  mode === 'prompt'
    ? {
        ...boundary,
        args: ['new', 'app'],
        isTerminal: () => true,
        prompt: (message: string, signal?: AbortSignal) => {
          console.log('PROMPTING');
          return boundary.prompt(message, signal);
        },
      }
    : { ...boundary, args: ['new', 'app', '--template', 'full-stack', '--yes'] };

process.exitCode = await runMain(selected, { ...host, cwd: () => root, log: () => {} });
