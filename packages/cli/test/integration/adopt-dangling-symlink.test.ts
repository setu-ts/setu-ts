/**
 * `setu adopt` against a committed dangling symlink, on a REAL filesystem.
 *
 * Git commits a symlink as readily as a file, so cloned content alone can put
 * one under `src/`. Walking it made `fs.stat` throw, the error escaped every
 * caller, and the runtime printed the uncaught error with the link's raw name —
 * a name that can carry a line feed (M101f re-audit N8). A fake filesystem
 * cannot produce a dangling link, so this drives the real one.
 *
 * @module
 */

import { afterEach, beforeEach, describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createDenoRuntimeServices } from '@setu-ts/runtime';
import { createRecorder } from '../fixtures/fake-fs.ts';
import { parseArgs } from '../../src/args.ts';
import { runAdoptCommand } from '../../src/commands/adopt.ts';

const fs = createDenoRuntimeServices().fs!;
let root = '';

beforeEach(async () => {
  root = await Deno.makeTempDir({ prefix: 'setu-adopt-symlink-' });
  await Deno.writeTextFile(
    `${root}/deno.json`,
    JSON.stringify({ tasks: { start: 'deno run -A main.ts' } }),
  );
  await Deno.writeTextFile(`${root}/setu.config.ts`, 'export function createApp() {}\n');
  await Deno.writeTextFile(`${root}/main.ts`, "import { createApp } from './setu.config.ts';\n");
  await Deno.mkdir(`${root}/src`);
  await Deno.writeTextFile(`${root}/src/ok.ts`, 'export const ok = 1;\n');
  await Deno.symlink(`${root}/does-not-exist`, `${root}/src/evil\nsetu: FORGED`);
});

afterEach(async () => {
  await Deno.remove(root, { recursive: true }).catch(() => {});
});

describe('adopt with a dangling symlink under an adopted directory', () => {
  for (const dryRun of [true, false]) {
    it(`refuses by name on one line and writes nothing (${dryRun ? 'dry run' : 'real run'})`, async () => {
      const out = createRecorder();
      const code = await runAdoptCommand(
        parseArgs(['--name', 'orders', ...(dryRun ? ['--dry-run'] : [])]),
        { fs, cwd: root, log: out.sink, error: out.sink },
      );
      expect(code).toBe(1);
      expect(out.text()).toContain('Cannot read every file under');
      expect(out.text()).toContain('evil\\u000asetu: FORGED');
      for (const line of out.lines) {
        expect(line.split('\n').some((part) => part.startsWith('setu: FORGED'))).toBe(false);
      }
      // Refused before any move: the real file is still where it was.
      expect(await Deno.readTextFile(`${root}/src/ok.ts`)).toBe('export const ok = 1;\n');
      await expect(Deno.stat(`${root}/setu.workspace.json`)).rejects.toThrow();
    });
  }
});
