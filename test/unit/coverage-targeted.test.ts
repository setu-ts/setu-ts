import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  belowBar,
  type CoverageRow,
  findUnreportedFiles,
  parseArgs,
  parseChangedPaths,
  parseMeasuredFiles,
  parseMemberTable,
  readWorkspaceMembers,
  renderProbeModule,
  resolveMembers,
} from '../../scripts/coverage-targeted.ts';

const MEMBERS = [
  'packages/common',
  'packages/kernel',
  'packages/exceptions',
  'packages/resilience-plugin',
  'packages/starters/rest-starter',
] as const;

describe('readWorkspaceMembers', () => {
  it('strips the leading ./ so entries compare against git paths', () => {
    const members = readWorkspaceMembers(
      JSON.stringify({ workspace: ['./packages/common', './packages/starters/rest-starter'] }),
    );
    expect(members).toEqual(['packages/common', 'packages/starters/rest-starter']);
  });

  it('treats a manifest with no workspace key as empty rather than throwing', () => {
    expect(readWorkspaceMembers('{}')).toEqual([]);
  });
});

describe('resolveMembers', () => {
  it('resolves a member path, a short name and a scoped name', () => {
    const resolved = resolveMembers(
      ['packages/common', 'kernel', '@setu-ts/exceptions'],
      MEMBERS,
    );
    expect(resolved.members).toEqual([
      'packages/common',
      'packages/kernel',
      'packages/exceptions',
    ]);
    expect(resolved.unmatched).toEqual([]);
  });

  it('resolves a file inside a member, which is what a git diff line looks like', () => {
    const resolved = resolveMembers(
      ['packages/kernel/src/router/router.ts', 'packages/kernel/test/unit/x.test.ts'],
      MEMBERS,
    );
    expect(resolved.members).toEqual(['packages/kernel']);
  });

  it('prefers the longest member so a two-segment starter is not mangled', () => {
    const resolved = resolveMembers(
      ['packages/starters/rest-starter/src/index.ts'],
      MEMBERS,
    );
    expect(resolved.members).toEqual(['packages/starters/rest-starter']);
  });

  it('accepts the bare concern of a plugin when exactly one member matches', () => {
    const resolved = resolveMembers(['resilience'], MEMBERS);
    expect(resolved.members).toEqual(['packages/resilience-plugin']);
  });

  it('reports an unknown selector instead of silently measuring nothing', () => {
    const resolved = resolveMembers(['packages/common', 'not-a-package'], MEMBERS);
    expect(resolved.members).toEqual(['packages/common']);
    expect(resolved.unmatched).toEqual(['not-a-package']);
  });

  it('refuses an ambiguous bare concern rather than guessing', () => {
    const ambiguous = ['packages/a-plugin', 'packages/b-plugin'];
    // `a` resolves to exactly one; a concern matching two would be unmatched.
    expect(resolveMembers(['a'], ambiguous).members).toEqual(['packages/a-plugin']);
    expect(resolveMembers(['zzz'], ambiguous).unmatched).toEqual(['zzz']);
  });

  it('deduplicates and returns members in manifest order', () => {
    const resolved = resolveMembers(
      ['packages/kernel/src/a.ts', 'kernel', 'packages/common'],
      MEMBERS,
    );
    expect(resolved.members).toEqual(['packages/common', 'packages/kernel']);
  });

  it('ignores an empty selector', () => {
    expect(resolveMembers([''], MEMBERS)).toEqual({ members: [], unmatched: [] });
  });
});

describe('parseMemberTable', () => {
  const table = [
    '| File                | Branch % | Function % | Line % |',
    '| ------------------- | -------- | ---------- | ------ |',
    '| index.ts            |    100.0 |      100.0 |  100.0 |',
    '| services/svc.ts     |     84.2 |       90.0 |   99.9 |',
    '| All files           |     92.1 |       95.0 |   99.9 |',
  ].join('\n');

  it('parses each file row and skips the header and the All files aggregate', () => {
    const rows = parseMemberTable(table);
    expect(rows.map((row) => row.file)).toEqual(['index.ts', 'services/svc.ts']);
    expect(rows[1]).toEqual({
      file: 'services/svc.ts',
      branchPct: 84.2,
      functionPct: 90,
      linePct: 99.9,
    });
  });

  it('strips ANSI colour so a colourized 75.9 is not read as a pass', () => {
    const esc = String.fromCharCode(0x1b);
    const colorized = `| a.ts | ${esc}[33m75.9${esc}[0m | 100.0 | 100.0 |`;
    const rows = parseMemberTable(colorized);
    expect(rows[0]?.branchPct).toBe(75.9);
  });

  it('returns no rows for output carrying no table', () => {
    expect(parseMemberTable('error: no covered files\n')).toEqual([]);
  });
});

describe('belowBar', () => {
  const row = (over: Partial<CoverageRow>): CoverageRow => ({
    file: 'a.ts',
    branchPct: 100,
    functionPct: 100,
    linePct: 100,
    ...over,
  });

  it('fails a row below the bar on any single dimension', () => {
    expect(belowBar([row({ branchPct: 89.9 })])).toHaveLength(1);
    expect(belowBar([row({ functionPct: 89.9 })])).toHaveLength(1);
    expect(belowBar([row({ linePct: 89.9 })])).toHaveLength(1);
  });

  it('passes a row exactly at the bar', () => {
    expect(belowBar([row({ branchPct: 90, functionPct: 90, linePct: 90 })])).toEqual([]);
  });
});

