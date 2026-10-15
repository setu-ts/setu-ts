import { run as runProcess, type RunOptions, type RunResult } from './lib/run.ts';
import { rm } from 'node:fs/promises';
import { isNotFound } from './lib/run.ts';
/* eslint-disable no-console -- repository test runner */
import { DENO_LANE_TESTS, DENO_ONLY_SOURCES } from './test-lanes.ts';
import { belowThreshold, parseCoverageTable, validateTargetSet } from './deno-lane-coverage.ts';

/** Runs the native-runtime proofs in their owning members permission scopes. */
export async function runDenoLane(
  args: readonly string[] = [],
  run: (
    command: string,
    args: readonly string[],
    options?: RunOptions,
  ) => Promise<RunResult> = runProcess,
): Promise<number> {
  const env = { ...process.env, DENO_NO_PACKAGE_JSON: '1' };
  const checked = await run(
    'deno',
    ['check', '--config', 'test/deno-lane/lane.config.json', '--frozen', ...DENO_ONLY_SOURCES],
    { inherit: true, env },
  );
  if (checked.code !== 0) {
    return checked.code;
  }
  // This graph is spawned rather than imported by the tests. Prepare it before
  // the diagnostics child starts so dependency installation cannot pollute stderr.
  const prepared = await run(
    'deno',
    [
      'install',
      '--config',
      'test/deno-lane/lane.config.json',
      '--frozen',
      '--entrypoint',
      'scripts/inspect-local-diagnostics.ts',
    ],
    { inherit: true, env },
  );
  if (prepared.code !== 0) return prepared.code;
  await rm('coverage-deno-lane', { recursive: true }).catch((error) => {
    if (!isNotFound(error)) throw error;
  });
  const groups = new Map<string, string[]>();
  for (const path of [...DENO_LANE_TESTS, 'test/deno-lane/vitest-shim.test.ts']) {
    const member = path.startsWith('packages/') ? path.split('/')[1]! : 'root';
    const group = groups.get(member) ?? [];
    group.push(path);
    groups.set(member, group);
  }
  let testCode = 0;
  for (const [member, tests] of groups) {
    const result = await run(
      'deno',
      [
        'test',
        ...(member === 'root' ? [] : [`-P=${member}`]),
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
        `--junit-path=coverage-deno-lane/${member}.xml`,
        ...tests,
        ...args,
      ],
      { inherit: true, env },
    );
    testCode ||= result.code;
  }
  const report = await run(
    'deno',
    ['coverage', 'coverage-deno-lane', `--include=${DENO_ONLY_SOURCES.join('|')}`],
    { env },
  );
  const text = report.stdout;
  console.log(text);
  const parsed = parseCoverageTable(text, DENO_ONLY_SOURCES);
  const errors = validateTargetSet(parsed, DENO_ONLY_SOURCES);
  for (const failure of errors) console.error(failure);
  const below = belowThreshold(parsed, 90, DENO_ONLY_SOURCES);
  for (const row of below) console.error(`Under 90%: ${row.target}`);
  return testCode || report.code || (errors.length || below.length ? 1 : 0);
}

if (import.meta.main) process.exitCode = await runDenoLane(process.argv.slice(2));
