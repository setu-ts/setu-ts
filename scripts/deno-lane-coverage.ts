import { DENO_ONLY_SOURCES } from './test-lanes.ts';
const THRESHOLD = 90;
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
  const ansiStripRe = new RegExp(String.fromCharCode(0x1b) + '\\[[0-9;]*m', 'g');
  const stripped = line.replace(ansiStripRe, '');
  // Match: | filename | branch | function | line |
  const match = /\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/.exec(stripped);
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
  targets: readonly string[] = DENO_ONLY_SOURCES,
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
    const ansiStripRe = new RegExp(String.fromCharCode(0x1b) + '\\[[0-9;]*m', 'g');
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
  targets: readonly string[] = DENO_ONLY_SOURCES,
): readonly string[] {
  const failures: string[] = [];

  if (parsed.byTarget.size === 0) {
    failures.push(
      'no coverage data found for any target script — run `pnpm run test:tooling:coverage` first.',
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
  targets: readonly string[] = DENO_ONLY_SOURCES,
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
export function parseSuccessfulCoverageChild(result: CoverageChildResult): ParsedCoverage {
  if (!result.success) {
    throw new Error(
      `script-coverage: deno coverage exited with code ${result.code}\n${result.stderr}`,
    );
  }
  return parseCoverageTable(result.stdout);
}
