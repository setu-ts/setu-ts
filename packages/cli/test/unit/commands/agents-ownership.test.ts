import { describe, expect, it } from 'vitest';
import { runCli } from '../../../src/cli.ts';
import type { ICliFileSystem } from '../../../src/utils/file-writer.ts';
import { assertAgentWorkspaceOwnership } from '../../../src/utils/agent-workspace-ownership.ts';
import { createFakeFs, createRecorder } from '../../fixtures/fake-fs.ts';

const workspace = {
  version: 1,
  basePort: 3000,
  runtime: 'node',
  transport: 'http',
  members: [
    { name: 'a', port: 3000 },
    { name: 'b', port: 3001 },
  ],
};
const manifest = JSON.stringify(workspace);
const owned = { uid: 123, mode: 0o755, isSymbolicLink: false, isDirectory: true };
type Ownership = typeof owned;

function harness(
  overrides: Record<string, Partial<Ownership> | Error> = {},
  seam = true,
  uid = true,
) {
  const fs = createFakeFs({
    '/work/setu.workspace.json': manifest,
    '/work/apps/a/package.json': '{}',
    '/work/apps/b/package.json': '{}',
  });
  const seen: string[] = [];
  const capable: ICliFileSystem = {
    ...fs,
    ...(uid ? { invokingUid: 123 } : {}),
    ...(seam
      ? {
          directoryOwnership: (path: string) => {
            seen.push(path);
            const override = overrides[path];
            return override instanceof Error
              ? Promise.reject(override)
              : Promise.resolve({ ...owned, ...override });
          },
        }
      : {}),
  };
  const error = createRecorder();
  return {
    fs,
    seen,
    error,
    run: (dir = '/work/apps/a') =>
      runCli(['agents', '--dir', dir], {
        fs: capable,
        cwd: '/work/apps/a',
        now: () => 0,
        log: () => {},
        error: error.sink,
      }),
  };
}

