/**
 * Unit tests for the Node-manifest generator (M111a plan §3.1, §3.4, §3.6).
 *
 * The pure core is driven with in-memory members, so every classification
 * rule and every refusal is asserted without the live tree; the I/O seam is
 * driven once against a throwaway workspace on disk, which is what proves
 * `--check` reports drift rather than only agreement.
 *
 * @module
 */

import { mkdir, mkdtemp, writeFile, readFile, rm, stat } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import {
  basePackageName,
  checkDecoratorSideEffects,
  classifyMember,
  externalAliases,
  findSrcCycle,
  generateWorkspace,
  type MemberInput,
  normalizeExports,
  renderDenoJson,
  renderPackageJson,
  renderLaneConfig,
  renderRootPackageJson,
  renderAppsTsconfig,
  renderAppTsconfig,
  renderCheckTsconfig,
  runNodeManifests,
} from '../../scripts/node-manifests.ts';

/** Builds one member from a map of member-relative paths to source text. */
function member(
  dir: string,
  name: string,
  files: Record<string, string> = {},
  extra: Partial<MemberInput> = {},
): MemberInput {
  return {
    dir,
    name,
    version: '0.8.0',
    exports: [{ subpath: '.', source: './src/index.ts' }],
    denoJson: `{\n  "name": "${name}",\n  "version": "0.8.0"\n}\n`,
    files: new Map(Object.entries(files).map(([path, text]) => [`${dir}/${path}`, text])),
    ...extra,
  };
}

/** The runtime member as the overrides require it: it imports both overridden packages. */
const RUNTIME = member('packages/runtime', '@setu-ts/runtime', {
  'src/index.ts': [
    "import type { X } from '@setu-ts/common';",
    "const server = await import('@hono/node-server');",
    "const ws = await import('ws');",
  ].join('\n'),
});
const COMMON = member('packages/common', '@setu-ts/common', { 'src/index.ts': 'export {};' });

const nameToDir = new Map([
  ['@setu-ts/common', 'packages/common'],
  ['@setu-ts/kernel', 'packages/kernel'],
  ['@setu-ts/runtime', 'packages/runtime'],
]);

describe('classifyMember — the §3.1 classification table', () => {
  const kernel = member('packages/kernel', '@setu-ts/kernel', {
    'src/index.ts': [
      "import { CAPABILITIES } from '@setu-ts/common';",
      "import { Hono } from 'hono';",
      "import type { Span } from '@opentelemetry/api';",
      "const s3 = await import('@aws-sdk/client-s3');",
      "import { worker } from '@setu-ts/runtime/worker';",
    ].join('\n'),
    'test/app.test.ts': [
      "import { Hono } from 'hono';",
      "import { DefaultAzureCredential } from '@azure/identity';",
      "import { kernel } from '@setu-ts/kernel';",
    ].join('\n'),
  });
  const { classified, refusals } = classifyMember(kernel, nameToDir);

  it('refuses nothing for a well-formed member', () => {
    expect(refusals).toEqual([]);
  });

  it('makes a src workspace import a workspace:^ dependency plus a reference', () => {
    expect(classified.dependencies.get('@setu-ts/common')).toBe('workspace:^');
    expect(classified.references).toContain('packages/common');
  });

  it('keys a subpath workspace import by its base package', () => {
    expect(classified.dependencies.get('@setu-ts/runtime')).toBe('workspace:^');
    expect([...classified.dependencies.keys()].some((k) => k.endsWith('/worker'))).toBe(false);
  });

  it('makes a static external value import a regular dependency', () => {
    expect(classified.dependencies.get('hono')).toBe('^4.12.30');
  });

  it('makes a type-only or dynamic external import an optional peer plus a dev mirror', () => {
    for (const name of ['@opentelemetry/api', '@aws-sdk/client-s3']) {
      expect(classified.peerDependencies.has(name)).toBe(true);
      expect(classified.devDependencies.get(name)).toBe(classified.peerDependencies.get(name));
      expect(classified.dependencies.has(name)).toBe(false);
    }
  });

  it('makes a test-only external a dev dependency, and skips one src already declares', () => {
    expect(classified.devDependencies.get('@azure/identity')).toBe('^4');
    expect(classified.devDependencies.has('hono')).toBe(false);
  });

  it('never references or dev-depends on itself, even when its own tests import it', () => {
    expect(classified.references).not.toContain('packages/kernel');
    expect(classified.devDependencies.has('@setu-ts/kernel')).toBe(false);
  });

  it('adds the pinned build tools to every member', () => {
    expect(classified.devDependencies.get('typescript')).toBe('6.0.3');
    expect(classified.devDependencies.has('@types/node')).toBe(true);
    expect(classified.devDependencies.has('@types/deno')).toBe(false);
  });

  it('lets a value import win over a type import of the same package', () => {
    const both = member('packages/kernel', '@setu-ts/kernel', {
      'src/a.ts': "import type { Span } from '@opentelemetry/api';",
      'src/b.ts': "import { trace } from '@opentelemetry/api';",
    });
    const result = classifyMember(both, nameToDir).classified;
    expect(result.dependencies.has('@opentelemetry/api')).toBe(true);
    expect(result.peerDependencies.has('@opentelemetry/api')).toBe(false);
  });

  it('adds a test-only workspace import as a workspace:^ dev dependency', () => {
    const withTestEdge = member('packages/kernel', '@setu-ts/kernel', {
      'src/index.ts': 'export {};',
      'test/x.test.ts': "import { RuntimePlugin } from '@setu-ts/runtime';",
    });
    const result = classifyMember(withTestEdge, nameToDir).classified;
    expect(result.devDependencies.get('@setu-ts/runtime')).toBe('workspace:^');
    expect(result.references).not.toContain('packages/runtime');
  });
});

