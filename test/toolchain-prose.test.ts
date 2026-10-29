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
  it('classifies captured pre-M126 development entries as historical fixture text', () => {
    for (const kind of ['member', 'standalone']) {
      const path = `packages/cli/test/fixtures/dev-entry-0.10.0-${kind}.txt`;
      expect(TOOLCHAIN_PROSE_RULES.allowlist.find((entry) => entry.path === path)?.category).toBe(
        'fixture',
      );
      expect(
        scan(`Run ${task('dev')}`, path, {
          ...TOOLCHAIN_PROSE_RULES,
          allowlist: TOOLCHAIN_PROSE_RULES.allowlist.filter((entry) => entry.path === path),
        }),
      ).toEqual([]);
    }
    expect(
      TOOLCHAIN_PROSE_RULES.allowlist.some(
        (entry) => entry.path === 'packages/cli/src/commands/devtool.ts',
      ),
    ).toBe(false);
  });
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
    expect(scan(text, 'src/app.ts').map((f) => f.rule)).toEqual(['P3']);
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
  it('P3 reports a command starting mid-chain once, at its own line', () => {
    const text = [
      'echo one \\',
      `  ${['deno', 'add'].join(' ')} @setu-ts/kernel \\`,
      '  done',
    ].join('\n');
    expect(scan(text).map((finding) => [finding.rule, finding.line])).toEqual([['P3', 2]]);
  });
  it('P3 joins a long continued chain in linear time', () => {
    // Re-joining from every line of the chain took ~108 s for 4,000 lines.
    const chain = Array.from({ length: 8_000 }, () => 'echo some words here \\').join('\n');
    const text = `${chain}\n${['deno', 'add'].join(' ')} @setu-ts/kernel`;
    const started = performance.now();
    const findings = scan(text);
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(findings.map((finding) => [finding.rule, finding.line])).toEqual([['P3', 8_001]]);
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
    "from 'npm:zod'",
    'from "npm:zod"',
    "import 'npm:zod'",
    "import type { z } from 'npm:zod'",
    'import type { z } from "npm:zod"',
    "import('npm:zod')",
  ])('P7 reports %s at the right line and not a backticked mention', (text) => {
    const findings = scan(`${text}\n\`from 'npm:zod'\``, 'docs/live.md');
    expect(findings.filter((f) => f.rule === 'P7').map((f) => [f.rule, f.line])).toEqual([
      ['P7', 1],
    ]);
  });
  it('P8 refuses a backticked npm: reference in a table and in prose', () => {
    expect(scan('| `npm:ioredis` | redis |', 'docs/live.md').map((f) => f.rule)).toEqual(['P8']);
    expect(scan('the `npm:ioredis` client', 'docs/live.md').map((f) => f.rule)).toEqual(['P8']);
  });
  it('P8 exempts @setu-ts, @jsr, deno install arguments, and allowlisted paths', () => {
    expect(scan('deno add npm:hono', 'docs/live.md')).toEqual([]);
    expect(scan('npm:@setu-ts/kernel\nnpm:@jsr/hono', 'docs/live.md')).toEqual([]);
    const entry = {
      path: 'docs/allowed.md',
      category: 'legacy-pin' as const,
      reason: 'Explains the audit',
      allowNpmRef: true as const,
    };
    expect(scan('npm:ioredis', entry.path, { ...rules, allowlist: [entry] })).toEqual([]);
    expect(scan('npm:ioredis', 'docs/live.md').map((f) => f.rule)).toEqual(['P8']);
  });
  it.each([
    ['quoted imports', "from 'npm:a' "],
    ['bare references', 'npm:a '],
    ['imports after an open backtick', "`import 'npm:a';"],
  ])('P7 and P8 scan a 1 MiB line of %s in linear time', (_label, unit) => {
    // Recounting the prefix per match made one such line take ~18 s.
    const line = unit.repeat(Math.ceil(1_048_576 / unit.length));
    const started = performance.now();
    const findings = scan(line, 'docs/live.md');
    expect(performance.now() - started).toBeLessThan(2_000);
    expect(findings.length).toBeGreaterThan(0);
  });
  it.each([
    ['a shell delimiter', 'deno add npm:hono; then use `npm:ioredis`'],
    ['a closing code span', '`deno add npm:hono` and the `npm:ioredis` client'],
    ['a pipe', 'deno install npm:hono | grep npm:ioredis'],
  ])('P8 exempts only the install arguments, not a reference after %s', (_label, text) => {
    expect(scan(text, 'docs/live.md').map((f) => [f.rule, f.line])).toEqual([['P8', 1]]);
  });
  it('P8 exempts every argument of each install command on a line', () => {
    expect(scan('deno add npm:a npm:b; deno install npm:c', 'docs/live.md')).toEqual([]);
    expect(scan('npm:x deno add npm:a npm:y', 'docs/live.md').map((f) => f.rule)).toEqual(['P8']);
  });
  it('P7 and P8 skip non-markdown files', () => {
    expect(scan("import { z } from 'npm:zod'\n`npm:ioredis`", 'src/app.ts')).toEqual([]);
  });
  it('ratchets an unused P8 allowance', () => {
    const entry = {
      path: 'unused.md',
      category: 'fixture' as const,
      reason: 'Needless P8 entry',
      allowNpmRef: true as const,
    };
    expect(scan('no npm input', entry.path, { ...rules, allowlist: [entry] })[0]?.rule).toBe(
      'stale-allowlist',
    );
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
          "from 'npm:zod'",
          '`npm:ioredis`',
        ].join('\n'),
        path,
      ),
    ).toEqual([]);
  });
  it('exempts only the Current status section and preserves line numbers', () => {
    const text = `# Instructions\n${task('check')}\n## Current status\n${task('fmt:check')}\npnpm run missing\nfrom 'npm:zod'\n## Verification\n${task('check')}\n\`npm:ioredis\``;
    expect(scan(text, 'CLAUDE.md').map((f) => [f.rule, f.line])).toEqual([
      ['P1', 2],
      ['P1', 8],
      ['P8', 9],
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
