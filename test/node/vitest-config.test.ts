import { describe, expect, it, vi } from 'vitest';
import config, {
  configurationFor,
  projectsFor,
  sourceExport,
} from '../../scripts/codemods/node-test-config.ts';
import { NODE_EXCLUDED_TESTS } from '../../scripts/test-lanes.ts';

describe('Vitest configuration', () => {
  it('omits only thresholds for any nonempty shard marker and restores them for merge', () => {
    const normal = configurationFor('packages/common');
    try {
      for (const marker of ['1', '0', 'anything']) {
        vi.stubEnv('SETU_TEST_SHARD', marker);
        const sharded = configurationFor('packages/common');
        expect(sharded.test?.coverage).not.toHaveProperty('thresholds');
        expect(sharded.test?.coverage).toEqual(
          Object.fromEntries(
            Object.entries(normal.test!.coverage!).filter(([key]) => key !== 'thresholds'),
          ),
        );
      }
      vi.stubEnv('SETU_TEST_SHARD', '');
      expect(configurationFor('packages/common').test?.coverage).toEqual(normal.test?.coverage);
    } finally {
      vi.unstubAllEnvs();
    }
  });
  it('resolves source barrels and subpath exports', () => {
    for (const name of ['@setu-ts/common', '@setu-ts/runtime/worker', '@setu-ts/rest-starter']) {
      expect(sourceExport(name)).toMatch(/\/src\/.+\.ts$/);
    }
    expect(sourceExport('vitest')).toBeNull();
    expect(sourceExport('@setu-ts/absent')).toBeNull();
    expect(sourceExport('@setu-ts/common/absent')).toBeNull();
  });
  it('orders decorator lowering before Vitest transforms', () => {
    expect(config.plugins).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ name: 'tc39-decorators', enforce: 'pre' }),
      ]),
    );
  });
  it('enforces per-file thresholds and reports failed members', () => {
    expect(config.test?.coverage?.thresholds).toEqual({
      perFile: true,
      branches: 90,
      functions: 90,
      lines: 90,
    });
    expect(config.test?.coverage?.reportOnFailure).toBe(true);
    expect(configurationFor('packages/common').test?.coverage?.include).toEqual([
      'packages/common/src/**/*.ts',
    ]);
  });
  it('keeps projects disjoint, ordered and outside the root suite', () => {
    const projects = projectsFor('packages/runtime');
    const files = projects.flatMap((p) => p.test.include);
    expect(new Set(files).size).toBe(files.length);
    expect(files.every((path) => path.startsWith('packages/runtime/test/'))).toBe(true);
    for (const excluded of NODE_EXCLUDED_TESTS) expect(files).not.toContain(excluded);
    expect(projects[0]?.test.fileParallelism).toBe(false);
    expect(projects.map((p) => p.test.sequence.groupOrder)).toEqual([0, 1]);
    expect(projectsFor('tooling').flatMap((p) => p.test.include).length).toBeGreaterThan(0);
  });
});

it('lowers a TC39 decorator and JSX before the runner parses the module', async () => {
  const plugin = config.plugins?.find((p) => p && 'name' in p && p.name === 'tc39-decorators');
  if (!plugin || !('transform' in plugin) || typeof plugin.transform !== 'function') {
    throw new Error('missing transformer');
  }
  const lower = plugin.transform.bind({} as never);
  const root = new URL('../..', import.meta.url).pathname;
  expect(await lower('export const x = 1', `${root}/file.js`)).toBeNull();
  expect(await lower('export const x = 1', `${root}/node_modules/pkg/index.ts`)).toBeNull();
  expect(await lower('export const x = 1', '/outside-workspace/proof.ts')).toBeNull();
  const output = await lower(
    'function mark(value: unknown, context: ClassDecoratorContext) {}\n@mark class Subject {}',
    `${root}/.tmp/proof.ts`,
  );
  expect(typeof output === 'string' ? output : output?.code).toContain('__decorateElement');
  const jsx = await lower('export const element = <div />;', `${root}/.tmp/proof.tsx`);
  expect(typeof jsx === 'string' ? jsx : jsx?.code).toContain('hono/jsx/jsx-runtime');
  const resolver = config.plugins?.find(
    (p) => p && 'name' in p && p.name === 'setu-source-exports',
  );
  if (!resolver || !('resolveId' in resolver) || typeof resolver.resolveId !== 'function') {
    throw new Error('missing resolver');
  }
  expect(resolver.resolveId.call({} as never, '@setu-ts/common', undefined, {} as never)).toMatch(
    /common\/src\/index.ts$/,
  );
});

it('widens tooling and preserves the frozen pre-retirement script coverage set', () => {
  const files = projectsFor('tooling').flatMap((p) => p.test.include);
  expect(files).toContain('test/docs-gate.test.ts');
  expect(files).toContain('scripts/codemods/std-to-vitest.test.ts');
  expect(files.some((f) => f.startsWith('test/deno-lane/'))).toBe(false);
  const frozen = [
    'scripts/toolchain-prose.ts',
    'scripts/jsr-sunset.ts',
    'scripts/set-jsr-metadata.ts',
    'scripts/script-targets.ts',
    'scripts/codemods/*.ts',
    'test/node-helpers.ts',
    'scripts/lib/source-hooks.ts',
    'scripts/pack-members.ts',
    'scripts/registry-overlay.ts',
    'scripts/side-effects.ts',
    'scripts/npm-release-gate.ts',
    'scripts/npm-placeholders.ts',
    'scripts/tar-read.ts',
    'scripts/check-docs.ts',
    'scripts/check-prose-assertions.ts',
    'scripts/check-example-behaviour.ts',
    'scripts/generate-api-docs.ts',
    'scripts/package-exports.ts',
    'scripts/npm-specifier-audit.ts',
    'scripts/version-sweep.ts',
    'scripts/check-since-tags.ts',
    'scripts/check-changelog-coverage.ts',
    'scripts/changelog-prs.ts',
    'scripts/node-manifests.ts',
    'scripts/node-build-gate.ts',
    'scripts/bump-version.ts',
    'scripts/version-sites.ts',
    'scripts/release-shape.ts',
    'scripts/test-partition-rules.ts',
    'scripts/publication-hold.ts',
  ];
  // The frozen inventory plus the helpers M111e2 added, which meet the same bar.
  expect([...(configurationFor('tooling').test?.coverage?.include ?? [])].sort()).toEqual(
    [...frozen, 'scripts/lib/*.ts'].sort(),
  );
});
