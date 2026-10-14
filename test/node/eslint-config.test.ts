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
