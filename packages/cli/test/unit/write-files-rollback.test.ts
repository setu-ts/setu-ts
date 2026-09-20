import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem } from '@setu-ts/common';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import { findExisting, writeFiles } from '../../src/utils/file-writer.ts';

describe('writeFiles rollback', () => {
  it('removes new files and nested directories after a partially written file rejects', async () => {
    const fs = createFakeFs();
    await fs.mkdir('project');
    const failure = new Error('disk full');
    const failing: IFileSystem = {
      ...fs,
      async writeFile(path, data) {
        await fs.writeFile(path, data.slice(0, 1));
        if (path.endsWith('b.ts')) throw failure;
      },
    };
    await expect(writeFiles(failing, [
      { path: 'project/src/deep/a.ts', contents: 'AAA' },
      { path: 'project/src/deep/b.ts', contents: 'BBB' },
    ])).rejects.toBe(failure);
    expect(fs.has('project/src/deep/a.ts')).toBe(false);
    expect(fs.has('project/src/deep/b.ts')).toBe(false);
    await expect(fs.stat('project/src/deep')).rejects.toThrow();
    await expect(fs.stat('project/src')).rejects.toThrow();
    expect((await fs.stat('project')).isDirectory).toBe(true);
  });

  it('restores original bytes, including the failed managed write, and permits retry', async () => {
    const fs = createFakeFs({ 'project/barrel.ts': 'old barrel' });
    const bytes = new Uint8Array([0, 255, 128, 1]);
    await fs.writeFile('project/binary', bytes);
    let failed = false;
    const failing: IFileSystem = {
      ...fs,
      async writeFile(path, data) {
        await fs.writeFile(path, data);
        if (path.endsWith('barrel.ts') && !failed) {
          failed = true;
          throw new Error('write interrupted');
        }
      },
    };
    const files = [
      { path: 'project/new.ts', contents: 'new' },
      { path: 'project/binary', contents: 'changed', managed: true },
      { path: 'project/barrel.ts', contents: 'new barrel', managed: true },
    ];
    await expect(writeFiles(failing, files)).rejects.toThrow('write interrupted');
    expect(await fs.readFile('project/binary')).toEqual(bytes);
    expect(fs.read('project/barrel.ts')).toBe('old barrel');
    expect(await findExisting(fs, files)).toEqual([]);
    await writeFiles(failing, files);
    expect(fs.read('project/barrel.ts')).toBe('new barrel');
  });

  it('preserves a file that arrived after preflight, even without managed', async () => {
    const fs = createFakeFs();
    const files = [{ path: 'arrived', contents: 'new' }, { path: 'failure', contents: 'x' }];
    expect(await findExisting(fs, files)).toEqual([]);
    await fs.writeFile('arrived', new TextEncoder().encode('concurrent file'));
    await expect(writeFiles({
      ...fs,
      writeFile: (path, data) =>
        path === 'failure' ? Promise.reject(new Error('disk full')) : fs.writeFile(path, data),
    }, files)).rejects.toThrow('disk full');
    expect(fs.read('arrived')).toBe('concurrent file');
  });

  it('does not overwrite an existing file it cannot snapshot', async () => {
    const fs = createFakeFs({ 'private': 'precious' });
    await expect(writeFiles({
      ...fs,
      readFile: () => Promise.reject(new Error('permission denied')),
    }, [{ path: 'private', contents: 'destroyed' }])).rejects.toThrow('permission denied');
    expect(fs.read('private')).toBe('precious');
    expect(fs.writes).toEqual([]);
  });

  it('reports all cleanup failures alongside the original and continues cleanup', async () => {
    const fs = createFakeFs({ 'managed': 'original' });
    let failed = false;
    const failing: IFileSystem = {
      ...fs,
      writeFile(path, data) {
        if (failed) return Promise.reject(new Error('restore denied'));
        if (path === 'fail') {
          failed = true;
          return Promise.reject(new Error('disk full'));
        }
        return fs.writeFile(path, data);
      },
      rm(path, options) {
        if (path === 'left') return Promise.reject(new Error('unlink denied'));
        return fs.rm(path, options);
      },
    };
    await expect(writeFiles(failing, [
      { path: 'removed', contents: 'a' },
      { path: 'left', contents: 'b' },
      { path: 'managed', contents: 'c', managed: true },
      { path: 'fail', contents: 'd' },
    ])).rejects.toThrow(
      /disk full[\s\S]*managed[\s\S]*restore denied[\s\S]*left[\s\S]*unlink denied/,
    );
    expect(fs.has('removed')).toBe(false);
  });
});

describe('rollback boundaries', () => {
  it('keeps a pre-existing empty parent and rolls back on mkdir failure', async () => {
    const fs = createFakeFs();
    await fs.mkdir('existing');
    await expect(writeFiles({
      ...fs,
      mkdir: (path, options) =>
        path === 'existing/blocked'
          ? Promise.reject(new Error('mkdir denied'))
          : fs.mkdir(path, options),
    }, [
      { path: 'existing/new/a', contents: 'a' },
      { path: 'existing/blocked/b', contents: 'b' },
    ])).rejects.toThrow('mkdir denied');
    expect((await fs.stat('existing')).isDirectory).toBe(true);
    await expect(fs.stat('existing/new')).rejects.toThrow();
    expect(fs.has('existing/new/a')).toBe(false);
  });

  it('propagates a stat access error instead of claiming an existing directory', async () => {
    const fs = createFakeFs();
    await expect(
      writeFiles({ ...fs, stat: () => Promise.reject(new Error('stat denied')) }, [{
        path: 'private/a',
        contents: 'a',
      }]),
    ).rejects.toThrow('stat denied');
    expect(fs.mkdirs).toEqual([]);
    expect(fs.writes).toEqual([]);
  });

  it('preserves new content in a directory and reports its non-recursive cleanup failure', async () => {
    const fs = createFakeFs();
    const calls: string[] = [];
    await expect(writeFiles({
      ...fs,
      writeFile: () => Promise.reject('original failure'),
      rm(path, options) {
        calls.push(path);
        expect(options?.recursive).not.toBe(true);
        if (path === 'new') return Promise.reject('not empty');
        return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
      },
    }, [{ path: 'new/a', contents: 'a' }])).rejects.toThrow(
      'original failure; rollback incomplete: new: not empty',
    );
    expect(calls).toEqual(['new/a', 'new']);
  });

  it('reports deletion failure for a new file and still removes the others', async () => {
    const fs = createFakeFs();
    await expect(writeFiles({
      ...fs,
      writeFile: () => Promise.reject(new Error('write denied')),
      rm: () => Promise.reject(new Error('rm denied')),
    }, [{ path: 'new', contents: 'a' }])).rejects.toThrow('new: rm denied');
  });

  it('restores an overwritten path that disappeared before rollback', async () => {
    const fs = createFakeFs({ original: 'original' });
    await expect(writeFiles({
      ...fs,
      async writeFile(path, bytes) {
        if (path === 'fail') {
          await fs.rm('original');
          throw new Error('disk full');
        }
        await fs.writeFile(path, bytes);
      },
    }, [{ path: 'original', contents: 'change' }, { path: 'fail', contents: '' }]))
      .rejects.toThrow('disk full');
    expect(fs.read('original')).toBe('original');
  });
});
