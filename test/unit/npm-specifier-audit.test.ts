/**
 * Unit tests for the computed-`import()` recurrence gate (M70e §3.7/§3.8).
 *
 * Exercises the pure `findComputedImports` core against deterministic source
 * snippets so the scanner's discrimination is proven without a live tree. The
 * whole-tree check lives in `test/npm-specifier-gate.test.ts`.
 *
 * @module
 */

import { mkdir, mkdtemp, writeFile, rm } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  auditPackageSources,
  findComputedImports,
  findPrefixedSpecifiers,
  findUnguardedImports,
  scanImportEdges,
} from '../../scripts/npm-specifier-audit.ts';
import ts from 'typescript';

describe('findComputedImports — literal arguments are accepted', () => {
  it('accepts a single-quoted literal', () => {
    expect(findComputedImports("const m = await import('npm:pino@10.x');")).toHaveLength(0);
  });

  it('accepts a bare npm: literal (the @connectrpc/connect shape)', () => {
    expect(findComputedImports("const m = await import('npm:@connectrpc/connect');")).toHaveLength(
      0,
    );
  });

  it('accepts a double-quoted literal', () => {
    expect(findComputedImports('const m = await import("npm:pino@10.x");')).toHaveLength(0);
  });

  it('accepts a clean template-literal argument', () => {
    expect(findComputedImports('const m = await import(`npm:pino@10.x`);')).toHaveLength(0);
  });

  it('accepts a multi-line literal (the otlp-exporter shape)', () => {
    const source = [
      'const mod = await import(',
      '  "npm:@opentelemetry/otlp-exporter-base@^0.220.0",',
      ');',
    ].join('\n');
    expect(findComputedImports(source)).toHaveLength(0);
  });
});

describe('findComputedImports — computed arguments are rejected', () => {
  it('rejects a concatenated string argument (X7-3 bypass)', () => {
    const findings = findComputedImports("const m = await import('npm:' + name);");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.snippet).toContain("'npm:' + name");
  });

  it('rejects a string argument composed with a template literal', () => {
    const findings = findComputedImports('const m = await import(`npm:` + name);');
    expect(findings).toHaveLength(1);
  });

  it('rejects a string argument cast with `as`', () => {
    const findings = findComputedImports("const m = await import('npm:foo' as string);");
    expect(findings).toHaveLength(1);
    expect(findings[0]?.snippet).toContain("'npm:foo' as string");
  });

  it('rejects an identifier argument', () => {
    const findings = findComputedImports('const m = await import(spec);');
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(1);
    expect(findings[0]?.file).toBe('');
    expect(findings[0]?.snippet).toContain('import(');
  });

  it('rejects a member-expression argument', () => {
    const findings = findComputedImports('const m = await import(mod.spec);');
    expect(findings).toHaveLength(1);
  });

  it('rejects an interpolated template argument', () => {
    const findings = findComputedImports('const m = await import(`npm:${name}`);');
    expect(findings).toHaveLength(1);
  });

  it('rejects a nested-interpolation template argument', () => {
    const findings = findComputedImports('const m = await import(`a${`b`}c`);');
    expect(findings).toHaveLength(1);
  });

  it('finds every computed import in a multi-import source', () => {
    const source = [
      "const a = import('npm:ok');",
      'const b = import(x);',
      'const c = import(y.z);',
    ].join('\n');
    const findings = findComputedImports(source);
    expect(findings).toHaveLength(2);
    expect(findings.map((f) => f.line).sort()).toEqual([2, 3]);
  });
});

describe('findComputedImports — comments and strings are ignored', () => {
  it('ignores an import() inside a line comment', () => {
    expect(findComputedImports('// import(x)\nconst a = 1;')).toHaveLength(0);
  });

  it('ignores an import() inside a block comment', () => {
    expect(findComputedImports('/* import(x) */\nconst a = 1;')).toHaveLength(0);
  });

  it('ignores an import() inside a string literal', () => {
    expect(findComputedImports("const s = 'import(x)';")).toHaveLength(0);
  });

  it('ignores import.meta', () => {
    expect(findComputedImports('const x = import.meta.url;')).toHaveLength(0);
  });

  it('still finds a real computed import that follows a comment', () => {
    const source = '/* import(x) */\nconst m = await import(spec);';
    const findings = findComputedImports(source);
    expect(findings).toHaveLength(1);
    expect(findings[0]?.line).toBe(2);
  });
});

