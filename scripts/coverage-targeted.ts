// deno-lint-ignore-file no-console -- console output is sanctioned in scripts (AI_GUIDELINES §11.6)
/**
 * @module
 *
 * Targeted per-file coverage gate — runs and measures only the workspace
 * members a change actually touches.
 *
 * `deno task test:coverage` runs the WHOLE suite (10+ minutes) and reports on
 * every `packages/<name>/src` file, which is the right gate for a milestone
 * hand-off and the wrong one for the edit-test loop: a change confined to two
 * packages pays for 47. This task runs `deno test` over the selected members
 * only and reports their `src/` files, so the same loop costs seconds.
 *
 * ## Soundness — read this before trusting a red result
 *
 * A package's `src` coverage is contributed to by OTHER packages' tests: an
 * `exceptions` integration test that boots a kernel application executes
 * `kernel/src` and `common/src` too. So for any file, the targeted run measures
 * a SUBSET of the executions the full run measures, which means:
 *
 *   - **A targeted PASS is sound.** Fewer tests can only lower a percentage, so
 *     ≥90% here implies ≥90% in the full run.
 *   - **A targeted FAIL may be a false alarm.** The uncovered lines might be
 *     covered by a dependent package's tests. Confirm with the full run before
 *     writing tests for them.
 *
 * `deno coverage` reports only modules that were LOADED, so a `src` file no
 * test imports would have no row at all rather than a 0% row. Those files are
 * classified rather than assumed: `probeUnreported` loads them and re-reports,
 * after which a module with runtime code carries a row (at 0%, so it fails the
 * bar) and a type-only module still carries none. So a PASS means every `src`
 * file of the selected members was measured and cleared the bar, or provably
 * emits no runtime code to measure.
 *
 * A `--with-dependents` flag was built and CUT: the transitive dependents of
 * every member measured here close over the ENTIRE workspace (47 of 47, for
 * `common`, `kernel`, `exceptions`, `static-plugin`, `cache-plugin` and
 * `graphql-plugin` alike, because the CLI templates and the starters name every
 * plugin), so the flag would have been `deno task test:coverage` under another
 * name. The honest answer for a failing file is the full run.
 *
 * The gate prints that caveat beside every failing file rather than leaving the
 * reader to remember it, and it never claims to replace `test:coverage` as a
 * milestone gate.
 *
 * ## Why this enforces the bar and `scripts/coverage.ts` does not
 *
 * `deno task test:coverage` exits 0 with a `src` file at 80% branch — CLAUDE.md
 * says so in as many words, and tells a human to read the ANSI-stripped table
 * themselves. This gate parses that table and exits non-zero, so the loop that
 * runs most often is also the one that fails closed.
 *
 * Not in `scripts/script-coverage.ts`'s `SCRIPT_TARGETS`, following the M39
 * `check-deploy.ts` precedent: the file is mostly `Deno.Command` orchestration
 * a test may not spawn, so its decidable logic (`readWorkspaceMembers`,
 * `resolveMembers`, `parseMemberTable`, `belowBar`, `parseArgs`) is exported and
 * unit-tested instead (`test/unit/coverage-targeted.test.ts`).
 *
 * Usage:
 *   deno task test:coverage:pkg                      # infer members from git
 *   deno task test:coverage:pkg exceptions kernel    # explicit, by short name
 *   deno task test:coverage:pkg packages/sdk         # or by path
 *   deno task test:coverage:pkg resilience           # or by bare plugin concern
 *   deno task test:coverage:pkg --base=origin/main   # change the diff base
 */

/** Absolute-percentage bar this repository applies to every `packages/<name>/src` file. */
export const THRESHOLD = 90;

/** Raw-coverage output directory. nested under the already-gitignored `.coverage/`. */
const COVERAGE_DIR = '.coverage/targeted';

/** The permission flags `deno task test` uses, so a targeted run behaves identically. */
const TEST_FLAGS = [
  '-P',
  '--allow-read',
  '--allow-import',
  '--allow-env',
  '--allow-sys=hostname,osRelease',
  '--allow-run=deno,git,docker',
  '--allow-write',
] as const;

/** One file's three measured dimensions. */
export interface FileCoverage {
  readonly branchPct: number;
  readonly functionPct: number;
  readonly linePct: number;
}

