import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import {
  belowBar,
  type CoverageRow,
  parseArgs,
  parseMemberTable,
  readWorkspaceMembers,
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
