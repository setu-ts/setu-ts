/**
 * Repo-wide recurrence gate for computed `import()` specifiers (M70e §3.7).
 *
 * Runs `auditPackageSources('packages')` over the whole tree on every suite
 * run and asserts it is clean: no computed `import()` in a package `src` tree
 * without a `computed-specifier` marker. The vacuity guard asserts the walker
 * actually visited files and found the three known marked sites, so a broken
 * walker cannot pass by scanning nothing.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { auditPackageSources } from '../scripts/npm-specifier-audit.ts';

describe('npm-specifier gate (whole packages/ tree)', () => {
  it('finds no unmarked computed import() in packages/*/src', async () => {
    const result = await auditPackageSources('packages');
    expect(result.findings).toEqual([]);
  });

  it('visited a non-zero number of source files (walker is not vacuous)', async () => {
    const result = await auditPackageSources('packages');
    expect(result.filesVisited).toBeGreaterThan(0);
  });

  it('found exactly the three known marked computed-import sites', async () => {
    const result = await auditPackageSources('packages');
    // Three legitimate computed imports, each marked with a reason:
    //   packages/cli/src/schematics/custom.ts
    //   packages/decorator-plugin/src/discovery/controller-discovery.ts
    //   packages/react-router-plugin/src/handler/server-build.ts
    // A fourth would be visible here (plan §8 R5).
    expect(result.markedSites).toBe(3);
  });
});
