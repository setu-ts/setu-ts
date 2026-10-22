import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import { coverageRows, parseRunnerArgs, runTargets, selectMembers } from './node-runner-core.ts';

describe('Per-member Node test runner', () => {
  it('resolves member paths and short names, deduplicates and refuses unknown members', () => {
    const members = ['./packages/common', './packages/runtime'];
    expect(selectMembers(members, [])).toEqual(members);
    expect(selectMembers(members, ['common', 'packages/runtime', './packages/common'])).toEqual(
      members,
    );
    expect(() => selectMembers(members, ['../outside'])).toThrow('Unknown workspace member');
  });
  it('leaves out skipped members and refuses an unknown skip', () => {
    const members = ['./packages/cli', './packages/common', './packages/runtime'];
    expect(selectMembers(members, [], ['cli', 'packages/runtime'])).toEqual(['./packages/common']);
    expect(selectMembers(members, ['cli', 'common'], ['cli'])).toEqual(['./packages/common']);
    expect(() => selectMembers(members, [], ['clii'])).toThrow('Unknown workspace member: clii');
  });
  it('parses coverage, tooling and repeated skip options', () => {
    expect(parseRunnerArgs([])).toEqual({
      coverage: false,
      tooling: true,
      selection: [],
      skip: [],
    });
    expect(
      parseRunnerArgs([
        '--coverage',
        '--no-tooling',
        '--skip',
        'cli',
        'common',
        '--skip',
        'kernel',
      ]),
    ).toEqual({ coverage: true, tooling: false, selection: ['common'], skip: ['cli', 'kernel'] });
    expect(() => parseRunnerArgs(['--skip'])).toThrow('--skip requires a workspace member');
    expect(() => parseRunnerArgs(['--skip', '--coverage'])).toThrow('--skip requires');
    expect(() => parseRunnerArgs(['--shard'])).toThrow('Unknown option: --shard');
  });
  it('omits the tooling target when asked', async () => {
    const calls: string[] = [];
    await runTargets(
      ['packages/common'],
      (member) => {
        calls.push(member);
        return Promise.resolve({ code: 0, rows: [] });
      },
      false,
    );
    expect(calls).toEqual(['packages/common']);
  });
  it('runs tooling after every member and propagates any failure', async () => {
    const calls: string[] = [];
    const result = await runTargets(['packages/common', 'packages/runtime'], (member) => {
      calls.push(member);
      return Promise.resolve({ code: member === 'packages/runtime' ? 1 : 0, rows: [member] });
    });
    expect(calls).toEqual(['packages/common', 'packages/runtime', 'tooling']);
    expect(result.code).toBe(1);
    expect(result.rows).toEqual(calls);
    expect((await runTargets([], () => Promise.resolve({ code: 0, rows: [] }))).code).toBe(0);
  });
  it('prints each source row without the aggregate', () => {
    const row = { branches: { pct: 91 }, functions: { pct: 92 }, lines: { pct: 93 } };
    expect(coverageRows({ total: row, '/work/packages/a/src/a.ts': row }, '/work')).toEqual([
      '| packages/a/src/a.ts | 91 | 92 | 93 |',
    ]);
  });
  it('runs the Node runner and preserves the tooling-only task boundary', async () => {
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    const expected = 'node scripts/test-node.ts';
    expect(pkg.scripts.test).toBe(expected);
    expect(pkg.scripts['test:coverage']).toBe(`${expected} --coverage`);
    expect(pkg.scripts['test:coverage:pkg']).toBe(`${expected} --coverage`);
    expect(pkg.scripts['test:tooling']).toBe('SETU_TEST_MEMBER=tooling vitest run');
  });
});
