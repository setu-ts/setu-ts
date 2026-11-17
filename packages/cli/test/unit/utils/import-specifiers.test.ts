import { describe, expect, it } from 'vitest';

import {
  hasNonImportBinding,
  lexImportSpecifiers,
  readImportSpecifiers,
} from '../../../src/utils/import-specifiers.ts';

const SOURCE = [
  "import { b } from './b.ts';",
  'import type { T } from "../t.ts";',
  "import { type U, v } from './u.ts';",
  "export { c } from './c.ts';",
  "export * from './d.ts';",
  "export * as e from './e.ts';",
  "export type { F } from './f.ts';",
  "import './side.ts';",
  "import x from 'pkg';",
  "const s = `from './fake.ts' ${b} ${`nested ${v}`}`;",
  "const r = /from '.\\/re.ts'/g;",
  'const half = 1 / 2;',
  "// import { z } from './comment.ts';",
  "/* export * from './block.ts'; */",
  "const lazy = await import('./lazy.ts');",
  'const meta = import.meta.url;',
  'export { s, r, half, lazy, meta, x };',
  'export const y: T | U = {} as T;',
  '',
].join('\n');

describe('lexImportSpecifiers', () => {
  it.each([
    ["import Default from './x.ts'", ['Default'], []],
    ["import type Default from './x.ts'", ['Default'], []],
    ["import {} from './x.ts'", [], []],
    ["import { same as same } from './x.ts'", ['same'], ['same']],
    ["import { type as local } from './x.ts'", ['local'], []],
    ["import { type T as Alias, A } from './x.ts'", ['Alias', 'A'], ['A']],
    ["import Default, * as namespace from './x.ts'", ['Default', 'namespace'], []],
    ["import './x.ts'", [], []],
    ["import { A } from './x.ts' assert { type: 'json' }", ['A'], ['A']],
  ] as const)('reads bindings and value names in %s', (source, bindings, named) => {
    const lexed = lexImportSpecifiers(source);
    if (lexed.kind !== 'ok') throw new Error(lexed.reason);
    expect(lexed.spans[0]?.declaration).toEqual({ start: 0, end: source.length, bindings, named });
  });
  it.each([
    "import { a b } from './x.ts'",
    "import { a as } from './x.ts'",
    "import * as namespace, { a } from './x.ts'",
    "import * other from './x.ts'",
    "import Default, other from './x.ts'",
    "import Default { a } from './x.ts'",
    "import { , } from './x.ts'",
    "import { a, from './x.ts'",
    "import { a } extra from './x.ts'",
  ])('withholds declaration metadata for an unreadable clause: %s', (source) => {
    const lexed = lexImportSpecifiers(source);
    expect(lexed.kind === 'ok' && lexed.spans[0]?.declaration).toBeUndefined();
  });
  it.each([
    "import './x.ts' with options",
    "import { a } from './x.ts' with options",
    "import './x.ts' with { type: 'json'",
    "import { a } from './x.ts' assert { type: 'json'",
  ])('refuses incomplete import attributes: %s', (source) => {
    expect(lexImportSpecifiers(source).kind).toBe('unclassifiable');
  });
  it('reports only real import clauses, their local bindings, and complete statement spans', () => {
    const lines = [
      "import Default, { same, other as alias, type T } from './real.ts'",
      "import type { OnlyType } from './types.ts';",
      "import * as namespace from './namespace.ts'",
      "import './side.ts' with { type: 'json' };",
      "import { value } from './data.json' with {\n type: 'json'\n};",
      'const note = "import { fake } from \'./fake.ts\'";',
      'const template = `import { fake } from "./fake.ts" ${import("./lazy.ts")}`;',
      'const regex = /import.*from/;',
      "export { same } from './export.ts';",
    ];
    const source = lines.join('\n');
    const lexed = lexImportSpecifiers(source);
    if (lexed.kind !== 'ok') throw new Error(lexed.reason);
    const declarations = lexed.spans.filter((span) => span.declaration !== undefined);
    expect(
      declarations.map((span) => [span.value, span.declaration!.bindings, span.declaration!.named]),
    ).toEqual([
      ['./real.ts', ['Default', 'same', 'alias', 'T'], ['same']],
      ['./types.ts', ['OnlyType'], []],
      ['./namespace.ts', ['namespace'], []],
      ['./side.ts', [], []],
      ['./data.json', ['value'], ['value']],
    ]);
    expect(
      declarations.map((span) => source.slice(span.declaration!.start, span.declaration!.end)),
    ).toEqual(lines.slice(0, 5));
    expect(lexed.spans.filter((span) => span.kind === 'dynamic').map((span) => span.value)).toEqual(
      ['./lazy.ts'],
    );
  });
  it('finds every specifier with its span, and nothing inside strings, regexes or comments', () => {
    const lexed = lexImportSpecifiers(SOURCE);
    if (lexed.kind !== 'ok') throw new Error(lexed.reason);
    expect(lexed.spans.map(({ value, typeOnly, kind }) => [value, typeOnly, kind])).toEqual([
      ['./b.ts', false, 'static'],
      ['../t.ts', true, 'static'],
      ['./u.ts', false, 'static'],
      ['./c.ts', false, 'static'],
      ['./d.ts', false, 'static'],
      ['./e.ts', false, 'static'],
      ['./f.ts', true, 'static'],
      ['./side.ts', false, 'static'],
      ['pkg', false, 'static'],
      ['./lazy.ts', false, 'dynamic'],
    ]);
    for (const span of lexed.spans)
      expect(SOURCE.slice(span.start + 1, span.end - 1)).toBe(span.value);
  });

  it('reads a regex after a keyword and a division after a value', () => {
    const lexed = lexImportSpecifiers(
      "function f(a: number) { return /x'/.test('y') ? a / 2 : a; }\nimport { g } from './g.ts';\n",
    );
    expect(lexed.kind === 'ok' && lexed.spans.map((span) => span.value)).toEqual(['./g.ts']);
  });

  it('refuses what it cannot read exactly', () => {
    const refused: readonly (readonly [string, string])[] = [
      ['an unterminated string', "import { a } from './a.ts;\n"],
      ['an unterminated comment', '/* never closed\n'],
      ['an unterminated template', 'const t = `x ${y'],
      ['an unterminated regex', 'const r = /abc\n'],
      ['a Unicode escape', 'const \\u0061 = 1;\n'],
      ['a relative require', "const a = require('./a.ts');\n"],
      ['a computed require', 'const a = require(name);\n'],
      ['a computed dynamic import', 'const a = await import(name);\n'],
      ['a template dynamic import', 'const a = await import(`./${name}.ts`);\n'],
      ['an import-equals', "import a = require('./a.ts');\n"],
      ['an import with no from', 'import { a };\n'],
    ];
    for (const [label, source] of refused)
      expect(lexImportSpecifiers(source).kind, label).toBe('unclassifiable');
  });

  it('allows a package require and ignores member access named import', () => {
    const lexed = lexImportSpecifiers(
      "const a = require('pkg');\nconst b = loader.import('./x.ts');\nexport { a, b };\n",
    );
    expect(lexed).toEqual({ kind: 'ok', spans: [], globs: [] });
  });

  it('reads import.meta.glob calls from tokens (M130)', () => {
    const lexed = lexImportSpecifiers(
      [
        "const a = import.meta.glob('./*.tsx');",
        "const b = import.meta.glob(['./a/*.ts', `!./a/x.ts`,], { eager: true, query: { raw: [1, (2)] }, 'base': '/src', });",
        'const c = import.meta.glob(`./c/*.ts`, {});',
      ].join('\n'),
    );
    expect(lexed.kind === 'ok' && lexed.globs).toEqual([
      { start: 10, patterns: ['./*.tsx'] },
      { start: 49, patterns: ['./a/*.ts', '!./a/x.ts'], base: '/src' },
      { start: 165, patterns: ['./c/*.ts'] },
    ]);
  });

  it('reads structure from punctuation only (re-audit P-1)', () => {
    const lexed = lexImportSpecifiers(
      `import.meta.glob('./*/*.service.ts', { eager: true, query: { "}": "}", ")": "}" }, base: "/src/modules" });\n` +
        `import.meta.glob('./*.ts', { query: { a: "}", b: ")" } });`,
    );
    expect(lexed.kind === 'ok' && lexed.globs).toEqual([
      { start: 0, patterns: ['./*/*.service.ts'], base: '/src/modules' },
      expect.objectContaining({ patterns: ['./*.ts'] }),
    ]);
  });

  it('treats import and export object keys as keys (re-audit P-2)', () => {
    const lexed = lexImportSpecifiers(
      "const m = import.meta.glob('./*.tsx', { eager: true, import: 'default' });\nconst o = { export: 1 };",
    );
    expect(lexed).toEqual({
      kind: 'ok',
      spans: [],
      globs: [{ start: 10, patterns: ['./*.tsx'] }],
    });
  });

  it.each([
    ['a non-literal pattern', 'import.meta.glob(p);'],
    ['a template pattern with a substitution', 'import.meta.glob(`./${d}/*.ts`);'],
    ['a non-literal array element', "import.meta.glob(['./a.ts', p]);"],
    ['a missing separator in the array', "import.meta.glob(['./a.ts' './b.ts']);"],
    ['a non-literal base', "import.meta.glob('./*.ts', { base: d });"],
    ['a computed key', "import.meta.glob('./*.ts', { ['base']: '/src' });"],
    ['a shorthand key', "import.meta.glob('./*.ts', { base });"],
    ['an options identifier', "import.meta.glob('./*.ts', o);"],
    ['the function used as a value', 'const g = import.meta.glob;'],
  ])('marks globs unreadable for %s without changing the imports', (_label, source) => {
    expect(lexImportSpecifiers(`import { x } from 'pkg';\n${source}`)).toEqual({
      kind: 'ok',
      spans: [expect.objectContaining({ value: 'pkg' })],
      globs: 'unreadable',
    });
  });
});

