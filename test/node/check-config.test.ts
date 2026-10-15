import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { DENO_LANE_TESTS, DENO_ONLY_SOURCES } from '../../scripts/test-lanes.ts';
import { renderCheckTsconfig } from '../../scripts/node-manifests.ts';

it('generates the check exclusions from the authoritative Deno lane lists', () => {
  const config = JSON.parse(readFileSync('tsconfig.check.json', 'utf8'));
  expect(config).toEqual(JSON.parse(renderCheckTsconfig()));
  expect(config.exclude).toEqual([
    ...DENO_LANE_TESTS,
    ...DENO_ONLY_SOURCES,
    'test/deno-lane',
    'test/fixtures/snippets',
  ]);
  expect(config.exclude).not.toContain('test/browser-gate.test.ts');
  expect(config.include).toEqual([
    'packages/*/src',
    'packages/*/test',
    'packages/starters/*/src',
    'packages/starters/*/test',
    'scripts',
    'test',
  ]);
  expect(config.compilerOptions).toMatchObject({
    noEmit: true,
    composite: false,
    declaration: false,
    allowImportingTsExtensions: true,
  });
});

it('keeps both Deno source checking and lane test checking enabled', () => {
  const runner = readFileSync('scripts/test-deno-lane.ts', 'utf8');
  expect(runner).not.toContain('--no-check');
  expect(runner).toContain('DENO_ONLY_SOURCES');
  expect(runner).toMatch(/run\(\s*'deno',\s*\[\s*'check'/);
});

it('maps every exported package subpath to its source, not to the unbuilt dist', async () => {
  // The `@setu-ts/*` wildcard maps `@setu-ts/cli/main` to `packages/cli/main/src/index.ts`, so a
  // subpath without its own entry type-checks only where a previous build left `dist/` behind.
  const { readdirSync, existsSync } = await import('node:fs');
  const paths = JSON.parse(readFileSync('tsconfig.check.json', 'utf8')).compilerOptions
    .paths as Record<string, string[]>;
  const manifests = [
    ...readdirSync('packages').map((name) => `packages/${name}/package.json`),
    ...readdirSync('packages/starters').map((name) => `packages/starters/${name}/package.json`),
  ].filter((file) => existsSync(file));
  const subpaths: string[] = [];
  for (const file of manifests) {
    const manifest = JSON.parse(readFileSync(file, 'utf8')) as {
      name: string;
      exports?: Record<string, unknown>;
    };
    for (const key of Object.keys(manifest.exports ?? {})) {
      if (key !== '.' && key !== './package.json') subpaths.push(manifest.name + key.slice(1));
    }
  }
  expect(subpaths.length).toBeGreaterThanOrEqual(3);
  for (const subpath of subpaths) {
    const target = paths[subpath]?.[0];
    expect(target, subpath).toBeDefined();
    expect(existsSync(target!), `${subpath} → ${target}`).toBe(true);
  }
});