describe('classifyMember — the committed overrides', () => {
  it('adds declarations for packages used only by tests without creating a runtime dependency', () => {
    for (const [dir, name, dependency, types] of [
      ['packages/database-plugin', '@setu-ts/database-plugin', 'pg', '@types/pg'],
      ['packages/idempotency-plugin', '@setu-ts/idempotency-plugin', 'pg', '@types/pg'],
      ['packages/websocket-plugin', '@setu-ts/websocket-plugin', 'ws', '@types/ws'],
    ]) {
      const input = member(dir, name, { 'test/a.test.ts': `import client from '${dependency}';` });
      const { classified, refusals } = classifyMember(input, new Map());
      expect(refusals).toEqual([]);
      expect(classified.devDependencies.has(types)).toBe(true);
      expect(classified.dependencies.has(dependency)).toBe(false);
    }
  });
  const { classified, refusals } = classifyMember(RUNTIME, nameToDir);

  it('refuses nothing when every override finds its package', () => {
    expect(refusals).toEqual([]);
  });

  it('makes @hono/node-server a regular dependency of runtime, not a peer', () => {
    expect(classified.dependencies.get('@hono/node-server')).toBe('^2.0.0');
    expect(classified.peerDependencies.has('@hono/node-server')).toBe(false);
    expect(classified.devDependencies.has('@hono/node-server')).toBe(false);
  });

  it('adds @types/ws beside the ws peer, and Deno types for runtime', () => {
    expect(classified.peerDependencies.has('ws')).toBe(true);
    expect(classified.devDependencies.get('@types/ws')).toBe('^8.18.2');
    expect(classified.devDependencies.get('@types/deno')).toBe('2.7.0');
  });

  it('refuses an override whose package the member no longer imports', () => {
    const bare = member('packages/runtime', '@setu-ts/runtime', { 'src/index.ts': 'export {};' });
    const messages = classifyMember(bare, nameToDir).refusals.join('\n');
    expect(messages).toContain('override packages/runtime → @hono/node-server matches nothing');
    expect(messages).toContain('override packages/runtime → @types/ws: its typed package');
  });
});