describe('hasNonImportBinding', () => {
  it.each([
    'function* CUSTOM_METRICS() {}',
    'enum CUSTOM_METRICS { A }',
    'namespace CUSTOM_METRICS {}',
    'const f = CUSTOM_METRICS => CUSTOM_METRICS;',
    'function f(CUSTOM_METRICS: unknown): void {}',
    'const f = (CUSTOM_METRICS) => CUSTOM_METRICS;',
    'try {} catch (CUSTOM_METRICS) {}',
    'const { x: { CUSTOM_METRICS } } = source;',
    'const first = "in", CUSTOM_METRICS = [];',
    'const first = "of", CUSTOM_METRICS = [];',
    'const [other, CUSTOM_METRICS] = source;',
    'using CUSTOM_METRICS = resource;',
    'const value = `${(() => { const CUSTOM_METRICS = []; })()}`;',
  ])('refuses a possible shadowing binding in %s', (source) => {
    expect(hasNonImportBinding(source, ['CUSTOM_METRICS'])).toBe(true);
  });
  it.each([
    "import { CUSTOM_METRICS } from './metrics.ts';",
    'const copy = CUSTOM_METRICS;',
    'let copy: unknown[] = [...CUSTOM_METRICS];',
    'const first = f({ value: CUSTOM_METRICS }), second = [...CUSTOM_METRICS];',
    'const opts = { CUSTOM_METRICS: [] };',
    'const note = "const CUSTOM_METRICS = []"; /* let CUSTOM_METRICS; */',
    'const f = () => CUSTOM_METRICS;',
    '(CUSTOM_METRICS)\n"{";',
  ])('allows an unshadowed reference in %s', (source) => {
    expect(hasNonImportBinding(source, ['CUSTOM_METRICS'])).toBe(false);
  });
  it.each(['const [x = [];', 'const value = {;', 'function f(', 'const s = "unterminated'])(
    'refuses unreadable groups in %s',
    (source) => {
      expect(hasNonImportBinding(source, ['CUSTOM_METRICS'])).toBeUndefined();
    },
  );
});

