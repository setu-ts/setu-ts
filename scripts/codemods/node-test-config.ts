import { defineConfig } from 'vitest/config';
import { transform } from 'esbuild';
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { DENO_ONLY_SOURCES, NODE_EXCLUDED_TESTS } from '../test-lanes.ts';
import { isolationReason } from '../test-partition-rules.ts';

const root = resolve(import.meta.dirname, '../..');
const workspace: string[] = JSON.parse(readFileSync(resolve(root, 'deno.json'), 'utf8')).workspace;
const members = new Map(workspace.map((member) => {
  const dir = resolve(root, member);
  const manifest = JSON.parse(readFileSync(resolve(dir, 'deno.json'), 'utf8'));
  const exports = typeof manifest.exports === 'string' ? { '.': manifest.exports } : manifest.exports;
  return [manifest.name, { dir, exports: exports as Record<string, string> }] as const;
}));

/** Resolve package tests to the same source export map used by the Node build. */
export function sourceExport(specifier: string): string | null {
  const match = /^(@setu-ts\/[^/]+)(\/.*)?$/.exec(specifier);
  if (!match) return null;
  const member = members.get(match[1]!);
  const target = member?.exports[match[2] ? '.' + match[2] : '.'];
  return member && target ? resolve(member.dir, target) : null;
}

function testFiles(directory: string): string[] {
  return readdirSync(resolve(root, directory), { withFileTypes: true }).flatMap((entry) => {
    const path = `${directory}/${entry.name}`;
    return entry.isDirectory() ? testFiles(path) : /\.test\.tsx?$/.test(path) ? [path] : [];
  });
}

/** Partition from the existing shared-resource classifier, excluding only the named Deno suites. */
export function projectsFor(member: string) {
  const candidates = member === 'tooling'
    ? [...testFiles('test/node'), ...testFiles('scripts/codemods')]
    : testFiles(`${member.replace(/^\.\//, '')}/test`);
  const files = candidates.filter((file) => !(NODE_EXCLUDED_TESTS as readonly string[]).includes(file));
  const isolated = files.filter((file) => isolationReason(file, readFileSync(resolve(root, file), 'utf8')) !== null);
  const parallel = files.filter((file) => !isolated.includes(file));
  return [{ name: 'isolated', files: isolated, order: 0 }, { name: 'parallel', files: parallel, order: 1 }]
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
const include = member === 'tooling'
  ? ['scripts/codemods/*.ts', 'test/node-helpers.ts']
  : [`${member.replace(/^\.\//, '')}/src/**/*.ts`];

// Vitest 5's oxc transform does not lower TC39 decorators; esbuild must run first.
return defineConfig({
  plugins: [{
    name: 'setu-source-exports', enforce: 'pre',
    resolveId(specifier) { return sourceExport(specifier); },
  }, {
    name: 'tc39-decorators', enforce: 'pre',
    async transform(code, id) {
      if (!/\.tsx?$/.test(id) || id.includes('/node_modules/') || !id.startsWith(root)) return null;
      const output = await transform(code, {
        loader: id.endsWith('x') ? 'tsx' : 'ts', target: 'es2022', format: 'esm',
        jsx: 'automatic', jsxImportSource: 'hono/jsx', sourcemap: true, sourcefile: id,
      });
      return { code: output.code, map: output.map };
    },
  }],
  test: {
    root, projects: projectsFor(member), pool: 'forks', maxWorkers: 4,
    testTimeout: 30_000, hookTimeout: 30_000,
    reporters: ['default', 'json'],
    outputFile: { json: `coverage-node/${member.split('/').pop()}/tests.json` },
    coverage: {
      provider: 'v8', include, exclude: [...DENO_ONLY_SOURCES, '**/*.test.ts', ...(member === 'tooling' ? [] : ['**/test/**'])],
      reportOnFailure: true,
      reporter: ['text', 'json-summary', 'json'],
      reportsDirectory: `coverage-node/${member.split('/').pop()}`,
      thresholds: { perFile: true, branches: 90, functions: 90, lines: 90 },
    },
  },
});

}
export default configurationFor(process.env.SETU_TEST_MEMBER ?? 'packages/common');