describe('the CLI executable (M111d §3.2, §3.3)', () => {
  const CLI = member('packages/cli', '@setu-ts/cli', {
    'src/index.ts': "import type { X } from '@setu-ts/common';",
    'src/utils/ts-loader.ts': "const { tsImport } = await import('tsx/esm/api');",
    'src/utils/prettier-format.ts': "const prettier = await import('prettier');",
  });
  const { classified, refusals } = classifyMember(CLI, nameToDir);

  it('makes tsx and prettier regular dependencies, never optional peers the consumer must add', () => {
    expect(refusals).toEqual([]);
    expect(classified.dependencies.get('tsx')).toBe('^4.23.0');
    expect(classified.peerDependencies.has('tsx')).toBe(false);
    expect(classified.dependencies.get('prettier')).toBe('^3.9.10');
    expect(classified.peerDependencies.has('prettier')).toBe(false);
  });

  it('renders the setu bin and lists the executable as its only side effect', () => {
    const pkg = JSON.parse(renderPackageJson(CLI, classified));
    expect(pkg.bin).toEqual({ setu: './dist/bin.js' });
    expect(pkg.sideEffects).toEqual(['./dist/bin.js']);
  });

  it('renders no bin for a library member', () => {
    const pkg = JSON.parse(renderPackageJson(COMMON, classifyMember(COMMON, nameToDir).classified));
    expect('bin' in pkg).toBe(false);
  });
});

describe('classifyMember — refusals name the file and the specifier', () => {
  const refusalsFor = (source: string, file = 'src/index.ts'): string[] =>
    classifyMember(member('packages/kernel', '@setu-ts/kernel', { [file]: source }), nameToDir)
      .refusals;

  it('refuses an npm:/jsr:-prefixed specifier in src', () => {
    expect(refusalsFor("await import('npm:pino@10.x');")[0]).toContain(
      'packages/kernel/src/index.ts: "npm:pino@10.x" is a prefixed specifier in src',
    );
    expect(refusalsFor("import { x } from 'jsr:@scope/pkg';")[0]).toContain(
      'is a prefixed specifier in src',
    );
  });

  it('refuses a Deno @std alias in src but tolerates it in tests until 111b', () => {
    expect(refusalsFor("import { parse } from '@std/jsonc';")[0]).toContain('Deno-only std alias');
    expect(refusalsFor("import { expect } from '@std/expect';", 'test/x.test.ts')).toEqual([]);
  });

  it('refuses a workspace import naming no member', () => {
    expect(refusalsFor("import { x } from '@setu-ts/nonexistent';")[0]).toContain(
      'which is not a workspace member',
    );
  });

  it('refuses an external with no committed range, in src and in tests', () => {
    expect(refusalsFor("import x from 'left-pad';")[0]).toContain(
      'external "left-pad" has no range',
    );
    expect(refusalsFor("import x from 'left-pad';", 'test/x.test.ts')[0]).toContain(
      'external "left-pad" has no range',
    );
  });

  it('ignores relative paths, node: builtins and masked text', () => {
    const source = [
      "import { a } from './a.ts';",
      "import { b } from '../b.ts';",
      "import { readFile } from 'node:fs/promises';",
      "/** @example import { x } from 'left-pad'; */",
      "const text = `import { y } from 'left-pad';`;",
    ].join('\n');
    expect(refusalsFor(source)).toEqual([]);
  });
});

describe('findSrcCycle', () => {
  it('reports a src-level cycle as a readable path', () => {
    const a = { ...classifyMember(COMMON, nameToDir).classified, references: ['packages/b'] };
    const b = { ...a, references: ['packages/a'] };
    expect(findSrcCycle([a, b], ['packages/a', 'packages/b'])).toBe(
      'packages/a → packages/b → packages/a',
    );
  });

  it('returns null for an acyclic graph and ignores an unknown reference', () => {
    const base = classifyMember(COMMON, nameToDir).classified;
    const a = { ...base, references: ['packages/b', 'packages/elsewhere'] };
    const b = { ...base, references: [] };
    expect(findSrcCycle([a, b], ['packages/a', 'packages/b'])).toBeNull();
  });
});

