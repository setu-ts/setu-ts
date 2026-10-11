// deno-lint-ignore-file no-console -- repository test runner
import { DENO_LANE_TESTS, DENO_ONLY_SOURCES } from './test-lanes.ts';
import { belowThreshold, parseCoverageTable, validateTargetSet } from './script-coverage.ts';

if (import.meta.main) {
  await Deno.remove('coverage-deno-lane', { recursive: true }).catch((error) => {
    if (!(error instanceof Deno.errors.NotFound)) throw error;
  });
  const result = await new Deno.Command('deno', {
    args: [
      'test',
      '-P',
      '--allow-read',
      '--allow-env',
      '--allow-import',
      '--allow-sys=hostname,osRelease',
      '--allow-run=deno',
      '--allow-write',
      '--import-map=test/deno-lane/deno.json',
      '--coverage=coverage-deno-lane',
      '--coverage-raw-data-only',
      '--junit-path=coverage-deno-lane/tests.xml',
      ...DENO_LANE_TESTS,
      'test/deno-lane/vitest-shim.test.ts',
      ...Deno.args,
    ],
    stdout: 'inherit',
    stderr: 'inherit',
  }).output();
  const report = await new Deno.Command('deno', {
    args: ['coverage', 'coverage-deno-lane', `--include=${DENO_ONLY_SOURCES.join('|')}`],
    stdout: 'piped',
    stderr: 'inherit',
  }).output();
  const text = new TextDecoder().decode(report.stdout);
  console.log(text);
  const parsed = parseCoverageTable(text, DENO_ONLY_SOURCES);
  const errors = validateTargetSet(parsed, DENO_ONLY_SOURCES);
  for (const failure of errors) console.error(failure);
  const below = belowThreshold(parsed, 90, DENO_ONLY_SOURCES);
  for (const row of below) console.error(`Under 90%: ${row.target}`);
  Deno.exit(result.code || report.code || (errors.length || below.length ? 1 : 0));
}
