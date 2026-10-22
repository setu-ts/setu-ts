import { link, mkdir, open, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { createNodeRuntimeServices } from '@setu-ts/runtime';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../../../test/node-helpers.ts';
import { writeFiles } from '../../../src/utils/file-writer.ts';
import { withRegularFileReads, writeRegularFile } from '../../../src/utils/node-regular-file.ts';

const hooks = vi.hoisted(() => ({
  opened: undefined as ((path: string, handle: FileHandle) => void | Promise<void>) | undefined,
}));
vi.mock('node:fs/promises', async (original) => {
  const real = await original<typeof import('node:fs/promises')>();
  return {
    ...real,
    open: async (...args: Parameters<typeof real.open>) => {
      const handle = await real.open(...args);
      await hooks.opened?.(String(args[0]), handle);
      return handle;
    },
  };
});

let root: string;
beforeEach(async () => {
  root = await tempDir({ prefix: 'm116-race-' });
});
afterEach(async () => {
  hooks.opened = undefined;
  expect((await readdir(root)).filter((name) => name.includes('.setu-'))).toEqual([]);
  await rm(root, { recursive: true, force: true });
});
const bytes = (text: string): Uint8Array => new TextEncoder().encode(text);

describe.skipIf(process.platform === 'win32')('real-inode hard-link races', () => {
  it('snapshot close failure precedes mutation and writeFiles does not try to undo the untouched target', async () => {
    const target = `${root}/AGENTS.md`;
    await writeFile(target, 'prior brief');
    const cause = new Error('snapshot close failed');
    const opened: string[] = [];
    hooks.opened = (path, handle) => {
      opened.push(path);
      if (path !== target) return;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        throw cause;
      };
    };
    const fs = withRegularFileReads(createNodeRuntimeServices().fs!);
    const write = vi.fn(writeRegularFile);
    const remove = vi.fn(fs.rm);
    await expect(
      writeFiles(
        { ...fs, writeRegularFile: write, rm: remove },
        [{ path: target, contents: 'replacement' }],
        { root },
      ),
    ).rejects.toBe(cause);
    expect(write).toHaveBeenCalledOnce();
    expect(remove).not.toHaveBeenCalled();
    expect(opened).toEqual([target]);
    expect(await readFile(target, 'utf8')).toBe('prior brief');
  });

  it('R4-2 never writes the victim when its target link is unlinked between open and fstat', async () => {
    const victim = `${root}/victim`;
    const target = `${root}/AGENTS.md`;
    await writeFile(victim, 'victim original');
    await link(victim, target);
    hooks.opened = async (path) => {
      if (path === target) await rm(target);
    };
    expect(await writeRegularFile(target, bytes('ATTACKER'), 1024)).toEqual({
      before: bytes('victim original'),
    });
    expect(await readFile(victim, 'utf8')).toBe('victim original');
    expect(await readFile(target, 'utf8')).toBe('ATTACKER');
  });

  it('replaces a hard-linked name planted after snapshot read without writing through it', async () => {
    const victim = `${root}/victim`;
    const target = `${root}/AGENTS.md`;
    await writeFile(victim, 'victim original');
    await writeFile(target, 'prior brief');
    hooks.opened = (path, handle) => {
      if (path !== target) return;
      const close = handle.close.bind(handle);
      handle.close = async () => {
        await close();
        await rm(target);
        await link(victim, target);
      };
    };
    expect(await writeRegularFile(target, bytes('ATTACKER'), 1024)).toEqual({
      before: bytes('prior brief'),
    });
    expect(await readFile(victim, 'utf8')).toBe('victim original');
    expect(await readFile(target, 'utf8')).toBe('ATTACKER');
  });

  it('removes its real temp after rename fails', async () => {
    const target = `${root}/AGENTS.md`;
    hooks.opened = async (path) => {
      if (path.includes('.setu-')) await mkdir(target);
    };
    await expect(writeRegularFile(target, bytes('brief'), 1024)).rejects.toMatchObject({
      name: 'RegularFileWriteError',
      before: undefined,
    });
    expect(await readdir(target)).toEqual([]);
  });

  it('the hook uses real filesystem handles', async () => {
    const handle = await open(`${root}/control`, 'w');
    await handle.close();
    expect(await readdir(root)).toEqual(['control']);
  });
});
