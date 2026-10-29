import { stat, readFile } from 'node:fs/promises';
import { describe, expect, it } from 'vitest';
import { DENO_LANE_TESTS, DENO_ONLY_SOURCES, NODE_EXCLUDED_TESTS } from '../scripts/test-lanes.ts';

describe('Package test lane boundaries', () => {
  it('runs all real connector proofs on Node and retains their Deno lane', () => {
    const connectorSuites = [
      ...[
        'authorization-explanations',
        'cache-observations',
        'config-provenance',
        'distributed-tracing',
        'event-observations',
        'health-observations',
        'local-connector',
        'outbound-http-observations',
        'queue-observations',
        'realtime-observations',
        'scheduler-observations',
        'storage-observations',
      ].map((name) => `packages/diagnostics-plugin/test/e2e/${name}.test.ts`),
      ...['activation', 'core-conformance', 'lifecycle', 'security'].map(
        (name) => `packages/diagnostics-plugin/test/integration/${name}.test.ts`,
      ),
      'test/inspect-local-diagnostics.test.ts',
      'packages/realtime-backplane-plugin/test/integration/realtime-observations-redis.test.ts',
      'packages/runtime/test/integration/local-diagnostics-listener-conformance.test.ts',
    ];
    for (const file of connectorSuites) {
      expect(NODE_EXCLUDED_TESTS).not.toContain(file);
      expect(DENO_LANE_TESTS).toContain(file);
    }
    expect(DENO_ONLY_SOURCES).toContain(
      'packages/runtime/src/diagnostics/deno-local-diagnostics-listener.ts',
    );
    expect(DENO_ONLY_SOURCES).not.toContain(
      'packages/runtime/src/diagnostics/local-diagnostics-listener.ts',
    );
    expect(DENO_ONLY_SOURCES).not.toContain(
      'packages/runtime/src/diagnostics/node-local-diagnostics-listener.ts',
    );
  });
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
    const pkg = JSON.parse(await readFile('package.json', 'utf8'));
    expect(pkg.scripts['test:tooling']).toBe('SETU_TEST_MEMBER=tooling vitest run');
    const runner = await readFile('scripts/codemods/node-test-config.ts', 'utf8');
    expect(runner).toContain("testFiles('test')");
    expect(runner).toContain("testFiles('scripts')");
    expect(runner).toContain("'test/deno-lane/'");
  });
});
