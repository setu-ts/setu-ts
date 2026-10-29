import { defineConfig } from 'vitest/config';
import { transform } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DENO_ONLY_SOURCES, NODE_EXCLUDED_TESTS } from '../test-lanes.ts';
import { isolationReason } from '../test-partition-rules.ts';
import { sourceExport } from './workspace-sources.ts';
import { SCRIPT_TARGETS } from '../script-targets.ts';

const root = resolve(import.meta.dirname, '../..');
export { sourceExport };

function testFiles(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? testFiles(path) : /\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

/** Partition from the existing shared-resource classifier, excluding only the named Deno suites. */
export function projectsFor(member: string) {
  const candidates =
    member === 'tooling'
      ? [...testFiles('test'), ...testFiles('scripts')]
      : testFiles(`${member.replace(/^\.\//, '')}/test`);
  const files = candidates.filter(
    (file) =>
      !file.startsWith('test/deno-lane/') &&
      !(NODE_EXCLUDED_TESTS as readonly string[]).includes(file),
  );
  const isolated = files.filter(
    (file) => isolationReason(file, readFileSync(resolve(root, file), 'utf8')) !== null,
  );
  const parallel = files.filter((file) => !isolated.includes(file));
  return [
    { name: 'isolated', files: isolated, order: 0 },
    { name: 'parallel', files: parallel, order: 1 },
  ]
    .filter((project) => project.files.length > 0)
    .map((project) => ({
      extends: true as const,
      test: {
        name: project.name,
        include: project.files,
        fileParallelism: project.name === 'parallel',
        sequence: { groupOrder: project.order },
      },
    }));
}

export function configurationFor(member: string) {
  const include =
    member === 'tooling'
      ? [
          'scripts/codemods/*.ts',
          'test/node-helpers.ts',
          // Decides which importers a source redirect may NOT touch (M111d).
          'scripts/lib/source-hooks.ts',
          // The scaffold-install gates' packer and local registry (M111d): `node:`
          // APIs only, and the overlay binds a real socket, which the root Deno lane
          // grants no permission for.
          'scripts/pack-members.ts',
          'scripts/registry-overlay.ts',
          // The shared subprocess helper and sandbox grants added in M111e2.
          'scripts/lib/*.ts',
          ...SCRIPT_TARGETS,
        ]
      : [`${member.replace(/^\.\//, '')}/src/**/*.ts`];

  // Vitest 5's oxc transform does not lower TC39 decorators; esbuild must run first.
  return defineConfig({
    plugins: [
      {
        name: 'setu-source-exports',
        enforce: 'pre',
        resolveId(specifier) {
          return sourceExport(specifier);
        },
      },
      {
        name: 'tc39-decorators',
        enforce: 'pre',
        async transform(code, id) {
          if (!/\.tsx?$/.test(id) || id.includes('/node_modules/') || !id.startsWith(root))
            return null;
          const output = await transform(code, {
            loader: id.endsWith('x') ? 'tsx' : 'ts',
            target: 'es2022',
            format: 'esm',
            jsx: 'automatic',
            jsxImportSource: 'hono/jsx',
            sourcemap: true,
            sourcefile: id,
          });
          return { code: output.code, map: output.map };
        },
      },
    ],
    test: {
      root,
      projects: projectsFor(member),
      pool: 'forks',
      maxWorkers: 4,
      // Code a test hands to Node directly — a worker thread, a module loaded
      // outside Vite — resolves `@setu-ts/*` through Node, which would reach a
      // member's built `dist/` (absent on a fresh checkout, stale after an edit).
      // The hook maps it to source exactly as `sourceExport` does here, and a
      // Worker inherits these flags from the fork.
      execArgv: ['--import', new URL('../../scripts/lib/source-register.ts', import.meta.url).href],
      // Deno's former root suite had no default deadline. Full fence inventories
      // compile hundreds of programs; keep their assertions, with a finite budget.
      testTimeout: member === 'tooling' ? 600_000 : 30_000,
      hookTimeout: 30_000,
      reporters: ['default', 'json'],
      outputFile: { json: `coverage-node/${member.split('/').pop()}/tests.json` },
      coverage: {
        provider: 'v8',
        include,
        exclude: [
          ...DENO_ONLY_SOURCES,
          '**/*.test.ts',
          // The sandbox preload is a two-line `--import` entry that only runs in a
          // permission-restricted child; its logic is measured in `sandbox.ts`.
          ...(member === 'tooling' ? ['scripts/lib/sandbox-preload.ts'] : ['**/test/**']),
        ],
        reportOnFailure: true,
        reporter: ['text', 'json-summary', 'json'],
        reportsDirectory: `coverage-node/${member.split('/').pop()}`,
        ...(process.env.SETU_TEST_SHARD
          ? {}
          : { thresholds: { perFile: true, branches: 90, functions: 90, lines: 90 } }),
      },
    },
  });
}
export default configurationFor(process.env.SETU_TEST_MEMBER ?? 'packages/common');
