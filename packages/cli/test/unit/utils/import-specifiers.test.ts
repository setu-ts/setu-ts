import { describe, expect, it } from 'vitest';

import { lexImportSpecifiers, readImportSpecifiers } from '../../../src/utils/import-specifiers.ts';

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
    expect(lexed).toEqual({ kind: 'ok', spans: [] });
  });
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
