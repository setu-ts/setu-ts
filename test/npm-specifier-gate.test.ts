/**
 * Repo-wide recurrence gate for computed `import()` specifiers (M70e §3.7).
 *
 * Runs `auditPackageSources('packages')` over the whole tree on every suite
 * run and asserts it is clean: no computed `import()` in a package `src` tree
 * without a `computed-specifier` marker. The vacuity guard asserts the walker
 * actually visited files and found the two known marked sites, so a broken
 * walker cannot pass by scanning nothing.
 *
 * @module
 */

import { readdir } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { auditPackageSources } from '../scripts/npm-specifier-audit.ts';

/**
 * Counts every `.ts` file under any `src` directory below `dir`, independently
 * of the walker under test — so the gate's own file count is checked against a
 * second implementation rather than against itself.
 */
async function countTsFilesUnderSrc(dir: string, inSrc = false): Promise<number> {
  let count = 0;
  for await (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules') continue;
      count += await countTsFilesUnderSrc(path, inSrc || entry.name === 'src');
    } else if (
      inSrc &&
      entry.isFile() &&
      (entry.name.endsWith('.ts') || entry.name.endsWith('.tsx'))
    ) {
      count++;
    }
  }
  return count;
}

describe('npm-specifier gate (whole packages/ tree)', () => {
  it('finds no unmarked computed import() in packages/*/src', async () => {
    const result = await auditPackageSources('packages');
    expect(result.findings).toEqual([]);
  });

  it('finds no npm:/jsr:-prefixed import specifier in packages/*/src (M111a §3.8)', async () => {
    const result = await auditPackageSources('packages');
    expect(result.prefixed).toEqual([]);
  });

  it('finds no unguarded bare import() in packages/*/src (M113d §3.2)', async () => {
    const result = await auditPackageSources('packages');
    expect(result.unguarded).toEqual([]);
  });

  it('visited a non-zero number of source files (walker is not vacuous)', async () => {
    const result = await auditPackageSources('packages');
    expect(result.filesVisited).toBeGreaterThan(0);
  });

  it('audits every src tree in the workspace, including the nested starters', async () => {
    const result = await auditPackageSources('packages');

    // `filesVisited > 0` is NOT a coverage guard: the first walker probed only
    // `packages/<pkg>/src`, so it skipped all three `packages/starters/*/src`
    // trees — published packages — while reporting a healthy 651 files and a
    // clean result for an import shape it refused everywhere else. Assert the
    // roots, which is what makes a missed subtree visible.
    for (const starter of ['rest-starter', 'microservice-starter', 'full-stack-starter']) {
      expect(result.srcRootsVisited).toContain(`packages/starters/${starter}/src`);
    }

    // Independent count: every `.ts` under any `packages/**/src` must have been
    // visited, so a subtree cannot be dropped without failing here.
    const expected = await countTsFilesUnderSrc('packages');
    expect(result.filesVisited).toBe(expected);
  });

  it('found exactly the two known marked computed-import sites', async () => {
    const result = await auditPackageSources('packages');
    // Two legitimate computed imports, each marked with a reason:
    //   packages/decorator-plugin/src/discovery/controller-discovery.ts
    //   packages/react-router-plugin/src/handler/server-build.ts
    // The CLI's custom-schematic loader was the third until M111d, which loads
    // project modules through tsx's tsImport (packages/cli/src/utils/ts-loader.ts)
    // — a function call naming a project file, not an import expression.
    // A third would be visible here (plan §8 R5).
    expect(result.markedSites).toBe(2);
  });
});
