import { describe, expect, it } from 'vitest';
import config, {
  configurationFor,
  projectsFor,
  sourceExport,
} from '../../scripts/codemods/node-test-config.ts';
import { NODE_EXCLUDED_TESTS } from '../../scripts/test-lanes.ts';

describe('Vitest configuration', () => {
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
  expect(output?.code).toContain('__decorateElement');
  const jsx = await lower('export const element = <div />;', `${root}/.tmp/proof.tsx`);
  expect(jsx?.code).toContain('hono/jsx/jsx-runtime');
  const resolver = config.plugins?.find((p) =>
    p && 'name' in p && p.name === 'setu-source-exports'
  );
  if (!resolver || !('resolveId' in resolver) || typeof resolver.resolveId !== 'function') {
    throw new Error('missing resolver');
  }
  expect(resolver.resolveId.call({} as never, '@setu-ts/common', undefined, {} as never)).toMatch(
    /common\/src\/index.ts$/,
  );
});
