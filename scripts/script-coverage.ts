// deno-lint-ignore-file no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6)
/**
 * Dedicated per-file coverage gate for workspace scripts.
 *
 * `scripts/coverage.ts` excludes `/scripts/` so tooling scripts do not pollute
 * the package-source per-file table. This script does the opposite: it runs
 * `deno coverage` over ONLY the M38 documentation scripts
 * (`scripts/check-docs.ts` and `scripts/generate-api-docs.ts`) and enforces the
 * same ≥90% branch/function/line bar the repository applies to `packages/ src`.
 *
 * It prints a per-file table and exits non-zero if any script is below
 * threshold on any of the three dimensions. Integrated into `check:docs` so it
 * cannot be omitted.
 *
 * ## Target-set completeness (the hardening this gate enforces)
 *
 * The parsed result key set MUST equal the canonical target set exactly: both
 * [`scripts/check-docs.ts`](./check-docs.ts) and
 * [`scripts/generate-api-docs.ts`](./generate-api-docs.ts), each once. The gate
 * rejects:
 *   - zero rows (no coverage data for either target),
 *   - only one target row (a target silently dropped from the run),
 *   - duplicate rows (the same target appearing twice — a parsing or coverage
 *     artifact that would let one copy mask the other),
 *   - unknown/extra rows (a row for a script that is not a canonical target),
 *   - and any target row below the ≥90% threshold on any dimension.
 *
 * The canonical target set is the single source of truth: adding a third
 * documentation script means adding it here AND regenerating coverage, so a
 * stale run that omits the new script fails the gate rather than passing on the
 * two it still measured.
 *
 * Usage:
 *   deno run --allow-run=deno scripts/script-coverage.ts [coverage-dir]
 *
 * @module
 */

const COVERAGE_DIR = Deno.args[0] ?? 'coverage';
const THRESHOLD = 90;

/**
 * The canonical target set this gate measures — each script exactly once.
 * Adding a script that should be coverage-gated means adding it here, and the
 * gate then refuses a run that omits it.
 */
export const SCRIPT_TARGETS: readonly string[] = [
  'scripts/check-docs.ts',
  'scripts/check-prose-assertions.ts',
  'scripts/generate-api-docs.ts',
  // The pure half of the package-exports tooling. Its subprocess wrapper
  // (`package-export-collection.ts`) is deliberately absent: it is the thin
  // external-I/O seam the decidable logic was extracted OUT of, which is the
  // technique CLAUDE.md prescribes rather than an exemption from the bar.
  'scripts/package-exports.ts',
  // The pure half of the computed-`import()` recurrence gate (M70e). Its
  // `auditPackageSources` walker is the thin I/O seam; `findComputedImports`
  // is the decidable core that carries the bar.
  'scripts/npm-specifier-audit.ts',
];

interface FileCoverage {
  readonly branchPct: number;
  readonly functionPct: number;
  readonly linePct: number;
}

/**
 * Parses `deno coverage` text output for a specific file's three percentages.
 * The table row looks like:
 *   | check-docs.ts        |    87.4 |      80.0 |   67.0 |
 *
 * Strips ANSI escape codes before matching so a colorized run is read correctly
 * (a `[33m` prefix once turned 75.9 into a false "OK" under naive parsing).
 */
export function parseCoverageRow(line: string): FileCoverage | null {
  const ansiStripRe = new RegExp(
    String.fromCharCode(0x1b) + '\\[[0-9;]*m',
    'g',
  );
  const stripped = line.replace(ansiStripRe, '');
  // Match: | filename | branch | function | line |
  const match = /\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/.exec(
    stripped,
  );
  if (!match) return null;
  return {
    branchPct: parseFloat(match[1] as string),
    functionPct: parseFloat(match[2] as string),
    linePct: parseFloat(match[3] as string),
  };
}

/**
 * The result of parsing a `deno coverage` table into a per-target coverage map.
 *
 * `byTarget` maps each canonical target path to its coverage row. `extras`
 * collects rows for scripts that are not canonical targets (a parsing artifact
 * or a stale target). `duplicates` collects targets that appeared more than
 * once. The gate consumes all three to enforce the exact-target-set rule.
 */
