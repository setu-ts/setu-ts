/** The gate's input strings include legacy `deno task` and JSR references deliberately. */
import { describe, expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { run } from '../scripts/lib/run.ts';
import {
  scanToolchainProse,
  runToolchainProseCheck,
  TOOLCHAIN_PROSE_RULES,
  type ToolchainProseRules,
} from '../scripts/toolchain-prose.ts';

const task = (name: string): string => ['deno', 'task', name].join(' ');
const root = resolve(import.meta.dirname, '..');
const rules: ToolchainProseRules = {
  ...TOOLCHAIN_PROSE_RULES,
  allowlist: [],
  rootScripts: ['check', 'fmt:check', 'test', 'lint'],
  appScripts: { minimal: ['start', 'check', 'smoke'] },
};
const scan = (text: string, path = 'AGENTS.md', config = rules) =>
  scanToolchainProse([{ path, text }], config);

describe('toolchain prose refusals', () => {
  it.each(['deno task', 'jsr:@setu-ts/kernel', '@jsr/setu-ts__kernel', 'dEnO-FiRsT'])(
    'P1 reports %s with the original path and line',
    (text) => {
      expect(scan(`heading\n${text}`, 'docs/live.md')).toEqual([
        { path: 'docs/live.md', line: 2, rule: 'P1', message: expect.any(String) },
      ]);
    },
  );
  it('P2 refuses repository-only tasks even in an allowed Deno file', () => {
    const config = {
      ...rules,
      allowlist: [
        { path: 'allowed.ts', category: 'deno-target' as const, reason: 'Generated project' },
      ],
    };
    expect(scan(task('fmt:check'), 'allowed.ts', config).map((f) => f.rule)).toEqual(['P2']);
    for (const name of rules.generatedDenoTasks) {
      expect(scan(task(name), 'allowed.ts', config)).toEqual([]);
    }
    expect(scan(task('unknown'), 'allowed.ts', config)).toEqual([]);
  });
  it.each(['deno', 'jsr', 'npx jsr'])('P3 rejects bare arguments after %s add', (command) => {
    const text = [command, 'add', 'npm:graphql', '@setu-ts/auth-plugin'].join(' ');
    expect(scan(text).map((f) => f.rule)).toEqual(['P3']);
    expect(scan(`${command} add npm:@setu-ts/auth-plugin`)).toEqual([]);
    expect(scan(`${command} add jsr:@setu-ts/auth-plugin`).map((f) => f.rule)).toEqual(['P1']);
  });
  it('P3 still runs in allowlisted files', () => {
    const config = {
      ...rules,
      allowlist: [{ path: 'allowed.ts', category: 'fixture' as const, reason: 'Fixture' }],
    };
    expect(
      scan(
        [task('dev'), ['deno', 'add', '@setu-ts/kernel'].join(' ')].join('\n'),
        'allowed.ts',
        config,
      ).map((f) => f.rule),
    ).toEqual(['P3']);
  });
  it('P3 checks quoted and continued arguments at the command line number', () => {
    for (const argument of ['"@setu-ts/kernel"', "'@setu-ts/kernel'", '@setu-ts/kernel']) {
      const text = ['deno', 'add', '\\'].join(' ') + '\n  ' + argument;
      expect(scan(text).map((finding) => [finding.rule, finding.line])).toEqual([['P3', 1]]);
    }
    expect(scan(['deno', 'add', '\\'].join(' '))).toEqual([]);
    expect(scan(task('check'), 'CHANGELOG.md.extra').map((finding) => finding.rule)).toEqual([
      'P1',
    ]);
  });
  it.each([
    'AGENTS.md',
    'AI_GUIDELINES.md',
    'CONTRIBUTING.md',
    'CLAUDE.md',
    'plans/TEMPLATE.md',
    '.roo/rules/01-project.md',
    'docs/releasing.md',
    'docs/examples.md',
    'apps/README.md',
    'apps/minimal/README.md',
  ])('P4 checks root and app scripts in %s', (path) => {
    expect(
      scan(
        'pnpm run missing\npnpm --dir apps/minimal run compile\npnpm --dir apps/unknown run check',
        path,
      ).map((f) => f.rule),
    ).toEqual(['P4', 'P4', 'P4']);
    expect(scan('pnpm run check\npnpm --dir apps/minimal run start', path)).toEqual([]);
  });
  it('P4 does not treat generated-project documentation as root instructions', () => {
    expect(scan('pnpm run generated', 'docs/cli.md')).toEqual([]);
  });
  it.each(['deno lint', 'deno doc --lint', 'deno audit', 'deno-lint-ignore'])(
    'P5 refuses %s',
    (text) => {
      expect(scan(text).map((f) => f.rule)).toEqual(['P5']);
      expect(scan(text, 'CLAUDE.md')).toEqual([]);
      expect(scan(text, 'docs/cli.md')).toEqual([]);
    },
  );
  it('P5 retains the SDK formatter exception', () => expect(scan('deno fmt')).toEqual([]));
  it('P6 distinguishes legacy pin allowances from URL allowances', () => {
    const text = 'jsr:@setu-ts/kernel\nhttps://jsr.io/@setu-ts/kernel';
    const entry = {
      path: 'docs/getting-started.md',
      category: 'legacy-pin' as const,
      reason: 'Legacy troubleshooting',
    };
    expect(scan(text, entry.path, { ...rules, allowlist: [entry] }).map((f) => f.rule)).toEqual([
      'P6',
    ]);
    expect(
      scan(text, entry.path, { ...rules, allowlist: [{ ...entry, allowJsrUrl: true }] }),
    ).toEqual([]);
    expect(scan('https://jsr.io/@setu-ts/kernel', 'docs/live.md').map((f) => f.rule)).toEqual([
      'P6',
    ]);
    expect(
      scan('https://jsr.io/@setu-ts/kernel', entry.path, {
        ...rules,
        allowlist: [{ ...entry, allowJsrUrl: true }],
      }),
    ).toEqual([]);
  });
  it.each([
    'CHANGELOG.md',
    'ROADMAP.md',
    'plans/archive/old.md',
    'plans/reviews/old.md',
    'plans/milestone-111f-docs-jsr-sunset.md',
  ])('exempts history %s from every rule', (path) => {
    expect(
      scan(
        [
          task('fmt:check'),
          ['deno', 'add', '@setu-ts/kernel'].join(' '),
          'pnpm run missing',
          'deno lint',
          'https://jsr.io/@setu-ts/kernel',
        ].join('\n'),
        path,
      ),
    ).toEqual([]);
  });
  it('exempts only the Current status section and preserves line numbers', () => {
    const text = `# Instructions\n${task('check')}\n## Current status\n${task('fmt:check')}\npnpm run missing\n## Verification\n${task('check')}`;
    expect(scan(text, 'CLAUDE.md').map((f) => [f.rule, f.line])).toEqual([
      ['P1', 2],
      ['P1', 7],
    ]);
    expect(scan(`## Current status\n${task('fmt:check')}`, 'CLAUDE.md')).toEqual([]);
  });
  it('ratchets unused and absent allowances', () => {
    const entry = { path: 'unused.md', category: 'fixture' as const, reason: 'Needless entry' };
    expect(scan('no legacy input', entry.path, { ...rules, allowlist: [entry] })[0]?.rule).toBe(
      'stale-allowlist',
    );
    expect(scanToolchainProse([], { ...rules, allowlist: [entry] })[0]?.rule).toBe(
      'stale-allowlist',
    );
  });
});

describe('repository scan', () => {
  it('checks the real tree with zero findings', async () => {
    expect(await runToolchainProseCheck(root)).toEqual([]);
  });
  it('propagates inventory failures', async () => {
    await expect(runToolchainProseCheck(resolve(root, '.tmp/absent-m111f'))).rejects.toThrow();
  });
  it('reads manifest scripts, ignores non-text files, and refuses a failed git inventory', async () => {
    const directory = await mkdtemp(resolve(root, '.tmp/prose-'));
    try {
      await mkdir(`${directory}/apps`, { recursive: true });
      await writeFile(`${directory}/package.json`, JSON.stringify({ scripts: { check: 'tsc' } }));
      await writeFile(`${directory}/note.bin`, task('check'));
      // A failing git executable is exercised without depending on global user configuration.
      await writeFile(`${directory}/.git`, 'gitdir: missing\n');
      await expect(runToolchainProseCheck(directory)).rejects.toThrow('git ls-files failed');
      expect((await run('git', ['--version'], { cwd: root })).code).toBe(0);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });
});
