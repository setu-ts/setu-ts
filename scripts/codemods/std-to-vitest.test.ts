import { describe, it, expect } from 'vitest';
import { mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { convertFiles, bareSpecifier, testSources } from './std-to-vitest.ts';
import { tempDir, run } from '../../test/node-helpers.ts';

async function fixture(source: string, write = true) {
  const directory = await tempDir();
  const file = `${directory}/sample.ts`;
  try {
    await writeFile(file, source);
    const report = convertFiles([file], write);
    return { text: await readFile(file, 'utf8'), report };
  } finally {
    await rm(directory, { recursive: true });
  }
}

describe('std-to-vitest codemod', () => {
  it('converts bound imports and guards, leaving shadowed names alone', async () => {
    const { text, report } = await fixture(
      `import { describe, it as spec } from '@std/testing/bdd';\nimport { expect } from '@std/expect';\nconst guard = { ignore: true };\nspec('guarded', guard, () => {});\nspec('again', guard, () => {});\nfunction shadow(spec) { spec('shadowed', { ignore: true }, () => {}); }`,
    );
    expect(text).toContain("from 'vitest'");
    expect(text).toContain('const guard = { skip: true }');
    expect(text).toContain("spec('shadowed', { ignore: true }");
    expect(report.changedFiles).toBe(1);
  });
  it('rewrites all supported option and object call forms', async () => {
    const { text, report } = await fixture(`import { it } from '@std/testing/bdd';
      it.ignore('skip', () => {});
      it('a', { ignore: true, timeout: 50 }, () => {});
      it('b', { ignore }, () => {});
      it('c', { sanitizeOps: false, sanitizeResources: false, sanitizeExit: false, permissions: 'inherit' }, () => {});
      it({ name: 'd', ignore: true, timeout: 20 }, () => {});
      it({ name: 'e', ignore: true, fn: () => {} });
      it({ name: 'f', async fn() {} });
      it({ name: 'g', fn() {} });
      it({ name: 'h', fn: function () {} });
    `);
    expect(text).toContain('it.skip(');
    expect(text).toContain('skip: ignore');
    expect(text).not.toContain('sanitizeOps');
    expect(text).toContain("it('c', () => {}");
    expect(text).toContain("'f', async () =>");
    expect(report.counts['rewrite:object-form']).toBe(4);
  });
  it('reports unsupported imports, options, context and matchers', async () => {
    const { report } = await fixture(`import * as bdd from '@std/testing/bdd';
      import { it, nonexistent } from '@std/testing/bdd';
      import type { describe as suite } from '@std/testing/bdd';
      import { strange } from '@std/expect';
      import { assertType } from '@std/testing/types';
      import { expect } from '@std/expect';
      it.only('x', (ctx) => {}); it('context', (ctx) => {});
      it.weird('x', () => {});
      it.skip('x', () => {});
      it('x', { other: 1, ...opts }, () => {});
      it({ name: 'x', extra: 1 }, () => {});
      it({ ignore: true }, () => {});
      it({ name: 'x', fn: () => {}, timeout: 1 });
      it({ name: 'x', extra: true, fn: () => {} });
      expect(1).toNonexistent(); expect(1).toThrow(Error, 'two');
      expect(1).toStrictEqual(1); expect(null).not.toContain('x');
      Deno.env.get('EXAMPLE');
    `);
    for (const kind of [
      'unmapped-import-shape',
      'unmapped-name',
      'unmapped-module',
      'unmapped-option',
      'unmapped-object-form',
      'only',
      'unmapped-modifier',
      'test-context-param',
      'unknown-matcher',
      'toThrow-two-args',
    ])
      expect(report.findings.some((finding) => finding.kind === kind)).toBe(true);
    expect(report.denoFiles).toHaveLength(1);
  });
  it('reports async assertions and keeps report-only runs reversible', async () => {
    const source =
      "import { expect } from 'vitest';\nexpect(Promise.reject(1)).rejects.toThrow();\nexpect(Promise.resolve(1)).resolves.toBe(1);";
    const { report, text } = await fixture(source, false);
    expect(text).toBe(source);
    expect(report.findings.filter((f) => f.kind === 'unawaited-async-assertion')).toHaveLength(2);
    expect(
      (
        await fixture(
          "import { expect } from 'vitest';\nawait expect(Promise.resolve(1)).resolves.toBe(1);",
        )
      ).report.findings,
    ).toEqual([]);
  });
  it('maps registry specifiers, subpaths and distinct Zod majors', async () => {
    for (const [before, after] of [
      ['npm:zod@^3.24.0', 'zod-v3'],
      ['npm:zod@^4.4.0', 'zod-v4'],
      ['npm:drizzle-orm@0.45.2/sqlite-proxy', 'drizzle-orm/sqlite-proxy'],
      ['jsr:@setu-ts/common@^0.8.0', '@setu-ts/common'],
      ['jsr:@hono/hono@^4/jsx', 'hono/jsx'],
      ['node:fs', 'node:fs'],
      ['npm:ws', 'ws'],
      ['npm:zod@^5', 'zod'],
    ])
      expect(bareSpecifier(before!)).toBe(after);
    const { text } = await fixture(
      "import { x } from 'npm:zod@^3.24.0';\nconst mod = import('npm:zod@^4.4.0');\ntype Module = typeof import('npm:ws@^8');",
    );
    expect(text).toContain("'zod-v3'");
    expect(text).toContain("'zod-v4'");
    expect(text).toContain("'ws'");
  });
  it('discovers helper modules and refuses an unawaited assertion through --check', async () => {
    const directory = await tempDir();
    try {
      await mkdir(`${directory}/packages/example/test/fixtures`, { recursive: true });
      await mkdir(`${directory}/packages/example/node_modules`, { recursive: true });
      await mkdir(`${directory}/packages/.hidden`);
      const file = `${directory}/packages/example/test/fixtures/helper.ts`;
      await writeFile(
        file,
        "import { expect } from 'vitest';\nexpect(Promise.resolve(1)).resolves.toBe(1);",
      );
      expect(testSources(`${directory}/packages`)).toEqual([file]);
      const result = await run(process.execPath, {
        args: [resolve('scripts/codemods/std-to-vitest.ts'), '--check'],
        cwd: directory,
      });
      expect(result.code).toBe(1);
      expect(new TextDecoder().decode(result.stderr)).toContain('helper.ts:2');
      await writeFile(
        file,
        "import { expect } from 'vitest';\nawait expect(Promise.resolve(1)).resolves.toBe(1);",
      );
      expect(
        (
          await run(process.execPath, {
            args: [resolve('scripts/codemods/std-to-vitest.ts'), '--check'],
            cwd: directory,
          })
        ).code,
      ).toBe(0);
    } finally {
      await rm(directory, { recursive: true });
    }
  });
});
