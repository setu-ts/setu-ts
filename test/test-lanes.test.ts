import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { DENO_LANE_TESTS, DENO_ONLY_SOURCES, NODE_EXCLUDED_TESTS } from '../scripts/test-lanes.ts';

describe('Package test lane boundaries', () => {
  it('names existing files and excludes only suites that also run on Deno', async () => {
    for (const file of [...DENO_LANE_TESTS, ...DENO_ONLY_SOURCES]) {
      expect((await Deno.stat(file)).isFile).toBe(true);
    }
    for (const file of NODE_EXCLUDED_TESTS) expect(DENO_LANE_TESTS).toContain(file);
    for (const file of DENO_LANE_TESTS) {
      const source = await Deno.readTextFile(file);
      expect(source).not.toMatch(/import\s*\{[^}]*\bvi\b[^}]*\}\s*from\s*['"]vitest/);
    }
    const lane = JSON.parse(await Deno.readTextFile('test/deno-lane/deno.json'));
    for (const file of DENO_LANE_TESTS) {
      const member = file.split('/')[1];
      expect(lane.scopes[`../../packages/${member}/test/`]?.vitest).toBe('./vitest-shim.ts');
    }
    const config = JSON.parse(await Deno.readTextFile('deno.json'));
    expect(config.tasks.test).toContain('--root-only');
    const runner = await Deno.readTextFile('scripts/test-partition.ts');
    expect(runner).toContain("'test/node/'");
    expect(runner).toContain("'test/deno-lane/'");
  });
});
