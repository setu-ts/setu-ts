import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, it } from 'vitest';
import { runCli } from '../../src/cli.ts';
import { createFakeFs } from '../fixtures/fake-fs.ts';

const hasBun = spawnSync('bun', ['--version']).status === 0;

for (const runtime of ['node', 'bun'] as const) {
  it(
    `V13-154 native runner handles empty matches and library-only delegation on ${runtime}`,
    { skip: runtime === 'bun' && !hasBun, timeout: 60_000 },
    async () => {
      const fs = createFakeFs();
      expect(
        await runCli(['new', 'ws', '--workspace', '--runtime', runtime], {
          fs,
          cwd: '/work',
          now: () => 0,
          log: () => {},
          error: () => {},
        }),
      ).toBe(0);
      await mkdir('.tmp', { recursive: true });
      const root = await mkdtemp(resolve('.tmp/workspace-tests-'));
      try {
        await mkdir(`${root}/scripts`);
        await writeFile(`${root}/scripts/test.mjs`, fs.read('/work/ws/scripts/test.mjs'));
        await writeFile(`${root}/package.json`, fs.read('/work/ws/package.json'));
        const run = () =>
          spawnSync(runtime === 'node' ? process.execPath : 'bun', ['scripts/test.mjs'], {
            cwd: root,
            encoding: 'utf8',
            timeout: 30_000,
          });
        const empty = run();
        expect(empty.status, empty.stdout + empty.stderr).toBe(0);
        expect(empty.stdout).toContain('No members or libraries yet; nothing to test.');
        await mkdir(`${root}/apps/empty`, { recursive: true });
        await mkdir(`${root}/libs`);
        await writeFile(`${root}/libs/not-a-directory`, 'user file');
        const unmatched = run();
        expect(unmatched.status, unmatched.stdout + unmatched.stderr).toBe(0);
        expect(unmatched.stdout).toContain('No members or libraries yet; nothing to test.');
        await mkdir(`${root}/libs/only`);
        await writeFile(
          `${root}/libs/only/package.json`,
          JSON.stringify({
            name: '@fixture/only',
            private: true,
            scripts: { test: 'node proof.mjs' },
          }),
        );
        await writeFile(
          `${root}/libs/only/proof.mjs`,
          "throw new Error('library delegation failed');\n",
        );
        const failed = run();
        expect(failed.status, failed.stdout + failed.stderr).not.toBe(0);
        expect(failed.stdout + failed.stderr).toContain('library delegation failed');
        await writeFile(
          `${root}/libs/only/proof.mjs`,
          "process.stdout.write('library delegation passed\\n');\n",
        );
        const passed = run();
        expect(passed.status, passed.stdout + passed.stderr).toBe(0);
        expect(passed.stdout).toContain('library delegation passed');
        expect(passed.stdout).not.toContain('nothing to test');
      } finally {
        await rm(root, { recursive: true });
      }
    },
  );
}
