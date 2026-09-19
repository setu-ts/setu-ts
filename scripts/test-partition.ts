// deno-lint-ignore-file no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6)
/**
 * Runs the test suite in two phases: isolated suites alone, then the rest in
 * parallel.
 *
 * `deno test` runs files sequentially unless told otherwise, and the Deno CI
 * job's test step is the overwhelming majority of that job. Most of the suite is
 * hermetic and parallelises safely; a minority touches something shared — a
 * docker container, a real broker, a real port, a subprocess — and must run
 * alone.
 *
 * ## Why the partition is DERIVED and not a list
 *
 * A first attempt (PR #339, reverted in `701bcf29`) hardcoded 56 paths into
 * `deno.json`, four times over: once in `test:isolated`, once as `--ignore` in
 * `test:bulk`, and twice more inside `test:coverage`. Four copies of one list is
 * how a list drifts, and worse, a NEWLY added hazardous suite lands in the
 * parallel phase by default — the unsafe direction.
 *
 * Here `isolationReason` in `./test-partition-rules.ts` is the only definition,
 * and it is evaluated on every run. A new suite that touches a shared resource
 * is isolated the moment it is written, with no list to remember to update.
 *
 * ## Why this set and not the narrower one
 *
 * The reverted attempt isolated e2e suites and the ten that drive docker into a
 * different state. That left every OTHER real-backend integration suite in the
 * parallel phase — 67 files, including
 * `packages/storage-plugin/test/integration/stream-backpressure-real.test.ts`,
 * which is the file that then failed on CI with `TypeError: The stream
 * controller cannot close or enqueue`, plus seven real database-adapter suites
 * and four real-broker suites. Guarding on the backend ENV VAR rather than on
 * "does it restart a container" is what closes that hole: a suite that talks to
 * a shared service contends with any other suite talking to it, whether or not
 * either one restarts it.
 *
 * Measured at `DENO_JOBS=4`, which approximates a runner's worker count: 343s
 * sequential becomes 278s (mean of three runs: 283s, 270s, 281s), a 19% saving.
 * A fourth run at the machine's full 32 workers was no faster overall, which is
 * the point — phase 1 is ~253s of that and is wall-clock bound (docker
 * stop/start, `deno install`, scaffold-and-boot), not CPU bound. So ~253s is the
 * floor no partition can go below, and reducing it means reducing those waits
 * themselves rather than spreading them over more cores.
 *
 * All four runs were green, including one with coverage, whose merged per-file
 * table is identical to the single-phase run's (97.5/99.5/98.6, nothing under
 * the bar) — both phases write raw data into one directory.
 *
 * @module
 */

import { partitionTests, ROOTS } from './test-partition-rules.ts';

/** Permissions the suite itself runs under, matching the previous single task. */
const TEST_FLAGS = [
  '-P',
  '--allow-read',
  '--allow-import',
  '--allow-env',
  '--allow-sys=hostname,osRelease',
  '--allow-run=deno,git,docker',
  '--allow-write',
] as const;

/**
 * Runs one phase and reports its exit code.
 *
 * @param label - Phase name, for the progress line
 * @param args - Arguments after the shared flags
 * @returns The child's exit code
 */
async function runPhase(label: string, args: readonly string[]): Promise<number> {
  console.log(`\n=== ${label} ===`);
  const child = new Deno.Command(Deno.execPath(), {
    args: ['test', ...TEST_FLAGS, ...args],
    stdout: 'inherit',
    stderr: 'inherit',
  }).spawn();
  return (await child.status).code;
}

if (import.meta.main) {
  // Flags other than `--coverage` are FORWARDED to both phases, because
  // `deno task` appends a task's extra arguments to its command and callers rely
  // on that: `.github/workflows/drift.yml` runs
  // `deno task test --lock=<fresh> --frozen` to re-run the suite against a
  // freshly resolved graph. Refusing them would break that job — and its own
  // history (issue #216) is that the flags were silently DROPPED and the gates
  // reported on the committed lockfile instead, which is the same class of
  // failure in the other direction.
  //
  // A bare positional is refused, though: this script owns the file list, so a
  // path here would be a mistake, and silently running the whole suite is what
  // happened when an unhandled `--help` was ignored during development.
  const passthrough = Deno.args.filter((argument) => argument !== '--coverage');
  const positional = passthrough.filter((argument) => !argument.startsWith('-'));
  if (positional.length > 0) {
    console.error(
      `test-partition: unexpected path argument(s) ${positional.join(', ')}. ` +
        `This script derives the file list itself; pass flags only. ` +
        `Usage: test-partition.ts [--coverage] [deno test flags...]`,
    );
    Deno.exit(2);
  }
  const coverage = Deno.args.includes('--coverage');
  // Both phases write raw data into ONE directory, so the coverage scripts that
  // run after this see the merged picture and the per-file bar still applies to
  // the whole suite rather than to either phase.
  const coverageFlags = coverage ? ['--coverage=coverage', '--coverage-raw-data-only'] : [];
  const { isolated, hermetic, reasons } = await partitionTests();

  if (isolated.length === 0 || hermetic.length === 0) {
    // Either side being empty means the classification collapsed — most likely a
    // failed listing. Running anyway would silently either serialise everything
    // or parallelise everything, and the second is unsafe.
    console.error(
      `test-partition: refusing to run with ${isolated.length} isolated and ` +
        `${hermetic.length} hermetic suites; the classification did not work.`,
    );
    Deno.exit(1);
  }

  console.log(
    `test-partition: ${isolated.length} isolated, ${hermetic.length} in parallel ` +
      `(${new Set(reasons.values()).size} distinct isolation reasons)`,
  );

  // Isolated first: these drive docker into different states and bind real
  // ports, so they get a machine the parallel phase has not yet loaded.
  const isolatedCode = await runPhase(
    `phase 1 — ${isolated.length} isolated suites, sequentially`,
    [...isolated, ...coverageFlags, ...passthrough],
  );

  // `--ignore` plus the roots rather than 1033 positional paths: Deno enumerates
  // the remainder itself, and the argument list stays the size of the isolated
  // set.
  const hermeticCode = await runPhase(
    `phase 2 — ${hermetic.length} hermetic suites, in parallel`,
    ['--parallel', `--ignore=${isolated.join(',')}`, ...ROOTS, ...coverageFlags, ...passthrough],
  );

  // Both phases run even when the first fails, so one red phase does not hide
  // the other's result.
  Deno.exit(isolatedCode !== 0 ? isolatedCode : hermeticCode);
}
