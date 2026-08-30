/**
 * Unit tests for domain-module discovery.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem, StatResult } from '@setu-ts/common';

import { MODULES_DIR, readModuleNames, scanModules } from '../../../src/utils/module-scanner.ts';

/** A directory stat, shaped as the real runtime adapters report one. */
const DIR_STAT: StatResult = { isFile: false, isDirectory: true, size: 0 };
/** A file stat. */
const FILE_STAT: StatResult = { isFile: true, isDirectory: false, size: 12 };

/**
 * Builds a filesystem double over a listing plus a per-path stat map.
 *
 * Keyed by the path suffix BELOW the modules root, so a test can describe both a
 * directory and the files inside it — which the scanner has to probe, because a
 * directory alone does not make a module.
 *
 * @param entries - What `readdir` returns, or an error to reject with
 * @param stats - Path suffix below the modules root → stat, or an error
 * @returns The double, satisfying the required members of IFileSystem
 */
function fsWith(
  entries: readonly string[] | Error,
  stats: Readonly<Record<string, StatResult | Error>> = {},
): IFileSystem {
  return {
    readdir: (_path: string) =>
      entries instanceof Error ? Promise.reject(entries) : Promise.resolve(entries),
    stat: (path: string) => {
      const key = path.slice(path.indexOf(MODULES_DIR) + MODULES_DIR.length + 1);
      const result = stats[key];
      if (result !== undefined) {
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      }
      // Unlisted: one segment is a directory, anything deeper is a file — the
      // shape of a well-formed module the CLI generated.
      return Promise.resolve(key.includes('/') ? FILE_STAT : DIR_STAT);
    },
    readFile: () => Promise.reject(new Error('unused')),
    writeFile: () => Promise.reject(new Error('unused')),
    mkdir: () => Promise.reject(new Error('unused')),
    rm: () => Promise.reject(new Error('unused')),
  };
}

/** A stat rejection shaped like a real runtime's missing-path error. */
const MISSING = new Error('NotFound');

describe('readModuleNames', () => {
  it('returns directory names sorted', () => {
    // Enumeration order is filesystem-defined; the sort is what makes the
    // rendered barrel stable across machines.
    return readModuleNames(fsWith(['user', 'billing', 'order']), '/app').then((names) => {
      expect(names).toEqual(['billing', 'order', 'user']);
    });
  });

  it('excludes files, so the barrel never imports from index.ts', async () => {
    const names = await readModuleNames(
      fsWith(['user', 'index.ts'], { 'index.ts': FILE_STAT }),
      '/app',
    );

    expect(names).toEqual(['user']);
  });

  it('returns an empty list when src/modules does not exist', async () => {
    // A project that has never generated a module is the common case, not an
    // error — every other schematic must keep working there.
    const names = await readModuleNames(fsWith(new Error('NotFound')), '/app');

    expect(names).toEqual([]);
  });

  it('skips an entry whose stat fails and keeps the rest', async () => {
    const names = await readModuleNames(
      fsWith(['user', 'vanished'], { vanished: new Error('NotFound') }),
      '/app',
    );

    expect(names).toEqual(['user']);
  });

  it('returns an empty list for an empty directory', async () => {
    expect(await readModuleNames(fsWith([]), '/app')).toEqual([]);
  });

  it('excludes a directory that is not a generated module', async () => {
    // A `shared/` helper folder under src/modules is a natural thing to create.
    // Treating it as a module makes the regenerated barrel import
    // `./shared/shared.controller.ts`, which does not exist — so the developer's
    // project stops compiling, from a command that reported success.
    const names = await readModuleNames(
      fsWith(['user', 'shared'], {
        'shared/shared.controller.ts': MISSING,
        'shared/shared.service.ts': MISSING,
      }),
      '/app',
    );

    expect(names).toEqual(['user']);
  });

  it('excludes a module directory missing its controller', async () => {
    // The barrel imports both files, so either one absent makes it unbuildable.
    const names = await readModuleNames(
      fsWith(['user', 'half'], { 'half/half.controller.ts': MISSING }),
      '/app',
    );

    expect(names).toEqual(['user']);
  });

  it('excludes a module directory missing its service', async () => {
    const names = await readModuleNames(
      fsWith(['user', 'half'], { 'half/half.service.ts': MISSING }),
      '/app',
    );

    expect(names).toEqual(['user']);
  });

  it('reports a legacy generated module missing its declaration', async () => {
    const scan = await scanModules(
      fsWith(['legacy'], { 'legacy/legacy.module.ts': MISSING }),
      '/app',
    );

    expect(scan.names).toEqual([]);
    expect(scan.skipped).toEqual([
      { name: 'legacy', path: 'src/modules/legacy', missing: 'legacy.module.ts' },
    ]);
  });

  it('excludes a directory whose canonical paths are themselves directories', async () => {
    // A directory named `user.controller.ts` satisfies a bare existence probe but
    // cannot be imported, so the check must require a FILE.
    const names = await readModuleNames(
      fsWith(['user'], { 'user/user.controller.ts': DIR_STAT }),
      '/app',
    );

    expect(names).toEqual([]);
  });

  it('scans under the directory it is given', async () => {
    const seen: string[] = [];
    const fs = fsWith(['user']);
    const probe: IFileSystem = {
      ...fs,
      readdir: (path: string) => {
        seen.push(path);
        return fs.readdir(path);
      },
    };

    await readModuleNames(probe, '/somewhere/else');

    // `--dir` must root the scan, or the scan and the write disagree.
    expect(seen).toEqual([`/somewhere/else/${MODULES_DIR}`]);
  });
});
