// The repository's ESLint config carries what `deno lint` enforced (M111e1 §3.2). Each case plants
// one violation through the real config and asserts the rule that must report it, so a preset
// change that quietly drops a rule fails here rather than in review.
import { describe, it, expect, beforeAll } from 'vitest';
import { fileURLToPath } from 'node:url';
import { ESLint } from 'eslint';

const root = fileURLToPath(new URL('../../', import.meta.url));
let eslint: ESLint;

beforeAll(() => {
  eslint = new ESLint({ cwd: root });
});

/** The rule ids reported for `code` linted as if it lived at `filePath`. */
async function rulesFor(code: string, filePath = 'packages/sample/src/sample.ts') {
  const [result] = await eslint.lintText(code, { filePath });
  return result.messages.map((message) => message.ruleId ?? `directive: ${message.message}`);
}

describe('ESLint configuration parity with deno lint', () => {
  it.each([
    ['console in a package', 'console.log(1);\n', 'no-console'],
    ['eval', "eval('1');\n", 'no-eval'],
    [
      'the Function constructor',
      "export const f = new Function('return 1');\n",
      'no-restricted-syntax',
    ],
    ['a Function call', "export const f = Function('return 1');\n", 'no-restricted-syntax'],
    ['an empty enum', 'export enum Empty {}\n', 'no-restricted-syntax'],
    [
      'an untyped type-only import',
      "import { Foo } from './foo.ts';\nexport type X = Foo;\n",
      '@typescript-eslint/consistent-type-imports',
    ],
    [
      'an unused parameter before a used one',
      'export function f(unused: string, used: string) {\n  return used;\n}\n',
      '@typescript-eslint/no-unused-vars',
    ],
    [
      'an unused parameter after a used one',
      'export function f(used: string, unused: string) {\n  return used;\n}\n',
      '@typescript-eslint/no-unused-vars',
    ],
    [
      'an unused caught error',
      'try {\n  JSON.parse("");\n} catch (error) {\n  console.info("x");\n}\n',
      '@typescript-eslint/no-unused-vars',
    ],
    [
      'unreachable code',
      'export function f() {\n  throw new Error("x");\n  return 1;\n}\n',
      'no-unreachable',
    ],
    [
      'an async function with no await',
      'export async function f() {\n  return 1;\n}\n',
      'require-await',
    ],
    ['window', 'export const w = window;\n', 'no-restricted-globals'],
    [
      'a blanket disable',
      '/* eslint-disable */\nexport const a = 1;\n',
      '@eslint-community/eslint-comments/no-unlimited-disable',
    ],
    [
      'separated overload signatures',
      'export interface I {\n  f(a: string): void;\n  g(): void;\n  f(a: number): void;\n}\n',
      '@typescript-eslint/adjacent-overload-signatures',
    ],
  ])('reports %s', async (_name, code, rule) => {
    expect(await rulesFor(code)).toContain(rule);
  });

  // Rules typescript-eslint's preset turns off on the grounds that a type check reports them.
  // Restored for every file, since .js/.mjs files are not type-checked (M111e1 review).
  it.each([
    ['a duplicate object key', 'export const o = { a: 1, a: 2 };\n', 'no-dupe-keys'],
    ['a const reassignment', 'const c = 1;\nc = 2;\nexport { c };\n', 'no-const-assign'],
    [
      'a getter without return',
      'export const o = {\n  get v() {\n    void 0;\n  },\n};\n',
      'getter-return',
    ],
    [
      'a function reassignment',
      'function f() {}\nf = () => {};\nexport { f };\n',
      'no-func-assign',
    ],
    ['a class reassignment', 'class C {}\nC = class {};\nexport { C };\n', 'no-class-assign'],
    ['an unsafe negation', "export const t = (o: object) => !'k' in o;\n", 'no-unsafe-negation'],
    ['new Symbol', "export const s = new Symbol('x');\n", 'no-new-native-nonconstructor'],
    [
      'a typeof compared with a variable',
      'export function f(x: unknown, t: string) {\n  return typeof x === t;\n}\n',
      'valid-typeof',
    ],
    [
      'a duplicate parameter',
      'export function f(a: number, a: number) {\n  return a;\n}\n',
      'no-dupe-args',
    ],
    [
      'a function declared in a block',
      'export function f() {\n  if (Math.random()) {\n    function g() {}\n    g();\n  }\n}\n',
      'no-inner-declarations',
    ],
  ])('reports %s', async (_name, code, rule) => {
    expect(await rulesFor(code)).toContain(rule);
  });

  it.each([
    ['a redeclared variable', 'var v = 1;\nvar v = 2;\nexport { v };\n', 'no-redeclare'],
    [
      'a duplicate class member',
      'export class C {\n  m() {}\n  m() {}\n}\n',
      'no-dupe-class-members',
    ],
  ])('reports %s in JavaScript', async (_name, code, rule) => {
    expect(await rulesFor(code, 'scripts/sample.mjs')).toContain(rule);
  });

  // espree parses JavaScript: nothing type-checks it, so these syntax errors are its only owner.
  it.each([
    ['a duplicate parameter (a module is strict)', 'export function f(a, a) {\n  return a;\n}\n'],
    ['await in a synchronous function', 'export function f() {\n  await Promise.resolve(1);\n}\n'],
    [
      'an import assertion',
      "import data from './sample.json' assert { type: 'json' };\nexport { data };\n",
    ],
  ])('refuses %s in JavaScript', async (_name, code) => {
    const [result] = await eslint.lintText(code, { filePath: 'scripts/sample.mjs' });
    expect(result.messages.some((message) => message.fatal)).toBe(true);
  });

  it('accepts an import attribute and JSX in JavaScript', async () => {
    const code =
      "import data from './sample.json' with { type: 'json' };\nexport const v = <div>{data}</div>;\n";
    expect(await rulesFor(code, 'packages/sample/src/view.jsx')).toEqual([]);
  });

  it('accepts a superclass wrapped in a type assertion', async () => {
    const code =
      'export function make(): object {\n  class Base {}\n  class C extends (Base as typeof Base) {\n    constructor() {\n      super();\n    }\n  }\n  return new C();\n}\n';
    expect(await rulesFor(code)).toEqual([]);
  });

  it('accepts TypeScript overloads and declaration merging', async () => {
    const code =
      'export class C {\n  m(a: string): void;\n  m(a: number): void;\n  m(_a: unknown) {}\n}\nexport interface I {\n  a: string;\n}\nexport interface I {\n  b: string;\n}\n';
    expect(await rulesFor(code)).toEqual([]);
  });

  it('lints .jsx files', async () => {
    expect(await rulesFor('console.log(<div />);\n', 'packages/sample/src/view.jsx')).toContain(
      'no-console',
    );
  });

  it('reports a directive that suppresses nothing', async () => {
    const rules = await rulesFor('// eslint-disable-next-line no-console\nexport const a = 1;\n');
    expect(
      rules.some((rule) => rule.startsWith('directive: Unused eslint-disable directive')),
    ).toBe(true);
  });

  it.each([
    ['a leading underscore', 'export function f(_ignored: string) {\n  return 1;\n}\n'],
    [
      'an underscored caught error',
      'try {\n  JSON.parse("");\n} catch (_error) {\n  /* nothing */\n}\n',
    ],
    [
      'a typeof-import type for a lazy dependency',
      "export type Redis = typeof import('node:fs');\n",
    ],
    [
      'an interface extending one type',
      'interface Base {\n  a: string;\n}\nexport interface Named extends Base {}\n',
    ],
  ])('accepts %s', async (_name, code) => {
    expect(await rulesFor(code)).toEqual([]);
  });

  it('exempts packages/cli from no-console only', async () => {
    expect(await rulesFor('console.log(1);\n', 'packages/cli/src/sample.ts')).toEqual([]);
    expect(await rulesFor('console.log(1);\n', 'scripts/sample.ts')).toContain('no-console');
  });

  it('declares Node globals for JavaScript modules', async () => {
    expect(await rulesFor('export const env = process.env.HOME;\n', 'scripts/sample.mjs')).toEqual(
      [],
    );
  });

  it('ignores what .gitignore ignores, and the website', async () => {
    for (const path of ['.tmp/sample.ts', '.claude/worktrees/x/sample.ts', 'website/sample.ts']) {
      expect(await eslint.isPathIgnored(path)).toBe(true);
    }
    expect(await eslint.isPathIgnored('packages/kernel/src/sample.ts')).toBe(false);
  });
});
