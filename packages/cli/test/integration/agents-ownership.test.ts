import { chmod, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/node-helpers.ts';
import { runCli } from '../../src/cli.ts';
import { withRegularFileReads } from '../../src/utils/node-regular-file.ts';

let root: string;
beforeEach(async () => {
  root = await tempDir({ prefix: 'm116-ownership-' });
  await mkdir(`${root}/apps/a`, { recursive: true });
  await mkdir(`${root}/apps/b`);
  await writeFile(
    `${root}/setu.workspace.json`,
    JSON.stringify({
      version: 1,
      runtime: 'node',
      transport: 'http',
      basePort: 3000,
      members: [
        { name: 'a', port: 3000 },
        { name: 'b', port: 3001 },
      ],
    }),
  );
  for (const member of ['a', 'b']) await writeFile(`${root}/apps/${member}/package.json`, '{}');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(typeof process.getuid !== 'function' || process.platform === 'win32')(
  'Node adoption ownership',
  () => {
    it('refuses a real other-writable member before writing any brief', async () => {
      await chmod(`${root}/apps/b`, 0o757);
      const fs = withRegularFileReads(createNodeRuntimeServices().fs!);
      expect(await fs.directoryOwnership!(`${root}/apps/b`)).toMatchObject({
        uid: process.getuid?.(),
        isDirectory: true,
        isSymbolicLink: false,
      });
      const errors: string[] = [];
      const run = () =>
        runCli(['agents'], {
          fs,
          cwd: `${root}/apps/a`,
          now: () => 0,
          log: () => {},
          error: (message) => errors.push(message),
        });
      expect(await run()).toBe(1);
      expect(errors).toEqual([
        `${root}/apps/b: writable by others; run \`setu agents\` in a workspace you own`,
      ]);
      expect(await readdir(root)).toEqual(['apps', 'setu.workspace.json']);
      for (const member of ['a', 'b'])
        expect(await readdir(`${root}/apps/${member}`)).toEqual(['package.json']);
      await chmod(`${root}/apps/b`, 0o755);
      errors.length = 0;
      expect(await run()).toBe(0);
      expect(errors).toEqual([]);
      expect(await readFile(`${root}/AGENTS.md`, 'utf8')).toContain('setu-agents:begin');
      for (const member of ['a', 'b'])
        expect(await readFile(`${root}/apps/${member}/AGENTS.md`, 'utf8')).toContain(
          'setu-agents:begin',
        );
    });
  },
);
