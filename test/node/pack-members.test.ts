/**
 * Tests for the per-tree member packer behind the registry overlay.
 *
 * Packing itself is replaced by a fake `pnpm` that writes a REAL tarball with
 * `tar`, so the manifest and entrypoint checks read genuine archives; the lock,
 * the cache and the cleanup paths are driven through the injected seams.
 *
 * @module
 */
import { describe, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promises as fs, rmSync } from 'node:fs';
import { hostname } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import {
  acquireLock,
  lockIsStale,
  packCacheKey,
  type PackDeps,
  packedEntrypoints,
  packMembers,
} from '../../scripts/pack-members.ts';
import { tempDir } from '../node-helpers.ts';

const tar = promisify(execFile);

/** A throwaway repository holding one member. */
async function repository(): Promise<string> {
  const root = await tempDir();
  await fs.mkdir(join(root, 'node_modules'));
  await fs.mkdir(join(root, 'packages/alpha/src'), { recursive: true });
  await fs.writeFile(join(root, 'packages/alpha/src/index.ts'), 'export const a = 1;\n');
  await fs.writeFile(join(root, 'packages/alpha/README.md'), '# alpha\n');
  await fs.writeFile(join(root, 'package.json'), '{}');
  return root;
}

/**
 * A fake `pnpm`: `exec tsc -b` does nothing, `pack` writes a real tarball whose
 * manifest names `files` and whose contents hold `present`.
 */
function fakePnpm(
  manifest: Record<string, unknown> = {
    name: '@setu-ts/alpha',
    version: '0.9.0',
    exports: { '.': './dist/index.js' },
  },
  present: readonly string[] = ['dist/index.js'],
) {
  const calls: string[][] = [];
  const run: NonNullable<PackDeps['run']> = async (command, args, options) => {
    calls.push([command, ...args]);
    if (args[0] !== 'pack') return { stdout: '' };
    const destination = args[args.indexOf('--pack-destination') + 1]!;
    const work = await fs.mkdtemp(join(options.cwd, '.pack-'));
    await fs.mkdir(join(work, 'package/dist'), { recursive: true });
    await fs.writeFile(join(work, 'package/package.json'), JSON.stringify(manifest));
    for (const file of present) await fs.writeFile(join(work, 'package', file), '');
    const tarball = join(destination, 'setu-ts-alpha-0.9.0.tgz');
    await tar('tar', ['-czf', tarball, '-C', work, 'package']);
    await fs.rm(work, { recursive: true, force: true });
    return { stdout: `noise\n${tarball}\n` };
  };
  return { run, calls };
}

/** The repository's overlay directory listing, minus nothing. */
async function overlayEntries(root: string): Promise<string[]> {
  return (await fs.readdir(join(root, '.tmp'))).sort();
}