describe('the decorator-plugin sideEffects guard (§3.4 safeguard 2)', () => {
  const dir = 'packages/decorator-plugin';

  it('accepts a manifest that declares no sideEffects', () => {
    expect(checkDecoratorSideEffects(dir, '{"name":"x"}')).toBeNull();
  });

  it('accepts a list that keeps the Symbol.metadata module', () => {
    const json = JSON.stringify({ sideEffects: ['./dist/metadata/symbol-metadata.js'] });
    expect(checkDecoratorSideEffects(dir, json)).toBeNull();
  });

  it('refuses sideEffects: false and a list that omits the module', () => {
    expect(checkDecoratorSideEffects(dir, '{"sideEffects":false}')).toContain(
      'declares "sideEffects": false',
    );
    expect(checkDecoratorSideEffects(dir, '{"sideEffects":["./dist/other.js"]}')).toContain(
      'omitting ./dist/metadata/symbol-metadata.js',
    );
  });

  it('refuses a manifest that is not JSON', () => {
    expect(checkDecoratorSideEffects(dir, '{')).toBe(`${dir}/package.json is not valid JSON`);
  });

  it('is enforced by generateWorkspace for the decorator-plugin member only', () => {
    const decorated = member(
      dir,
      '@setu-ts/decorator-plugin',
      { 'src/index.ts': 'export {};' },
      {
        currentPackageJson: '{"sideEffects":false}',
      },
    );
    const other = member(
      'packages/other',
      '@setu-ts/common',
      { 'src/index.ts': 'export {};' },
      {
        currentPackageJson: '{"sideEffects":false}',
      },
    );
    const refusals = generateWorkspace([decorated, other]).refusals;
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toContain(dir);
  });
});

describe('externalAliases — the member import map (§10, correction 10)', () => {
  it('maps every bare external, subpaths included, from the range table', () => {
    const kernel = member('packages/kernel', '@setu-ts/kernel', {
      'src/router.ts': [
        "import { Hono } from 'hono';",
        "import { LinearRouter } from 'hono/router/linear-router';",
        "const s3 = await import('@aws-sdk/client-s3');",
      ].join('\n'),
      'test/x.test.ts': "import { DefaultAzureCredential } from '@azure/identity';",
    });
    expect([...externalAliases(kernel)].sort()).toEqual([
      ['@aws-sdk/client-s3', 'npm:@aws-sdk/client-s3@^3'],
      ['@azure/identity', 'npm:@azure/identity@^4'],
      ['hono', 'npm:hono@^4.12.30'],
      ['hono/router/linear-router', 'npm:hono@^4.12.30/router/linear-router'],
    ]);
  });

  it('skips relative, builtin, workspace, prefixed, std and unranged specifiers', () => {
    const quiet = member('packages/kernel', '@setu-ts/kernel', {
      'src/a.ts': [
        "import { a } from './a.ts';",
        "import { f } from 'node:fs';",
        "import { c } from '@setu-ts/common';",
        "await import('npm:pino@10.x');",
        "import { parse } from '@std/jsonc';",
        "import x from 'left-pad';",
      ].join('\n'),
    });
    expect(externalAliases(quiet).size).toBe(0);
  });
});

it('maps aliased test dependencies to their real npm package', () => {
  const input = member('packages/openapi-plugin', '@setu-ts/openapi-plugin', {
    'test/alias.test.ts': "import { z } from 'zod-v4'; import { v } from 'zod-v4/v4';",
  });
  expect([...externalAliases(input)]).toEqual([
    ['zod-v4', 'npm:zod@^4.6.6'],
    ['zod-v4/v4', 'npm:zod@^4.6.6/v4'],
  ]);
});

describe('renderDenoJson — splices only the imports block', () => {
  const aliases = new Map([['hono', 'npm:hono@^4.12.30']]);

  it('inserts a block, leaving every other byte as fmt wrote it', () => {
    const raw =
      '{\n  "name": "@setu-ts/x",\n  "test": { "permissions": { "sys": ["hostname"] } }\n}\n';
    expect(renderDenoJson(raw, aliases)).toBe(
      '{\n  "name": "@setu-ts/x",\n  "test": { "permissions": { "sys": ["hostname"] } },\n' +
        '  "imports": {\n    "hono": "npm:hono@^4.12.30"\n  }\n}\n',
    );
  });

  it('replaces a stale bare alias and keeps a prefixed pin, sorted', () => {
    const raw =
      '{\n  "name": "@setu-ts/x",\n  "imports": {\n    "stale": "npm:stale@1",\n' +
      '    "npm:zod@^4.6.6": "npm:zod@^4.6.6"\n  }\n}\n';
    expect(renderDenoJson(raw, aliases)).toBe(
      '{\n  "name": "@setu-ts/x",\n  "imports": {\n    "hono": "npm:hono@^4.12.30",\n' +
        '    "npm:zod@^4.6.6": "npm:zod@^4.6.6"\n  }\n}\n',
    );
  });

  it('removes the block, with its comma, when nothing remains', () => {
    const raw = '{\n  "name": "@setu-ts/x",\n  "imports": {\n    "stale": "npm:stale@1"\n  }\n}\n';
    expect(renderDenoJson(raw, new Map())).toBe('{\n  "name": "@setu-ts/x"\n}\n');
  });

  it('leaves a manifest with no block and no aliases untouched', () => {
    const raw = '{\n  "name": "@setu-ts/x"\n}\n';
    expect(renderDenoJson(raw, new Map())).toBe(raw);
  });

  it('is idempotent', () => {
    const once = renderDenoJson('{\n  "name": "@setu-ts/x"\n}\n', aliases);
    expect(renderDenoJson(once, aliases)).toBe(once);
  });
});