describe('readImportSpecifiers', () => {
  it('accepts files on which the lexer and esbuild agree', async () => {
    const result = await readImportSpecifiers(
      new Map([
        ['/p/a.ts', SOURCE],
        ['/p/b.tsx', "import { h } from './h.ts';\nexport const v = <div>{h}</div>;\n"],
      ]),
    );
    if (result.kind !== 'ok') throw new Error(result.reason);
    expect(result.spans.get('/p/a.ts')).toHaveLength(10);
    expect(result.spans.get('/p/b.tsx')?.map((span) => span.value)).toEqual(['./h.ts']);
  });

  it('refuses a file the two readers read differently', async () => {
    // `import type from` is a default import named `type`: the lexer reads it as
    // type-only and esbuild keeps it, so the two disagree and the file is refused.
    const result = await readImportSpecifiers(
      new Map([['/p/a.ts', "import type from './x.ts';\nexport { type };\n"]]),
    );
    expect(result).toEqual({
      kind: 'unclassifiable',
      path: '/p/a.ts',
      reason: 'its imports read differently to the TypeScript parser',
    });
  });

  it('refuses a file esbuild cannot parse, and one the lexer refuses', async () => {
    expect(
      await readImportSpecifiers(
        new Map([['/p/a.ts', "import { a } from './a.ts';\nconst = ;\n"]]),
      ),
    ).toEqual({ kind: 'unclassifiable', path: '/p/a.ts', reason: 'esbuild cannot parse it' });
    expect(
      await readImportSpecifiers(new Map([['/p/b.ts', "const a = require('./a.ts');\n"]])),
    ).toEqual({ kind: 'unclassifiable', path: '/p/b.ts', reason: 'a require() call' });
  });
});
