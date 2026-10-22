import { chmod, mkdir, readFile, readdir, rm, symlink, writeFile } from 'node:fs/promises';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../test/node-helpers.ts';
import { runCli } from '../../src/cli.ts';
import { withRegularFileReads } from '../../src/utils/node-regular-file.ts';
import { escapeName } from '../../src/utils/names.ts';
import type { ICliFileSystem } from '../../src/utils/file-writer.ts';

const workspace = {
  version: 1,
  runtime: 'node',
  transport: 'http',
  basePort: 3000,
  members: [
    { name: 'a', port: 3000 },
    { name: 'b', port: 3001 },
  ],
};

let root: string;
beforeEach(async () => {
  root = await tempDir({ prefix: 'm116-ownership-' });
  await mkdir(`${root}/apps/a`, { recursive: true, mode: 0o755 });
  await mkdir(`${root}/apps/b`, { mode: 0o755 });
  await writeFile(`${root}/setu.workspace.json`, JSON.stringify(workspace));
  for (const member of ['a', 'b']) await writeFile(`${root}/apps/${member}/package.json`, '{}');
});
afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe.skipIf(typeof process.getuid !== 'function' || process.platform === 'win32')(
  'Node agents workspace ownership',
  () => {
    it('trusts a real chain you own even when others can write it (the git model)', async () => {
      // umask 002 leaves every directory 0775; permission bits are not checked, only owners.
      for (const dir of [root, `${root}/apps`, `${root}/apps/a`, `${root}/apps/b`])
        await chmod(dir, 0o777);
      const fs = withRegularFileReads(createNodeRuntimeServices().fs!);
      const errors: string[] = [];
      const code = await runCli(['agents'], {
        fs,
        cwd: `${root}/apps/a`,
        now: () => 0,
        log: () => {},
        error: (message) => errors.push(message),
      });
      expect(errors).toEqual([]);
      expect(code).toBe(0);
      expect(await readFile(`${root}/AGENTS.md`, 'utf8')).toContain('setu-agents:begin');
    });

    it.each(['member', 'root'] as const)(
      'refuses a real symlinked member from the %s before writing any brief',
      async (from) => {
        await rm(`${root}/apps/b`, { recursive: true });
        await mkdir(`${root}/elsewhere`, { mode: 0o755 });
        await writeFile(`${root}/elsewhere/package.json`, '{}');
        await symlink(`${root}/elsewhere`, `${root}/apps/b`);
        const fs = withRegularFileReads(createNodeRuntimeServices().fs!);
        expect(await fs.directoryOwnership!(`${root}/apps/b`)).toMatchObject({
          uid: process.getuid?.(),
          isSymbolicLink: true,
        });
        const errors: string[] = [];
        const run = () =>
          runCli(['agents'], {
            fs,
            cwd: from === 'root' ? root : `${root}/apps/a`,
            now: () => 0,
            log: () => {},
            error: (message) => errors.push(message),
          });
        expect(await run()).toBe(1);
        expect(errors).toEqual([
          `${root}/apps/b: symlink; run \`setu agents\` in a workspace you own`,
        ]);
        expect(await readdir(root)).toEqual(['apps', 'elsewhere', 'setu.workspace.json']);
        for (const member of ['a', 'b'])
          expect(await readdir(`${root}/apps/${member}`)).toEqual(['package.json']);
        await rm(`${root}/apps/b`);
        await mkdir(`${root}/apps/b`, { mode: 0o755 });
        await writeFile(`${root}/apps/b/package.json`, '{}');
        errors.length = 0;
        expect(await run()).toBe(0);
        expect(errors).toEqual([]);
        expect(await readFile(`${root}/AGENTS.md`, 'utf8')).toContain('setu-agents:begin');
        for (const member of ['a', 'b'])
          expect(await readFile(`${root}/apps/${member}/AGENTS.md`, 'utf8')).toContain(
            'setu-agents:begin',
          );
      },
    );

    it('checks a missing real member via its existing ancestor', async () => {
      await writeFile(
        `${root}/setu.workspace.json`,
        JSON.stringify({
          ...workspace,
          members: [{ name: 'b', port: 3001 }],
        }),
      );
      await rm(`${root}/apps/b`, { recursive: true });
      const fs = withRegularFileReads(createNodeRuntimeServices().fs!);
      const seen: string[] = [];
      const errors: string[] = [];
      const checkedFs: ICliFileSystem = {
        ...fs,
        directoryOwnership: (path) => {
          seen.push(path);
          return fs.directoryOwnership!(path);
        },
      };
      const result = await runCli(['agents'], {
        fs: checkedFs,
        cwd: root,
        now: () => 0,
        log: () => {},
        error: (message) => errors.push(message),
      });
      expect(seen).toContain(`${root}/apps/b`);
      expect(seen).toContain(`${root}/apps`);
      expect(result).toBe(1);
      expect(await readdir(root)).toEqual(['apps', 'setu.workspace.json']);
      expect(await readdir(`${root}/apps`)).toEqual(['a']);
      expect(await readdir(`${root}/apps/a`)).toEqual(['package.json']);
      expect(errors).toEqual([`${root}/apps/b: not a project`]);
      expect(errors.join('\n')).not.toMatch(
        /cannot check directory ownership|workspace you own|ENOENT/,
      );
    });

    it('passes ownership through missing real directories, then refuses the missing project', async () => {
      await rm(`${root}/apps`, { recursive: true });
      const errors: string[] = [];
      expect(
        await runCli(['agents'], {
          fs: withRegularFileReads(createNodeRuntimeServices().fs!),
          cwd: root,
          now: () => 0,
          log: () => {},
          error: (message) => errors.push(message),
        }),
      ).toBe(1);
      expect(errors).toEqual([`${root}/apps/a: not a project`]);
      expect(errors.join('\n')).not.toMatch(
        /cannot check directory ownership|workspace you own|ENOENT/,
      );
      expect(await readdir(root)).toEqual(['setu.workspace.json']);
    });

    it('escapes another seam error in a real workspace refusal', async () => {
      const unusual = `${root}/line\n\u001b[31m`;
      await mkdir(unusual, { mode: 0o755 });
      await writeFile(`${unusual}/setu.workspace.json`, JSON.stringify(workspace));
      const fs = withRegularFileReads(createNodeRuntimeServices().fs!);
      const refusingFs: ICliFileSystem = {
        ...fs,
        directoryOwnership: () =>
          Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
      };
      const errors: string[] = [];
      expect(
        await runCli(['agents'], {
          fs: refusingFs,
          cwd: unusual,
          now: () => 0,
          log: () => {},
          error: (message) => errors.push(message),
        }),
      ).toBe(1);
      expect(errors).toEqual([
        `${escapeName(unusual)}: cannot check directory ownership; run \`setu agents\` in a workspace you own`,
      ]);
      expect(await readdir(unusual)).toEqual(['setu.workspace.json']);
    });
  },
);
