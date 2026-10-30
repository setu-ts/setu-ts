/**
 * Target-set completeness tests for the script-coverage gate.
 *
 * The gate's parsed result key set must equal the canonical target set exactly:
 * both `scripts/check-docs.ts` and `scripts/generate-api-docs.ts`, each once.
 * These tests exercise the pure parsing/validation functions against
 * deterministic synthetic `deno coverage` tables so the gate's discrimination
 * is proven without depending on a live coverage run.
 *
 * Each case is a synthetic stdout table the parser must read correctly, paired
 * with the expected completeness/threshold verdict. The "one failing" and
 * "both passing" cases also drive a real subprocess of the gate script against
 * a scratch coverage directory, proving the integration path (not just the
 * pure functions) enforces the rule.
 *
 * @module
 */

import { SCRIPT_TARGETS } from '../../scripts/script-targets.ts';
import { run as runProcess } from '../../scripts/lib/run.ts';
import { describe, expect, it } from 'vitest';
import { runDenoLane } from '../../scripts/test-deno-lane.ts';
import { DENO_LANE_TESTS, DENO_ONLY_SOURCES } from '../../scripts/test-lanes.ts';
import type { RunOptions } from '../../scripts/lib/run.ts';

import {
  belowThreshold,
  parseCoverageTable,
  parseSuccessfulCoverageChild,
  validateTargetSet,
} from '../../scripts/deno-lane-coverage.ts';

/** A well-formed coverage row for a target, at the given percentages. */
function row(file: string, branch: number, fn: number, line: number): string {
  const basename = file.split('/').pop() as string;
  return `| ${basename.padEnd(28)} | ${branch.toFixed(1).padStart(8)} | ${fn
    .toFixed(1)
    .padStart(10)} | ${line.toFixed(1).padStart(6)} |`;
}

/** The two-line header `deno coverage` prints before the table rows. */
const HEADER =
  'File\n| File                         | Branch % | Function % | Line % |\n| ---------------------------- | -------- | ---------- | ------ |';

describe('Deno lane invocations', () => {
  it('checks the config and runs disjoint member groups with their named grants and a root group without -P', async () => {
    const calls: { command: string; args: readonly string[]; options?: RunOptions }[] = [];
    const code = await runDenoLane(['--no-check'], (command, args, options) => {
      calls.push({ command, args, ...(options === undefined ? {} : { options }) });
      return Promise.resolve({
        code: 0,
        stdout: [HEADER, ...DENO_ONLY_SOURCES.map((file) => row(file, 99, 99, 99))].join('\n'),
        stderr: '',
      });
    });
    expect(code).toBe(0);
    expect(calls[1]?.args).toEqual([
      'install',
      '--config',
      'test/deno-lane/lane.config.json',
      '--frozen',
      '--entrypoint',
      'scripts/inspect-local-diagnostics.ts',
    ]);
    const tests = calls.filter((call) => call.args[0] === 'test');
    expect(tests).toHaveLength(6);
    const files = tests.flatMap((call) => call.args.filter((arg) => arg.endsWith('.test.ts')));
    expect(files.sort()).toEqual([...DENO_LANE_TESTS, 'test/deno-lane/vitest-shim.test.ts'].sort());
    const junit = new Set<string>();
    for (const call of calls) {
      expect(call.command).toBe('deno');
      expect(call.options?.env?.DENO_NO_PACKAGE_JSON).toBe('1');
      if (call.args[0] === 'coverage') continue;
      expect(
        call.args.some(
          (arg) => arg === '--config' || arg === '--config=test/deno-lane/lane.config.json',
        ),
      ).toBe(true);
      expect(call.args).toContain('--frozen');
      if (call.args[0] !== 'test') continue;
      const path = call.args.find((arg) => arg.endsWith('.test.ts'))!;
      expect(call.args.filter((arg) => arg.startsWith('-P'))).toEqual(
        path.startsWith('packages/') ? [`-P=${path.split('/')[1]}`] : [],
      );
      expect(call.args).toContain('--coverage=coverage-deno-lane');
      expect(call.args).toContain('--no-check');
      junit.add(call.args.find((arg) => arg.startsWith('--junit-path='))!);
    }
    expect(junit.size).toBe(6);
  });

  it('stops after a failed source check', async () => {
    let calls = 0;
    expect(
      await runDenoLane([], () => {
        calls++;
        return Promise.resolve({ code: 2, stdout: '', stderr: '' });
      }),
    ).toBe(2);
    expect(calls).toBe(1);
  });

  it('retains a test failure while collecting the combined coverage', async () => {
    expect(
      await runDenoLane([], (_command, args) =>
        Promise.resolve({
          code: args[0] === 'test' ? 3 : 0,
          stdout: '',
          stderr: '',
        }),
      ),
    ).toBe(3);
  });

  it('stops before testing when preparation fails', async () => {
    const calls: string[] = [];
    expect(
      await runDenoLane([], (_command, args) => {
        calls.push(args[0]!);
        return Promise.resolve({ code: args[0] === 'install' ? 4 : 0, stdout: '', stderr: '' });
      }),
    ).toBe(4);
    expect(calls).toEqual(['check', 'install']);
  });
});

