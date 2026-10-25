import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import {
  chmod,
  link,
  mkdir,
  readFile,
  readdir,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { tempDir } from '../../../../../test/node-helpers.ts';
import { MAX_EXISTING_FILE_BYTES, writeFiles } from '../../../src/utils/file-writer.ts';
import {
  regularFileWriteFlags,
  withRegularFileReads,
  writeRegularFile,
} from '../../../src/utils/node-regular-file.ts';

const exec = promisify(execFile);
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);
let root: string;
beforeEach(async () => {
  root = await tempDir({ prefix: 'm116-write-' });
});
afterEach(async () => {
  for (const entry of await readdir(root, { recursive: true }))
    expect(entry).not.toMatch(/\.setu-[a-f0-9]+\.tmp$/);
  await rm(root, { recursive: true, force: true });
});

describe('Node regular-file writer', () => {
  it('creates a new file and returns absent undo bytes', async () => {
    const path = `${root}/new`;
    expect(await writeRegularFile(path, bytes('new'), MAX_EXISTING_FILE_BYTES)).toEqual({
      before: undefined,
    });
    expect(await readFile(path, 'utf8')).toBe('new');
  });

  it.each(['', 'old contents longer than replacement'])(
    'replaces an existing file and returns its exact prior bytes: %j',
    async (before) => {
      const path = `${root}/existing`;
      await writeFile(path, before);
      await chmod(path, 0o640);
      expect(await writeRegularFile(path, bytes('new'), MAX_EXISTING_FILE_BYTES)).toEqual({
        before: bytes(before),
      });
      expect(await readFile(path, 'utf8')).toBe('new');
      if (process.platform !== 'win32') expect((await stat(path)).mode & 0o777).toBe(0o640);
    },
  );

  it('accepts exactly 1 MiB and replaces it with an empty file', async () => {
    const path = `${root}/boundary`;
    const before = new Uint8Array(MAX_EXISTING_FILE_BYTES).fill(65);
    await writeFile(path, before);
    expect(await writeRegularFile(path, new Uint8Array(), MAX_EXISTING_FILE_BYTES)).toEqual({
      before,
    });
    expect((await readFile(path)).length).toBe(0);
  });

  it.skipIf(process.platform === 'win32')(
    'drops setuid, setgid and sticky bits while preserving 0o777 permissions',
    async () => {
      const path = `${root}/special-mode`;
      await writeFile(path, 'old');
      await chmod(path, 0o7640);
      const beforeMode = (await stat(path)).mode;
      // Require real setgid/sticky bits; setuid is also exercised wherever retained by the host.
      expect(beforeMode & 0o3000).toBe(0o3000);
      expect(beforeMode & 0o777).toBe(0o640);
      expect(await writeRegularFile(path, bytes('new'), MAX_EXISTING_FILE_BYTES)).toEqual({
        before: bytes('old'),
      });
      const afterMode = (await stat(path)).mode;
      expect(afterMode & 0o7000).toBe(0);
      expect(afterMode & 0o777).toBe(beforeMode & 0o777);
      expect(await readFile(path, 'utf8')).toBe('new');
    },
  );

  it('refuses an oversize file without changing it', async () => {
    const path = `${root}/oversize`;
    const before = new Uint8Array(MAX_EXISTING_FILE_BYTES + 1).fill(65);
    await writeFile(path, before);
    await expect(writeRegularFile(path, bytes('new'), MAX_EXISTING_FILE_BYTES)).rejects.toThrow(
      'expected a regular file at most 1 MiB',
    );
    expect(await readFile(path)).toEqual(Buffer.from(before));
  });

  it.skipIf(process.platform === 'win32' || process.getuid?.() === 0)(
    'refuses a read-only file and leaves it unchanged',
    async () => {
      const target = `${root}/AGENTS.md`;
      await writeFile(target, 'read only');
      await chmod(target, 0o444);
      await expect(writeRegularFile(target, bytes('new'), MAX_EXISTING_FILE_BYTES)).rejects.toThrow(
        `${target}: not writable`,
      );
      expect(await readFile(target, 'utf8')).toBe('read only');
      expect((await stat(target)).mode & 0o777).toBe(0o444);
    },
  );

  it('refuses a directory', async () => {
    await expect(writeRegularFile(root, bytes('new'), MAX_EXISTING_FILE_BYTES)).rejects.toThrow();
  });

  it.skipIf(process.getuid?.() === 0)(
    'maps a permission failure creating the temp file without naming the temp file',
    async () => {
      const dir = `${root}/locked`;
      await mkdir(dir);
      await chmod(dir, 0o555);
      const target = `${dir}/file`;
      try {
        const failure = await writeRegularFile(target, bytes('new'), MAX_EXISTING_FILE_BYTES).then(
          () => undefined,
          (cause: unknown) => cause,
        );
        expect(failure).toBeInstanceOf(Error);
        expect((failure as Error).message).toBe(
          `${target}: permission denied creating a file in ${dir}`,
        );
        expect((failure as Error).message).not.toMatch(/\.setu-[a-f0-9]+\.tmp/);
        // `RegularFileWriteError` wraps the mapped message, which keeps the raw
        // errno one level deeper for diagnosis.
        expect((failure as { cause?: { cause?: { code?: string } } }).cause?.cause?.code).toBe(
          'EACCES',
        );
      } finally {
        await chmod(dir, 0o755);
      }
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a symlink to an outside file and preserves the outside bytes',
    async () => {
      const project = `${root}/project`;
      await mkdir(project);
      const victim = `${root}/outside`;
      await writeFile(victim, 'outside original');
      await symlink(victim, `${project}/AGENTS.md`);
      await expect(
        writeRegularFile(`${project}/AGENTS.md`, bytes('brief'), MAX_EXISTING_FILE_BYTES),
      ).rejects.toThrow('expected a regular file at most 1 MiB');
      expect(await readFile(victim, 'utf8')).toBe('outside original');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a hard link to an outside file and preserves the outside bytes',
    async () => {
      const project = `${root}/project`;
      await mkdir(project);
      const victim = `${root}/outside`;
      await writeFile(victim, 'outside original');
      await link(victim, `${project}/AGENTS.md`);
      await expect(
        writeRegularFile(`${project}/AGENTS.md`, bytes('brief'), MAX_EXISTING_FILE_BYTES),
      ).rejects.toThrow('expected a regular file at most 1 MiB');
      expect(await readFile(victim, 'utf8')).toBe('outside original');
    },
  );

  it.skipIf(process.platform === 'win32')(
    'refuses a FIFO promptly without hanging',
    async () => {
      const path = `${root}/pipe`;
      await exec('mkfifo', [path]);
      await expect(writeRegularFile(path, bytes('new'), MAX_EXISTING_FILE_BYTES)).rejects.toThrow(
        'expected a regular file at most 1 MiB',
      );
    },
    1500,
  );

  it('uses only available platform write flags', () => {
    expect(regularFileWriteFlags({ O_WRONLY: 1, O_CREAT: 2, O_EXCL: 4 })).toBe(7);
    expect(
      regularFileWriteFlags({
        O_WRONLY: 1,
        O_CREAT: 2,
        O_EXCL: 4,
        O_NOFOLLOW: 8,
        O_NOCTTY: 16,
      }),
    ).toBe(31);
  });
});

describe('writeFiles with the Node capability', () => {
  it.skipIf(process.platform === 'win32')(
    'refuses a leaf symlink swapped after preflight and rolls back earlier writes',
    async () => {
      const project = `${root}/project`;
      await mkdir(project);
      const target = `${project}/AGENTS.md`;
      const victim = `${root}/outside`;
      await writeFile(victim, 'outside original');
      await writeFile(target, 'old brief');
      await writeFile(`${project}/existing`, 'original');
      await writeFile(`${project}/empty`, '');
      const fs = withRegularFileReads(createNodeRuntimeServices().fs!);
      expect(fs.writeRegularFile).toBe(writeRegularFile);
      let swapped = false;
      const swapping = {
        ...fs,
        async stat(path: string) {
          // The first parent stat is AFTER every assertInsideProject preflight.
          if (!swapped) {
            swapped = true;
            await rm(target);
            await symlink(victim, target);
          }
          return fs.stat(path);
        },
      };
      const failure: unknown = await writeFiles(
        swapping,
        [
          { path: `${project}/existing`, contents: 'changed' },
          { path: `${project}/created/nested`, contents: 'created' },
          { path: `${project}/empty`, contents: 'changed empty' },
          { path: target, contents: 'ATTACK: brief written through symlink' },
        ],
        { root: project },
      ).catch((cause: unknown) => cause);
      expect(await readFile(victim, 'utf8'), 'outside file must remain unchanged').toBe(
        'outside original',
      );
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).toContain('expected a regular file at most 1 MiB');
      expect(await readFile(`${project}/existing`, 'utf8')).toBe('original');
      expect(await readFile(`${project}/empty`, 'utf8')).toBe('');
      await expect(readFile(`${project}/created/nested`)).rejects.toMatchObject({ code: 'ENOENT' });
      await expect(fs.stat(`${project}/created`)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it('reports created, updated and unchanged through the Node capability', async () => {
    const fs = withRegularFileReads(createNodeRuntimeServices().fs!);
    await writeFile(`${root}/existing`, 'old');
    await writeFile(`${root}/same`, 'same');
    expect(
      await writeFiles(
        fs,
        [
          { path: `${root}/new`, contents: 'new' },
          { path: `${root}/existing`, contents: 'new' },
          { path: `${root}/same`, contents: 'same' },
        ],
        { root },
      ),
    ).toEqual([
      { path: `${root}/new`, outcome: 'created' },
      { path: `${root}/existing`, outcome: 'updated' },
      { path: `${root}/same`, outcome: 'unchanged' },
    ]);
  });

  it.skipIf(process.platform === 'win32')(
    'refuses a rollback target swapped to a symlink without touching its victim',
    async () => {
      const project = `${root}/project`;
      await mkdir(project);
      const victim = `${root}/outside`;
      const existing = `${project}/existing`;
      const later = `${project}/later`;
      await writeFile(victim, 'outside original');
      await writeFile(existing, 'original');
      const fs = withRegularFileReads(createNodeRuntimeServices().fs!);
      const swapping = {
        ...fs,
        async writeRegularFile(path: string, data: Uint8Array, max: number) {
          if (path === later) {
            await rm(existing);
            await symlink(victim, existing);
            throw new Error('later write failed');
          }
          return writeRegularFile(path, data, max);
        },
      };
      await expect(
        writeFiles(
          swapping,
          [
            { path: existing, contents: 'changed' },
            { path: later, contents: 'fail' },
          ],
          { root: project },
        ),
      ).rejects.toThrow('rollback incomplete');
      expect(await readFile(victim, 'utf8')).toBe('outside original');
    },
  );
});
