import { describe, expect, it } from 'vitest';
import { mkdir, rm, stat, symlink, writeFile } from 'node:fs/promises';
import { tempDir } from '../../../../test/node-helpers.ts';
import { createNodeRuntimeServices } from '../../src/adapters/node/node-runtime.ts';

describe('Node filesystem removal against the real host', () => {
  it('removes an empty directory without recursive, refuses a nonempty one, and never follows a symlink', async () => {
    const root = await tempDir();
    const fs = createNodeRuntimeServices().fs!;
    try {
      await mkdir(`${root}/empty`);
      await fs.rm(`${root}/empty`);
      await expect(stat(`${root}/empty`)).rejects.toThrow('ENOENT');
      await mkdir(`${root}/full`);
      await writeFile(`${root}/full/kept.txt`, 'keep');
      await expect(fs.rm(`${root}/full`)).rejects.toThrow();
      expect((await stat(`${root}/full/kept.txt`)).isFile()).toBe(true);
      await symlink(`${root}/full`, `${root}/link`, 'dir');
      await fs.rm(`${root}/link`);
      expect((await stat(`${root}/full/kept.txt`)).isFile()).toBe(true);
      await fs.rm(`${root}/full`, { recursive: true });
      await expect(stat(`${root}/full`)).rejects.toThrow('ENOENT');
      await expect(fs.rm(`${root}/absent`)).rejects.toThrow('ENOENT');
    } finally {
      await rm(root, { recursive: true });
    }
  });
});
