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
 * Usage:
 *   deno run --allow-run=deno scripts/script-coverage.ts [coverage-dir]
 *
 * @module
 */

const COVERAGE_DIR = Deno.args[0] ?? 'coverage';
const THRESHOLD = 90;

/** The scripts this gate measures. */
const SCRIPTS = [
  'scripts/check-docs.ts',
  'scripts/generate-api-docs.ts',
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
 */
function parseCoverageRow(line: string): FileCoverage | null {
  // Strip ANSI escape codes before parsing.
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

async function main(): Promise<void> {
  // Build the --include flag for the two scripts.
  const includeFlag = `--include=${SCRIPTS.join('|')}`;

  const cmd = new Deno.Command('deno', {
    args: ['coverage', COVERAGE_DIR, includeFlag],
    stdout: 'piped',
    stderr: 'piped',
  });
  const output = await cmd.output();
  const stdout = new TextDecoder().decode(output.stdout);
  const stderr = new TextDecoder().decode(output.stderr);

  if (!output.success && !stdout.includes('File')) {
    console.error(stderr);
    Deno.exit(output.code);
  }

  const lines = stdout.split('\n');
  const results: Array<{ file: string; coverage: FileCoverage }> = [];
  for (const line of lines) {
    for (const script of SCRIPTS) {
      const basename = script.split('/').pop() as string;
      if (line.includes(basename)) {
        const coverage = parseCoverageRow(line);
        if (coverage) {
          results.push({ file: script, coverage });
        }
      }
    }
  }

  if (results.length === 0) {
    console.error('script-coverage: no coverage data found for the target scripts.');
    console.error('Run `deno task test:coverage` first to generate coverage data.');
    Deno.exit(1);
  }

  // Print the per-file table.
  console.log('\nScript coverage (per-file, ≥90% branch/function/line required):');
  console.log('| File                         | Branch % | Function % | Line % |');
  console.log('| ---------------------------- | -------- | ---------- | ------ |');

  let allPass = true;
  for (const { file, coverage } of results) {
    const pass = coverage.branchPct >= THRESHOLD &&
      coverage.functionPct >= THRESHOLD &&
      coverage.linePct >= THRESHOLD;
    if (!pass) allPass = false;
    const status = pass ? '✅' : '❌';
    console.log(
      `| ${file.padEnd(28)} | ${coverage.branchPct.toFixed(1).padStart(8)} | ${
        coverage.functionPct.toFixed(1).padStart(10)
      } | ${coverage.linePct.toFixed(1).padStart(6)} | ${status}`,
    );
  }

  if (!allPass) {
    console.error('\nscript-coverage: one or more scripts are below the 90% threshold.');
    Deno.exit(1);
  }

  console.log('\nscript-coverage: all target scripts meet the ≥90% threshold.');
}

if (import.meta.main) {
  await main();
}
