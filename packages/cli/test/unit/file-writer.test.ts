import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createFakeFs } from '../fixtures/fake-fs.ts';
import type { IFileSystem } from '@setu-ts/common';
import {
  assertInsideProject,
  dirName,
  findExisting,
  firstDuplicatePath,
  interruptedRunRetryHint,
  joinPath,
  PathEscapesProjectError,
  resolveDir,
  writeFiles,
} from '../../src/utils/file-writer.ts';

describe('firstDuplicatePath', () => {
  // The overwrite check probes the filesystem, so it cannot see a path planned
  // twice within one plan — both would be written and the last would win.
  it('finds a path planned twice', () => {
    expect(firstDuplicatePath([
      { path: 'deno.json', contents: '{}' },
      { path: 'main.ts', contents: '' },
      { path: 'deno.json', contents: 'overwrites the framework manifest' },
    ])).toBe('deno.json');
  });

  it('returns the FIRST duplicate when there are several', () => {
    expect(firstDuplicatePath([
      { path: 'a', contents: '' },
      { path: 'b', contents: '' },
      { path: 'a', contents: '' },
      { path: 'b', contents: '' },
    ])).toBe('a');
  });

  it('returns undefined for a distinct plan', () => {
    expect(firstDuplicatePath([
      { path: 'deno.json', contents: '' },
      { path: 'main.ts', contents: '' },
    ])).toBeUndefined();
  });

  it('returns undefined for an empty plan', () => {
    expect(firstDuplicatePath([])).toBeUndefined();
  });
});

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

  // The `/./` used to survive into the resolved path. Nothing failed loudly —
  // every filesystem call honours it — but it reached every path the CLI PRINTS,
  // and `setu adopt` derives its member name from the last segment, so `--dir .`
  // produced a member literally called `.` and a conversion that died on `mkdir
  // apps/.`.
  it('anchors a dot-relative --dir to the cwd, resolving the dots', () => {
    expect(resolveDir('/work', './proj/nested')).toBe('/work/proj/nested');
    expect(resolveDir('/work/svc', '.')).toBe('/work/svc');
    expect(resolveDir('/work/svc', '..')).toBe('/work');
  });

  // What every filesystem does with `/..`: a path cannot climb above the root.
  it('cannot be walked above the filesystem root', () => {
    expect(resolveDir('/work', '../../..')).toBe('/');
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

  it('skips an existing file the schematic marks managed', async () => {
    // The aggregate module barrel has to be rewritten whenever a module is
    // added, so the CLI declares it owns that path.
    const fs = createFakeFs({ 'src/modules/index.ts': 'old barrel' });

    const found = await findExisting(fs, [
      { path: 'src/modules/index.ts', contents: 'new barrel', managed: true },
    ]);

    expect(found).toEqual([]);
  });

  it('still reports an unmanaged existing file beside a managed one', async () => {
    // The exemption is per file, not per command: a module whose own controller
    // already exists must still refuse, even though the barrel is exempt.
    const fs = createFakeFs({
      'src/modules/index.ts': 'old barrel',
      'src/modules/user/user.controller.ts': 'mine',
    });

    const found = await findExisting(fs, [
      { path: 'src/modules/user/user.controller.ts', contents: 'new' },
      { path: 'src/modules/index.ts', contents: 'new barrel', managed: true },
    ]);

    expect(found).toEqual(['src/modules/user/user.controller.ts']);
  });

  it('reports an existing file whose managed flag is explicitly false', async () => {
    const fs = createFakeFs({ 'a.ts': 'old' });

    const found = await findExisting(fs, [{ path: 'a.ts', contents: 'x', managed: false }]);

    expect(found).toEqual(['a.ts']);
  });

  it('propagates an unreadable target instead of treating it as absent', async () => {
    const fs = createFakeFs({ private: 'keep' });
    await expect(findExisting({
      ...fs,
      stat: () => Promise.reject(new Error('permission denied')),
    }, [{ path: 'private', contents: 'new' }])).rejects.toThrow('permission denied');
  });
});

describe('interruptedRunRetryHint', () => {
  it('offers cleanup only when every collision is inside the directory the run would create', () => {
    expect(interruptedRunRetryHint(
      ['/work/app/deno.json', '/work/app/src/main.ts'],
      '/work/app',
    )).toContain('delete /work/app');
    expect(interruptedRunRetryHint(
      ['/work/app/deno.json', '/work/keep.txt'],
      '/work/app',
    )).toBeUndefined();
    expect(interruptedRunRetryHint([], '/work/app')).toBeUndefined();
  });
});

