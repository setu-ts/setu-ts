import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

const exec = promisify(execFile);
let root: string;
beforeAll(async () => {
  const scratch = resolve(process.env['M116_TEST_SCRATCH'] ?? '.tmp');
  await mkdir(scratch, { recursive: true });
  root = await mkdtemp(`${scratch}/m116-agents-special-`);
});
afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(process.platform === 'win32')(
  'agents executable with special project files',
  () => {
    for (const name of ['wrangler.toml', 'package.json']) {
      for (const kind of ['fifo', 'device']) {
        it(`finishes with ${name} symlinked to ${kind}`, async () => {
          const dir = `${root}/${name}-${kind}`;
          await mkdir(dir);
          if (name !== 'package.json') await writeFile(`${dir}/package.json`, '{}');
          const target = kind === 'fifo' ? `${dir}/pipe` : '/dev/zero';
          if (kind === 'fifo') await exec('mkfifo', [target]);
          await symlink(target, `${dir}/${name}`);
          const result = await exec(
            process.execPath,
            [
              '--import',
              './scripts/lib/source-register.ts',
              'packages/cli/src/bin.ts',
              'agents',
              '--dir',
              dir,
              '--dry-run',
            ],
            { timeout: 2500, killSignal: 'SIGKILL', maxBuffer: 64 * 1024 },
          ).then(
            (output) => ({ ...output, code: 0, killed: false }),
            (
              cause: Error & { code?: number; killed?: boolean; stdout?: string; stderr?: string },
            ) => cause,
          );
          expect(result.killed, 'CLI must finish within the subprocess deadline').toBe(false);
          if (name === 'wrangler.toml') {
            expect(result.code).toBe(0);
            expect(result.stdout).toContain(`would create ${dir}/AGENTS.md`);
          } else {
            expect(result.code).toBe(1);
            // Since M120 (audit F1) the link itself is refused before the special
            // file behind it is ever opened.
            expect(result.stderr).toContain('is a symbolic link; Setu does not read through links');
          }
        }, 4000);
      }
    }
  },
);
