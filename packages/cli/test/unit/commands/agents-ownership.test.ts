import { describe, expect, it } from 'vitest';
import { runCli } from '../../../src/cli.ts';
import type { ICliFileSystem } from '../../../src/utils/file-writer.ts';
import { createFakeFs, createRecorder } from '../../fixtures/fake-fs.ts';

const manifest = JSON.stringify({
  version: 1,
  basePort: 3000,
  runtime: 'node',
  transport: 'http',
  members: [
    { name: 'a', port: 3000 },
    { name: 'b', port: 3001 },
  ],
});
const owned = { uid: 123, mode: 0o755, isSymbolicLink: false, isDirectory: true };
type Ownership = typeof owned;

function harness(overrides: Record<string, Partial<Ownership>> = {}, seam = true, uid = true) {
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
            return Promise.resolve({ ...owned, ...overrides[path] });
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

describe('ancestor workspace adoption ownership', () => {
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

  it('leaves direct workspace-root invocation unchanged', async () => {
    const h = harness({ '/work/apps/b': { uid: 456 } });
    expect(await h.run('/work')).toBe(0);
    expect(h.seen).toEqual([]);
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