export interface ParsedCoverage {
  /** Canonical target path → coverage (first occurrence wins on a duplicate). */
  readonly byTarget: ReadonlyMap<string, FileCoverage>;
  /** Targets that appeared more than once. */
  readonly duplicates: readonly string[];
  /** Rows whose basename matched a non-target script (extras). */
  readonly extras: readonly string[];
}

/**
 * Parses a `deno coverage` stdout table into a per-target coverage map keyed by
 * the canonical target path, plus the duplicates and extras the gate reports.
 *
 * A row is attributed to a target when the row's text includes the target's
 * basename AND the row parses as a coverage row. The basename match is
 * deliberately substring-based because `deno coverage` prints the path as it was
 * invoked (relative, absolute, or workspace-rooted), so an exact-equality
 * match would be brittle; the canonical-target set is small and the
 * duplicate/extra accounting below catches a mis-attribution.
 */
export function parseCoverageTable(
  stdout: string,
  targets: readonly string[] = SCRIPT_TARGETS,
): ParsedCoverage {
  const lines = stdout.split('\n');
  const byTarget = new Map<string, FileCoverage>();
  const duplicates: string[] = [];
  const extras: string[] = [];
  const seenTargets = new Set<string>();

  for (const line of lines) {
    const coverage = parseCoverageRow(line);
    if (coverage === null) continue;

    // `deno coverage` always prints an `All files` aggregate summary row even
    // under `--include`; it is not a script, so skip it rather than counting it
    // as an extra. A real extra (a row for a non-target script) carries a
    // basename, not the literal "All files". The line may be ANSI-colorized, so
    // strip escape codes before testing.
    const ansiStripRe = new RegExp(
      String.fromCharCode(0x1b) + '\\[[0-9;]*m',
      'g',
    );
    const strippedLine = line.replace(ansiStripRe, '');
    if (/\bAll files\b/.test(strippedLine)) continue;

    // Attribute the row to the first canonical target whose basename appears in
    // the line. A row that matches no canonical target is an extra.
    let matched: string | null = null;
    for (const target of targets) {
      const basename = target.split('/').pop() as string;
      if (line.includes(basename)) {
        matched = target;
        break;
      }
    }
    if (matched === null) {
      // Record the raw row text so a stale extra is locatable in the report.
      extras.push(line.trim());
      continue;
    }

    if (seenTargets.has(matched)) {
      duplicates.push(matched);
    } else {
      seenTargets.add(matched);
      byTarget.set(matched, coverage);
    }
  }

  return { byTarget, duplicates, extras };
}

/**
 * Validates a parsed coverage map against the canonical target set. Returns the
 * list of completeness failures (empty when the set is exactly right).
 *
 * The set of targets with a row must equal the canonical target set exactly:
 * every target present once, no target absent, no target duplicated, and no
 * extra row. Each failure names the specific defect so a misconfigured run is
 * debuggable rather than a generic "wrong count".
 */
export function validateTargetSet(
  parsed: ParsedCoverage,
  targets: readonly string[] = SCRIPT_TARGETS,
): readonly string[] {
  const failures: string[] = [];

  if (parsed.byTarget.size === 0) {
    failures.push(
      'no coverage data found for any target script — run `deno task test:coverage` first.',
    );
    return failures;
  }

  // Every canonical target must have exactly one row.
  for (const target of targets) {
    if (!parsed.byTarget.has(target)) {
      failures.push(
        `target "${target}" has no coverage row — the run omitted it or parsing missed it.`,
      );
    }
  }

  // No row for a non-target script.
  if (parsed.extras.length > 0) {
    failures.push(
      `unknown/extra coverage rows that are not canonical targets: ${parsed.extras.join('; ')}`,
    );
  }

  // No target may appear more than once.
  if (parsed.duplicates.length > 0) {
    const unique = [...new Set(parsed.duplicates)].sort();
    failures.push(`duplicate coverage rows for targets: ${unique.join(', ')}`);
  }

  return failures;
}

