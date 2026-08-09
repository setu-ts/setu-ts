/**
 * Unit tests for domain-module discovery.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem, StatResult } from '@setu-ts/common';

import { MODULES_DIR, readModuleNames } from '../../../src/utils/module-scanner.ts';

/** A directory stat, shaped as the real runtime adapters report one. */
const DIR_STAT: StatResult = { isFile: false, isDirectory: true, size: 0 };
/** A file stat. */
const FILE_STAT: StatResult = { isFile: true, isDirectory: false, size: 12 };

/**
 * Builds a filesystem double over a listing plus a per-entry stat map.
 *
 * @param entries - What `readdir` returns
 * @param stats - Entry name to stat, or a thrown error
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
      const key = path.slice(path.lastIndexOf('/') + 1);
      const result = stats[key] ?? DIR_STAT;
      return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
    },
    readFile: () => Promise.reject(new Error('unused')),
    writeFile: () => Promise.reject(new Error('unused')),
    mkdir: () => Promise.reject(new Error('unused')),
    rm: () => Promise.reject(new Error('unused')),
  };
}

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
