/**
 * `setu check` parses files a pull request controls, so every parser on its path must
 * stay linear. Each shape below held `check` for seconds to minutes at 1 MiB before the
 * M118 audit (F1, F3); the budget is far above the measured time and far below that.
 */
import { describe, expect, it } from 'vitest';

import { declarationSpecifiers } from '../../src/diagnostics/barrel-drift.ts';
import { moduleActive, withoutImports } from '../../src/diagnostics/modules.ts';
import { maskComments, maskSourceCode } from '../../src/devtool/sources.ts';
import { exportsSymbol } from '../../src/seams/seam-spec.ts';

const MIB = 1024 * 1024;
const BUDGET_MS = 1000;
const fill = (unit: string): string => unit.repeat(Math.floor(MIB / unit.length));

function timed<T>(run: () => T): { readonly value: T; readonly ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

function specifiers(text: string): readonly string[] {
  const source = maskComments(text) ?? '';
  return declarationSpecifiers(source, maskSourceCode(source) ?? '');
}

describe('parsers on the check path stay linear at 1 MiB', () => {
  for (const [name, text] of [
    ['blank lines', '\n'.repeat(MIB)],
    ['unclosed import braces', fill('\nimport {')],
    ['repeated import keywords', fill('import ')],
    ['unclosed export braces', fill('export{')],
    ['keywords after long whitespace', fill(`import${' '.repeat(57)}\n`)],
  ] as const) {
    it(`parses barrel declarations: ${name}`, () => {
      const { value, ms } = timed(() => specifiers(text));
      expect(value).toEqual([]);
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }

  it('still finds every declaration of a legitimate 1 MiB barrel in budget', () => {
    const line = "import { registerARoutes } from './a.controller.ts';\n";
    const { value, ms } = timed(() => specifiers(fill(line)));
    expect(value).toHaveLength(Math.floor(MIB / line.length));
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  it('strips imports from a config of repeated import keywords', () => {
    const text = fill('import ');
    const { value, ms } = timed(() => withoutImports(text));
    expect(value).toBe(text);
    expect(ms).toBeLessThan(BUDGET_MS);
  });

  for (const unit of ['MODULES ', 'MODULES = [ ']) {
    it(`reads class-based activation from repeated ${JSON.stringify(unit)}`, () => {
      const { value, ms } = timed(() => moduleActive(fill(unit), 'OrdersModule', 'class-based'));
      expect(value).toBe(false);
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }

  for (const unit of ['export{', 'export { a }\n']) {
    it(`checks artifact exports in repeated ${JSON.stringify(unit)}`, () => {
      const { value, ms } = timed(() => exportsSymbol(fill(unit), 'registerOrdersRoutes'));
      expect(value).toBe(false);
      expect(ms).toBeLessThan(BUDGET_MS);
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
