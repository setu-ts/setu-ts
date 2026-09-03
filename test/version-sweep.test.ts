/**
 * Tests for the residual-version gate (`scripts/version-sweep.ts`).
 *
 * The gate's failure mode is a SILENT PASS — a pattern that stops matching
 * reports zero findings and looks exactly like a clean tree — so the cases
 * below lean on the two things that distinguish a working sweep from a dead
 * one: a reference it must REPORT, and the vacuity guard.
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  findStaleReferences,
  isSweptPath,
  main,
  referenceMatches,
  reportSweep,
  sweepTrackedFiles,
  trackedFiles,
  workspaceVersion,
} from '../scripts/version-sweep.ts';

describe('version sweep — referenceMatches', () => {
  it('accepts an exact match', () => {
    expect(referenceMatches('0.3.0', '0.3.0')).toBe(true);
  });

  // A lockfile abbreviates a caret range to `0.3` while a link key spells
  // `0.3.0`; both name the shipping version, so neither is staleness.
  it('accepts a lockfile range shorthand', () => {
    expect(referenceMatches('0.3', '0.3.0')).toBe(true);
    expect(referenceMatches('0', '0.3.0')).toBe(true);
  });

  // The boundary is what keeps the shorthand from over-matching. Without the
  // dot check, `0.3` would accept `0.30.0` and a real bump would go unreported.
  it('rejects a prefix that is not dot-bounded', () => {
    expect(referenceMatches('0.3', '0.30.0')).toBe(false);
    expect(referenceMatches('0.30', '0.3.0')).toBe(false);
  });

  it('rejects an outright different version', () => {
    expect(referenceMatches('0.2.0', '0.3.0')).toBe(false);
    expect(referenceMatches('0.1.0-alpha.9', '0.3.0')).toBe(false);
  });
});

describe('version sweep — findStaleReferences', () => {
  it('reports a stale specifier with its package, line and version', () => {
    const source = "import x from 'jsr:@setu-ts/common@^0.2.0';\n";
    const { findings, seen } = findStaleReferences('a/src/b.ts', source, '0.3.0');
    expect(seen).toBe(1);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.pkg).toBe('common');
    expect(findings[0]?.version).toBe('0.2.0');
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.file).toBe('a/src/b.ts');
  });

  it('counts a current reference as seen but not stale', () => {
    const { findings, seen } = findStaleReferences(
      'a/src/b.ts',
      "import x from 'jsr:@setu-ts/common@^0.3.0';\n",
      '0.3.0',
    );
    expect(seen).toBe(1);
    expect(findings).toEqual([]);
  });

  it('reads both lockfile shapes on one line', () => {
    const source = '"jsr:@setu-ts/cli@0.3.0": { "dependencies": ["jsr:@setu-ts/common@0.3"] }\n';
    const { findings, seen } = findStaleReferences('deno.lock', source, '0.3.0');
    expect(seen).toBe(2);
    expect(findings).toEqual([]);
  });

  it('exempts a reference marked as history, on its line or the one above', () => {
    const inline = "const old = 'jsr:@setu-ts/common@^0.2.0'; // version:history\n";
    expect(findStaleReferences('a/src/b.ts', inline, '0.3.0').findings).toEqual([]);

    const above = "// version:history\nconst old = 'jsr:@setu-ts/common@^0.2.0';\n";
    expect(findStaleReferences('a/src/b.ts', above, '0.3.0').findings).toEqual([]);

    // The marker reaches exactly one line, not the whole file.
    const twoBelow = "// version:history\n\nconst old = 'jsr:@setu-ts/common@^0.2.0';\n";
    expect(findStaleReferences('a/src/b.ts', twoBelow, '0.3.0').findings).toHaveLength(1);
  });

  it('reports every stale reference, not only the first', () => {
    const source = "'jsr:@setu-ts/common@^0.2.0';\n'jsr:@setu-ts/kernel@^0.1.0-alpha.9';\n";
    const { findings } = findStaleReferences('a/src/b.ts', source, '0.3.0');
    expect(findings.map((f) => f.pkg)).toEqual(['common', 'kernel']);
  });

  it('ignores a bare version that names no package', () => {
    // packages/cli/src legitimately stamps a scaffolded project's own version,
    // which has nothing to do with this framework's. A bare-number sweep would
    // report every one of them.
    const source = "const scaffold = { version: '0.1.0' };\n";
    const { findings, seen } = findStaleReferences('a/src/b.ts', source, '0.3.0');
    expect(seen).toBe(0);
    expect(findings).toEqual([]);
  });
});

describe('version sweep — isSweptPath', () => {
  it('takes source under a src tree and every lockfile', () => {
    expect(isSweptPath('packages/sdk/src/http/client.ts')).toBe(true);
    expect(isSweptPath('packages/starters/rest-starter/src/index.ts')).toBe(true);
    expect(isSweptPath('deno.lock')).toBe(true);
    expect(isSweptPath('apps/minimal/deno.lock')).toBe(true);
  });

  it('leaves manifests to release:verify and Markdown to check:docs', () => {
    expect(isSweptPath('packages/sdk/deno.json')).toBe(false);
    expect(isSweptPath('deno.json')).toBe(false);
    expect(isSweptPath('README.md')).toBe(false);
    expect(isSweptPath('docs/releasing.md')).toBe(false);
  });

  // A fixture's version is data, not a dependency: add.test.ts hard-codes `@^1`
  // to prove `setu add` PRESERVES an existing pin, and rewriting it would
  // destroy what the test asserts.
  it('leaves test fixtures alone', () => {
    expect(isSweptPath('packages/cli/test/unit/plugin-detector.test.ts')).toBe(false);
    expect(isSweptPath('test/docs-gate.test.ts')).toBe(false);
  });

  it('ignores a non-TypeScript file that is not a lockfile', () => {
    expect(isSweptPath('packages/sdk/src/logo.svg')).toBe(false);
  });
});

describe('version sweep — sweepTrackedFiles', () => {
  it('reads the real tree and reports both vacuity guards', async () => {
    const result = await sweepTrackedFiles('0.3.0', [
      'packages/sdk/src/retry/retry-strategy.ts',
      'packages/sdk/deno.json', // filtered out by isSweptPath
    ]);
    expect(result.filesScanned).toBe(1);
    expect(result.referencesSeen).toBeGreaterThan(0);
    expect(result.findings).toEqual([]);
  });

  it('skips a path git lists but the working tree does not have', async () => {
    const result = await sweepTrackedFiles('0.3.0', ['packages/sdk/src/does-not-exist.ts']);
    expect(result.filesScanned).toBe(0);
    expect(result.referencesSeen).toBe(0);
    expect(result.findings).toEqual([]);
  });

  it('reports a stale reference found in a real file', async () => {
    const result = await sweepTrackedFiles('9.9.9', [
      'packages/sdk/src/retry/retry-strategy.ts',
    ]);
    expect(result.findings.length).toBeGreaterThan(0);
    expect(result.findings[0]?.pkg).toBe('common');
  });
});

describe('version sweep — reportSweep', () => {
  const clean = { findings: [], filesScanned: 10, referencesSeen: 42 } as const;

  it('passes and names both guards when nothing is stale', () => {
    const { failed, lines } = reportSweep(clean, '0.3.0');
    expect(failed).toBe(false);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain('42');
    expect(lines[0]).toContain('10');
    expect(lines[0]).toContain('0.3.0');
  });

  // The branch a healthy tree can never produce, which is exactly why it is
  // worth a test: zero references means the pattern died, not that the tree is
  // tidy, and reporting a pass there would make every later run meaningless.
  it('fails on zero references even with zero findings', () => {
    const { failed, lines } = reportSweep(
      { findings: [], filesScanned: 767, referencesSeen: 0 },
      '0.3.0',
    );
    expect(failed).toBe(true);
    expect(lines[0]).toContain('NO @setu-ts references');
    expect(lines[0]).toContain('767');
  });

  it('fails and lists every stale reference with a remedy', () => {
    const { failed, lines } = reportSweep({
      findings: [
        { file: 'packages/sdk/src/a.ts', line: 3, pkg: 'common', version: '0.2.0' },
        { file: 'apps/minimal/deno.lock', line: 9, pkg: 'kernel', version: '0.2' },
      ],
      filesScanned: 767,
      referencesSeen: 2245,
    }, '0.3.0');
    expect(failed).toBe(true);
    expect(lines[0]).toContain('2 reference(s)');
    expect(lines[1]).toBe('  packages/sdk/src/a.ts:3  @setu-ts/common@0.2.0');
    expect(lines[2]).toBe('  apps/minimal/deno.lock:9  @setu-ts/kernel@0.2');
    expect(lines[3]).toContain('version:history');
  });
});

describe('version sweep — entry points', () => {
  it('reads the workspace version from the kernel manifest', async () => {
    expect(await workspaceVersion()).toMatch(/^\d+\.\d+\.\d+/);
  });

  it('passes against the real repository at its own version', async () => {
    expect(await main(await workspaceVersion())).toBe(false);
  });

  // Drives the failing path end to end: every real reference is stale against
  // a version the repository is not on.
  it('fails against a version the repository is not on', async () => {
    expect(await main('9.9.9')).toBe(true);
  });
});

describe('version sweep — trackedFiles', () => {
  const enc = (t: string) => new TextEncoder().encode(t);

  it('splits the listing and drops the trailing blank', async () => {
    const files = await trackedFiles(() =>
      Promise.resolve({ success: true, stdout: enc('a.ts\nb/deno.lock\n'), stderr: enc('') })
    );
    expect(files).toEqual(['a.ts', 'b/deno.lock']);
  });

  // A failed lister must throw rather than return nothing: returning an empty
  // list would reach the vacuity guard and report "the pattern is broken",
  // which names the wrong cause and sends the reader to the wrong file.
  it('throws with git stderr when the lister fails', async () => {
    await expect(
      trackedFiles(() =>
        Promise.resolve({ success: false, stdout: enc(''), stderr: enc('not a git repository') })
      ),
    ).rejects.toThrow('not a git repository');
  });

  // Asserts a long-tracked path, deliberately not this module's own file: an
  // uncommitted file is absent from `git ls-files`, so that assertion would
  // fail during the very change that introduces it.
  it('reaches the real git lister by default', async () => {
    const files = await trackedFiles();
    expect(files).toContain('deno.json');
    expect(files).toContain('scripts/check-docs.ts');
  });
});