describe('findComputedImports — the computed-specifier marker', () => {
  it('accepts a marker on the preceding line', () => {
    const source = '/* computed-specifier: app-supplied path */\nconst m = import(url);';
    expect(findComputedImports(source)).toHaveLength(0);
  });

  it('accepts a marker inline', () => {
    const source = 'const m = import(/* computed-specifier: app-supplied path */ url);';
    expect(findComputedImports(source)).toHaveLength(0);
  });

  it('rejects a marker with an empty reason', () => {
    const source = '/* computed-specifier: */\nconst m = import(url);';
    expect(findComputedImports(source)).toHaveLength(1);
  });

  it('rejects a marker that only has whitespace as its reason', () => {
    const source = '/* computed-specifier:    */\nconst m = import(url);';
    expect(findComputedImports(source)).toHaveLength(1);
  });

  it('does not treat an unrelated comment as a marker', () => {
    const source = '/* some other note */\nconst m = import(url);';
    expect(findComputedImports(source)).toHaveLength(1);
  });

  it('requires the marker to be adjacent (not two lines above)', () => {
    const source = '/* computed-specifier: reason */\n\nconst m = import(url);';
    expect(findComputedImports(source)).toHaveLength(1);
  });
});

describe('auditPackageSources — which src trees the walker reaches', () => {
  /**
   * Builds a throwaway package tree and returns its root. The nesting is the
   * point: `flat/src` sits one level down, `group/nested/src` two — the shape
   * `packages/starters/<name>/src` has, and the shape the first version of this
   * walker silently skipped while still reporting a healthy file count.
   */
  async function createTree(): Promise<string> {
    const root = await await mkdir('.tmp', { recursive: true }).then(() => mkdtemp('.tmp/test-'));
    await mkdir(`${root}/flat/src`, { recursive: true });
    await writeFile(`${root}/flat/src/a.ts`, "await import('npm:ok@1');\n");
    await mkdir(`${root}/group/nested/src/deep`, { recursive: true });
    await writeFile(`${root}/group/nested/src/deep/b.ts`, 'export const b = 1;\n');
    return root;
  }

  it('reaches a src tree nested more than one level below the root', async () => {
    const root = await createTree();
    try {
      const result = await auditPackageSources(root);
      expect(result.srcRootsVisited).toContain(`${root}/flat/src`);
      expect(result.srcRootsVisited).toContain(`${root}/group/nested/src`);
      expect(result.filesVisited).toBe(2);
      expect(result.findings).toEqual([]);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('refuses a computed import in a deeply nested src tree', async () => {
    const root = await createTree();
    try {
      await writeFile(
        `${root}/group/nested/src/deep/b.ts`,
        'const load = (spec: string) => import(spec);\nexport const l = load;\n',
      );
      const result = await auditPackageSources(root);
      expect(result.findings).toHaveLength(1);
      expect(result.findings[0].file).toBe(`${root}/group/nested/src/deep/b.ts`);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('never audits a vendored node_modules tree', async () => {
    const root = await createTree();
    try {
      await mkdir(`${root}/flat/node_modules/dep/src`, { recursive: true });
      await writeFile(
        `${root}/flat/node_modules/dep/src/vendor.ts`,
        'const load = (spec: string) => import(spec);\nexport const l = load;\n',
      );
      const result = await auditPackageSources(root);
      // A dependency's own source is not ours to gate; it must not appear as a
      // root, be counted, or be reported.
      expect(result.srcRootsVisited.some((r) => r.includes('node_modules'))).toBe(false);
      expect(result.filesVisited).toBe(2);
      expect(result.findings).toEqual([]);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('returns an empty result for a root that does not exist', async () => {
    const result = await auditPackageSources('/nonexistent-setu-audit-root');
    expect(result.srcRootsVisited).toEqual([]);
    expect(result.filesVisited).toBe(0);
    expect(result.findings).toEqual([]);
  });
});

describe('findPrefixedSpecifiers — npm:/jsr: import specifiers are refused (M111a §3.8)', () => {
  it('refuses an npm: literal in a dynamic import()', () => {
    expect(findPrefixedSpecifiers("const m = await import('npm:pino@10.x');")).toEqual([
      { file: '', line: 1, specifier: 'npm:pino@10.x' },
    ]);
  });

  it('refuses a jsr: specifier in a static from-clause, on its own line', () => {
    const source = "// header\nimport type { X } from 'jsr:@setu-ts/common@^0.8.0';\n";
    expect(findPrefixedSpecifiers(source)).toEqual([
      { file: '', line: 2, specifier: 'jsr:@setu-ts/common@^0.8.0' },
    ]);
  });

  it('refuses every semver range form, not only a bare version', () => {
    const source = [
      "await import('npm:zod@^3.24.0');",
      "await import('npm:ws@~8.18.0');",
      "await import('npm:pino@>=10 <11');",
      "await import('npm:x@*');",
    ].join('\n');
    // The last-but-one carries a space, which no specifier the repo writes
    // does; it stays out rather than widening the class to whitespace.
    expect(findPrefixedSpecifiers(source).map((h) => h.specifier)).toEqual([
      'npm:zod@^3.24.0',
      'npm:ws@~8.18.0',
      'npm:x@*',
    ]);
  });

  it('refuses a side-effect import', () => {
    expect(findPrefixedSpecifiers("import 'npm:reflect-metadata';")).toHaveLength(1);
  });

  it('accepts the bare form every rewritten site now uses', () => {
    expect(
      findPrefixedSpecifiers("const m = await import('pino');\nimport { Hono } from 'hono';"),
    ).toEqual([]);
  });

  it('exempts template text emitted into a generated project', () => {
    const source = "export const MAIN = `import { x } from 'npm:pino@10.x';`;";
    expect(findPrefixedSpecifiers(source)).toEqual([]);
  });

  it('exempts a JSDoc @example and a line comment', () => {
    const source = [
      '/**',
      " * @example import { x } from 'jsr:@setu-ts/kernel';",
      ' */',
      "// await import('npm:pino@10.x')",
    ].join('\n');
    expect(findPrefixedSpecifiers(source)).toEqual([]);
  });

  it('exempts a string constant that is not in an import position', () => {
    expect(findPrefixedSpecifiers("export const SPECIFIER = 'npm:pino@10.x';")).toEqual([]);
  });
});

describe('scanImportEdges — import positions and modes', () => {
  it('classifies value, type-only and dynamic imports', () => {
    const source = [
      "import { a } from 'value-pkg';",
      "import type { B } from 'type-pkg';",
      "export type { C } from 'type-reexport';",
      "export { d } from 'value-reexport';",
      "const m = await import('dynamic-pkg');",
    ].join('\n');
    expect(scanImportEdges(source, 'f.ts').map((e) => [e.specifier, e.mode, e.line])).toEqual([
      ['value-pkg', 'value', 1],
      ['type-pkg', 'type', 2],
      ['type-reexport', 'type', 3],
      ['value-reexport', 'value', 4],
      ['dynamic-pkg', 'dynamic', 5],
    ]);
  });

  it('ignores a method named import and a call argument', () => {
    const source = "loader.import('not-an-edge');\nrequire('also-not');\nerr('nope');";
    expect(scanImportEdges(source, 'f.ts')).toEqual([]);
  });

  it('decides each statement by its own keyword, not an earlier type import', () => {
    const source = "import type { A } from 'a';\nimport { b } from 'b';";
    expect(scanImportEdges(source, 'f.ts').map((e) => e.mode)).toEqual(['type', 'value']);
  });

  it('rejects a literal no module specifier could be (a misread regex)', () => {
    // The masker does not model regex literals; a regex body containing
    // `from "(…)"` presents as a string after `from` and must not become an edge.
    const source = 'const re = /from "(@setu-ts\\/[a-z]+)"/;';
    expect(scanImportEdges(source, 'f.ts')).toEqual([]);
  });

  it('reads past a closing template delimiter without swallowing later imports', () => {
    // The shape that made service-bus-broker.ts lose its import(): a template
    // literal followed by a real import must still yield that import.
    const source = "const t = `x`;\nconst m = await import('@azure/service-bus');";
    expect(scanImportEdges(source, 'f.ts').map((e) => e.specifier)).toEqual(['@azure/service-bus']);
  });

  it('yields no edge for an interpolated template specifier', () => {
    expect(scanImportEdges('const m = await import(`${base}/x`);', 'f.ts')).toEqual([]);
  });
});

// ── M113d §3.2 — the guarded-import rule ─────────────────────────────────────

/** A function whose `try` block holds `body`, with a catch that wraps the error. */
function inTry(body: string): string {
  return [
    'async function load(flag?: boolean) {',
    '  try {',
    `    ${body}`,
    '  } catch (error) {',
    "    throw new Error('unavailable', { cause: error });",
    '  }',
    '}',
  ].join('\n');
}

// Every case below mirrors an esbuild 0.28.2 bundle of the same body with the
// package absent: the accepted shapes bundled, the refused ones failed with
// "Could not resolve" (measured 2026-10-17, M113d §3.2).
describe('findUnguardedImports — an AWAITED import in a same-function try guards', () => {
  it.each([
    ['an assignment', "let mod; mod = await import('ioredis'); return mod;"],
    ['a return', "return await import('@aws-sdk/client-dynamodb');"],
    ['a cast over the awaited import', "return (await import('mongodb')) as unknown as { a: 1 };"],
    ['an assertion inside the await', "return await (import('mongodb') as Promise<unknown>);"],
    ['a call argument', "return String(await import('ioredis'));"],
    ['an object property', "return { mod: await import('ioredis') };"],
    ['an array element', "return [await import('ioredis')];"],
    ['a conditional branch', "return flag ? await import('ioredis') : null;"],
  ])('accepts the import awaited in %s', (_name, body) => {
    expect(findUnguardedImports(inTry(body))).toEqual([]);
  });

  it('accepts an async arrow whose body is the try', () => {
    const source = [
      'const load = async () => {',
      '  try {',
      "    return await import('@aws-sdk/client-dynamodb');",
      '  } catch (error) {',
      "    throw new Error('unavailable', { cause: error });",
      '  }',
      '};',
    ].join('\n');
    expect(findUnguardedImports(source)).toEqual([]);
  });
});

describe('findUnguardedImports — shapes the rule refuses', () => {
  it('refuses a bare import with no try at all', () => {
    const source = "async function load() { return (await import('mongodb')).MongoClient; }";
    const hits = findUnguardedImports(source);
    expect(hits).toHaveLength(1);
    expect(hits[0].line).toBe(1);
    expect(hits[0].snippet).toContain("import('mongodb')");
  });

  it.each([
    ['as a variable initializer', "const p = import('ioredis'); return await p;", 1],
    ['as a bare return', "return import('ioredis');", 1],
    [
      'inside Promise.all([...])',
      "return await Promise.all([import('@aws-sdk/client-s3'), import('@aws-sdk/s3-request-presigner')]);",
      2,
    ],
    ['inside an awaited array literal', "return await [import('ioredis')];", 1],
    ['as an object property', "const o = { m: import('ioredis') }; return await o.m;", 1],
  ])('refuses an UNAWAITED import %s inside a same-function try', (_name, body, count) => {
    expect(findUnguardedImports(inTry(body))).toHaveLength(count);
  });

  it('refuses an awaited .catch() chain (esbuild tolerates it; the rule keeps one shape)', () => {
    const body = "return await import('ioredis').catch((e: unknown) => { throw e; });";
    expect(findUnguardedImports(inTry(body))).toHaveLength(1);
  });

  it('refuses an import inside the try of an ENCLOSING function', () => {
    const source = [
      'async function outer() {',
      '  try {',
      '    const inner = async () => {',
      "      return await import('ioredis');",
      '    };',
      '    return await inner();',
      '  } catch {',
      '    return null;',
      '  }',
      '}',
    ].join('\n');
    expect(findUnguardedImports(source)).toHaveLength(1);
  });

  it('refuses an import inside the finally block', () => {
    const source = [
      'async function load() {',
      '  try {',
      '    return 1;',
      '  } finally {',
      "    await import('ioredis');",
      '  }',
      '}',
    ].join('\n');
    expect(findUnguardedImports(source)).toHaveLength(1);
  });

  it('refuses an import inside the catch block', () => {
    const source = [
      'async function load() {',
      '  try {',
      '    return 1;',
      '  } catch {',
      "    return await import('ioredis');",
      '  }',
      '}',
    ].join('\n');
    expect(findUnguardedImports(source)).toHaveLength(1);
  });

  it('refuses a top-level import outside any function', () => {
    const source = "const mod = await import('mongodb');";
    expect(findUnguardedImports(source)).toHaveLength(1);
  });
});

describe('findUnguardedImports — exemptions and non-imports', () => {
  it('exempts node: and @setu-ts/* specifiers', () => {
    const source = [
      "await import('node:fs/promises');",
      "await import('@setu-ts/common');",
      "await import('./relative.js');",
      "await import('cloudflare:workers');",
    ].join('\n');
    expect(findUnguardedImports(source)).toEqual([]);
  });

  it('exempts a type-position typeof import and a non-literal argument', () => {
    const source = [
      "type Mod = typeof import('mongodb');",
      'const spec = "mongodb";',
      'await import(spec);',
    ].join('\n');
    expect(findUnguardedImports(source)).toEqual([]);
  });

  it('exempts a scoped package only when it is @setu-ts/*, and reads .tsx', () => {
    const source = "const x = () => import('@aws-sdk/client-dynamodb');";
    expect(findUnguardedImports(source, ts.ScriptKind.TSX)).toHaveLength(1);
  });
});