/**
 * Returns the targets whose coverage is below the threshold on any dimension.
 */
export function belowThreshold(
  parsed: ParsedCoverage,
  threshold: number = THRESHOLD,
  targets: readonly string[] = SCRIPT_TARGETS,
): readonly { readonly target: string; readonly coverage: FileCoverage }[] {
  const below: { target: string; coverage: FileCoverage }[] = [];
  for (const target of targets) {
    const coverage = parsed.byTarget.get(target);
    if (coverage === undefined) continue;
    if (
      coverage.branchPct < threshold ||
      coverage.functionPct < threshold ||
      coverage.linePct < threshold
    ) {
      below.push({ target, coverage });
    }
  }
  return below;
}

/**
 * Formats a coverage row for the printed table.
 */
function formatRow(
  file: string,
  coverage: FileCoverage,
  pass: boolean,
): string {
  const status = pass ? '✅' : '❌';
  return `| ${file.padEnd(28)} | ${coverage.branchPct.toFixed(1).padStart(8)} | ${
    coverage.functionPct.toFixed(1).padStart(10)
  } | ${coverage.linePct.toFixed(1).padStart(6)} | ${status}`;
}

/** Decoded child-process result consumed by the fail-closed gate. */
export interface CoverageChildResult {
  readonly success: boolean;
  readonly code: number;
  readonly stdout: string;
  readonly stderr: string;
}

/**
 * Validates subprocess success before parsing any percentage rows.
 * @throws {Error} when the coverage child fails, regardless of stdout shape
 */
export function parseSuccessfulCoverageChild(
  result: CoverageChildResult,
): ParsedCoverage {
  if (!result.success) {
    throw new Error(
      `script-coverage: deno coverage exited with code ${result.code}\n${result.stderr}`,
    );
  }
  return parseCoverageTable(result.stdout);
}

async function main(): Promise<void> {
  // Build the --include flag for the target scripts.
  const includeFlag = `--include=${SCRIPT_TARGETS.join('|')}`;

  const cmd = new Deno.Command('deno', {
    args: ['coverage', COVERAGE_DIR, includeFlag],
    stdout: 'piped',
    stderr: 'piped',
  });
  const output = await cmd.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);

  // Any nonzero subprocess exit must fail unconditionally, regardless of whether
  // stdout contains a passing-looking table. The presence of "File" in a table
  // does not override a nonzero exit code — that is how the gate fails closed.
  let parsed: ParsedCoverage;
  try {
    parsed = parseSuccessfulCoverageChild({
      success: output.success,
      code: output.code,
      stdout,
      stderr,
    });
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(output.code === 0 ? 1 : output.code);
  }

  // The parsed result key set MUST equal the canonical target set exactly.
  const completenessFailures = validateTargetSet(parsed);
  if (completenessFailures.length > 0) {
    console.error('script-coverage: target-set completeness check failed.');
    for (const failure of completenessFailures) {
      console.error(`  - ${failure}`);
    }
    console.error(
      `Expected exactly these targets, each once: ${SCRIPT_TARGETS.join(', ')}`,
    );
    Deno.exit(1);
  }

  // Print the per-file table.
  console.log(
    '\nScript coverage (per-file, ≥90% branch/function/line required):',
  );
  console.log(
    '| File                         | Branch % | Function % | Line % |',
  );
  console.log(
    '| ---------------------------- | -------- | ---------- | ------ |',
  );

  let allPass = true;
  for (const target of SCRIPT_TARGETS) {
    const coverage = parsed.byTarget.get(target)!;
    const pass = coverage.branchPct >= THRESHOLD &&
      coverage.functionPct >= THRESHOLD &&
      coverage.linePct >= THRESHOLD;
    if (!pass) allPass = false;
    console.log(formatRow(target, coverage, pass));
  }

  if (!allPass) {
    console.error(
      '\nscript-coverage: one or more scripts are below the 90% threshold.',
    );
    Deno.exit(1);
  }

  console.log('\nscript-coverage: all target scripts meet the ≥90% threshold.');
}

if (import.meta.main) {
  await main();
}
