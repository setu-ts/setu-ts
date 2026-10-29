import { describe, it, expect } from 'vitest';
import { readFile } from 'node:fs/promises';
import {
  coverageRows,
  parseRunnerArgs,
  runTargets,
  selectMembers,
  validateRunnerArgs,
  vitestArgs,
} from './node-runner-core.ts';

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
    expect(() => parseRunnerArgs(['--unknown'])).toThrow('Unknown option: --unknown');
  });
  it('validates shard syntax and refuses incompatible selections before execution', () => {
    for (const value of [
      undefined,
      '0/3',
      '4/3',
      '1/9',
      '1.5/3',
      '1/0',
      '-1/3',
      '01/3',
      '1/3/4',
      '--coverage',
    ])
      expect(() => parseRunnerArgs(value === undefined ? ['--shard'] : ['--shard', value])).toThrow(
        '--shard requires',
      );
    for (const mode of [['--shard', '1/3'], ['--merge']]) {
      const valid = parseRunnerArgs(['--coverage', '--no-tooling', 'cli', ...mode]);
      expect(() => validateRunnerArgs(valid, ['packages/cli'])).not.toThrow();
      expect(() => validateRunnerArgs({ ...valid, coverage: false }, ['packages/cli'])).toThrow(
        'require --coverage',
      );
      expect(() => validateRunnerArgs(valid, ['packages/cli', 'packages/common'])).toThrow(
        'exactly one',
      );
      expect(() => validateRunnerArgs(valid, [])).toThrow('exactly one');
      expect(() => validateRunnerArgs({ ...valid, selection: [] }, ['packages/cli'])).toThrow(
        'exactly one',
      );
      expect(() => validateRunnerArgs({ ...valid, tooling: true }, ['packages/cli'])).toThrow(
        'refuse the tooling',
      );
    }
    expect(() =>
      validateRunnerArgs(parseRunnerArgs(['--coverage', '--shard', '1/3', '--merge']), ['cli']),
    ).toThrow('mutually exclusive');
    expect(() => validateRunnerArgs(parseRunnerArgs([]), [])).not.toThrow();
    expect(parseRunnerArgs(['--shard', '8/8']).shard).toBe('8/8');
  });
  it('builds normal, shard and merge Vitest invocations', async () => {
    expect(vitestArgs(parseRunnerArgs([]), 'cli')).toEqual(['exec', 'vitest', 'run']);
    expect(vitestArgs(parseRunnerArgs(['--coverage']), 'cli')).toEqual([
      'exec',
      'vitest',
      'run',
      '--coverage',
    ]);
    expect(vitestArgs(parseRunnerArgs(['--coverage', '--shard', '2/3']), 'cli')).toEqual([
      'exec',
      'vitest',
      'run',
      '--coverage',
      '--shard=2/3',
      '--reporter=blob',
      '--coverage.reporter=json-summary',
      '--coverage.reporter=json',
      '--coverage.reportsDirectory=coverage-node/cli/shard-2',
      '--outputFile.blob=.vitest-reports/cli/blob-2.json',
    ]);
    expect(vitestArgs(parseRunnerArgs(['--coverage', '--merge']), 'cli')).toEqual([
      'exec',
      'vitest',
      'run',
      '--merge-reports=.vitest-reports/cli',
      '--coverage',
    ]);
    expect(
      (await runTargets(['cli'], () => Promise.resolve({ code: 7, rows: [] }), false)).code,
    ).toBe(7);
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
