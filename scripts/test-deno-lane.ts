import { run as runProcess } from './lib/run.ts';
import { rm } from 'node:fs/promises';
import { isNotFound } from './lib/run.ts';
/* eslint-disable no-console -- repository test runner */
import { DENO_LANE_TESTS, DENO_ONLY_SOURCES } from './test-lanes.ts';
import { belowThreshold, parseCoverageTable, validateTargetSet } from './deno-lane-coverage.ts';

if (import.meta.main) {
  await (async () => {
    const checked = await runProcess(
      'deno',
      ['check', '--config', 'test/deno-lane/lane.config.json', '--frozen', ...DENO_ONLY_SOURCES],
      { inherit: true },
    );
    if (checked.code !== 0) {
      process.exitCode = checked.code;
      return;
    }
    await rm('coverage-deno-lane', { recursive: true }).catch((error) => {
      if (!isNotFound(error)) throw error;
    });
    const result = await runProcess(
      'deno',
      [
        'test',
        '-P',
        '--allow-read',
        '--allow-env',
        '--allow-import',
        '--allow-sys=hostname,osRelease',
        '--allow-run=deno',
        '--allow-write',
        '--config=test/deno-lane/lane.config.json',
        '--frozen',
        '--coverage=coverage-deno-lane',
        '--coverage-raw-data-only',
        '--junit-path=coverage-deno-lane/tests.xml',
        ...DENO_LANE_TESTS,
        'test/deno-lane/vitest-shim.test.ts',
        ...process.argv.slice(2),
      ],
      { inherit: true },
    );
    const report = await runProcess('deno', [
      'coverage',
      'coverage-deno-lane',
      `--include=${DENO_ONLY_SOURCES.join('|')}`,
    ]);
    const text = report.stdout;
    console.log(text);
    const parsed = parseCoverageTable(text, DENO_ONLY_SOURCES);
    const errors = validateTargetSet(parsed, DENO_ONLY_SOURCES);
    for (const failure of errors) console.error(failure);
    const below = belowThreshold(parsed, 90, DENO_ONLY_SOURCES);
    for (const row of below) console.error(`Under 90%: ${row.target}`);
    process.exitCode = result.code || report.code || (errors.length || below.length ? 1 : 0);
    return;
  })();
}
