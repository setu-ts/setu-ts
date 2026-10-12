/**
 * Tests for formatting what the CLI writes into an npm-target project.
 *
 * The fake loader pins the branching (which config, which parser, what is
 * skipped); the real-Prettier cases pin what the fake cannot: that a project's
 * own `overrides` reach the file they target, which is resolved per destination.
 *
 * @module
 */
import * as nodeFs from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

import {
  formatForTarget,
  formatPlannedFiles,
  formatsWithPrettier,
  loadPrettier,
  parserFor,
  type PrettierApi,
} from '../../../src/utils/prettier-format.ts';
import { PRETTIER_OPTIONS } from '../../../src/templates/npm-tooling.ts';

/** A loader recording every config lookup and every format call. */
function fakePrettier(
  configs: Readonly<Record<string, Record<string, unknown> | null>> = {},
  failOn?: (source: string) => unknown,
) {
  const lookups: string[] = [];
  const calls: { source: string; options: Record<string, unknown> }[] = [];
  let loads = 0;
  const api: PrettierApi = {
    resolveConfig: (path) => {
      lookups.push(path);
      return Promise.resolve(configs[path] ?? null);
    },
    format: (source, options) => {
      calls.push({ source, options });
      const failure = failOn?.(source);
      if (failure !== undefined) return Promise.reject(failure);
      return Promise.resolve(`formatted:${source}`);
    },
  };
  return {
    lookups,
    calls,
    loads: () => loads,
    load: () => {
      loads++;
      return Promise.resolve(api);
    },
  };
}

describe('parserFor', () => {
  const cases: readonly (readonly [string, string | undefined])[] = [
    ['src/a.ts', 'typescript'],
    ['app/root.tsx', 'typescript'],
    ['x.mts', 'typescript'],
    ['x.cts', 'typescript'],
    ['scripts/dev.js', 'babel'],
    ['scripts/dev.mjs', 'babel'],
    ['x.cjs', 'babel'],
    ['package.json', 'json'],
    ['README.md', 'markdown'],
    ['docker/compose.yaml', 'yaml'],
    ['k8s/x.yml', 'yaml'],
    ['app/app.css', 'css'],
    ['index.html', 'html'],
    ['.gitignore', undefined],
    ['.env', undefined],
    ['Dockerfile', undefined],
    ['wrangler.toml', undefined],
    ['x.constructor', undefined],
  ];
  for (const [path, parser] of cases) {
    it(`maps ${path} to ${String(parser)}`, () => {
      expect(parserFor(path)).toBe(parser);
    });
  }
});

describe('formatsWithPrettier', () => {
  it('formats every npm-manifest target and leaves Deno to deno fmt', () => {
    expect(formatsWithPrettier('node')).toBe(true);
    expect(formatsWithPrettier('bun')).toBe(true);
    expect(formatsWithPrettier('cloudflare-workers')).toBe(true);
    expect(formatsWithPrettier('deno')).toBe(false);
  });
});

