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
  expect(runner).toMatch(/runProcess\('deno',\s*\['check'/);
});
