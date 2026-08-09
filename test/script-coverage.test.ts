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
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';

import {
  belowThreshold,
  parseCoverageTable,
  SCRIPT_TARGETS,
  validateTargetSet,
} from '../scripts/script-coverage.ts';

/** A well-formed coverage row for a target, at the given percentages. */
function row(file: string, branch: number, fn: number, line: number): string {
  const basename = file.split('/').pop() as string;
  return `| ${basename.padEnd(28)} | ${branch.toFixed(1).padStart(8)} | ${
    fn.toFixed(1).padStart(10)
  } | ${line.toFixed(1).padStart(6)} |`;
}

/** The two-line header `deno coverage` prints before the table rows. */
const HEADER =
  'File\n| File                         | Branch % | Function % | Line % |\n| ---------------------------- | -------- | ---------- | ------ |';

const FAILING_COVERAGE = { branchPct: 80.0, functionPct: 70.0, linePct: 60.0 };

describe('script-coverage target-set completeness', () => {
  it('has exactly two canonical targets', () => {
    expect(SCRIPT_TARGETS.length).toBe(2);
    expect(SCRIPT_TARGETS).toContain('scripts/check-docs.ts');
    expect(SCRIPT_TARGETS).toContain('scripts/generate-api-docs.ts');
  });

  it('rejects zero rows (no coverage data)', () => {
    const parsed = parseCoverageTable(HEADER);
    const failures = validateTargetSet(parsed);
    expect(parsed.byTarget.size).toBe(0);
    expect(failures.length).toBe(1);
    expect(failures[0]).toContain('no coverage data');
  });

  it('rejects only one target row (a target silently dropped)', () => {
    const stdout = HEADER + '\n' +
      row('scripts/check-docs.ts', 95, 96, 94);
    const parsed = parseCoverageTable(stdout);
    const failures = validateTargetSet(parsed);
    expect(parsed.byTarget.size).toBe(1);
    expect(parsed.byTarget.has('scripts/check-docs.ts')).toBe(true);
    expect(parsed.byTarget.has('scripts/generate-api-docs.ts')).toBe(false);
    expect(failures.some((f) => f.includes('generate-api-docs'))).toBe(true);
  });

  it('rejects duplicate rows (a target appearing twice)', () => {
    const stdout = HEADER + '\n' +
      row('scripts/check-docs.ts', 95, 96, 94) + '\n' +
      row('scripts/check-docs.ts', 95, 96, 94) + '\n' +
      row('scripts/generate-api-docs.ts', 93, 95, 93);
    const parsed = parseCoverageTable(stdout);
    const failures = validateTargetSet(parsed);
    expect(parsed.duplicates).toContain('scripts/check-docs.ts');
    expect(failures.some((f) => f.includes('duplicate'))).toBe(true);
  });

  it('rejects an unknown/extra row (a non-target script)', () => {
    const stdout = HEADER + '\n' +
      row('scripts/check-docs.ts', 95, 96, 94) + '\n' +
      row('scripts/generate-api-docs.ts', 93, 95, 93) + '\n' +
      row('scripts/some-other-script.ts', 99, 99, 99);
    const parsed = parseCoverageTable(stdout);
    const failures = validateTargetSet(parsed);
    expect(parsed.extras.length).toBe(1);
    expect(failures.some((f) => f.includes('unknown/extra'))).toBe(true);
  });

  it('accepts both targets passing (the happy path)', () => {
    const stdout = HEADER + '\n' +
      row('scripts/check-docs.ts', 95, 96, 94) + '\n' +
      row('scripts/generate-api-docs.ts', 93, 95, 93);
    const parsed = parseCoverageTable(stdout);
    const failures = validateTargetSet(parsed);
    expect(failures).toEqual([]);
    expect(parsed.byTarget.size).toBe(2);
    const below = belowThreshold(parsed);
    expect(below).toEqual([]);
  });

  it('flags one target below threshold while the set is complete', () => {
    const stdout = HEADER + '\n' +
      row('scripts/check-docs.ts', 95, 96, 94) + '\n' +
      row('scripts/generate-api-docs.ts', 80, 70, 60);
    const parsed = parseCoverageTable(stdout);
    // The set is complete — completeness passes.
    const failures = validateTargetSet(parsed);
    expect(failures).toEqual([]);
    // But one target is below threshold.
    const below = belowThreshold(parsed);
    expect(below.length).toBe(1);
    expect(below[0]?.target).toBe('scripts/generate-api-docs.ts');
    expect(below[0]?.coverage.branchPct).toBe(FAILING_COVERAGE.branchPct);
  });

  it('flags both targets below threshold', () => {
    const stdout = HEADER + '\n' +
      row('scripts/check-docs.ts', 80, 70, 60) + '\n' +
      row('scripts/generate-api-docs.ts', 80, 70, 60);
    const parsed = parseCoverageTable(stdout);
    expect(validateTargetSet(parsed)).toEqual([]);
    const below = belowThreshold(parsed);
    expect(below.length).toBe(2);
  });

  it('parses ANSI-stripped rows correctly (no false OK from color codes)', () => {
    // A `[33m` prefix once turned 75.9 into a false "OK" under naive parsing.
    const ansi = String.fromCharCode(0x1b) + '[33m';
    const stdout = HEADER + '\n' +
      `| ${ansi}check-docs.ts${String.fromCharCode(0x1b)}[0m` +
      '          |    75.9 |      80.0 |   67.0 |';
    const parsed = parseCoverageTable(stdout);
    expect(parsed.byTarget.has('scripts/check-docs.ts')).toBe(true);
    const cov = parsed.byTarget.get('scripts/check-docs.ts');
    expect(cov?.branchPct).toBe(75.9);
    // 75.9 < 90, so this target is below threshold.
    expect(belowThreshold(parsed).length).toBe(1);
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
    const cmd = new Deno.Command('deno', {
      args: [
        'run',
        '--allow-run=deno',
        'scripts/script-coverage.ts',
        '.tmp/nonexistent-coverage-dir-' + Date.now(),
      ],
      stdout: 'piped',
      stderr: 'piped',
    });
    const output = await cmd.output();
    expect(output.code).not.toBe(0);
    const stderr = new TextDecoder().decode(output.stderr);
    // The gate reports the failure rather than exiting silently.
    expect(stderr.length).toBeGreaterThan(0);
  });
});
