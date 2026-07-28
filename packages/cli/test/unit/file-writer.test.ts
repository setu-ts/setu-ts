import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import {
  dirName,
  findExisting,
  joinPath,
  resolveDir,
  writeFiles,
} from '../../src/utils/file-writer.ts';

describe('joinPath', () => {
  it('joins relative segments', () => {
    expect(joinPath('src', 'services', 'a.ts')).toBe('src/services/a.ts');
  });

  it('preserves a leading slash', () => {
    expect(joinPath('/tmp/app', 'src/a.ts')).toBe('/tmp/app/src/a.ts');
  });

  it('collapses repeated separators', () => {
    expect(joinPath('/tmp//app/', '/src/a.ts')).toBe('/tmp/app/src/a.ts');
  });

  it('ignores empty segments', () => {
    expect(joinPath('', 'src', '', 'a.ts')).toBe('src/a.ts');
  });

  it('returns an empty string for no segments', () => {
    expect(joinPath()).toBe('');
  });
});

describe('resolveDir', () => {
  it('returns the cwd when no --dir was supplied', () => {
    expect(resolveDir('/work')).toBe('/work');
  });

  it('returns the cwd for an empty --dir', () => {
    expect(resolveDir('/work', '')).toBe('/work');
  });

  it('passes an absolute --dir through, normalized', () => {
    expect(resolveDir('/work', '/tmp//sandbox/')).toBe('/tmp/sandbox');
  });

  it('anchors a relative --dir to the cwd', () => {
    // Regression: a relative --dir used to reach `import()` as `/proj/...`,
    // resolving against the filesystem ROOT instead of the cwd.
    expect(resolveDir('/work', 'proj')).toBe('/work/proj');
  });

  it('anchors a dot-relative --dir to the cwd', () => {
    expect(resolveDir('/work', './proj/nested')).toBe('/work/./proj/nested');
  });
});

describe('dirName', () => {
  it('returns the parent of a nested path', () => {
    expect(dirName('/tmp/app/src/a.ts')).toBe('/tmp/app/src');
  });

  it('returns an empty string when there is no parent', () => {
    expect(dirName('a.ts')).toBe('');
  });

  it('returns / for a root-level path', () => {
    expect(dirName('/a.ts')).toBe('/');
  });
});

describe('findExisting', () => {
  it('returns an empty list when nothing exists', async () => {
    const fs = createFakeFs();
    const found = await findExisting(fs, [{ path: 'a.ts', contents: 'x' }]);
    expect(found).toEqual([]);
  });

  it('returns only the paths that already exist, in plan order', async () => {
    const fs = createFakeFs({ 'b.ts': 'old' });
    const found = await findExisting(fs, [
      { path: 'a.ts', contents: 'x' },
      { path: 'b.ts', contents: 'y' },
      { path: 'c.ts', contents: 'z' },
    ]);
    expect(found).toEqual(['b.ts']);
  });
});

describe('writeFiles', () => {
  it('writes every file in order', async () => {
    const fs = createFakeFs();
    await writeFiles(fs, [
      { path: 'src/a.ts', contents: 'A' },
      { path: 'src/b.ts', contents: 'B' },
    ]);
    expect(fs.writes).toEqual(['src/a.ts', 'src/b.ts']);
    expect(fs.read('src/a.ts')).toBe('A');
    expect(fs.read('src/b.ts')).toBe('B');
  });

  it('creates each parent directory recursively, once', async () => {
    const fs = createFakeFs();
    let recursive = false;
    const spy = {
      ...fs,
      mkdir: (path: string, options?: { readonly recursive?: boolean }) => {
        recursive = options?.recursive === true;
        return fs.mkdir(path, options);
      },
    };
    await writeFiles(spy, [
      { path: 'src/services/a.ts', contents: 'A' },
      { path: 'src/services/b.ts', contents: 'B' },
      { path: 'src/routes/c.ts', contents: 'C' },
    ]);
    expect(fs.mkdirs).toEqual(['src/services', 'src/routes']);
    expect(recursive).toBe(true);
  });

  it('does not mkdir for a file with no parent directory', async () => {
    const fs = createFakeFs();
    await writeFiles(fs, [{ path: 'deno.json', contents: '{}' }]);
    expect(fs.mkdirs).toEqual([]);
    expect(fs.read('deno.json')).toBe('{}');
  });

  it('propagates a filesystem failure', async () => {
    const fs = createFakeFs();
    const failing = {
      ...fs,
      writeFile: () => Promise.reject(new Error('disk full')),
    };
    await expect(writeFiles(failing, [{ path: 'a.ts', contents: 'A' }]))
      .rejects.toThrow('disk full');
  });
});
