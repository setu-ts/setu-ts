/**
 * `setu check` parses files a pull request controls, so every parser on its path must
 * stay linear. Each shape below held `check` for seconds to minutes at 1 MiB before the
 * M118 audit (F1, F3). Each test checks the answer at 1 MiB and then the growth from
 * 256 KiB to 1 MiB: a linear parser takes about 4 times as long, the replaced
 * expressions took about 16. A time limit is not used, because it fails a linear parser
 * on a slow runner (2,030 ms against a 2,000 ms limit, once, under coverage).
 */
import { describe, expect, it } from 'vitest';

import { declarationSpecifiers } from '../../src/diagnostics/barrel-drift.ts';
import { moduleActive, withoutImports } from '../../src/diagnostics/modules.ts';
import { maskComments, maskSourceCode } from '../../src/devtool/sources.ts';
import { exportsSymbol } from '../../src/seams/seam-spec.ts';
import { expectLinearGrowth } from '../fixtures/linear-growth.ts';

const MIB = 1024 * 1024;
/** The smaller input of each growth check; the larger is the full 1 MiB. */
const QUARTER = MIB / 4;
const fill = (unit: string, bytes = MIB): string => unit.repeat(Math.floor(bytes / unit.length));

/** The two masked views `diagnoseBarrels` hands the parser. */
function masked(text: string): { readonly source: string; readonly code: string } {
  const source = maskComments(text) ?? '';
  return { source, code: maskSourceCode(source) ?? '' };
}

function specifiers(text: string): readonly string[] {
  const { source, code } = masked(text);
  return declarationSpecifiers(source, code);
}

describe('parsers on the check path stay linear at 1 MiB', () => {
  for (const [name, unit] of [
    ['blank lines', '\n'],
    ['unclosed import braces', '\nimport {'],
    ['repeated import keywords', 'import '],
    ['unclosed export braces', 'export{'],
    ['keywords after long whitespace', `import${' '.repeat(57)}\n`],
  ] as const) {
    it(`parses barrel declarations: ${name}`, () => {
      expect(specifiers(fill(unit))).toEqual([]);
      // Masked outside the timer: the growth measures the parser alone, and the
      // masking pass (shared with every other check-path read) is not the subject.
      expectLinearGrowth(
        name,
        (bytes) => {
          const { source, code } = masked(fill(unit, bytes));
          return () => declarationSpecifiers(source, code);
        },
        QUARTER,
      );
    });
  }

  it('still finds every declaration of a legitimate 1 MiB barrel in linear time', () => {
    const line = "import { registerARoutes } from './a.controller.ts';\n";
    expect(specifiers(fill(line))).toHaveLength(Math.floor(MIB / line.length));
    expectLinearGrowth(
      'legitimate barrel',
      (bytes) => {
        const { source, code } = masked(fill(line, bytes));
        return () => declarationSpecifiers(source, code);
      },
      QUARTER,
    );
  });

  it('strips imports from a config of repeated import keywords', () => {
    const text = fill('import ');
    expect(withoutImports(text)).toBe(text);
    expectLinearGrowth(
      'withoutImports',
      (bytes) => {
        const part = fill('import ', bytes);
        return () => withoutImports(part);
      },
      QUARTER,
    );
  });

  for (const unit of ['MODULES ', 'MODULES = [ ']) {
    it(`reads class-based activation from repeated ${JSON.stringify(unit)}`, () => {
      expect(moduleActive(fill(unit), 'OrdersModule', 'class-based')).toBe(false);
      expectLinearGrowth(
        `moduleActive ${JSON.stringify(unit)}`,
        (bytes) => {
          const part = fill(unit, bytes);
          return () => moduleActive(part, 'OrdersModule', 'class-based');
        },
        QUARTER,
      );
    });
  }

  for (const unit of ['export{', 'export { a }\n']) {
    it(`checks artifact exports in repeated ${JSON.stringify(unit)}`, () => {
      expect(exportsSymbol(fill(unit), 'registerOrdersRoutes')).toBe(false);
      expectLinearGrowth(
        `exportsSymbol ${JSON.stringify(unit)}`,
        (bytes) => {
          const part = fill(unit, bytes);
          return () => exportsSymbol(part, 'registerOrdersRoutes');
        },
        QUARTER,
      );
    });
  }
});