describe('writeFiles', () => {
  it('classifies created, updated, and unchanged files', async () => {
    const fs = createFakeFs({ 'updated.ts': 'before', 'same.ts': 'same' });
    expect(
      await writeFiles(fs, [
        { path: 'created.ts', contents: 'new' },
        { path: 'updated.ts', contents: 'after' },
        { path: 'same.ts', contents: 'same' },
      ], { root: '/' }),
    ).toEqual([
      { path: 'created.ts', outcome: 'created' },
      { path: 'updated.ts', outcome: 'updated' },
      { path: 'same.ts', outcome: 'unchanged' },
    ]);
  });
  it('writes every file in order', async () => {
    const fs = createFakeFs();
    await writeFiles(fs, [
      { path: 'src/a.ts', contents: 'A' },
      { path: 'src/b.ts', contents: 'B' },
    ], { root: '/' });
    expect(fs.writes).toEqual(['src/a.ts', 'src/b.ts']);
    expect(fs.read('src/a.ts')).toBe('A');
    expect(fs.read('src/b.ts')).toBe('B');
  });

  it('creates each missing directory individually, once', async () => {
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
      { path: 'src/controllers/c.ts', contents: 'C' },
    ], { root: '/' });
    expect(fs.mkdirs).toEqual(['src', 'src/services', 'src/controllers']);
    expect(recursive).toBe(false);
  });

  it('does not mkdir for a file with no parent directory', async () => {
    const fs = createFakeFs();
    await writeFiles(fs, [{ path: 'deno.json', contents: '{}' }], { root: '/' });
    expect(fs.mkdirs).toEqual([]);
    expect(fs.read('deno.json')).toBe('{}');
  });

  it('propagates a filesystem failure', async () => {
    const fs = createFakeFs();
    const failing = {
      ...fs,
      writeFile: () => Promise.reject(new Error('disk full')),
    };
    await expect(writeFiles(failing, [{ path: 'a.ts', contents: 'A' }], { root: '/' }))
      .rejects.toThrow('disk full');
  });
});

describe('assertInsideProject (M101f re-audit N9/N10)', () => {
  const base = { ...createFakeFs({ '/p/a.ts': 'a' }) };

  it('accepts a path that resolves to its own place under the root', async () => {
    await assertInsideProject(base, '/p', '/p/a.ts');
    await assertInsideProject(base, '/p', '/p/new/dir/file.ts');
  });

  it('refuses a target lexically outside the root, including through ..', async () => {
    await expect(assertInsideProject(base, '/p', '/q/a.ts')).rejects.toThrow('is outside');
    await expect(assertInsideProject(base, '/p', '/p/../q/a.ts')).rejects.toThrow('is outside');
  });

  it('fails closed when the filesystem cannot resolve links', async () => {
    const bare: IFileSystem = { ...base };
    delete bare.realPath;
    await expect(assertInsideProject(bare, '/p', '/p/a.ts')).rejects.toThrow(
      'cannot resolve links',
    );
  });

  it('refuses a target that resolves elsewhere through a link', async () => {
    const linked: IFileSystem = {
      ...base,
      realPath: (path) =>
        path === '/p/a.ts' ? Promise.resolve('/elsewhere/a.ts') : base.realPath!(path),
    };
    await expect(assertInsideProject(linked, '/p', '/p/a.ts')).rejects.toBeInstanceOf(
      PathEscapesProjectError,
    );
  });

  it('refuses a dangling link instead of treating it as absent', async () => {
    const dangling: IFileSystem = {
      ...base,
      readdir: (path) => path === '/p' ? Promise.resolve(['a.ts', 'ghost']) : base.readdir(path),
    };
    await expect(assertInsideProject(dangling, '/p', '/p/ghost')).rejects.toThrow(
      'link to something that does not exist',
    );
  });

  it('reports a resolution failure that is not absence, escaped to one line', async () => {
    const looping: IFileSystem = {
      ...base,
      realPath: () => Promise.reject(new Error('ELOOP: too many links\nsetu: FORGED')),
    };
    const failure = await assertInsideProject(looping, '/p', '/p/a.ts').then(
      () => '',
      (error: Error) => error.message,
    );
    expect(failure).toContain('Cannot resolve');
    expect(failure).not.toContain('\n');
  });

  it('ignores an unlistable parent and resolves the next ancestor', async () => {
    const unlistable: IFileSystem = {
      ...base,
      readdir: () => Promise.reject(new Error('EACCES')),
    };
    await assertInsideProject(unlistable, '/p', '/p/missing/file.ts');
  });

  it('refuses the whole batch before the first write', async () => {
    const fs = createFakeFs({ '/p/a.ts': 'a' });
    const linked: IFileSystem = {
      ...fs,
      realPath: (path) =>
        path === '/p/b.ts' ? Promise.resolve('/elsewhere/b.ts') : fs.realPath!(path),
      stat: (path) =>
        path === '/p/b.ts'
          ? Promise.resolve({ isFile: true, isDirectory: false, size: 1 })
          : fs.stat(path),
    };
    await expect(
      writeFiles(linked, [{ path: '/p/a.ts', contents: 'A' }, { path: '/p/b.ts', contents: 'B' }], {
        root: '/p',
      }),
    ).rejects.toBeInstanceOf(PathEscapesProjectError);
    expect(fs.writes).toEqual([]);
  });
});