describe('parseArgs', () => {
  it('separates positional selectors from the diff base', () => {
    const parsed = parseArgs(['kernel', '--base=origin/main']);
    expect(parsed.selectors).toEqual(['kernel']);
    expect(parsed.base).toBe('origin/main');
  });

  it('defaults the diff base to main', () => {
    const parsed = parseArgs([]);
    expect(parsed.base).toBe('main');
    expect(parsed.selectors).toEqual([]);
  });
});

describe('parseMeasuredFiles', () => {
  it('reads the SF records and ignores every other lcov line', () => {
    const lcov = [
      'SF:/repo/packages/exceptions/src/index.ts',
      'FNF:3',
      'FNH:3',
      'DA:1,1',
      'end_of_record',
      'SF:/repo/packages/exceptions/src/errors/http-error.ts',
      'end_of_record',
    ].join('\n');
    expect(parseMeasuredFiles(lcov)).toEqual([
      '/repo/packages/exceptions/src/index.ts',
      '/repo/packages/exceptions/src/errors/http-error.ts',
    ]);
  });

  it('returns nothing for a report with no records', () => {
    expect(parseMeasuredFiles('')).toEqual([]);
  });
});

describe('findUnreportedFiles', () => {
  it('does not let a measured index.ts claim a nested one', () => {
    // The defect this replaced: `deno coverage`'s TABLE prints the only
    // measured file as `index.ts`, and a suffix test then accepted it for
    // `internal/index.ts` too — skipping an untested runtime module. Matching
    // full lcov paths makes the two distinct. Observed live: a single-member
    // run reported `9 measured … 0 with no runtime code` over 10 src files.
    const expected = [
      'packages/exceptions/src/index.ts',
      'packages/exceptions/src/internal/index.ts',
    ];
    const measured = ['/repo/packages/exceptions/src/index.ts'];
    expect(findUnreportedFiles(expected, measured)).toEqual([
      'packages/exceptions/src/internal/index.ts',
    ]);
  });

  it('matches an absolute measured path against a repo-relative expectation', () => {
    const expected = ['packages/exceptions/src/index.ts'];
    const measured = ['/home/someone/checkout/packages/exceptions/src/index.ts'];
    expect(findUnreportedFiles(expected, measured)).toEqual([]);
  });

  it('accepts an already-relative measured path', () => {
    expect(findUnreportedFiles(['packages/a/src/b.ts'], ['packages/a/src/b.ts'])).toEqual([]);
  });

  it('reports every expected file when nothing was measured', () => {
    const expected = ['packages/a/src/one.ts', 'packages/a/src/two.ts'];
    expect(findUnreportedFiles(expected, [])).toEqual(expected);
  });

  it('does not match on a partial segment', () => {
    const expected = ['packages/a/src/my-index.ts'];
    expect(findUnreportedFiles(expected, ['/repo/packages/a/src/index.ts'])).toEqual([
      'packages/a/src/my-index.ts',
    ]);
  });
});

describe('parseChangedPaths', () => {
  it('combines committed paths with the working tree', () => {
    const paths = parseChangedPaths(
      'packages/kernel/src/router.ts\n',
      ' M packages/common/src/http.ts\n?? packages/sdk/src/new.ts\n',
    );
    expect(paths).toEqual([
      'packages/kernel/src/router.ts',
      'packages/common/src/http.ts',
      'packages/sdk/src/new.ts',
    ]);
  });

  it('takes the destination of a rename', () => {
    expect(parseChangedPaths('', 'R  packages/a/src/old.ts -> packages/a/src/new.ts\n'))
      .toEqual(['packages/a/src/new.ts']);
  });

  it('drops blank lines from both sources', () => {
    expect(parseChangedPaths('\n\n', '   \n')).toEqual([]);
  });
});

describe('renderProbeModule', () => {
  it('derives the ../ depth from the probe directory so specifiers resolve', () => {
    const module = renderProbeModule(
      ['packages/exceptions/src/zz.ts'],
      '.coverage/targeted',
    );
    expect(module).toContain("await import('../../packages/exceptions/src/zz.ts');");
  });

  it('reflects a different probe depth rather than hardcoding two levels', () => {
    expect(renderProbeModule(['packages/a/src/b.ts'], 'tmp'))
      .toContain("await import('../packages/a/src/b.ts');");
  });

  it('declares a test, without which deno test reports the module as failed', () => {
    // A module registering no tests exits non-zero, so the probe could never
    // classify anything (verified: "0 passed | 1 failed").
    expect(renderProbeModule(['packages/a/src/b.ts'], 'tmp')).toContain('Deno.test(');
  });

  it('loads every file it is given', () => {
    const module = renderProbeModule(
      ['packages/a/src/one.ts', 'packages/a/src/two.ts'],
      '.coverage/targeted',
    );
    expect(module.match(/await import\(/g)).toHaveLength(2);
  });
});