describe('the linear forms keep the expressions they replaced', () => {
  const oldWithoutImports = (code: string): string => code.replace(/\bimport\b[^;]*?\bfrom\b/g, '');
  it.each([
    "import { a } from './a';\nregisterX(app);",
    'import a import b from x; from y',
    'from a import b; import c from d e',
    'importx from y; import from z',
    'import a\nregisterModules(app)',
    '',
  ])('withoutImports(%j)', (code) => {
    expect(withoutImports(code)).toBe(oldWithoutImports(code));
  });

  const oldModulesActive = (code: string, symbol: string): boolean => {
    const match = /\bMODULES\b[^=]*=\s*\[([^\]]*)\]/.exec(code);
    return match !== null && new RegExp(`\\b${symbol}\\b`).test(match[1] ?? '');
  };
  it.each([
    'export const MODULES: readonly ModuleClass[] = [OrdersModule];',
    'export const MODULES = [];\nconst other = [OrdersModule];',
    'MODULES MODULES = [OrdersModule]',
    'MODULES = x; MODULES = [OrdersModule]',
    'MODULES = [OrdersModule',
    'MODULES\n=\n[\nOrdersModule\n]',
  ])('moduleActive(%j)', (code) => {
    expect(moduleActive(code, 'OrdersModule', 'class-based')).toBe(
      oldModulesActive(code, 'OrdersModule'),
    );
  });

  const oldExportClause = (source: string, symbol: string): boolean =>
    [...source.matchAll(/export\s*\{[^}]*\}/g)].some((m) =>
      new RegExp(`\\b${symbol}\\b`).test(m[0]),
    );
  it.each([
    'export { a, registerXRoutes }',
    'export { a } export { registerXRoutes as b }',
    'export {\n  registerXRoutes,\n}',
    'reexport { registerXRoutes }',
    'export { a',
    'export registerXRoutes }',
  ])('exportsSymbol clause form (%j)', (source) => {
    expect(exportsSymbol(source, 'registerXRoutes')).toBe(
      oldExportClause(source, 'registerXRoutes'),
    );
  });

  // The expression `declarationSpecifiers` replaced, with its code-position check.
  const oldSpecifiers = (text: string): readonly string[] => {
    const source = maskComments(text) ?? '';
    const code = maskSourceCode(source) ?? '';
    return [
      ...source.matchAll(
        /(?:^|[;\r\n])\s*(?:import|export)\s+(?:type\s+)?(?:\{[^}]*\}|\*(?:\s+as\s+[A-Za-z_$][\w$]*)?|[A-Za-z_$][\w$]*(?:\s*,\s*(?:\{[^}]*\}|\*\s+as\s+[A-Za-z_$][\w$]*))?)\s+from\s*([\x27\x22])([^\x27\x22\r\n]+)\1/g,
      ),
    ]
      .filter((match) => {
        const offset = match[0].search(/\b(?:import|export)\b/);
        return /^(?:import|export)\b/.test(code.slice(match.index + offset));
      })
      .map((match) => match[2] ?? '');
  };
  it.each([
    'import { a } from \'./a.controller.ts\';\nexport { b } from "./b.controller.ts";',
    "import {\n  a,\n  b,\n} from './a.controller.ts';",
    "import x, * as y from './x.controller.ts';\nexport * from './z.controller.ts';",
    "import type { T } from './t.controller.ts';\nimport type from './type.controller.ts';",
    "const s = 'import { a } from \"./fake.controller.ts\"';\nimport { r } from './real.controller.ts';",
    "// import { c } from './comment.controller.ts';\nimport{ n } from './no-space.controller.ts';",
    "foo; import { a } from './after-semicolon.controller.ts';",
  ])('declarationSpecifiers agrees with the replaced expression on %j', (text) => {
    expect(specifiers(text)).toEqual(oldSpecifiers(text));
  });

  // The one deliberate difference, pinned so it cannot widen unnoticed: a brace list
  // holding `{` or `;` is not read, which no import list does.
  it('differs only for a brace list holding a brace or a semicolon', () => {
    const braced = "import { a; b } from './semi.controller.ts';";
    expect(oldSpecifiers(braced)).toEqual(['./semi.controller.ts']);
    expect(specifiers(braced)).toEqual([]);
  });

  it('reads type-only, default-named-type and namespace declarations', () => {
    expect(
      specifiers(
        [
          "import type { A } from './a.controller.ts';",
          "import type from './type.controller.ts';",
          "import x, { y } from './b.controller.ts';",
          "export * as c from './c.controller.ts';",
          "import{ z } from './no-space.controller.ts';",
        ].join('\n'),
      ),
    ).toEqual([
      './a.controller.ts',
      './type.controller.ts',
      './b.controller.ts',
      './c.controller.ts',
    ]);
  });
});