describe('packCacheKey', () => {
  const self = new URL('../../scripts/pack-members.ts', import.meta.url).pathname;

  // Codex review (M111d): a changed README or root build config reused the
  // previous tarball, because neither was hashed.
  it('changes with every shipped or build-shaping input', async () => {
    const root = await repository();
    try {
      const base = await packCacheKey(root, ['packages/alpha'], self);
      expect(await packCacheKey(root, ['packages/alpha'], self)).toBe(base);
      const inputs: readonly (readonly [string, string])[] = [
        ['packages/alpha/README.md', '# alpha, edited\n'],
        ['packages/alpha/LICENSE', 'MIT\n'],
        ['packages/alpha/src/index.ts', 'export const a = 2;\n'],
        ['tsconfig.json', '{}'],
        ['pnpm-workspace.yaml', 'packages: []\n'],
        ['LICENSE', 'MIT\n'],
      ];
      let previous = base;
      for (const [path, contents] of inputs) {
        await fs.writeFile(join(root, path), contents);
        const next = await packCacheKey(root, ['packages/alpha'], self);
        expect(next, path).not.toBe(previous);
        previous = next;
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('packCacheKey with a member that has no sources', () => {
  it('hashes the member files that exist and nothing for an absent src/', async () => {
    const root = await repository();
    try {
      await fs.rm(join(root, 'packages/alpha/src'), { recursive: true });
      const self = new URL('../../scripts/pack-members.ts', import.meta.url).pathname;
      const key = await packCacheKey(root, ['packages/alpha'], self);
      expect(key).toMatch(/^[0-9a-f]{24}$/);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('packedEntrypoints', () => {
  it('lists every relative exports target and bin, once and sorted', () => {
    expect(packedEntrypoints({
      exports: { '.': { types: './dist/index.d.ts', default: './dist/index.js' }, x: 'bare' },
      bin: { setu: './dist/bin.js' },
    })).toEqual(['dist/bin.js', 'dist/index.d.ts', 'dist/index.js']);
    expect(packedEntrypoints({})).toEqual([]);
  });
});

describe('packMembers', () => {
  it('refuses an uninstalled tree', async () => {
    const root = await repository();
    try {
      await fs.rm(join(root, 'node_modules'), { recursive: true });
      await expect(packMembers(root, ['packages/alpha'], fakePnpm())).rejects.toThrow(
        'is not installed',
      );
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('builds once, then serves the cache without building again', async () => {
    const root = await repository();
    try {
      const pnpm = fakePnpm();
      const packs = await packMembers(root, ['packages/alpha'], pnpm);
      const alpha = packs.get('@setu-ts/alpha')!;
      expect(alpha.version).toBe('0.9.0');
      await fs.stat(alpha.tarball);
      expect(pnpm.calls.map((call) => call[1])).toEqual(['exec', 'pack']);

      const again = fakePnpm();
      expect((await packMembers(root, ['packages/alpha'], again)).get('@setu-ts/alpha'))
        .toEqual(alpha);
      expect(again.calls).toEqual([]);
      // Published, unlocked, and no staging left behind.
      expect((await fs.readdir(join(root, '.tmp/overlay'))).filter((e) => e !== 'build.lock'))
        .toHaveLength(1);
      expect(await overlayEntries(root)).toEqual(['overlay']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a pack missing an entrypoint, cleaning up staging and the lock', async () => {
    const root = await repository();
    try {
      await expect(packMembers(root, ['packages/alpha'], fakePnpm(undefined, [])))
        .rejects.toThrow('packed manifest names dist/index.js, absent');
      expect(await overlayEntries(root)).toEqual(['overlay']);
      expect(await fs.readdir(join(root, '.tmp/overlay'))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('refuses a pack that reports no tarball', async () => {
    const root = await repository();
    try {
      const run: NonNullable<PackDeps['run']> = () => Promise.resolve({ stdout: 'nothing\n' });
      await expect(packMembers(root, ['packages/alpha'], { run }))
        .rejects.toThrow('pnpm pack reported no tarball');
      expect(await overlayEntries(root)).toEqual(['overlay']);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Codex review (M111d): only collected refusals cleaned up; a rejected pack
  // left its staging directory behind.
  it('removes staging when packing itself fails', async () => {
    const root = await repository();
    try {
      const run: NonNullable<PackDeps['run']> = (_command, args) =>
        args[0] === 'pack'
          ? Promise.reject(new Error('pack exploded'))
          : Promise.resolve({ stdout: '' });
      await expect(packMembers(root, ['packages/alpha'], { run })).rejects.toThrow('pack exploded');
      expect(await overlayEntries(root)).toEqual(['overlay']);
      expect(await fs.readdir(join(root, '.tmp/overlay'))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Codex review (M111d): the waiter read a missing index, the builder then
  // published and released, and the waiter reported failure.
  it('returns the packs a live builder publishes while this caller waits', async () => {
    const root = await repository();
    try {
      const builder = fakePnpm();
      const built = await packMembers(root, ['packages/alpha'], builder);
      // Re-create the moment a builder holds the lock with its index not yet
      // visible: move the index aside, hold a live lock, publish on first wait.
      const cacheDir = join(
        root,
        '.tmp/overlay',
        (await fs.readdir(join(root, '.tmp/overlay')))[0]!,
      );
      await fs.rename(join(cacheDir, 'packs.json'), join(root, 'packs.json'));
      expect(await acquireLock(join(root, '.tmp/overlay/build.lock'), 'here', 0)).toBe(true);
      let waits = 0;
      const packs = await packMembers(root, ['packages/alpha'], {
        ...fakePnpm(),
        hostname: 'here',
        alive: () => true,
        sleep: async () => {
          waits++;
          await fs.rename(join(root, 'packs.json'), join(cacheDir, 'packs.json'));
          await fs.rm(join(root, '.tmp/overlay/build.lock'), { recursive: true });
        },
      });
      expect(waits).toBe(1);
      expect(packs).toEqual(built);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('builds itself when the lock it waited on was released without packs', async () => {
    const root = await repository();
    try {
      const lock = join(root, '.tmp/overlay/build.lock');
      await fs.mkdir(join(root, '.tmp/overlay'), { recursive: true });
      expect(await acquireLock(lock, 'here', 0)).toBe(true);
      const pnpm = fakePnpm();
      const packs = await packMembers(root, ['packages/alpha'], {
        ...pnpm,
        hostname: 'here',
        alive: () => true,
        sleep: () => fs.rm(lock, { recursive: true }),
      });
      expect(packs.has('@setu-ts/alpha')).toBe(true);
      expect(pnpm.calls).toHaveLength(2);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  // Codex review (M111d): a killed builder stranded its lock, and every later
  // caller waited fifteen minutes and failed.
  it('reclaims a lock whose owner on this host is dead', async () => {
    const root = await repository();
    try {
      const lock = join(root, '.tmp/overlay/build.lock');
      await fs.mkdir(join(root, '.tmp/overlay'), { recursive: true });
      expect(await acquireLock(lock, 'here', 0)).toBe(true);
      const pnpm = fakePnpm();
      const packs = await packMembers(root, ['packages/alpha'], {
        ...pnpm,
        hostname: 'here',
        alive: () => false,
        sleep: () => Promise.reject(new Error('must not wait on a dead owner')),
      });
      expect(packs.has('@setu-ts/alpha')).toBe(true);
      expect((await fs.readdir(join(root, '.tmp/overlay'))).some((e) => e.includes('stale')))
        .toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('times out on a lock another host holds rather than reclaiming it', async () => {
    const root = await repository();
    try {
      const lock = join(root, '.tmp/overlay/build.lock');
      await fs.mkdir(join(root, '.tmp/overlay'), { recursive: true });
      expect(await acquireLock(lock, 'elsewhere', 0)).toBe(true);
      let clock = 0;
      await expect(packMembers(root, ['packages/alpha'], {
        ...fakePnpm(),
        hostname: 'here',
        alive: () => false,
        now: () => clock,
        sleep: () => {
          clock += 20 * 60 * 1000;
          return Promise.resolve();
        },
      })).rejects.toThrow('timed out waiting for');
      await fs.stat(lock);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('the default command runner', () => {
  // `pnpm exec tsc` in a directory with no TypeScript fails for real: the build
  // step rejects, and the lock is released for the next caller.
  it('runs the real build and releases the lock when it fails', async () => {
    const root = await repository();
    try {
      await expect(packMembers(root, ['packages/alpha'])).rejects.toThrow();
      expect(await fs.readdir(join(root, '.tmp/overlay'))).toEqual([]);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('reclaiming a stale lock', () => {
  it('lets another caller reclaim it first, then takes the lock itself', async () => {
    const root = await repository();
    try {
      const lock = join(root, '.tmp/overlay/build.lock');
      await fs.mkdir(join(root, '.tmp/overlay'), { recursive: true });
      expect(await acquireLock(lock, 'here', 0)).toBe(true);
      const packs = await packMembers(root, ['packages/alpha'], {
        ...fakePnpm(),
        hostname: 'here',
        // Another caller reclaims the lock while this one judges it stale, so
        // this caller's own rename finds nothing to move.
        alive: () => {
          rmSync(lock, { recursive: true, force: true });
          return false;
        },
      });
      expect(packs.has('@setu-ts/alpha')).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('the real liveness check', () => {
  /** Holds the build lock as `pid` on this host, as a builder would. */
  async function holdAs(root: string, pid: number): Promise<string> {
    const lock = join(root, '.tmp/overlay/build.lock');
    await fs.mkdir(lock, { recursive: true });
    await fs.writeFile(
      join(lock, 'owner.json'),
      JSON.stringify({ pid, hostname: hostname(), since: 0 }),
    );
    return lock;
  }

  it('reclaims a lock held by a process that no longer exists', async () => {
    const root = await repository();
    try {
      await holdAs(root, 99_999_999);
      const packs = await packMembers(root, ['packages/alpha'], {
        ...fakePnpm(),
        sleep: () => Promise.reject(new Error('must not wait on a dead owner')),
      });
      expect(packs.has('@setu-ts/alpha')).toBe(true);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('waits on a live owner, including one it may not signal', async () => {
    for (const pid of [process.pid, 1]) {
      const root = await repository();
      try {
        const lock = await holdAs(root, pid);
        let waits = 0;
        await packMembers(root, ['packages/alpha'], {
          ...fakePnpm(),
          sleep: async () => {
            waits++;
            await fs.rm(lock, { recursive: true });
          },
        });
        expect(waits, String(pid)).toBe(1);
      } finally {
        await fs.rm(root, { recursive: true, force: true });
      }
    }
  });
});

describe('waiting through the real timer', () => {
  it('polls until a live builder releases the lock', async () => {
    const root = await repository();
    try {
      const lock = join(root, '.tmp/overlay/build.lock');
      await fs.mkdir(join(root, '.tmp/overlay'), { recursive: true });
      expect(await acquireLock(lock, hostname(), 0)).toBe(true);
      const released = setTimeout(() => rmSync(lock, { recursive: true, force: true }), 100);
      try {
        const packs = await packMembers(root, ['packages/alpha'], fakePnpm());
        expect(packs.has('@setu-ts/alpha')).toBe(true);
      } finally {
        clearTimeout(released);
      }
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});

describe('lockIsStale', () => {
  it('reads an ownerless lock by its age, and a released one as not stale', async () => {
    const root = await repository();
    try {
      const lock = join(root, 'lock');
      await fs.mkdir(lock);
      const created = (await fs.stat(lock)).mtimeMs;
      expect(await lockIsStale(lock, 'here', created + 1000, () => true)).toBe(false);
      expect(await lockIsStale(lock, 'here', created + 61_000, () => true)).toBe(true);
      await fs.rm(lock, { recursive: true });
      expect(await lockIsStale(lock, 'here', created + 61_000, () => true)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });

  it('asks whether a same-host owner is alive', async () => {
    const root = await repository();
    try {
      const lock = join(root, 'lock');
      expect(await acquireLock(lock, 'here', 5)).toBe(true);
      expect(await acquireLock(lock, 'here', 6)).toBe(false);
      expect(await lockIsStale(lock, 'here', 10, () => true)).toBe(false);
      expect(await lockIsStale(lock, 'here', 10, () => false)).toBe(true);
      expect(await lockIsStale(lock, 'other', 10, () => false)).toBe(false);
    } finally {
      await fs.rm(root, { recursive: true, force: true });
    }
  });
});
