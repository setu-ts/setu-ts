import { calledOutsideImports, referencedOutsideImports } from '../../src/diagnostics/wiring.ts';
import { describe, expect, it } from 'vitest';
import { referenceMask, referenceDiagnosis } from '../../src/diagnostics/reference-mask.ts';
import { maskSourceCode } from '../../src/devtool/sources.ts';

describe('check-only reference mask', () => {
  it.each([
    'const name = `text ${use({ a: { b: 1 } })} tail`;',
    'const name = `outer ${`inner ${use()}`} tail`;',
    String.raw`const patterns = [/https?:\/\//, /[a-z/]+/gi]; use();`,
    'const value = 10 / 2; use(value / 2);',
    'const label = "escaped \\"use\\""; use();',
    'function test() { return /hello/; } use();',
    'const value = value / 2 / 3; use(value);',
    'const value = [12] / 2; use(value);',
    String.raw`const value = /a\/b[\\]/gi; use(value);`,
    'const value = `escaped \\` tick ${use()}`;',
    'const value = "line\\\ncontinuation"; use(value);',
  ])('classifies literals and retains real references: %s', (source) => {
    expect(referenceMask(source), source).toContain('use');
    expect(maskSourceCode(source)).toBeUndefined();
  });
  it('masks template text, regex bodies and comments without counting their identifiers', () => {
    expect(referenceMask('const label = `use`; const r = /use/; // use\n')).not.toContain('use');
  });
  it('M4 masks regex bodies after default and extends', () => {
    for (const text of [
      'export default /APP_CONTROLLERS/;',
      'class X extends /APP_CONTROLLERS/ {}',
    ]) {
      expect(referenceMask(text)).toBeDefined();
      expect(referenceMask(text)).not.toContain('APP_CONTROLLERS');
    }
  });
  it.each([
    'eval',
    'export default createRestApp({ workers: cores! / 2, controllers: APP_CONTROLLERS, t: ms / 1000 });',
    'if (flag) /APP_CONTROLLERS/.test(s);',
    'while (x) /APP_CONTROLLERS/g.exec(s);',
    'const value = (12) / 2; use(value);',
    'Function',
    'require',
    'globalThis',
    'self',
    'window',
    'Reflect',
    'Proxy',
    'Object',
    'constructor',
    'prototype',
    '__proto__',
    'setPrototypeOf',
    'defineProperty',
    'defineProperties',
    '__defineGetter__',
    '__defineSetter__',
    '__lookupGetter__',
    '__lookupSetter__',
    'import("dynamic")',
    'obj[key]',
    'obj["constructor"]',
    'const ü = 1',
    'const \\u0061 = 1',
    '`unterminated',
    '`x${a',
    '"unterminated',
    '/* unterminated',
    'const r = /unterminated',
    '{} /ambiguous/',
    'a + /undecidable/',
    'const value = (',
    'const value = [}',
    'const value = "escape\\',
    '`escape\\',
    'obj["constr\\u0075ctor"]',
    'import "escaped\\x20specifier";',
    'throw /expression/',
    'const regex = /line\nbreak/',
  ])('retains the strict stop for %s', (source) => {
    expect(referenceMask(source)).toBeUndefined();
    expect(referenceDiagnosis(source)).toHaveProperty('stop');
    expect(referenceMask('const x = `text ${' + source + '}`')).toBeUndefined();
  });
  it('reads a property named like a keyword as a value before / (M139d audit F1)', () => {
    for (const name of ['default', 'extends', 'return', 'typeof']) {
      expect(
        calledOutsideImports(
          `const h = env.${name} / 2; const s = "/ app.register(MailPlugin()) // ";`,
          'MailPlugin',
        ),
        name,
      ).toBe(false);
      expect(
        referenceMask(`const h = mod?.${name} / 2; eval('x'); const q = 1 / 3;`),
        name,
      ).toBeUndefined();
    }
  });
  it('reads a keyword after a spread as a keyword, not a property (M139d re-audit F6)', () => {
    expect(referencedOutsideImports('const a = [...typeof /CachePlugin/];', 'CachePlugin')).toBe(
      false,
    );
    for (const source of [
      'const a = [...void /CachePlugin/g];',
      'const a = [...await /CachePlugin/];',
    ])
      expect(referencedOutsideImports(source, 'CachePlugin'), source).not.toBe(true);
    expect(referencedOutsideImports('const a = [...typeof /x/];', 'CachePlugin')).toBe(false);
  });
});