describe('generateWorkspace — rendered files', () => {
  const kernel = member(
    'packages/kernel',
    '@setu-ts/kernel',
    {
      'src/index.ts': "import { x } from '@setu-ts/common';",
    },
    {
      exports: [
        { subpath: '.', source: './src/index.ts' },
        { subpath: './worker', source: './src/worker/index.ts' },
      ],
    },
  );
  const starter = member('packages/starters/rest-starter', '@setu-ts/rest-starter', {
    'src/index.ts': "import { k } from '@setu-ts/kernel';",
  });
  const { files, refusals } = generateWorkspace([COMMON, kernel, RUNTIME, starter]);

  it('generates with no refusals', () => {
    expect(refusals).toEqual([]);
  });

  it('renders dependency keys sorted, whatever order the sources were read in', () => {
    // CI regression: `readDir` order differs between disks, and the manifests
    // came out with test devDependencies in a different order on the runner.
    const sources = {
      'test/b.test.ts': "import { r } from '@setu-ts/runtime';",
      'test/a.test.ts': "import { k } from '@setu-ts/kernel';",
      'src/index.ts': "import { x } from '@setu-ts/common';\nconst w = await import('ws');",
    };
    const forward = member('packages/cache', '@setu-ts/cache-plugin', sources);
    const reversed = member(
      'packages/cache',
      '@setu-ts/cache-plugin',
      Object.fromEntries(Object.entries(sources).reverse()),
    );
    const render = (m: MemberInput) =>
      generateWorkspace([COMMON, kernel, RUNTIME, m]).files.get('packages/cache/package.json')!;
    expect(render(reversed)).toBe(render(forward));
    const pkg = JSON.parse(render(forward));
    for (const field of [
      'dependencies',
      'peerDependencies',
      'peerDependenciesMeta',
      'devDependencies',
    ]) {
      const keys = Object.keys(pkg[field]);
      expect(keys).toEqual([...keys].sort());
    }
    expect(Object.keys(pkg.devDependencies)).toEqual([
      '@setu-ts/kernel',
      '@setu-ts/runtime',
      '@types/node',
      'typescript',
      'ws',
    ]);
  });

  it('maps every export subpath to its dist .js and .d.ts twins', () => {
    const pkg = JSON.parse(files.get('packages/kernel/package.json')!);
    expect(pkg.exports).toEqual({
      '.': { types: './dist/index.d.ts', default: './dist/index.js' },
      './worker': { types: './dist/worker/index.d.ts', default: './dist/worker/index.js' },
    });
    expect(pkg.type).toBe('module');
    expect(pkg.engines).toEqual({ node: '^22.23.4 || ^24.22.1 || >=26.12.1' });
    expect(pkg.files).toEqual(['dist', 'src', 'README.md', 'LICENSE', 'AGENT_CARD.md']);
  });

  it('marks every peer optional', () => {
    const pkg = JSON.parse(files.get('packages/runtime/package.json')!);
    expect(pkg.peerDependenciesMeta).toEqual({ ws: { optional: true } });
  });

  it('omits empty dependency fields', () => {
    const pkg = JSON.parse(files.get('packages/common/package.json')!);
    expect('dependencies' in pkg).toBe(false);
    expect('peerDependencies' in pkg).toBe(false);
  });

  it('resolves extends and references from a nested starter', () => {
    const config = JSON.parse(files.get('packages/starters/rest-starter/tsconfig.json')!);
    expect(config.extends).toBe('../../../tsconfig.base.json');
    expect(config.references).toEqual([{ path: '../../kernel' }]);
  });

  it('gives runtime the deno types and every member the base strictness', () => {
    const runtime = JSON.parse(files.get('packages/runtime/tsconfig.json')!);
    expect(runtime.compilerOptions.types).toEqual(['node', 'deno']);
    const base = JSON.parse(files.get('tsconfig.base.json')!).compilerOptions;
    for (const option of ['strict', 'exactOptionalPropertyTypes', 'isolatedDeclarations']) {
      expect(base[option]).toBe(true);
    }
  });

  it('lists the members once, in pnpm-workspace.yaml, and in the solution', () => {
    const dirs = [
      'packages/common',
      'packages/kernel',
      'packages/runtime',
      'packages/starters/rest-starter',
    ];
    // No root `workspaces` field: pnpm reads pnpm-workspace.yaml, and Deno treats a
    // package.json `workspaces` list as a workspace root, which captured every Deno
    // project scaffolded under .tmp/ and broke its module resolution (M111e3).
    expect(JSON.parse(files.get('package.json')!)).not.toHaveProperty('workspaces');
    expect(files.has('pnpm-workspace.yaml')).toBe(false);
    expect(JSON.parse(files.get('tsconfig.json')!).references).toEqual(
      dirs.map((dir) => ({ path: `./${dir}` })),
    );
  });

  it('keeps authored pnpm install policies', async () => {
    const yaml = await readFile('pnpm-workspace.yaml', 'utf8');
    expect(yaml).toContain('  protobufjs: false');
    expect(yaml).toContain('  sse4_crc32: false');
    expect(yaml).toContain('ignoreWorkspaceCycles: true');
  });

  it('generates a standalone lane with every export and preserved scopes', () => {
    const lane = {
      imports: { vitest: './vitest-shim.ts' },
      scopes: { '../../test/': { vitest: './vitest-shim.ts' } },
    };
    const generated = JSON.parse(renderLaneConfig([COMMON, kernel], JSON.stringify(lane)));
    expect(generated.nodeModulesDir).toBe('auto');
    expect(generated.imports).toMatchObject({
      vitest: './vitest-shim.ts',
      '@setu-ts/common': './../../packages/common/src/index.ts',
      '@setu-ts/kernel/worker': './../../packages/kernel/src/worker/index.ts',
    });
    expect(generated.scopes).toEqual(lane.scopes);
    expect(generated.compilerOptions.strict).toBe(true);
    expect(generated.compilerOptions.lib).toContain('deno.ns');
  });

  it('pins the package manager and the build tools at the root', () => {
    const root = JSON.parse(renderRootPackageJson());
    expect(root.private).toBe(true);
    expect(root.packageManager).toBe('pnpm@12.11.2');
    expect(root.devDependencies.typescript).toBe('6.0.3');
  });

  it('carries the formatter and linter at the root, with their scripts', () => {
    const root = JSON.parse(renderRootPackageJson());
    expect(root.scripts).toMatchObject({
      format: 'prettier --write .',
      'format:check': 'prettier --check .',
      lint: 'eslint .',
    });
    expect(root.devDependencies).toMatchObject({
      prettier: '3.9.10',
      eslint: '10.12.0',
      '@eslint/js': '10.0.1',
      '@eslint/compat': '2.1.1',
      '@eslint-community/eslint-plugin-eslint-comments': '4.8.1',
      'typescript-eslint': '8.71.2',
      globals: '17.13.0',
      espree: '11.2.0',
    });
  });

  it('writes nothing when any member is refused, and refuses a duplicate name', () => {
    const result = generateWorkspace([COMMON, { ...COMMON, dir: 'packages/twin' }]);
    expect(result.refusals).toContain('duplicate workspace member name: @setu-ts/common');
    expect(result.files.size).toBe(0);
  });

  it('refuses a src-level cycle across members', () => {
    const a = member('packages/a', '@setu-ts/a', { 'src/index.ts': "import '@setu-ts/b';" });
    const b = member('packages/b', '@setu-ts/b', { 'src/index.ts': "import '@setu-ts/a';" });
    const { refusals: cycle } = generateWorkspace([a, b]);
    expect(cycle.join('\n')).toContain('src-level workspace dependency cycle');
  });
});