describe('agents workspace ownership', () => {
  it('adopts an owned chain, checking every parent to / once', async () => {
    const h = harness();
    expect(await h.run()).toBe(0);
    expect(h.fs.writes).toEqual([
      '/work/AGENTS.md',
      '/work/apps/a/AGENTS.md',
      '/work/apps/b/AGENTS.md',
    ]);
    expect(new Set(h.seen)).toEqual(
      new Set(['/work', '/', '/work/apps', '/work/apps/a', '/work/apps/b']),
    );
    expect(h.seen.length).toBe(5);
  });

  it.each([
    ['/work/apps/b', { uid: 456 }, 'not owned by you'],
    ['/work/apps/b', { mode: 0o757 }, 'writable by others'],
    ['/work/apps', { mode: 0o775 }, 'writable by others'],
    ['/work', { uid: 0, mode: 0o777 }, 'writable by others'],
    ['/work/apps/b', { uid: 123, mode: 0o1777 }, 'writable by others'],
    ['/work/apps/b', { isSymbolicLink: true }, 'symlink'],
    ['/work/apps/b', { isDirectory: false }, 'not a directory'],
    ['/', { uid: 456 }, 'not owned by you'],
  ] as const)('refuses %s (%j), writes nothing and exits 1', async (path, override, reason) => {
    const h = harness({ [path]: override });
    expect(await h.run()).toBe(1);
    expect(h.fs.writes).toEqual([]);
    expect(h.fs.mkdirs).toEqual([]);
    expect(h.error.lines).toEqual([
      `${path}: ${reason}; run \`setu agents\` in a workspace you own`,
    ]);
  });

  it('allows a root-owned sticky writable directory and root-owned normal ancestors', async () => {
    const h = harness({ '/work': { uid: 0, mode: 0o1777 }, '/': { uid: 0 } });
    expect(await h.run()).toBe(0);
  });

  it.each([
    [false, true],
    [true, false],
  ])('skips without seam=%s or uid=%s', async (seam, uid) => {
    const h = harness({ '/work/apps/b': { uid: 456 } }, seam, uid);
    expect(await h.run()).toBe(0);
    expect(h.seen).toEqual([]);
  });

  it('refuses an other-writable member from the direct workspace root', async () => {
    const h = harness({ '/work/apps/b': { mode: 0o757 } });
    expect(await h.run('/work')).toBe(1);
    expect(h.fs.writes).toEqual([]);
    expect(h.fs.mkdirs).toEqual([]);
    expect(h.seen).toContain('/work/apps/b');
    expect(h.error.lines).toEqual([
      '/work/apps/b: writable by others; run `setu agents` in a workspace you own',
    ]);
  });

  it('writes every brief from an owned direct workspace root', async () => {
    const h = harness();
    expect(await h.run('/work')).toBe(0);
    expect(h.seen).toContain('/work/apps/b');
    expect(h.fs.writes).toEqual([
      '/work/AGENTS.md',
      '/work/apps/a/AGENTS.md',
      '/work/apps/b/AGENTS.md',
    ]);
  });

  it.each([false, true])(
    'checks a missing member via its nearest existing ancestor (writable=%s)',
    async (writable) => {
      const h = harness({
        '/work/apps/b': Object.assign(new Error('missing b'), { code: 'ENOENT' }),
        '/work/apps': { mode: writable ? 0o757 : 0o755 },
      });
      await h.fs.writeFile(
        '/work/setu.workspace.json',
        new TextEncoder().encode(
          JSON.stringify({ ...workspace, members: [{ name: 'b', port: 3001 }] }),
        ),
      );
      await h.fs.rm('/work/apps/b/package.json');
      const writesBefore = [...h.fs.writes];
      expect(await h.run('/work')).toBe(1);
      expect(h.fs.writes).toEqual(writesBefore);
      expect(h.fs.mkdirs).toEqual([]);
      if (writable) {
        expect(h.error.lines).toEqual([
          '/work/apps: writable by others; run `setu agents` in a workspace you own',
        ]);
      } else {
        expect(h.seen).toEqual(['/work', '/', '/work/apps/b', '/work/apps']);
        expect(h.error.lines).toEqual(['/work/apps/b: not a project']);
        expect(h.error.lines.join('\n')).not.toMatch(
          /cannot check directory ownership|workspace you own|ENOENT/,
        );
      }
    },
  );

  it('passes ownership through multiple missing directories, then refuses the missing project', async () => {
    const h = harness({
      '/work/apps/a': Object.assign(new Error('missing a'), { code: 'ENOENT' }),
      '/work/apps/b': Object.assign(new Error('missing b'), { code: 'ENOENT' }),
      '/work/apps': Object.assign(new Error('missing apps'), { code: 'ENOENT' }),
    });
    await h.fs.rm('/work/apps/a/package.json');
    await h.fs.rm('/work/apps/b/package.json');
    expect(await h.run('/work')).toBe(1);
    expect(h.seen).toEqual([
      '/work',
      '/',
      '/work/apps/a',
      '/work/apps',
      '/work/apps/b',
      '/work/apps',
    ]);
    expect(h.fs.writes).toEqual([]);
    expect(h.fs.mkdirs).toEqual([]);
    expect(h.error.lines).toEqual(['/work/apps/a: not a project']);
    expect(h.error.lines.join('\n')).not.toMatch(
      /cannot check directory ownership|workspace you own|ENOENT/,
    );
  });

  it.each(['/work/apps/missing', '/work/apps/missing/nested'])(
    'allows ownership validation alone for %s through its existing ancestor',
    async (path) => {
      const seen: string[] = [];
      const fs: ICliFileSystem = {
        ...createFakeFs(),
        invokingUid: 123,
        directoryOwnership: (directory) => {
          seen.push(directory);
          if (directory === '/work/apps/missing' || directory === path)
            return Promise.reject(Object.assign(new Error('missing'), { code: 'ENOENT' }));
          return Promise.resolve(owned);
        },
      };
      await expect(assertAgentWorkspaceOwnership(fs, [path])).resolves.toBeUndefined();
      expect(seen).toContain('/work/apps');
      expect(seen.at(-1)).toBe('/');
    },
  );

  it('refuses when even the filesystem root is missing from the seam', async () => {
    const h = harness({ '/': Object.assign(new Error('missing root'), { code: 'ENOENT' }) });
    expect(await h.run('/work')).toBe(1);
    expect(h.fs.writes).toEqual([]);
    expect(h.error.lines).toEqual([
      '/: cannot check directory ownership; run `setu agents` in a workspace you own',
    ]);
  });

  it('escapes a refused directory name into one terminal line', async () => {
    const root = '/work\n\u001b[31m';
    const fs: ICliFileSystem = {
      ...createFakeFs({ [`${root}/setu.workspace.json`]: manifest }),
      invokingUid: 123,
      directoryOwnership: () => Promise.resolve({ ...owned, uid: 456 }),
    };
    const error = createRecorder();
    expect(
      await runCli(['agents'], {
        fs,
        cwd: `${root}/apps/a`,
        now: () => 0,
        log: () => {},
        error: error.sink,
      }),
    ).toBe(1);
    expect(error.lines).toEqual([
      '/work\\u000a\\u001b[31m: not owned by you; run `setu agents` in a workspace you own',
    ]);
  });

  it('reports another seam error as an escaped refusal', async () => {
    const root = '/work\n\u001b[31m';
    const base = createFakeFs({ [`${root}/setu.workspace.json`]: manifest });
    const fs: ICliFileSystem = {
      ...base,
      invokingUid: 123,
      directoryOwnership: () =>
        Promise.reject(Object.assign(new Error('denied'), { code: 'EACCES' })),
    };
    const error = createRecorder();
    expect(
      await runCli(['agents'], {
        fs,
        cwd: root,
        now: () => 0,
        log: () => {},
        error: error.sink,
      }),
    ).toBe(1);
    expect(base.writes).toEqual([]);
    expect(base.mkdirs).toEqual([]);
    expect(error.lines).toEqual([
      '/work\\u000a\\u001b[31m: cannot check directory ownership; run `setu agents` in a workspace you own',
    ]);
  });

  it('does not check ownership for a standalone project', async () => {
    const base = createFakeFs({ '/project/package.json': '{}' });
    const seen: string[] = [];
    const fs: ICliFileSystem = {
      ...base,
      invokingUid: 123,
      directoryOwnership: (path) => {
        seen.push(path);
        return Promise.resolve({ ...owned, uid: 456 });
      },
    };
    expect(
      await runCli(['agents'], {
        fs,
        cwd: '/project',
        now: () => 0,
        log: () => {},
        error: () => {},
      }),
    ).toBe(0);
    expect(seen).toEqual([]);
    expect(base.writes).toEqual(['/project/AGENTS.md']);
  });
});
