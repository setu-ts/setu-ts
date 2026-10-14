import { stat, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DENO_LANE_TESTS, DENO_ONLY_SOURCES, NODE_EXCLUDED_TESTS } from '../scripts/test-lanes.ts';

describe('Package test lane boundaries', () => {
  it('names existing files and excludes only suites that also run on Deno', async () => {
    for (const file of [...DENO_LANE_TESTS, ...DENO_ONLY_SOURCES]) {
      expect((await stat(file)).isFile()).toBe(true);
    }
    for (const file of NODE_EXCLUDED_TESTS) expect(DENO_LANE_TESTS).toContain(file);
    for (const file of DENO_LANE_TESTS) {
      const source = await readFile(file, 'utf8');
      expect(source).not.toMatch(/import\s*\{[^}]*\bvi\b[^}]*\}\s*from\s*['"]vitest/);
    }
    const lane = JSON.parse(await readFile('test/deno-lane/deno.json', 'utf8'));
    for (const file of DENO_LANE_TESTS) {
      const member = file.split('/')[1];
      const scope = file.startsWith('test/') ? '../../test/' : `../../packages/${member}/test/`;
      expect(lane.scopes[scope]?.vitest).toBe('./vitest-shim.ts');
    }
    const config = JSON.parse(await readFile('deno.json', 'utf8'));
    expect(config.tasks.test).toBe('pnpm run test:tooling');
    const runner = await readFile('scripts/codemods/node-test-config.ts', 'utf8');
    expect(runner).toContain("testFiles('test')");
    expect(runner).toContain("testFiles('scripts')");
    expect(runner).toContain("'test/deno-lane/'");
  });
});
