// The repository linter (M111e1 §3.2). It carries what `deno lint` enforced, then restores what the
// recommended presets leave out. The plan's §3.2 lists each rule's origin; the parity test in
// test/node/eslint-config.test.ts plants a violation of each and asserts it is reported.
import { fileURLToPath } from 'node:url';
import js from '@eslint/js';
import { includeIgnoreFile } from '@eslint/compat';
import comments from '@eslint-community/eslint-plugin-eslint-comments';
import * as espree from 'espree';
import globals from 'globals';
import tseslint from 'typescript-eslint';

const gitignore = fileURLToPath(new URL('.gitignore', import.meta.url));

export default tseslint.config(
  includeIgnoreFile(gitignore),
  // The website's build output and its own installed graph are generated, not authored.
  { ignores: ['website/dist/**', 'website/.astro/**'] },
  {
    linterOptions: { reportUnusedDisableDirectives: 'error' },
  },
  js.configs.recommended,
  tseslint.configs.recommended,
  {
    plugins: { '@eslint-community/eslint-comments': comments },
    rules: {
      // deno lint's tags and includes (deno.json `lint.rules`).
      'no-console': 'error',
      'no-eval': 'error',
      'require-await': 'error',
      // `typeof import('ioredis')` types a lazily loaded optional dependency without importing it
      // (AI_GUIDELINES §12.2); deno's verbatim-module-syntax allows it.
      '@typescript-eslint/consistent-type-imports': ['error', { disallowTypeAnnotations: false }],
      '@typescript-eslint/adjacent-overload-signatures': 'error',
      // `interface CqrsCommand<T> extends CqrsRequest<T> {}` names a contract on purpose.
      '@typescript-eslint/no-empty-object-type': [
        'error',
        { allowInterfaces: 'with-single-extends' },
      ],
      'no-restricted-globals': ['error', { name: 'window', message: 'Use globalThis.' }],
      // `args: 'all'`: the default would pass an unused parameter before a used one, which deno
      // reports. A leading underscore is deno's escape, kept (plan C1).
      '@typescript-eslint/no-unused-vars': [
        'error',
        {
          args: 'all',
          caughtErrors: 'all',
          argsIgnorePattern: '^_',
          varsIgnorePattern: '^_',
          caughtErrorsIgnorePattern: '^_',
          destructuredArrayIgnorePattern: '^_',
        },
      ],
      // typescript-eslint's preset turns these off for TypeScript on the grounds that a type check
      // reports them. deno lint enforced them, and a type check only warns about unreachable code,
      // so they come back. no-dupe-class-members, no-redeclare and constructor-super stay off for
      // TypeScript: they misfire on overloads, declaration merging and an asserted superclass
      // (`extends (Base as typeof Base)`), and tsc reports the real cases. Neither
      // preset touches them for JavaScript, where nothing type-checks.
      'no-unreachable': 'error',
      'getter-return': 'error',
      'no-class-assign': 'error',
      'no-const-assign': 'error',
      'no-dupe-args': 'error',
      'no-dupe-keys': 'error',
      'no-func-assign': 'error',
      'no-import-assign': 'error',
      'no-new-native-nonconstructor': 'error',
      'no-obj-calls': 'error',
      'no-setter-return': 'error',
      'no-this-before-super': 'error',
      'no-unsafe-negation': 'error',
      'no-with': 'error',
      'valid-typeof': ['error', { requireStringLiterals: true }],
      'no-inner-declarations': ['error', 'functions', { blockScopedFunctions: 'disallow' }],
      'no-restricted-syntax': [
        'error',
        {
          selector: ":matches(NewExpression, CallExpression)[callee.name='Function']",
          message: 'The Function constructor is eval (AI_GUIDELINES §13.5).',
        },
        {
          selector: 'TSEnumDeclaration[body.members.length=0]',
          message: 'An empty enum declares nothing.',
        },
      ],
      // deno's ban-untagged-ignore: a directive must name the rules it suppresses.
      '@eslint-community/eslint-comments/no-unlimited-disable': 'error',
    },
  },
  {
    // The CLI talks to a terminal (deno.json for packages/cli had no-console excluded).
    files: ['packages/cli/**'],
    rules: { 'no-console': 'off' },
  },
  {
    files: ['**/*.js', '**/*.jsx', '**/*.mjs', '**/*.cjs'],
    // ESLint's own parser: nothing type-checks JavaScript, so a synchronous `await` or an `assert`
    // import must fail here as a syntax error, which typescript-eslint's parser does not raise.
    languageOptions: {
      parser: espree,
      globals: { ...globals.node },
      parserOptions: { ecmaFeatures: { jsx: true } },
    },
    rules: { '@typescript-eslint/consistent-type-imports': 'off' },
  },
);
