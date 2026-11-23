import { describe, expect, it } from 'vitest';
import {
  withProjectLock,
  runWithProjectLock,
  ProjectLockError,
} from '../../src/utils/project-lock.ts';
import { InterruptedError } from '../../src/utils/interruption.ts';
import { createFakeFs, createRecorder } from '../fixtures/fake-fs.ts';
import { runCli } from '../../src/cli.ts';

const lock = '/work/.setu-ts/write.lock';
const ownerPath = `${lock}/owner.json`;

describe('project write lock', () => {
  it('publishes the process and command before invoking its callback, then releases', async () => {
    const fs = { ...createFakeFs(), invokingPid: 123 };
    expect(
      await withProjectLock(fs, '/work', undefined, 'add', async () => {
        expect(JSON.parse(fs.read(ownerPath))).toEqual({ pid: 123, command: 'add' });
        expect((await fs.stat(lock)).isDirectory).toBe(true);
        return 42;
      }),
    ).toBe(42);
    await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(fs.writes).toEqual([ownerPath]);
  });

  it('publishes an unknown process when the host supplies no pid', async () => {
    const fs = createFakeFs();
    await withProjectLock(fs, '/work', undefined, 'sync', () => {
      expect(JSON.parse(fs.read(ownerPath))).toEqual({ pid: null, command: 'sync' });
      return Promise.resolve();
    });
  });

  it.each([new Error('callback failed'), new InterruptedError()])(
    'releases on callback error or interruption (%s)',
    async (error) => {
      const fs = createFakeFs();
      await expect(
        withProjectLock(fs, '/work', undefined, 'add', () => Promise.reject(error)),
      ).rejects.toBe(error);
      await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each([true, false, undefined, 'throw'] as const)(
    'refuses an existing owner without changing it, probe %s',
    async (state) => {
      const owner = JSON.stringify({ pid: 321, command: 'generate' });
      const fs = createFakeFs({ [ownerPath]: owner });
      const removed: string[] = [];
      const probe =
        state === undefined
          ? undefined
          : () => {
              if (state === 'throw') throw new Error('EPERM');
              return state;
            };
      const guarded = {
        ...fs,
        rm: (path: string) => {
          removed.push(path);
          return Promise.resolve();
        },
      };
      await expect(
        withProjectLock(guarded, '/work', probe, 'add', () =>
          Promise.reject(new Error('must not enter')),
        ),
      ).rejects.toThrow(
        state === false
          ? `A setu command (generate, pid 321) that is no longer running may have left ${lock}.\nConfirm no setu command is running in this project, then delete it and run this again.`
          : `Another setu command (generate, pid 321) is changing this project; run this again when it finishes.\nIf no setu command is running, delete ${lock} and run this again.`,
      );
      expect(fs.read(ownerPath)).toBe(owner);
      expect(fs.writes).toEqual([]);
      expect(removed).toEqual([]);
    },
  );

  it('is not re-entrant and never removes the held lock during a contender refusal', async () => {
    const fs = { ...createFakeFs(), invokingPid: 123 };
    await withProjectLock(
      fs,
      '/work',
      () => true,
      'add',
      async () => {
        const original = fs.read(ownerPath);
        await expect(
          withProjectLock(
            fs,
            '/work',
            () => true,
            'add',
            () => Promise.resolve(0),
          ),
        ).rejects.toBeInstanceOf(ProjectLockError);
        expect(fs.read(ownerPath)).toBe(original);
        expect((await fs.stat(lock)).isDirectory).toBe(true);
      },
    );
  });

  it.each([
    'null',
    'true',
    '{}',
    '{"pid":123}',
    '{"pid":"123","command":"add"}',
    '{"pid":1.5,"command":"add"}',
    '{"pid":0,"command":"add"}',
    '{"pid":123,"command":42}',
    '{"pid":123,"command":""}',
    'not JSON',
  ])('refuses an unknown or malformed owner without removing it (%s)', async (owner) => {
    const fs = createFakeFs({ [ownerPath]: owner });
    await expect(
      withProjectLock(
        fs,
        '/work',
        () => false,
        'add',
        () => Promise.resolve(0),
      ),
    ).rejects.toThrow(
      `Another setu command is changing this project; run this again when it finishes.\nIf no setu command is running, delete ${lock} and run this again.`,
    );
    expect(fs.read(ownerPath)).toBe(owner);
    expect(fs.writes).toEqual([]);
  });

  it.each([false, true])(
    'refuses a missing or unreadable owner during publication, unreadable %s',
    async (unreadable) => {
      const fs = createFakeFs({ [ownerPath]: '{}' });
      if (!unreadable) await fs.rm(ownerPath);
      await fs.mkdir(lock, { recursive: true });
      const reading = {
        ...fs,
        readFile: (path: string) =>
          unreadable ? Promise.reject(new Error('denied')) : fs.readFile(path),
      };
      await expect(
        withProjectLock(reading, '/work', undefined, 'add', () => Promise.resolve(0)),
      ).rejects.toThrow('Another setu command is changing this project');
      expect((await fs.stat(lock)).isDirectory).toBe(true);
      expect(fs.writes).toEqual([]);
    },
  );

  it.each([
    new Error('denied'),
    Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    'denied',
  ])('reports acquisition failures without invoking or releasing (%s)', async (cause) => {
    const fs = createFakeFs();
    await expect(
      withProjectLock(
        { ...fs, mkdir: () => Promise.reject(cause) },
        '/work',
        undefined,
        'add',
        () => Promise.resolve(0),
      ),
    ).rejects.toThrow(`Cannot acquire ${lock}:`);
    expect(fs.writes).toEqual([]);
  });

  it.each([
    new Error('denied'),
    Object.assign(new Error('permission denied'), { code: 'EACCES' }),
    'denied',
  ])('reports a lock directory failure after the parent exists (%s)', async (cause) => {
    const fs = createFakeFs();
    const reporting = {
      ...fs,
      mkdir: (path: string, options?: { recursive?: boolean }) =>
        path === lock ? Promise.reject(cause) : fs.mkdir(path, options),
    };
    await expect(
      withProjectLock(reporting, '/work', undefined, 'add', () =>
        Promise.reject(new Error('must not enter')),
      ),
    ).rejects.toThrow(`Cannot acquire ${lock}:`);
    expect(fs.mkdirs).toEqual(['/work/.setu-ts']);
    expect(fs.writes).toEqual([]);
  });

  it.each([new Error('owner write denied'), 'owner write denied'])(
    'releases when owner publication fails (%s)',
    async (cause) => {
      const fs = createFakeFs();
      await expect(
        withProjectLock(
          { ...fs, writeFile: () => Promise.reject(cause) },
          '/work',
          undefined,
          'add',
          () => Promise.resolve(0),
        ),
      ).rejects.toThrow(`Failed to write ${ownerPath}: owner write denied`);
      await expect(fs.stat(lock)).rejects.toMatchObject({ code: 'ENOENT' });
    },
  );

  it.each([new Error('release denied'), 'release denied'])(
    'reports release failures by path (%s)',
    async (cause) => {
      const fs = createFakeFs();
      await expect(
        withProjectLock({ ...fs, rm: () => Promise.reject(cause) }, '/work', undefined, 'add', () =>
          Promise.resolve(0),
        ),
      ).rejects.toHaveProperty(
        'message',
        `The command completed, but its lock ${lock} could not be removed: release denied\nDo not run the command again; delete ${lock} before the next setu command.`,
      );
    },
  );

  it.each([new Error('callback failed'), new InterruptedError()])(
    'keeps the callback error when release also fails, and reports the release (%s)',
    async (error) => {
      const fs = createFakeFs();
      const reported: string[] = [];
      await expect(
        withProjectLock(
          { ...fs, rm: () => Promise.reject(new Error('release denied')) },
          '/work',
          undefined,
          'add',
          () => Promise.reject(error),
          (message) => reported.push(message),
        ),
      ).rejects.toBe(error);
      expect(reported).toEqual([`Cannot release ${lock}: release denied`]);
    },
  );

  it('keeps the callback error when release fails and nothing receives the report', async () => {
    const fs = createFakeFs();
    const error = new Error('callback failed');
    await expect(
      withProjectLock(
        { ...fs, rm: () => Promise.reject(new Error('release denied')) },
        '/work',
        undefined,
        'add',
        () => Promise.reject(error),
      ),
    ).rejects.toBe(error);
  });

  it('names a file where the lock parent belongs instead of reporting a held lock', async () => {
    const fs = createFakeFs({ '/work/.setu-ts': 'not a directory' });
    await expect(
      withProjectLock(fs, '/work', undefined, 'add', () =>
        Promise.reject(new Error('must not enter')),
      ),
    ).rejects.toThrow(`Cannot acquire ${lock}: EEXIST: /work/.setu-ts`);
    expect(fs.writes).toEqual([]);
  });

  it.each([
    [
      0,
      1,
      `The command completed, but its lock ${lock} could not be removed: release denied\nDo not run the command again; delete ${lock} before the next setu command.`,
    ],
    [2, 2, `Cannot release ${lock}: release denied`],
    [1, 1, `Cannot release ${lock}: release denied`],
  ])(
    'says completed only for exit 0 when release fails, keeping a refusal status (exit %i)',
    async (status, exit, message) => {
      const fs = createFakeFs({ '/work/package.json': '{}' });
      const errors: string[] = [];
      const deps = {
        fs: { ...fs, rm: () => Promise.reject(new Error('release denied')) },
        error: (line: string) => errors.push(line),
      };
      expect(
        await runWithProjectLock(deps, '/work', true, 'add', () => Promise.resolve(status)),
      ).toBe(exit);
      expect(errors).toEqual([message]);
    },
  );

  it('keeps an incomplete result when release fails and nothing receives the report', async () => {
    const fs = createFakeFs();
    expect(
      await withProjectLock(
        { ...fs, rm: () => Promise.reject(new Error('release denied')) },
        '/work',
        undefined,
        'add',
        () => Promise.resolve(2),
        undefined,
        () => false,
      ),
    ).toBe(2);
  });

  it('shares the workspace root across member writers and propagates non-lock callback errors', async () => {
    const fs = createFakeFs();
    const err = createRecorder();
    const deps = { fs, cwd: '/work', now: () => 0, log: () => {}, error: err.sink };
    expect(await runCli(['new', 'ws', '--workspace'], deps)).toBe(0);
    expect(await runCli(['g', 'app', 'api', '--dir', '/work/ws'], deps), err.text()).toBe(0);
    const failure = new Error('callback failed');
    await expect(
      runWithProjectLock(deps, '/work/ws/apps/api', true, 'generate', async () => {
        expect((await fs.stat('/work/ws/.setu-ts/write.lock')).isDirectory).toBe(true);
        await expect(fs.stat('/work/ws/apps/api/.setu-ts/write.lock')).rejects.toMatchObject({
          code: 'ENOENT',
        });
        throw failure;
      }),
    ).rejects.toBe(failure);
    await expect(fs.stat('/work/ws/.setu-ts/write.lock')).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('locks a symlinked workspace member at the workspace root', async () => {
    const fs = createFakeFs();
    const deps = { fs, cwd: '/work', now: () => 0, log: () => {}, error: () => {} };
    expect(await runCli(['new', 'ws', '--workspace'], deps)).toBe(0);
    expect(await runCli(['g', 'app', 'api', '--dir', '/work/ws'], deps)).toBe(0);
    const alias = '/work/alias';
    const target = (path: string) =>
      path === alias || path.startsWith(`${alias}/`)
        ? path.replace(alias, '/work/ws/apps/api')
        : path;
    const aliased = {
      ...fs,
      realPath: (path: string) => Promise.resolve(target(path)),
      stat: (path: string) => fs.stat(target(path)),
      readFile: (path: string) => fs.readFile(target(path)),
      readdir: (path: string) => fs.readdir(target(path)),
    };
    expect(
      await runWithProjectLock({ ...deps, fs: aliased }, alias, true, 'generate', async () => {
        expect((await fs.stat('/work/ws/.setu-ts/write.lock')).isDirectory).toBe(true);
        return 0;
      }),
    ).toBe(0);
    // A member linked out of its workspace locks the workspace it is listed in and,
    // after it, the project it really is; a command run there is refused meanwhile.
    const linkedOut = {
      ...fs,
      realPath: (path: string) =>
        Promise.resolve(path === '/work/ws/apps/api' ? '/elsewhere/api' : path),
    };
    await fs.mkdir('/elsewhere/api', { recursive: true });
    await fs.writeFile('/elsewhere/api/package.json', new TextEncoder().encode('{}'));
    const errors: string[] = [];
    expect(
      await runWithProjectLock(
        { ...deps, fs: linkedOut },
        '/work/ws/apps/api',
        true,
        'generate',
        async () => {
          expect((await fs.stat('/work/ws/.setu-ts/write.lock')).isDirectory).toBe(true);
          expect((await fs.stat('/elsewhere/api/.setu-ts/write.lock')).isDirectory).toBe(true);
          expect(
            await runWithProjectLock(
              { ...deps, error: (line: string) => errors.push(line) },
              '/elsewhere/api',
              true,
              'add',
              () => Promise.resolve(0),
            ),
          ).toBe(1);
          return 0;
        },
      ),
    ).toBe(0);
    expect(errors.join('\n')).toContain('/elsewhere/api/.setu-ts/write.lock');
    await expect(fs.stat('/work/ws/.setu-ts/write.lock')).rejects.toMatchObject({ code: 'ENOENT' });
    await expect(fs.stat('/elsewhere/api/.setu-ts/write.lock')).rejects.toMatchObject({
      code: 'ENOENT',
    });
    const unresolvable = { ...aliased, realPath: () => Promise.reject(new Error('ELOOP')) };
    expect(
      await runWithProjectLock({ ...deps, fs: unresolvable }, alias, true, 'generate', async () => {
        expect((await fs.stat(`${alias}/.setu-ts/write.lock`)).isDirectory).toBe(true);
        return 0;
      }),
    ).toBe(0);
  });

  it('locks a member reached through a linked workspace path once, at the workspace', async () => {
    const fs = createFakeFs();
    const deps = { fs, cwd: '/work', now: () => 0, log: () => {}, error: () => {} };
    expect(await runCli(['new', 'ws', '--workspace'], deps)).toBe(0);
    expect(await runCli(['g', 'app', 'api', '--dir', '/work/ws'], deps)).toBe(0);
    const map = (path: string) =>
      path === '/link' || path.startsWith('/link/') ? path.replace('/link', '/work') : path;
    const linked = {
      ...fs,
      realPath: (path: string) => Promise.resolve(map(path)),
      stat: (path: string) => fs.stat(map(path)),
      readFile: (path: string) => fs.readFile(map(path)),
      readdir: (path: string) => fs.readdir(map(path)),
      mkdir: (path: string, options?: { recursive?: boolean }) => fs.mkdir(map(path), options),
      writeFile: (path: string, data: Uint8Array) => fs.writeFile(map(path), data),
      rm: (path: string, options?: { recursive?: boolean }) => fs.rm(map(path), options),
    };
    expect(
      await runWithProjectLock(
        { ...deps, fs: linked },
        '/link/ws/apps/api',
        true,
        'add',
        async () => {
          expect((await fs.stat('/work/ws/.setu-ts/write.lock')).isDirectory).toBe(true);
          await expect(fs.stat('/work/ws/apps/api/.setu-ts')).rejects.toMatchObject({
            code: 'ENOENT',
          });
          return 0;
        },
      ),
    ).toBe(0);
  });

  it('locks a member once when realPath returns native Windows paths', async () => {
    const fs = createFakeFs();
    const deps = { fs, cwd: '/work', now: () => 0, log: () => {}, error: () => {} };
    expect(await runCli(['new', 'ws', '--workspace'], deps)).toBe(0);
    expect(await runCli(['g', 'app', 'api', '--dir', '/work/ws'], deps)).toBe(0);
    const native = {
      ...fs,
      realPath: (path: string) => Promise.resolve(`C:${path.replaceAll('/', '\\')}`),
    };
    const before = fs.mkdirs.length;
    expect(
      await runWithProjectLock(
        { ...deps, fs: native },
        '/work/ws/apps/api',
        true,
        'add',
        async () => {
          expect((await fs.stat('/work/ws/.setu-ts/write.lock')).isDirectory).toBe(true);
          return 0;
        },
      ),
    ).toBe(0);
    expect(fs.mkdirs.slice(before)).toEqual(['/work/ws/.setu-ts', '/work/ws/.setu-ts/write.lock']);
  });

  it("locks a linked-out member's real path at that path's own workspace", async () => {
    const fs = createFakeFs();
    const deps = { fs, cwd: '/work', now: () => 0, log: () => {}, error: () => {} };
    for (const base of ['/work', '/other']) {
      expect(await runCli(['new', 'ws', '--workspace'], { ...deps, cwd: base })).toBe(0);
      expect(await runCli(['g', 'app', 'api', '--dir', `${base}/ws`], deps)).toBe(0);
    }
    const linked = {
      ...fs,
      realPath: (path: string) =>
        Promise.resolve(path === '/work/ws/apps/api' ? '/other/ws/apps/api' : path),
    };
    expect(
      await runWithProjectLock(
        { ...deps, fs: linked },
        '/work/ws/apps/api',
        true,
        'add',
        async () => {
          expect((await fs.stat('/work/ws/.setu-ts/write.lock')).isDirectory).toBe(true);
          expect((await fs.stat('/other/ws/.setu-ts/write.lock')).isDirectory).toBe(true);
          await expect(fs.stat('/other/ws/apps/api/.setu-ts')).rejects.toMatchObject({
            code: 'ENOENT',
          });
          return 0;
        },
      ),
    ).toBe(0);
  });

  it('reports a schematic runtime typo as a usage error even while the lock is held', async () => {
    const owner = JSON.stringify({ pid: 123, command: 'add' });
    const fs = createFakeFs({ '/work/package.json': '{}', [ownerPath]: owner });
    const errors = createRecorder();
    expect(
      await runCli(['g', 'service', 'orders', '--runtime', 'typo'], {
        fs,
        cwd: '/work',
        now: () => 0,
        log: () => {},
        error: errors.sink,
      }),
    ).toBe(2);
    expect(errors.text()).toContain('Unknown runtime "typo"');
    expect(fs.read(ownerPath)).toBe(owner);
  });

  it('creates no lock for dry runs, informational commands or a refused add outside a project', async () => {
    const fs = createFakeFs();
    const deps = { fs, cwd: '/work', now: () => 0, log: () => {}, error: () => {} };
    expect(await runCli(['add', 'cache'], deps)).toBe(1);
    expect(await runCli(['add', '--help'], deps)).toBe(0);
    expect(await runCli(['g'], deps)).toBe(0);
    expect(await runCli(['sync', '--dry-run'], deps)).toBe(1);
    expect(fs.mkdirs).toEqual([]);
    expect(fs.writes).toEqual([]);
    const unreadable = createFakeFs({ '/work/package.json': 'not JSON' });
    expect(
      await runWithProjectLock({ ...deps, fs: unreadable }, '/work', true, 'add', () =>
        Promise.resolve(1),
      ),
    ).toBe(1);
    expect(unreadable.mkdirs).toEqual([]);
  });

  it.each([['add', 'cache'], ['g', 'service', 'billing'], ['sync']])(
    'skips a held lock for dry-run %j',
    async (...args) => {
      const owner = JSON.stringify({ pid: 123, command: 'add' });
      const fs = createFakeFs({ '/work/package.json': '{}', [ownerPath]: owner });
      const errors = createRecorder();
      expect(
        await runCli([...args, '--dry-run'], {
          fs,
          cwd: '/work',
          now: () => 0,
          log: () => {},
          error: errors.sink,
        }),
        errors.text(),
      ).toBe(0);
      expect(fs.read(ownerPath)).toBe(owner);
      expect(fs.writes).toEqual([]);
      expect(fs.mkdirs).toEqual([]);
    },
  );

  it('holds exactly one lock for generate app/library and sync, and scaffolds both ignore files', async () => {
    for (const runtime of ['node', 'bun', 'deno']) {
      const fs = createFakeFs();
      const errors = createRecorder();
      const deps = { fs, cwd: '/work', now: () => 0, log: () => {}, error: errors.sink };
      expect(await runCli(['new', 'ws', '--workspace', '--runtime', runtime], deps)).toBe(0);
      const root = '/work/ws';
      expect(fs.read(`${root}/.gitignore`)).toContain('.setu-ts/write.lock/\n');
      for (const argv of [
        ['g', 'app', 'api'],
        ['g', 'library', 'shared'],
      ]) {
        const before = fs.writes.filter((path) => path.endsWith('/write.lock/owner.json')).length;
        expect(await runCli([...argv, '--dir', root], deps), errors.text()).toBe(0);
        expect(fs.writes.filter((path) => path.endsWith('/write.lock/owner.json'))).toHaveLength(
          before + 1,
        );
        await expect(fs.stat(`${root}/.setu-ts/write.lock`)).rejects.toMatchObject({
          code: 'ENOENT',
        });
      }
      expect(fs.read(`${root}/apps/api/.gitignore`)).toContain('.setu-ts/write.lock/\n');
      expect(
        await runCli(['g', 'service', 'billing', '--dir', `${root}/apps/api`], deps),
        errors.text(),
      ).toBe(0);
      expect(await runCli(['sync', '--dir', root], deps), errors.text()).toBe(0);
      await expect(fs.stat(`${root}/.setu-ts/write.lock`)).rejects.toMatchObject({
        code: 'ENOENT',
      });
    }
  });
});