/** A parsed row: the path as `deno coverage` printed it, plus its percentages. */
export interface CoverageRow extends FileCoverage {
  readonly file: string;
}

/**
 * Reads the workspace member list from the root manifest.
 *
 * The members are the single source of truth for what a "package" is: they
 * carry the two-segment `starters/rest-starter` form that a naive
 * `packages/<name>` split would mangle (the M36c drift-gate defect).
 */
export function readWorkspaceMembers(manifest: string): readonly string[] {
  const parsed = JSON.parse(manifest) as { workspace?: readonly string[] };
  return (parsed.workspace ?? []).map((entry) => entry.replace(/^\.\//, ''));
}

/**
 * Maps arbitrary paths (a git diff line, a user-supplied name) onto workspace
 * member directories, longest-member-first so `packages/starters/rest-starter`
 * wins over a hypothetical `packages/starters`.
 *
 * Accepts a member path (`packages/sdk`), a short name (`sdk`), a scoped name
 * (`@setu-ts/sdk`), the bare concern of a plugin (`resilience` ->
 * `packages/resilience-plugin`, accepted only when exactly one member matches)
 * or any file inside a member. Returns the members in
 * manifest order with no duplicates, plus the inputs that matched nothing —
 * an unmatched input is REPORTED rather than silently dropped, because
 * silently measuring nothing is how a gate turns into a false pass.
 */
export function resolveMembers(
  inputs: readonly string[],
  members: readonly string[],
): { readonly members: readonly string[]; readonly unmatched: readonly string[] } {
  const byLength = [...members].sort((a, b) => b.length - a.length);
  const hit = new Set<string>();
  const unmatched: string[] = [];

  for (const raw of inputs) {
    const input = raw.replace(/^\.\//, '').replace(/^@setu-ts\//, '');
    if (input === '') continue;
    const member = byLength.find((candidate) =>
      input === candidate ||
      input.startsWith(`${candidate}/`) ||
      input === candidate.slice('packages/'.length) ||
      candidate.slice('packages/'.length) === input.replace(/^packages\//, '')
    );
    if (member === undefined) {
      // Convenience fallback: most members are `<name>-plugin`, so accept the
      // bare concern (`resilience` -> `packages/resilience-plugin`) when it
      // resolves to EXACTLY one member. Ambiguity is refused rather than
      // guessed, so a selector can never silently measure the wrong package.
      const suffixed = members.filter((candidate) =>
        candidate.slice('packages/'.length) === `${input}-plugin`
      );
      if (suffixed.length !== 1) {
        unmatched.push(raw);
        continue;
      }
      hit.add(suffixed[0] as string);
      continue;
    }
    hit.add(member);
  }

  return { members: members.filter((m) => hit.has(m)), unmatched };
}

/**
 * Parses a `deno coverage` table into rows, ANSI-stripped.
 *
 * Colorized output is why this strips first: a `[33m` prefix once turned 75.9
 * into a false "OK" under naive parsing (`scripts/script-coverage.ts` carries
 * the same note). The `All files` aggregate row is skipped — the bar is
 * per-file, and an aggregate that clears 90 hides a file that does not.
 */
export function parseMemberTable(stdout: string): readonly CoverageRow[] {
  const ansi = new RegExp(String.fromCharCode(0x1b) + '\\[[0-9;]*m', 'g');
  const rows: CoverageRow[] = [];

  for (const line of stdout.split('\n')) {
    const stripped = line.replace(ansi, '');
    if (/\bAll files\b/.test(stripped)) continue;
    const match = /^\|\s*(\S.*?)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|\s*([\d.]+)\s*\|/
      .exec(stripped);
    if (match === null) continue;
    rows.push({
      file: match[1] as string,
      branchPct: parseFloat(match[2] as string),
      functionPct: parseFloat(match[3] as string),
      linePct: parseFloat(match[4] as string),
    });
  }

  return rows;
}

/** Returns the rows below the bar on any of the three dimensions. */
export function belowBar(
  rows: readonly CoverageRow[],
  threshold: number = THRESHOLD,
): readonly CoverageRow[] {
  return rows.filter((row) =>
    row.branchPct < threshold ||
    row.functionPct < threshold ||
    row.linePct < threshold
  );
}

/**
 * Returns the expected source files that `deno coverage` reported no row for.
 *
 * `deno coverage` reports only modules that were LOADED, so a `src` file no
 * test imports is absent from the table rather than present at 0% — and a run
 * that reads only the rows it was given used to claim
 * `all 9 file(s) meet the ≥90% bar` while saying nothing about it.
 *
 * An absent row has two causes, and they must be told apart: a module nothing
 * loaded (a real gap) and a TYPE-ONLY module, erased at compile time and so
 * absent from every report including the full run's. `probeUnreported` settles
 * it by asking the compiler — see there.
 *
 * A source-level classifier was attempted first and rejected: over the 742
 * `src` files in `packages/` it misclassified 47 as type-only that the full run
 * had measured, because a barrel carrying both `export { … }` and
 * `export type { … }` defeats whole-file token matching, and a wrong answer in
 * that direction silently skips a real file.
 *
 * Rows are matched by path SUFFIX because `deno coverage` prints each path
 * relative to the common root of the files it reported — `index.ts` for a
 * single member, `exceptions/src/index.ts` for two — so reconstructing that
 * prefix would duplicate a rule this tool does not own. The match requires a
 * `/` boundary (or full equality) so a row for `index.ts` cannot claim
 * `my-index.ts`.
 */
export function findUnreportedFiles(
  expected: readonly string[],
  rows: readonly CoverageRow[],
): readonly string[] {
  return expected.filter((file) =>
    !rows.some((row) => file === row.file || file.endsWith(`/${row.file}`))
  );
}

/**
 * Splits the two change-discovery command outputs into candidate paths.
 *
 * A `git status --porcelain` rename reads `old -> new`; the destination is the
 * path that exists, so that is the one taken.
 */
export function parseChangedPaths(
  diffStdout: string,
  statusStdout: string,
): readonly string[] {
  const fromStatus = statusStdout
    .split('\n')
    .map((line) => line.slice(3).trim())
    .filter((line) => line !== '')
    .map((line) => line.includes(' -> ') ? line.split(' -> ')[1] as string : line);
  return [...diffStdout.split('\n'), ...fromStatus].filter((path) => path.trim() !== '');
}

/**
 * Splits argv into flags and positional member selectors.
 */
export function parseArgs(
  argv: readonly string[],
): { readonly selectors: readonly string[]; readonly base: string } {
  const selectors: string[] = [];
  let base = 'main';
  for (const arg of argv) {
    const baseFlag = /^--base=(.+)$/.exec(arg);
    if (baseFlag !== null) {
      base = baseFlag[1] as string;
      continue;
    }
    selectors.push(arg);
  }
  return { selectors, base };
}

async function run(
  cmd: string,
  args: readonly string[],
  inherit: boolean,
): Promise<{ success: boolean; code: number; stdout: string; stderr: string }> {
  const child = new Deno.Command(cmd, {
    args: [...args],
    stdout: inherit ? 'inherit' : 'piped',
    stderr: inherit ? 'inherit' : 'piped',
  });
  const output = await child.output();
  const decoder = new TextDecoder();
  return {
    success: output.success,
    code: output.code,
    stdout: inherit ? '' : decoder.decode(output.stdout),
    stderr: inherit ? '' : decoder.decode(output.stderr),
  };
}

/**
 * Collects changed paths: committed against `base`, plus the working tree.
 *
 * A failing command EXITS rather than reporting no changes. `git diff` answers
 * a misspelled `--base`, an absent default ref, or a missing merge base with a
 * non-zero status and empty stdout, which on a clean tree is indistinguishable
 * from "nothing changed" — so the gate would skip itself and exit 0. Verified:
 * `--base=does-not-exist-ref` reported `nothing to measure` before this check.
 */
async function changedPaths(base: string): Promise<readonly string[]> {
  const diff = await run('git', ['diff', '--name-only', `${base}...HEAD`], false);
  if (!diff.success) {
    console.error(
      `coverage-targeted: git diff against '${base}' failed — cannot infer the ` +
        'changed members. Name them explicitly, or pass a valid --base.',
    );
    console.error(diff.stderr.trim());
    Deno.exit(diff.code === 0 ? 1 : diff.code);
  }

  const status = await run('git', ['status', '--porcelain'], false);
  if (!status.success) {
    console.error(
      'coverage-targeted: git status failed — cannot infer the changed members.',
    );
    console.error(status.stderr.trim());
    Deno.exit(status.code === 0 ? 1 : status.code);
  }

  return parseChangedPaths(diff.stdout, status.stdout);
}

/** Lists a member's `src` files, repo-relative, for the completeness check. */
async function listSourceFiles(member: string): Promise<readonly string[]> {
  const found: string[] = [];
  const walk = async (dir: string): Promise<void> => {
    let entries: AsyncIterable<Deno.DirEntry>;
    try {
      entries = Deno.readDir(dir);
    } catch {
      return; // A member with no `src` contributes nothing to measure.
    }
    for await (const entry of entries) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory) {
        await walk(path);
      } else if (/\.(ts|tsx|mts)$/.test(entry.name)) {
        found.push(path);
      }
    }
  };
  await walk(`${member}/src`);
  return found.sort();
}

/**
 * Renders the probe module that loads the unreported files.
 *
 * The specifiers are STATIC and relative to the probe's own directory, so Deno
 * resolves them into the module graph at load time rather than needing runtime
 * read permission per target; the `../` depth therefore has to match where the
 * probe is written, which is what this derives from `coverageDir` instead of
 * hardcoding.
 */
export function renderProbeModule(
  files: readonly string[],
  coverageDir: string,
): string {
  const toRoot = '../'.repeat(coverageDir.split('/').length);
  const imports = files
    .map((file) => `  await import('${toRoot}${file}');`)
    .join('\n');
  return `Deno.test('coverage-targeted: classify unreported modules', async () => {\n${imports}\n});\n`;
}

/**
 * Loads modules that produced no coverage row, so `deno coverage` can classify
 * them, then reports whether the probe ran.
 *
 * This asks the COMPILER rather than guessing from source text, which is what
 * makes the classification sound. Measured on a scratch project: after
 * importing a type-only module and an unexercised runtime module in one test
 * run, `deno coverage` emitted a row for the runtime module — at 0% function
 * and line, so it fails the bar — and NO row for the type-only one, whose raw
 * entry exists but whose emitted output has nothing to measure.
 *
 * The probe emits STATIC relative specifiers because Deno resolves those into
 * the module graph at load time; a computed `new URL(...).href` needs runtime
 * read permission for every target instead. It runs `--no-check`: types are
 * already the business of `deno task check`, and this run only needs the
 * modules loaded.
 *
 * The generated file is removed afterwards, and it lives under the gitignored
 * coverage directory, which `deno fmt` and `deno lint` skip (verified — a
 * deliberately misformatted file there left `fmt:check` clean).
 */
async function probeUnreported(
  files: readonly string[],
): Promise<{ readonly ok: boolean; readonly stderr: string }> {
  const probePath = `${COVERAGE_DIR}/unreported.probe.test.ts`;
  await Deno.writeTextFile(probePath, renderProbeModule(files, COVERAGE_DIR));

  try {
    const probe = await run('deno', [
      'test',
      '--quiet',
      '--no-check',
      ...TEST_FLAGS,
      probePath,
      `--coverage=${COVERAGE_DIR}`,
      '--coverage-raw-data-only',
    ], false);
    return { ok: probe.success, stderr: probe.stderr };
  } finally {
    await Deno.remove(probePath).catch(() => {});
  }
}

function formatRow(row: CoverageRow, pass: boolean): string {
  return `| ${row.file.padEnd(58)} | ${row.branchPct.toFixed(1).padStart(8)} | ${
    row.functionPct.toFixed(1).padStart(10)
  } | ${row.linePct.toFixed(1).padStart(6)} | ${pass ? '✅' : '❌'}`;
}

async function main(): Promise<void> {
  const { selectors, base } = parseArgs(Deno.args);
  const members = readWorkspaceMembers(await Deno.readTextFile('deno.json'));

  const inputs = selectors.length > 0 ? selectors : await changedPaths(base);
  const resolved = resolveMembers(inputs, members);

  if (selectors.length > 0 && resolved.unmatched.length > 0) {
    console.error(
      `coverage-targeted: not a workspace member: ${resolved.unmatched.join(', ')}`,
    );
    console.error(
      `Members are named by path or short name, e.g. ${members.slice(0, 3).join(', ')}`,
    );
    Deno.exit(2);
  }

  if (resolved.members.length === 0) {
    console.log(
      selectors.length > 0
        ? 'coverage-targeted: nothing to measure.'
        : `coverage-targeted: no packages/* changes against ${base} — nothing to measure.\n` +
          'Pass member names explicitly to force a run.',
    );
    Deno.exit(0);
  }

  const gated = resolved.members;

  console.log(`coverage-targeted: ${gated.length} member(s)`);
  for (const member of gated) console.log(`  - ${member}`);
  console.log('');

  await Deno.remove(COVERAGE_DIR, { recursive: true }).catch(() => {});

  const test = await run('deno', [
    'test',
    ...TEST_FLAGS,
    ...gated,
    `--coverage=${COVERAGE_DIR}`,
    '--coverage-raw-data-only',
  ], true);
  if (!test.success) {
    console.error('\ncoverage-targeted: tests failed — coverage not reported.');
    Deno.exit(test.code);
  }

  // Report ONLY the selected members' src. Every other file the tests executed
  // (a dependency's `src`, a fixture) is measured but not gated here: it is
  // gated by its own package's run, and including it would report a partial
  // number as though it were that package's coverage.
  const include = `--include=/(${gated.join('|')})/src/`;
  const report = async (): Promise<readonly CoverageRow[]> => {
    const result = await run('deno', [
      'coverage',
      COVERAGE_DIR,
      include,
      '--exclude=/test/',
      '--exclude=/scripts/',
    ], false);
    if (!result.success) {
      console.error(result.stderr);
      Deno.exit(result.code === 0 ? 1 : result.code);
    }
    return parseMemberTable(result.stdout);
  };

  let rows = await report();
  if (rows.length === 0) {
    console.error(
      'coverage-targeted: no src rows measured — the selected members have no ' +
        'covered source. Check the member selection.',
    );
    Deno.exit(1);
  }

  // Completeness before thresholds: an absent row is not a passing row.
  const expected: string[] = [];
  for (const member of gated) expected.push(...await listSourceFiles(member));
  let unreported = findUnreportedFiles(expected, rows);
  if (unreported.length > 0) {
    const probe = await probeUnreported(unreported);
    if (!probe.ok) {
      console.error(
        `\ncoverage-targeted: could not load ${unreported.length} src file(s) that ` +
          'produced no coverage row, so their coverage is unknown:',
      );
      for (const file of unreported) console.error(`  - ${file}`);
      console.error(probe.stderr.trim());
      Deno.exit(1);
    }
    rows = await report();
    unreported = findUnreportedFiles(expected, rows);
  }

  const failing = belowBar(rows);
  console.log(`Per-file coverage (≥${THRESHOLD}% branch/function/line required):`);
  console.log(
    `| ${'File'.padEnd(58)} | Branch % | Function % | Line % |`,
  );
  console.log(`| ${'-'.repeat(58)} | -------- | ---------- | ------ |`);
  const failingSet = new Set(failing.map((row) => row.file));
  for (const row of rows) console.log(formatRow(row, !failingSet.has(row.file)));

  if (unreported.length > 0) {
    console.log(
      `\ncoverage-targeted: ${unreported.length} of ${expected.length} src file(s) ` +
        'emit no runtime code (type-only, erased at compile time), so there is ' +
        'nothing to measure in them:',
    );
    for (const file of unreported) console.log(`  - ${file}`);
  }

  if (failing.length > 0) {
    console.error(
      `\ncoverage-targeted: ${failing.length} file(s) below the ${THRESHOLD}% bar.`,
    );
    console.error(
      "A targeted run measures only these members' tests, and a targeted FAIL is " +
        "NOT sound: another package's tests may already cover these lines (a " +
        'targeted PASS is sound). Confirm with `deno task test:coverage` before ' +
        'writing tests for them.',
    );
    Deno.exit(1);
  }

  console.log(
    `\ncoverage-targeted: all ${expected.length} src file(s) accounted for — ` +
      `${rows.length} measured and ≥${THRESHOLD}% on all three, ` +
      `${unreported.length} with no runtime code.`,
  );
  console.log('Milestone hand-off still requires the full `deno task test:coverage`.');
}

if (import.meta.main) {
  await main();
}