describe('small helpers', () => {
  it('normalizes the string and object export forms', () => {
    expect(normalizeExports('./src/index.ts')).toEqual([
      {
        subpath: '.',
        source: './src/index.ts',
      },
    ]);
    expect(normalizeExports({ '.': './a.ts', './x': './x.ts' })).toEqual([
      { subpath: '.', source: './a.ts' },
      { subpath: './x', source: './x.ts' },
    ]);
    expect(normalizeExports(undefined)).toEqual([]);
  });

  it('reduces a subpath to its base package, scoped or not', () => {
    expect(basePackageName('hono/jsx')).toBe('hono');
    expect(basePackageName('@aws-sdk/client-s3/dist')).toBe('@aws-sdk/client-s3');
  });
});

describe('runNodeManifests — the I/O seam, against a throwaway workspace', () => {
  async function workspace(): Promise<string> {
    const root = await await mkdir('.tmp', { recursive: true }).then(() => mkdtemp('.tmp/test-'));
    await writeFile(`${root}/pnpm-workspace.yaml`, 'packages:\n  - packages/a\n  - apps/*\n');
    await mkdir(`${root}/test/deno-lane`, { recursive: true });
    await writeFile(`${root}/test/deno-lane/deno.json`, '{"imports":{},"scopes":{}}');
    await writeFile(`${root}/LICENSE`, 'test license\n');
    await mkdir(`${root}/apps/minimal`, { recursive: true });
    await writeFile(`${root}/apps/minimal/package.json`, '{}');
    await mkdir(`${root}/packages/a/src`, { recursive: true });
    await writeFile(
      `${root}/packages/a/deno.json`,
      '{"name":"@setu-ts/common","version":"0.8.0","exports":"./src/index.ts"}',
    );
    await writeFile(`${root}/packages/a/src/index.ts`, "import { Hono } from 'hono';");
    return root;
  }

  it('refuses an unknown mode with exit 2', async () => {
    expect(await runNodeManifests([], '.')).toBe(2);
  });

  it('reports missing files, writes them, then agrees, then reports an edit as drift', async () => {
    const root = await workspace();
    try {
      expect(await runNodeManifests(['--check'], root)).toBe(1);
      expect(await runNodeManifests(['--write'], root)).toBe(0);
      expect(await runNodeManifests(['--check'], root)).toBe(0);
      for (const path of ['tsconfig.apps.json', 'apps/minimal/tsconfig.json']) {
        const original = await readFile(`${root}/${path}`, 'utf8');
        await writeFile(`${root}/${path}`, '{}');
        expect(await runNodeManifests(['--check'], root)).toBe(1);
        await writeFile(`${root}/${path}`, original);
      }
      await writeFile(`${root}/packages/a/LICENSE`, 'drift');
      expect(await runNodeManifests(['--check'], root)).toBe(1);
      await writeFile(`${root}/packages/a/LICENSE`, 'test license\n');
      const path = `${root}/packages/a/package.json`;
      const pkg = JSON.parse(await readFile(path, 'utf8'));
      expect(pkg.dependencies).toEqual({ hono: '^4.12.30' });
      const deno = JSON.parse(await readFile(`${root}/packages/a/deno.json`, 'utf8'));
      expect(deno.imports).toEqual({ hono: 'npm:hono@^4.12.30' });
      await writeFile(path, JSON.stringify({ ...pkg, version: '9.9.9' }));
      expect(await runNodeManifests(['--check'], root)).toBe(1);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('exits 1 on a refusal before writing anything', async () => {
    const root = await workspace();
    try {
      await writeFile(`${root}/packages/a/src/index.ts`, "import x from 'left-pad';");
      expect(await runNodeManifests(['--write'], root)).toBe(1);
      await expect(stat(`${root}/packages/a/package.json`)).rejects.toThrow();
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('refuses a workspace entry without its member manifest', async () => {
    const root = await workspace();
    try {
      await rm(`${root}/packages/a/deno.json`);
      await expect(runNodeManifests(['--check'], root)).rejects.toThrow(
        'packages/a: no parsable deno.json',
      );
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('reports removed exports as lane config drift', async () => {
    const root = await workspace();
    try {
      await runNodeManifests(['--write'], root);
      const path = `${root}/packages/a/deno.json`;
      const manifest = JSON.parse(await readFile(path, 'utf8'));
      delete manifest.exports;
      await writeFile(path, JSON.stringify(manifest));
      expect(await runNodeManifests(['--check'], root)).toBe(1);
    } finally {
      await rm(root, { recursive: true });
    }
  });

  it('agrees with the committed tree', async () => {
    expect(await runNodeManifests(['--check'])).toBe(0);
  });

  it('copies each lane member permission set verbatim without widening loopback grants', async () => {
    const config = JSON.parse(await readFile('test/deno-lane/lane.config.json', 'utf8'));
    const names = [
      'cli',
      'diagnostics-plugin',
      'realtime-backplane-plugin',
      'runtime',
      'websocket-plugin',
    ];
    expect(Object.keys(config.permissions).sort()).toEqual(names);
    for (const name of names) {
      const manifest = JSON.parse(await readFile(`packages/${name}/deno.json`, 'utf8'));
      expect(config.permissions[name]).toEqual(manifest.test.permissions);
    }
    expect(config.permissions.cli.net).toEqual(['127.0.0.1']);
    expect(config.permissions.runtime.net).toBe(true);
  });
});

describe('app type-check configurations', () => {
  it('shares source aliases and uses the plan-prescribed non-emitting Node options', () => {
    const apps = JSON.parse(renderAppsTsconfig());
    const check = JSON.parse(renderCheckTsconfig());
    expect(apps.extends).toBe('./tsconfig.base.json');
    expect(apps.compilerOptions).toEqual({
      noEmit: true,
      composite: false,
      declaration: false,
      declarationMap: false,
      isolatedDeclarations: false,
      allowImportingTsExtensions: true,
      rewriteRelativeImportExtensions: false,
      typeRoots: ['./node_modules/@types', './packages/runtime/node_modules/@types'],
      types: ['node', 'deno'],
      paths: check.compilerOptions.paths,
    });
  });

  it('replaces the complete alias map only for the React full-stack app', () => {
    const minimal = JSON.parse(renderAppTsconfig('apps/minimal'));
    expect(minimal).toEqual({
      extends: '../../tsconfig.apps.json',
      include: ['**/*.ts', '**/*.tsx'],
    });
    const full = JSON.parse(renderAppTsconfig('apps/full-stack'));
    expect(full.extends).toBe(minimal.extends);
    expect(full.include).toEqual([...minimal.include, 'node_modules/vite/client.d.ts']);
    expect(full.compilerOptions.jsx).toBe('react-jsx');
    const { '~/*': alias, ...paths } = full.compilerOptions.paths;
    expect(alias).toEqual(['./app/*']);
    const root = JSON.parse(renderAppsTsconfig()).compilerOptions.paths;
    expect(paths).toEqual(
      Object.fromEntries(
        Object.entries(root).map(([key, values]) => [
          key,
          (values as string[]).map((value) => '../../' + value.slice(2)),
        ]),
      ),
    );
  });
});

describe('npm publish metadata', () => {
  it('emits all named fields and includes source and license', () => {
    const inputs = [COMMON, member('packages/decorator-plugin', '@setu-ts/decorator-plugin')];
    const generated = generateWorkspace(inputs, 'license bytes');
    for (const input of inputs) {
      const pkg = JSON.parse(generated.files.get(`${input.dir}/package.json`)!);
      for (const field of [
        'description',
        'repository',
        'homepage',
        'bugs',
        'publishConfig',
        'sideEffects',
      ])
        expect(Object.hasOwn(pkg, field)).toBe(true);
      expect(pkg.repository).toEqual({
        type: 'git',
        url: 'git+https://github.com/setu-ts/setu-ts.git',
        directory: input.dir,
      });
      expect(pkg.publishConfig).toEqual({ access: 'public' });
      expect(pkg.files).toEqual(['dist', 'src', 'README.md', 'LICENSE', 'AGENT_CARD.md']);
      expect(generated.files.get(`${input.dir}/LICENSE`)).toBe('license bytes');
      expect(pkg.sideEffects).toEqual(
        input === COMMON ? false : ['./dist/metadata/symbol-metadata.js'],
      );
    }
  });
  it('refuses missing descriptions in generation and the renderer', () => {
    const unknown = member('packages/unknown', '@setu-ts/unknown');
    expect(generateWorkspace([unknown]).refusals).toContain(
      '@setu-ts/unknown: missing package description',
    );
    expect(() => renderPackageJson(unknown, classifyMember(unknown, new Map()).classified)).toThrow(
      'description',
    );
  });
});