describe('formatPlannedFiles', () => {
  it('never loads Prettier when nothing has a parser', async () => {
    const fake = fakePrettier();
    const files = [{ path: '.gitignore', contents: 'x' }];
    const plan = await formatPlannedFiles(files, undefined, fake.load);
    expect(plan).toEqual({ files, skipped: [] });
    expect(fake.loads()).toBe(0);
  });

  it('formats with the scaffold options before a project exists', async () => {
    const fake = fakePrettier();
    const plan = await formatPlannedFiles(
      [{ path: 'a.ts', contents: 'a' }, { path: '.env', contents: 'E=1' }],
      undefined,
      fake.load,
    );
    expect(plan.files).toEqual([
      { path: 'a.ts', contents: 'formatted:a' },
      { path: '.env', contents: 'E=1' },
    ]);
    expect(fake.lookups).toEqual([]);
    expect(fake.calls[0]!.options).toEqual({ ...PRETTIER_OPTIONS, parser: 'typescript' });
  });

  it('resolves the configuration per destination, relative or absolute', async () => {
    const fake = fakePrettier({
      '/proj/src/a.ts': { semi: false },
      '/elsewhere/b.json': { tabWidth: 4 },
    });
    await formatPlannedFiles(
      [
        { path: 'src/a.ts', contents: 'a' },
        { path: '/elsewhere/b.json', contents: '{}' },
        { path: 'c.md', contents: '# c' },
      ],
      '/proj',
      fake.load,
    );
    expect(fake.lookups).toEqual(['/proj/src/a.ts', '/elsewhere/b.json', '/proj/c.md']);
    expect(fake.calls.map((call) => call.options)).toEqual([
      { semi: false, parser: 'typescript' },
      { tabWidth: 4, parser: 'json' },
      // No config on disk for this file: the scaffold's own options.
      { ...PRETTIER_OPTIONS, parser: 'markdown' },
    ]);
  });

  it('keeps a file Prettier cannot parse as rendered and reports its first line', async () => {
    const fake = fakePrettier(
      {},
      (source) =>
        source === 'bad' ? new SyntaxError('Unexpected token (1:1)\n> 1 | bad') : undefined,
    );
    const plan = await formatPlannedFiles(
      [{ path: 'bad.ts', contents: 'bad' }, { path: 'ok.ts', contents: 'ok' }],
      undefined,
      fake.load,
    );
    expect(plan.files).toEqual([
      { path: 'bad.ts', contents: 'bad' },
      { path: 'ok.ts', contents: 'formatted:ok' },
    ]);
    expect(plan.skipped).toEqual([{ path: 'bad.ts', reason: 'Unexpected token (1:1)' }]);
  });

  it('reports a non-Error rejection by its string form', async () => {
    const fake = fakePrettier({}, () => 'plain failure');
    const plan = await formatPlannedFiles([{ path: 'a.ts', contents: 'a' }], undefined, fake.load);
    expect(plan.skipped).toEqual([{ path: 'a.ts', reason: 'plain failure' }]);
  });
});

describe('formatForTarget', () => {
  it('returns a Deno plan untouched without loading Prettier', async () => {
    const fake = fakePrettier();
    const files = [{ path: 'a.ts', contents: 'a' }];
    expect(await formatForTarget(files, 'deno', undefined, () => {}, fake.load)).toBe(files);
    expect(fake.loads()).toBe(0);
  });

  it('formats an npm target and reports every skipped file', async () => {
    const fake = fakePrettier({}, (source) => (source === 'bad' ? new Error('nope') : undefined));
    const lines: string[] = [];
    const out = await formatForTarget(
      [{ path: 'bad.ts', contents: 'bad' }, { path: 'ok.ts', contents: 'ok' }],
      'node',
      undefined,
      (line) => lines.push(line),
      fake.load,
    );
    expect(out.map((file) => file.contents)).toEqual(['bad', 'formatted:ok']);
    expect(lines).toEqual(['Left bad.ts as rendered: Prettier could not parse it (nope).']);
  });
});

describe('the real Prettier', () => {
  it('formats with the scaffold options', async () => {
    const plan = await formatPlannedFiles([
      { path: 'a.ts', contents: 'const a = "x"' },
    ]);
    expect(plan.files[0]!.contents).toBe("const a = 'x';\n");
  });

  // Codex review (M111d): the configuration was resolved once, for the
  // project's package.json, so an override targeting `*.ts` never applied and a
  // generated file failed the project's own `format:check`.
  it("honours a project's override for the file it targets", async () => {
    const dir = await nodeFs.mkdtemp(join(tmpdir(), 'setu-prettier-'));
    try {
      await nodeFs.writeFile(
        join(dir, '.prettierrc.json'),
        JSON.stringify({
          singleQuote: true,
          overrides: [{ files: '*.ts', options: { semi: false } }],
        }),
      );
      const plan = await formatPlannedFiles(
        [
          { path: 'a.ts', contents: 'const a = "x";' },
          { path: 'b.js', contents: 'const b = "y"' },
        ],
        dir,
        loadPrettier,
      );
      expect(plan.files.map((file) => file.contents)).toEqual([
        "const a = 'x'\n",
        "const b = 'y';\n",
      ]);
    } finally {
      await nodeFs.rm(dir, { recursive: true, force: true });
    }
  });
});