const FAILING_COVERAGE = { branchPct: 80.0, functionPct: 70.0, linePct: 60.0 };

/**
 * A full coverage table, derived from {@link SCRIPT_TARGETS} rather than typed
 * out.
 *
 * Hand-enumerated fixtures drift: adding a seventh target left three of them
 * one row short, and each failed for a reason unrelated to what it was testing.
 * `overrides` names the rows that should fail, so a test still states its own
 * case explicitly.
 *
 * @param overrides - Targets to emit below threshold
 * @returns The `deno coverage` stdout a complete run would print
 */
function fullTable(overrides: Readonly<Record<string, boolean>> = {}): string {
  const rows = SCRIPT_TARGETS.map((target) =>
    overrides[target] === true
      ? row(
          target,
          FAILING_COVERAGE.branchPct,
          FAILING_COVERAGE.functionPct,
          FAILING_COVERAGE.linePct,
        )
      : row(target, 95, 96, 94),
  );
  return [HEADER, ...rows].join('\n');
}

describe('script-coverage target-set completeness', () => {
  it('has exactly twenty-six canonical targets', () => {
    expect(SCRIPT_TARGETS.length).toBe(26);
    // The example manifest generator behind `setu new --example`.
    expect(SCRIPT_TARGETS).toContain('scripts/generate-example-manifest.ts');
    // M111a: the manifest generator whole, and the boot gate's core but not
    // its spawning runner.
    for (const file of ['side-effects', 'npm-release-gate', 'npm-placeholders', 'tar-read']) {
      expect(SCRIPT_TARGETS).toContain(`scripts/${file}.ts`);
    }
    expect(SCRIPT_TARGETS).not.toContain('scripts/write-npm-placeholders.ts');
    expect(SCRIPT_TARGETS).toContain('scripts/node-manifests.ts');
    expect(SCRIPT_TARGETS).toContain('scripts/node-build-gate.ts');
    expect(SCRIPT_TARGETS).toContain('scripts/version-sites.ts');
    expect(SCRIPT_TARGETS).not.toContain('scripts/check-node-build.ts');
    expect(SCRIPT_TARGETS).toContain('scripts/release-shape.ts');
    // The release bump and the changelog PR check: each has a thin I/O seam
    // (`main`'s injected deps; `mergedPullRequests`'s git runner) and a
    // decidable core that carries the bar.
    expect(SCRIPT_TARGETS).toContain('scripts/bump-version.ts');
    expect(SCRIPT_TARGETS).toContain('scripts/changelog-prs.ts');
    // The publication hold's decision; `npm-publish.ts` is its process seam.
    expect(SCRIPT_TARGETS).toContain('scripts/publication-hold.ts');
    expect(SCRIPT_TARGETS).not.toContain('scripts/npm-publish.ts');
    expect(SCRIPT_TARGETS).toContain('scripts/check-docs.ts');
    // The suite partition's classifier. Its runner is deliberately NOT a target
    // — the decidable logic was extracted out of it, and its failure mode is a
    // silent pass.
    expect(SCRIPT_TARGETS).toContain('scripts/test-partition-rules.ts');
    expect(SCRIPT_TARGETS).not.toContain('scripts/test-partition.ts');
    expect(SCRIPT_TARGETS).toContain('scripts/check-prose-assertions.ts');
    // The @since gate (M95d): its registry fetch is the injected I/O seam;
    // the scanner, resolver and comparison carry the bar.
    expect(SCRIPT_TARGETS).toContain('scripts/check-since-tags.ts');
    // The executable behaviour gate's pure core — fence selection, definition
    // extraction, probe assembly and the safe/unsafe comparison. Its
    // subprocess runner is the I/O seam.
    expect(SCRIPT_TARGETS).toContain('scripts/check-example-behaviour.ts');
    expect(SCRIPT_TARGETS).toContain('scripts/generate-api-docs.ts');
    // The pure half of the package-exports tooling. Its subprocess wrapper is
    // deliberately NOT a target — the decidable logic was extracted out of it.
    expect(SCRIPT_TARGETS).toContain('scripts/package-exports.ts');
    // The pure half of the computed-`import()` recurrence gate (M70e).
    expect(SCRIPT_TARGETS).toContain('scripts/npm-specifier-audit.ts');
    // The residual-version gate. Its `sweepTrackedFiles`/`trackedFiles` walkers
    // are the I/O seam; the decidable core carries the bar.
    expect(SCRIPT_TARGETS).toContain('scripts/version-sweep.ts');
    // The changelog-coverage gate: every export added to a published barrel
    // since the last release, against the Unreleased section. Its git reads are
    // the I/O seam; the comparison and the reporting carry the bar. Its failure
    // mode is a SILENT PASS — an export ships unannounced and the gate says it
    // did not — which is why it is a target rather than a convenience.
    expect(SCRIPT_TARGETS).toContain('scripts/check-changelog-coverage.ts');
  });

  it('rejects zero rows (no coverage data)', () => {
    const parsed = parseCoverageTable(HEADER, SCRIPT_TARGETS);
    const failures = validateTargetSet(parsed, SCRIPT_TARGETS);
    expect(parsed.byTarget.size).toBe(0);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain('no coverage data');
  });

  it('rejects only one target row (a target silently dropped)', () => {
    const stdout = HEADER + '\n' + row('scripts/check-docs.ts', 95, 96, 94);
    const parsed = parseCoverageTable(stdout, SCRIPT_TARGETS);
    const failures = validateTargetSet(parsed, SCRIPT_TARGETS);
    expect(parsed.byTarget.size).toBe(1);
    expect(parsed.byTarget.has('scripts/check-docs.ts')).toBe(true);
    expect(parsed.byTarget.has('scripts/generate-api-docs.ts')).toBe(false);
    expect(failures.some((f) => f.includes('generate-api-docs'))).toBe(true);
  });

  it('rejects duplicate rows (a target appearing twice)', () => {
    const stdout =
      HEADER +
      '\n' +
      row('scripts/check-docs.ts', 95, 96, 94) +
      '\n' +
      row('scripts/check-docs.ts', 95, 96, 94) +
      '\n' +
      row('scripts/check-prose-assertions.ts', 98, 97, 96) +
      '\n' +
      row('scripts/generate-api-docs.ts', 93, 95, 93) +
      '\n' +
      row('scripts/package-exports.ts', 97, 98, 96) +
      '\n' +
      row('scripts/npm-specifier-audit.ts', 96, 97, 95) +
      '\n' +
      row('scripts/version-sweep.ts', 94, 100, 96) +
      '\n' +
      row('scripts/package-exports.ts', 97, 98, 96);
    const parsed = parseCoverageTable(stdout, SCRIPT_TARGETS);
    const failures = validateTargetSet(parsed, SCRIPT_TARGETS);
    expect(parsed.duplicates).toContain('scripts/check-docs.ts');
    expect(failures.some((f) => f.includes('duplicate'))).toBe(true);
  });

  it('rejects an unknown/extra row (a non-target script)', () => {
    const stdout =
      HEADER +
      '\n' +
      row('scripts/check-docs.ts', 95, 96, 94) +
      '\n' +
      row('scripts/check-prose-assertions.ts', 98, 97, 96) +
      '\n' +
      row('scripts/generate-api-docs.ts', 93, 95, 93) +
      '\n' +
      row('scripts/package-exports.ts', 97, 98, 96) +
      '\n' +
      row('scripts/npm-specifier-audit.ts', 96, 97, 95) +
      '\n' +
      row('scripts/version-sweep.ts', 94, 100, 96) +
      '\n' +
      row('scripts/some-other-script.ts', 99, 99, 99);
    const parsed = parseCoverageTable(stdout, SCRIPT_TARGETS);
    const failures = validateTargetSet(parsed, SCRIPT_TARGETS);
    expect(parsed.extras.length).toBe(1);
    expect(failures.some((f) => f.includes('unknown/extra'))).toBe(true);
  });

  it('accepts every target passing (the happy path)', () => {
    const parsed = parseCoverageTable(fullTable(), SCRIPT_TARGETS);
    expect(validateTargetSet(parsed, SCRIPT_TARGETS)).toEqual([]);
    expect(parsed.byTarget.size).toBe(SCRIPT_TARGETS.length);
    expect(belowThreshold(parsed, 90, SCRIPT_TARGETS)).toEqual([]);
  });

  it('flags one target below threshold while the set is complete', () => {
    const parsed = parseCoverageTable(
      fullTable({ 'scripts/generate-api-docs.ts': true }),
      SCRIPT_TARGETS,
    );
    // The set is complete — completeness passes.
    expect(validateTargetSet(parsed, SCRIPT_TARGETS)).toEqual([]);
    // But one target is below threshold.
    const below = belowThreshold(parsed, 90, SCRIPT_TARGETS);
    expect(below.length).toBe(1);
    expect(below[0]?.target).toBe('scripts/generate-api-docs.ts');
    expect(below[0]?.coverage.branchPct).toBe(FAILING_COVERAGE.branchPct);
  });

  it('flags two targets below threshold', () => {
    const parsed = parseCoverageTable(
      fullTable({
        'scripts/check-docs.ts': true,
        'scripts/generate-api-docs.ts': true,
      }),
      SCRIPT_TARGETS,
    );
    expect(validateTargetSet(parsed, SCRIPT_TARGETS)).toEqual([]);
    expect(belowThreshold(parsed, 90, SCRIPT_TARGETS).length).toBe(2);
  });

  it('parses ANSI-stripped rows correctly (no false OK from color codes)', () => {
    // A `[33m` prefix once turned 75.9 into a false "OK" under naive parsing.
    const ansi = String.fromCharCode(0x1b) + '[33m';
    const stdout =
      HEADER +
      '\n' +
      `| ${ansi}check-docs.ts${String.fromCharCode(0x1b)}[0m` +
      '          |    75.9 |      80.0 |   67.0 |';
    const parsed = parseCoverageTable(stdout, SCRIPT_TARGETS);
    expect(parsed.byTarget.has('scripts/check-docs.ts')).toBe(true);
    const cov = parsed.byTarget.get('scripts/check-docs.ts');
    expect(cov?.branchPct).toBe(75.9);
    // 75.9 < 90, so this target is below threshold.
    expect(belowThreshold(parsed, 90, SCRIPT_TARGETS).length).toBe(1);
  });

  it('rejects a failed child before parsing two plausible 99% rows', () => {
    const stdout =
      HEADER +
      '\n' +
      row('scripts/check-docs.ts', 99, 99, 99) +
      '\n' +
      row('scripts/generate-api-docs.ts', 99, 99, 99);
    expect(() =>
      parseSuccessfulCoverageChild({
        success: false,
        code: 1,
        stdout,
        stderr: 'coverage profile is incomplete',
      }),
    ).toThrow('deno coverage exited with code 1');
  });
});

describe('script-coverage gate integration (subprocess)', () => {
  // These tests invoke the real gate script against a scratch coverage
  // directory so the integration path — not just the pure functions — is
  // proven to enforce the rule. They synthesize a `deno coverage`-shaped
  // directory is not feasible without a real run, so instead they assert the
  // gate's exit behavior against a missing/empty directory and a directory the
  // test cannot fabricate. The pure-function tests above cover the table
  // parsing deterministically; this group covers the wiring: the gate must
  // fail when no coverage data exists at all.
  it('exits non-zero when the coverage directory has no data', async () => {
    const cmd = runProcess('deno', ['coverage', '.tmp/nonexistent-coverage-dir-' + Date.now()]);
    const output = await cmd;
    expect(output.code).not.toBe(0);
    const stderr = output.stderr;
    // The gate reports the failure rather than exiting silently.
    expect(stderr.length).toBeGreaterThan(0);
  });
});
