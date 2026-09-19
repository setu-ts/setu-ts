// deno-lint-ignore-file no-console -- one test swaps `console.log`/`console.error`
// to prove the production reporters route to the streams a CI log separates.
/**
 * The changelog-coverage gate's own controls.
 *
 * Its design was validated against the three releases that actually lost an
 * export before it was written: replaying `v0.3.0`→#233, `v0.4.0`→#248 and
 * `v0.6.0`→#327 reports `ResponseSnapshotInit`,
 * `respondWithAuthorizationFailure` and the thirteen ingress decorators
 * respectively, and replaying the current tree reports nothing. Those replays
 * need a repository; the cases here need none.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  type CoverageOptions,
  exportedNames,
  lastReleasedVersion,
  main,
  type MainDeps,
  mentions,
  productionDeps,
  publishedReadmes,
  readAtRevision,
  revisionExists,
  run,
  unreleasedSection,
} from '../../scripts/check-changelog-coverage.ts';

function readme(...names: readonly string[]): string {
  const rows = names.map((name) => `| \`${name}\` | function |`).join('\n');
  return `# Pkg\n\n## Exports\n\n| Export | Kind |\n| --- | --- |\n${rows}\n\n## Notes\n\nx\n`;
}

function changelog(unreleased: string): string {
  return `# Changelog\n\n## [Unreleased]\n\n### Added\n\n${unreleased}\n\n## [0.7.0] — 2026-09-18\n\n- old\n`;
}

function options(over: Partial<CoverageOptions> = {}): CoverageOptions {
  return {
    readmes: ['packages/pkg/README.md'],
    readAtBase: () => Promise.resolve(readme('Kept')),
    readAtHead: () => Promise.resolve(readme('Kept', 'Minted')),
    readChangelog: () => Promise.resolve(changelog('- nothing relevant')),
    ...over,
  };
}

describe('unreleasedSection', () => {
  it('takes the Unreleased body and stops at the next released heading', () => {
    const section = unreleasedSection(changelog('- new thing'));
    expect(section).toContain('new thing');
    expect(section).not.toContain('old');
  });

  it('returns null when there is no Unreleased heading', () => {
    expect(unreleasedSection('# Changelog\n\n## [0.7.0] — x\n\n- old\n')).toBeNull();
  });
});

describe('exportedNames', () => {
  it('strips the kind, which is not new surface on its own', () => {
    expect(exportedNames(readme('A', 'B'))).toEqual(new Set(['A', 'B']));
  });

  it('returns null when the table is absent, so absence is never read as empty', () => {
    // An empty set would make every export of that package look pre-existing.
    expect(exportedNames('# Pkg\n\nNo table here.\n')).toBeNull();
  });
});

describe('mentions', () => {
  it('requires a CODE SPAN, so a section heading cannot satisfy a symbol', () => {
    // Found by a fixture that named its symbol `Added` and passed: the
    // section's own `### Added` heading matched it. Every Keep-a-Changelog
    // heading is a plausible identifier, and this direction is a false PASS —
    // the export ships unannounced while the gate reports it did not.
    for (const heading of ['Added', 'Changed', 'Fixed', 'Removed', 'Deprecated', 'Security']) {
      expect(mentions(`### ${heading}\n\n- something else\n`, heading)).toBe(false);
      expect(mentions(`### ${heading}\n\n- adds \`${heading}\`\n`, heading)).toBe(true);
    }
  });

  it('does not let ordinary prose stand in for naming the export', () => {
    expect(mentions('- the plugin now has a Gateway concept', 'Gateway')).toBe(false);
    expect(mentions('- adds `Gateway` for websocket ingress', 'Gateway')).toBe(true);
  });

  it('reads a symbol inside a longer span, which is how options are written', () => {
    expect(
      mentions('- `defineConfigSection({ prefix, keys })` declares one', 'defineConfigSection'),
    )
      .toBe(true);
  });

  it('matches on a word boundary in both directions', () => {
    expect(mentions('adds `ViewPlugin` today', 'ViewPlugin')).toBe(true);
    // The trap this boundary exists for: a longer name must not satisfy a
    // shorter one, nor the reverse.
    expect(mentions('adds `ViewPluginOptions`', 'ViewPlugin')).toBe(false);
    expect(mentions('adds `ViewPlugin`', 'ViewPluginOptions')).toBe(false);
  });

  it('is not fooled by an identifier character before the name', () => {
    expect(mentions('adds `MyViewPlugin`', 'ViewPlugin')).toBe(false);
  });
});

describe('lastReleasedVersion', () => {
  it('reads the newest released section, never Unreleased', () => {
    expect(lastReleasedVersion(changelog('- x'))).toBe('0.7.0');
  });

  it('reads a prerelease version', () => {
    expect(lastReleasedVersion('## [0.1.0-alpha.10] — x\n')).toBe('0.1.0-alpha.10');
  });

  it('returns null when nothing is released yet', () => {
    expect(lastReleasedVersion('# Changelog\n\n## [Unreleased]\n')).toBeNull();
  });
});

describe('run', () => {
  it('reports an added export no entry names', async () => {
    const result = await run(options());
    expect(result.unannounced).toEqual([
      { readme: 'packages/pkg/README.md', symbol: 'Minted' },
    ]);
    expect(result.compared).toBe(1);
  });

  it('passes when an entry names it', async () => {
    const result = await run(
      options({ readChangelog: () => Promise.resolve(changelog('- adds `Minted`')) }),
    );
    expect(result.unannounced).toEqual([]);
  });

  it('ignores an export that was already there', async () => {
    const result = await run(
      options({ readAtHead: () => Promise.resolve(readme('Kept')) }),
    );
    expect(result.unannounced).toEqual([]);
  });

  it('treats a package absent at the base as entirely new surface', async () => {
    // A first publish must announce what it ships, so every export counts.
    const result = await run(options({ readAtBase: () => Promise.resolve(null) }));
    expect(result.unannounced.map((u) => u.symbol)).toEqual(['Kept', 'Minted']);
  });

  it('reports a missing table rather than comparing against nothing', async () => {
    // Reading an absent table as an empty set would report every export of that
    // package as new; reading it as "everything" would hide a real addition.
    const result = await run(
      options({ readAtBase: () => Promise.resolve('# Pkg\n\nNo table.\n') }),
    );
    expect(result.unannounced).toEqual([]);
    expect(result.compared).toBe(0);
    expect(result.skipped[0]?.reason).toContain('base revision');
  });

  it('reports an absent working-tree README', async () => {
    const result = await run(options({ readAtHead: () => Promise.resolve(null) }));
    expect(result.compared).toBe(0);
    expect(result.skipped[0]?.reason).toContain('absent from the working tree');
  });

  it('reports every added export when the changelog has no Unreleased section', async () => {
    const result = await run(
      options({ readChangelog: () => Promise.resolve('# Changelog\n\n## [0.7.0] — x\n') }),
    );
    expect(result.unannounced.map((u) => u.symbol)).toEqual(['Minted']);
  });
});

describe('main — reporting and exit codes', () => {
  function deps(over: Partial<MainDeps> = {}): { deps: MainDeps; out: string[]; err: string[] } {
    const out: string[] = [];
    const err: string[] = [];
    return {
      out,
      err,
      deps: {
        readChangelog: () => Promise.resolve(changelog('- adds `Minted`')),
        revisionExists: () => Promise.resolve(true),
        readAtRevision: () => Promise.resolve(readme('Kept')),
        readWorkingTree: () => Promise.resolve(readme('Kept', 'Minted')),
        listReadmes: () => Promise.resolve(['packages/pkg/README.md']),
        log: (line) => out.push(line),
        error: (line) => err.push(line),
        ...over,
      },
    };
  }

  it('exits 0 and says what it compared', async () => {
    const { deps: d, out } = deps();
    expect(await main(d)).toBe(0);
    expect(out.join('\n')).toContain('1 package(s) compared against v0.7.0');
  });

  it('exits 1 naming the export and the package', async () => {
    const { deps: d, err } = deps({
      readChangelog: () => Promise.resolve(changelog('- unrelated prose')),
    });
    expect(await main(d)).toBe(1);
    const report = err.join('\n');
    expect(report).toContain('packages/pkg/README.md');
    expect(report).toContain('Minted');
  });

  it('fails CLOSED when the base tag does not resolve, with the remedy', async () => {
    // A shallow checkout fetches no tags. Comparing nothing and reporting a
    // pass is the failure mode this gate exists to remove, so it must not be
    // this gate's own behaviour.
    const { deps: d, err } = deps({ revisionExists: () => Promise.resolve(false) });
    expect(await main(d)).toBe(1);
    expect(err.join('\n')).toContain('fetch-depth: 0');
  });

  it('fails when the changelog names no released version', async () => {
    const { deps: d, err } = deps({
      readChangelog: () => Promise.resolve('# Changelog\n\n## [Unreleased]\n'),
    });
    expect(await main(d)).toBe(1);
    expect(err.join('\n')).toContain('no released version');
  });

  it('FAILS when every README was skipped, because nothing was compared', async () => {
    // The gate's own failure mode. An empty `git ls-files`, a checkout with no
    // packages, or every table missing all reach here, and reporting a pass
    // for a run that checked nothing is what this gate exists to stop.
    const { deps: d, out, err } = deps({
      readWorkingTree: () => Promise.resolve('# Pkg\n\nNo table.\n'),
    });
    expect(await main(d)).toBe(1);
    expect(out.join('\n')).toContain('skipped packages/pkg/README.md');
    expect(err.join('\n')).toContain('nothing was checked');
  });

  it('FAILS when the README list itself is empty', async () => {
    const { deps: d, err } = deps({ listReadmes: () => Promise.resolve([]) });
    expect(await main(d)).toBe(1);
    expect(err.join('\n')).toContain('no package README was compared');
  });
});

describe('the git seams, against this repository', () => {
  // Deliberately `HEAD` rather than a release tag. A shallow checkout — which
  // is what `actions/checkout` produces by default, and what a reviewer's
  // sandbox has — fetches no tags, so a tag-dependent unit test fails for a
  // reason that has nothing to do with the seam it claims to cover. That a
  // real tag resolves is proved by the gate's own run under `check:docs`,
  // where the workflow checks out full history.
  it('resolves a revision that exists and rejects one that does not', async () => {
    expect(await revisionExists('HEAD')).toBe(true);
    expect(await revisionExists('v99.0.0-does-not-exist')).toBe(false);
  });

  it('reads a path at a revision, and reports an absent path as null', async () => {
    const changelog = await readAtRevision('HEAD', 'CHANGELOG.md');
    expect(changelog).not.toBeNull();
    expect(changelog).toContain('## [Unreleased]');
    expect(await readAtRevision('HEAD', 'no/such/file.md')).toBeNull();
  });

  it('lists every published package README, and only those', async () => {
    const readmes = await publishedReadmes();
    // The count is not asserted: a new package is a normal change, and pinning
    // it here would make adding one fail this test for no reason.
    expect(readmes.length).toBeGreaterThan(40);
    expect(readmes).toContain('packages/kernel/README.md');
    expect(readmes).toContain('packages/starters/rest-starter/README.md');
    expect(readmes.every((r) => r.startsWith('packages/') && r.endsWith('/README.md'))).toBe(true);
  });
});

describe('productionDeps', () => {
  it('reads the WORKING TREE changelog and working-tree READMEs', async () => {
    // The wiring is the part with no branches and every opportunity to be
    // subtly wrong: reading the changelog at the base revision instead of the
    // working tree would compare a release against itself and always pass.
    const deps = productionDeps();
    expect(await deps.readChangelog()).toContain('## [Unreleased]');
    expect(await deps.readWorkingTree('packages/kernel/README.md')).toContain('## Exports');
    expect(await deps.readWorkingTree('no/such/file.md')).toBeNull();
    expect(await deps.revisionExists('HEAD')).toBe(true);
    expect(await deps.readAtRevision('HEAD', 'CHANGELOG.md')).toContain('## [Unreleased]');
    expect((await deps.listReadmes()).length).toBeGreaterThan(40);
  });

  it('routes its two reporters to the streams a CI log separates', () => {
    // `log` and `error` are one line each and trivially swappable, which is
    // why they are worth pinning: a gate whose failures go to stdout is a gate
    // whose failures are easy to miss in a CI log.
    const deps = productionDeps();
    const originalLog = console.log;
    const originalError = console.error;
    const out: string[] = [];
    const err: string[] = [];
    console.log = (line: string) => out.push(line);
    console.error = (line: string) => err.push(line);
    try {
      deps.log('to stdout');
      deps.error('to stderr');
    } finally {
      console.log = originalLog;
      console.error = originalError;
    }
    expect(out).toEqual(['to stdout']);
    expect(err).toEqual(['to stderr']);
  });
});
