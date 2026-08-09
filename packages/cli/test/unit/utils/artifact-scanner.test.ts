/**
 * Unit tests for generated-artifact discovery.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import type { IFileSystem, StatResult } from '@setu-ts/common';

import { readArtifactNames, scanArtifacts } from '../../../src/utils/artifact-scanner.ts';
import { getSeamSpec, listSeamSpecs } from '../../../src/seams/registry.ts';
import type { SeamSpec } from '../../../src/seams/seam-spec.ts';

/** A file stat, shaped as the real runtime adapters report one. */
const FILE_STAT: StatResult = { isFile: true, isDirectory: false, size: 12 };
/** A directory stat. */
const DIR_STAT: StatResult = { isFile: false, isDirectory: true, size: 0 };
/** A stat rejection shaped like a real runtime's missing-path error. */
const MISSING = new Error('NotFound');

/**
 * Builds a filesystem double over one directory listing plus a per-entry stat map.
 *
 * @param entries - What `readdir` returns, or an error to reject with
 * @param stats - Entry name → stat, or an error; unlisted entries stat as files
 * @returns The double, satisfying the required members of IFileSystem
 */
function fsWith(
  entries: readonly string[] | Error,
  stats: Readonly<Record<string, StatResult | Error>> = {},
): IFileSystem {
  return {
    readdir: () => entries instanceof Error ? Promise.reject(entries) : Promise.resolve(entries),
    stat: (path: string) => {
      const entry = path.slice(path.lastIndexOf('/') + 1);
      const result = stats[entry];
      if (result !== undefined) {
        return result instanceof Error ? Promise.reject(result) : Promise.resolve(result);
      }
      return Promise.resolve(FILE_STAT);
    },
    readFile: () => Promise.reject(new Error('unused')),
    writeFile: () => Promise.reject(new Error('unused')),
    mkdir: () => Promise.reject(new Error('unused')),
    rm: () => Promise.reject(new Error('unused')),
  };
}

const ROUTES = getSeamSpec('route')!;
const PLUGINS = getSeamSpec('plugin')!;

describe('readArtifactNames', () => {
  it('returns names sorted, with the suffix stripped', () => {
    // Enumeration order is filesystem-defined; the sort is what makes the regenerated
    // barrel byte-identical between two machines holding the same artifacts.
    return readArtifactNames(
      fsWith(['user.routes.ts', 'billing.routes.ts', 'order.routes.ts']),
      '/app',
      ROUTES,
    ).then((names) => {
      expect(names).toEqual(['billing', 'order', 'user']);
    });
  });

  it('excludes an entry whose suffix does not match', async () => {
    const names = await readArtifactNames(
      fsWith(['user.routes.ts', 'notes.md', 'helper.ts']),
      '/app',
      ROUTES,
    );
    expect(names).toEqual(['user']);
  });

  // The barrel's own file ends in `.ts`, so a `.ts` suffix would admit it and the barrel
  // would import from itself. This is the case the `.plugin.ts` suffix exists for.
  it('excludes a hand-written module in a scanned directory', async () => {
    const names = await readArtifactNames(
      fsWith(['user.plugin.ts', 'index.ts', 'notes.ts']),
      '/app',
      PLUGINS,
    );
    expect(names).toEqual(['user']);
  });

  it('excludes a DIRECTORY whose name matches the suffix', async () => {
    // A directory cannot be imported, so admitting one would make the barrel name a
    // module that does not exist.
    const names = await readArtifactNames(
      fsWith(['user.routes.ts', 'legacy.routes.ts'], { 'legacy.routes.ts': DIR_STAT }),
      '/app',
      ROUTES,
    );
    expect(names).toEqual(['user']);
  });

  it('excludes a bare suffix, which would derive an empty symbol name', async () => {
    const names = await readArtifactNames(fsWith(['.routes.ts', 'user.routes.ts']), '/app', ROUTES);
    expect(names).toEqual(['user']);
  });

  it('returns [] when the directory does not exist', async () => {
    // The common case for a project that has never generated this family — not an error.
    expect(await readArtifactNames(fsWith(MISSING), '/app', ROUTES)).toEqual([]);
  });

  it('skips one unreadable entry and keeps the rest', async () => {
    const names = await readArtifactNames(
      fsWith(['user.routes.ts', 'gone.routes.ts'], { 'gone.routes.ts': MISSING }),
      '/app',
      ROUTES,
    );
    expect(names).toEqual(['user']);
  });
});

describe('scanArtifacts', () => {
  it('keys every wired family, even the ones with no artifacts', async () => {
    const artifacts = await scanArtifacts(fsWith(MISSING), '/app', listSeamSpecs());
    expect(Object.keys(artifacts).sort()).toEqual(
      listSeamSpecs().map((s) => s.schematic).sort(),
    );
    for (const names of Object.values(artifacts)) expect(names).toEqual([]);
  });

  // `command-handler` and `query-handler` share `src/cqrs/`, so they are told apart by
  // suffix rather than by location — a scan keyed on directory would merge them.
  it('separates two families sharing one directory', async () => {
    const cqrs: readonly SeamSpec[] = [
      getSeamSpec('command-handler')!,
      getSeamSpec('query-handler')!,
    ];
    const artifacts = await scanArtifacts(
      fsWith(['a.command-handler.ts', 'b.query-handler.ts', 'index.ts']),
      '/app',
      cqrs,
    );
    expect(artifacts['command-handler']).toEqual(['a']);
    expect(artifacts['query-handler']).toEqual(['b']);
  });
});
