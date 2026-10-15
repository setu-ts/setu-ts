import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { run } from '../../scripts/lib/run.ts';
import {
  DENIED_BUILTINS,
  escapingSymlinks,
  installSandboxGuards,
  isDeniedBuiltin,
  SANDBOX_READ_PATHS,
  sandboxReadFlags,
  trackedSymlinks,
} from '../../scripts/lib/sandbox.ts';

const none = (): Promise<never[]> => Promise.resolve([]);

describe('documentation sandbox read grants', () => {
  it('grants the import paths and any extra path, resolved against the root', async () => {
    expect(await sandboxReadFlags('/repo', ['.tmp/scratch'], none)).toEqual([
      ...SANDBOX_READ_PATHS.map((path) => `--allow-fs-read=/repo/${path}`),
      '--allow-fs-read=/repo/.tmp/scratch',
    ]);
  });

  it('never grants the repository root, .git or an environment file', () => {
    expect(SANDBOX_READ_PATHS).not.toContain('.');
    expect(
      SANDBOX_READ_PATHS.some((path) => path.startsWith('.git') || path.includes('.env')),
    ).toBe(false);
  });

  it('refuses to build flags while a tracked symlink escapes the grants', async () => {
    const links = () => Promise.resolve([{ path: 'packages/x/leak', target: '../../.git/config' }]);
    await expect(sandboxReadFlags('/repo', [], links)).rejects.toThrow('packages/x/leak');
  });

  it('accepts the repository as it is committed', async () => {
    await expect(sandboxReadFlags(process.cwd())).resolves.toHaveLength(SANDBOX_READ_PATHS.length);
  });
});

describe('escapingSymlinks', () => {
  it('reports an escaping link inside the grants and ignores the rest', () => {
    expect(
      escapingSymlinks(
        [
          { path: 'packages/a/up', target: '../../README.md' },
          { path: 'packages/a/abs', target: '/etc/passwd' },
          { path: 'packages/a/out', target: '../../../../outside' },
          { path: 'packages/a/inside', target: '../b/src/index.ts' },
          { path: 'packages/a/nm', target: '../../node_modules/x' },
          { path: 'docs/link', target: '../.git/config' },
          { path: '.tmp/scratch/ok', target: '../../packages/a' },
        ],
        ['.tmp/scratch'],
      ),
    ).toEqual(['packages/a/up', 'packages/a/abs', 'packages/a/out']);
  });

  it('treats a link onto a granted file as inside', () => {
    expect(escapingSymlinks([{ path: 'packages/a/pkg', target: '../../package.json' }])).toEqual(
      [],
    );
  });
});

describe('trackedSymlinks', () => {
  it('reads tracked symlinks and their stored targets from git', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-links-'));
    try {
      const git = (...args: string[]) => run('git', args, { cwd: root });
      await git('init', '-q');
      await mkdir(join(root, 'packages'));
      await writeFile(join(root, 'packages/file.txt'), 'x');
      await symlink('../.git/config', join(root, 'packages/leak'));
      await git('add', '.');
      expect(await trackedSymlinks(root)).toEqual([
        { path: 'packages/leak', target: '../.git/config' },
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  it('fails when git cannot list the repository', async () => {
    const root = await mkdtemp(join(tmpdir(), 'sandbox-nogit-'));
    try {
      await expect(trackedSymlinks(root)).rejects.toThrow('git ls-files failed');
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe('sandbox builtin guards', () => {
  it('names a denied builtin with or without the node: scheme', () => {
    for (const id of DENIED_BUILTINS) {
      expect(isDeniedBuiltin(id)).toBe(true);
      expect(isDeniedBuiltin(`node:${id}`)).toBe(true);
    }
    expect(isDeniedBuiltin('node:fs')).toBe(false);
    expect(isDeniedBuiltin('sqlite-wrapper')).toBe(false);
  });

  it('refuses denied builtins on resolution and getBuiltinModule, and locks the replacement', () => {
    type Hooks = Parameters<Parameters<typeof installSandboxGuards>[0]>[0];
    let hooks: Hooks | undefined;
    const target = { getBuiltinModule: (id: string) => ({ id }) as never };
    installSandboxGuards((options) => {
      hooks = options;
      return { deregister() {} };
    }, target);

    const next = ((specifier: string) => ({ url: specifier, shortCircuit: true })) as never;
    expect(() => hooks?.resolve?.('node:sqlite', {} as never, next)).toThrow(
      expect.objectContaining({ code: 'ERR_ACCESS_DENIED' }),
    );
    expect(hooks?.resolve?.('node:fs', {} as never, next)).toEqual({
      url: 'node:fs',
      shortCircuit: true,
    });
    expect(() => target.getBuiltinModule('node:module')).toThrow('documentation sandbox');
    expect(target.getBuiltinModule('node:fs')).toEqual({ id: 'node:fs' });
    expect(() => Object.defineProperty(target, 'getBuiltinModule', { value: () => 1 })).toThrow(
      TypeError,
    );
  });
});
