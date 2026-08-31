/**
 * API documentation generator and JSDoc linter for the Setu-TS workspace.
 *
 * This script provides two modes:
 * 1. **Generate mode** (default): Runs `deno doc --html` over all published package
 *    export targets and outputs the result to `docs/api/`.
 * 2. **Check mode** (`--check`): Runs `deno doc --lint` over the same targets and
 *    reports diagnostics using the ratchet policy from the milestone plan.
 *
 * The ratchet policy (§3.10 of the M38 plan):
 * - Diagnostics are partitioned by owning package path
 * - Any diagnostic in a CLEAN_PACKAGE fails the gate
 * - The total diagnostic count must not exceed DOC_LINT_BASELINE, and only
 *   when the running Deno matches DOC_LINT_BASELINE_DENO — the count is
 *   version-sensitive, so it is skipped rather than compared elsewhere
 * - If the count is BELOW baseline, the script instructs to lower the constant
 *
 * Usage:
 *   deno run --allow-read --allow-run --allow-write --allow-env scripts/generate-api-docs.ts
 *   deno run --allow-read --allow-run --allow-env scripts/generate-api-docs.ts --check
 *
 * @module
 */

// deno-lint-ignore-file no-console
import { PUBLISHED_PACKAGES } from './release-packages.ts';

/** The ten packages measured clean in the M38 plan baseline. */
export const CLEAN_PACKAGES = new Set([
  'common',
  'config-plugin',
  'cqrs-plugin',
  'exceptions',
  'http-security-plugin',
  'kernel',
  'scheduler-plugin',
  'full-stack-starter',
  'microservice-starter',
  'rest-starter',
]);

/**
 * The frozen baseline diagnostic count.
 *
 * Measured at 776 in the M38 plan (§1.1) against a tree cut before M56–M61.
 * Merging `origin/main` brought the JSDoc improvements those milestones shipped
 * and the real count fell to 775, so the ratchet did its job: it refused the
 * stale constant and named the new number. Lowered here rather than widened,
 * which is the whole point of a ratchet — debt paid down is locked in.
 *
 * M59 added four `missing-jsdoc` diagnostics (constructors carrying `@param`
 * tags but no description) and then removed five by writing the descriptions —
 * one of them on a constructor that predates the milestone. The ratchet refused
 * the run in BOTH directions, which is exactly its job.
 *
 * M70i (X6-3) lowered the count to 764: widening the GraphQL structural
 * facades to accept the real `graphql` package replaced a number of
 * `missing-jsdoc`/`private-type-ref` diagnostics on the old narrow facade
 * members with documented, `unknown`-typed ones.
 *
 * M83 raised the count to 753 for one `private-type-ref`:
 * `MetadataStore.mergeModule` references `ModuleMetadata`, which the plan
 * (§3.1) keeps internal because `IMetadataStore` deliberately hides concrete
 * values and no other package consumes module metadata. Its two siblings,
 * `mergeController`/`ControllerMetadata` and `mergeService`/`ServiceMetadata`,
 * are already in this baseline, so the only fixes available were to contradict
 * that decision or to split one member of a three-member family away from the
 * other two. Recorded rather than concealed, following M67.
 *
 * M79 re-measured against **Deno 2.9.6** when the CI pin moved off 2.9.5, and
 * the count fell to 497. That drop is the TOOLCHAIN, not paid-down debt — 2.9.6
 * reports far fewer diagnostics over an identical tree — so it is neither a
 * ratchet win nor a regression. It is recorded as a re-measurement so a later
 * reader does not mistake 753 -> 497 for 256 documentation fixes. Moving the
 * pin BACK to 2.9.5 requires re-measuring in the same change; the two constants
 * are only meaningful together.
 */
export const DOC_LINT_BASELINE = 497;

/**
 * The Deno version {@linkcode DOC_LINT_BASELINE} was measured on.
 *
 * `deno doc --lint` output is **version-sensitive**, and not marginally so: the
 * identical tree at `22bb5ca9` — the commit that froze the count at 752 —
 * reports **752** diagnostics on Deno 2.9.5 and **496** on 2.9.6, a 256
 * difference from the toolchain alone. So a count is only meaningful against
 * the version that produced the baseline, and comparing across versions is not
 * a stricter check, it is a meaningless one. The baseline now tracks the 2.9.6
 * side of that pair.
 *
 * Before this constant existed the ratchet had no way to know that, so a
 * developer on any other Deno saw a permanently red gate whose message told
 * them, in as many words, to `Update DOC_LINT_BASELINE ... to 496`. Following
 * that instruction would have made CI fail on the next push with *exceeds
 * baseline (496)*, inverting the gate and blocking every PR — a confident
 * instruction that breaks the build is worse than no check at all.
 *
 * Keep this in step with the `deno-version` pin in `.github/workflows/ci.yml`;
 * CI is the authoritative reading. When that pin moves, re-measure and update
 * BOTH constants in the same change.
 *
 * M79 moved that pin from 2.9.5 to 2.9.6 to match the version developers
 * actually run, which makes the ratchet **comparable locally** rather than
 * skipped. That matters beyond convenience: while the two disagreed, a local
 * run reported SKIPPED and a contributor could only learn a new diagnostic's
 * existence from a red CI job, then had to reproduce it through a Docker
 * container to find out which symbol it was. This milestone paid that cost once
 * and closed it.
 */
export const DOC_LINT_BASELINE_DENO = '2.9.6';

/** The outcome of comparing a diagnostic count against the frozen baseline. */
export interface BaselineVerdict {
  /** Whether this toolchain can be compared against the baseline at all. */
  readonly comparable: boolean;
  /** Findings that must fail the gate; empty when satisfied or skipped. */
  readonly findings: readonly string[];
  /** The line describing the outcome. Always present, never empty. */
  readonly report: string;
}

/**
 * Applies the ratchet policy to a diagnostic count.
 *
 * Extracted as a pure function so every branch — including the
 * version-mismatch skip, which cannot be reached on a machine matching the
 * baseline — is unit-testable without spawning `deno doc`.
 *
 * A version mismatch is deliberately **not** a failure. Failing would block
 * every contributor whose Deno differs from CI's pin, which is the defect this
 * seam exists to remove; the count is reported and the comparison skipped, and
 * CI remains authoritative. Clean-package findings are unaffected and still
 * fail, because those are specific, named diagnostics rather than a count
 * comparison.
 *
 * @param totalDiagnostics - Diagnostics parsed from this run.
 * @param denoVersion - The Deno version that produced them.
 * @param baseline - The frozen count. Defaults to {@linkcode DOC_LINT_BASELINE}.
 * @param baselineDenoVersion - The version the baseline was measured on.
 *   Defaults to {@linkcode DOC_LINT_BASELINE_DENO}.
 * @returns The verdict; `findings` is empty unless the gate must fail.
 */
export function evaluateBaselineRatchet(
  totalDiagnostics: number,
  denoVersion: string,
  baseline: number = DOC_LINT_BASELINE,
  baselineDenoVersion: string = DOC_LINT_BASELINE_DENO,
): BaselineVerdict {
  if (denoVersion !== baselineDenoVersion) {
    return {
      comparable: false,
      findings: [],
      report: `API JSDoc ratchet SKIPPED: not comparable on this toolchain. ` +
        `This run is Deno ${denoVersion} and produced ${totalDiagnostics} ` +
        `diagnostic(s); the baseline of ${baseline} was measured on Deno ` +
        `${baselineDenoVersion}, and \`deno doc --lint\` output differs by ` +
        `version. Do NOT update DOC_LINT_BASELINE from this run — CI (Deno ` +
        `${baselineDenoVersion}) is authoritative. To reproduce its reading: ` +
        `docker run --rm -v "$PWD":/w -w /w -e DENO_DIR=/tmp/dc ` +
        `denoland/deno:${baselineDenoVersion} run --allow-read --allow-run ` +
        `--allow-env --allow-write=/tmp/dc scripts/generate-api-docs.ts --check`,
    };
  }

  if (totalDiagnostics > baseline) {
    return {
      comparable: true,
      findings: [
        `Total JSDoc diagnostics (${totalDiagnostics}) exceeds baseline (${baseline}).`,
      ],
      report: `API JSDoc lint failed: ${totalDiagnostics} exceeds baseline ${baseline}.`,
    };
  }

  if (totalDiagnostics < baseline) {
    return {
      comparable: true,
      findings: [
        `Total JSDoc diagnostics (${totalDiagnostics}) is BELOW baseline (${baseline}).`,
        `Update DOC_LINT_BASELINE constant in scripts/generate-api-docs.ts to ${totalDiagnostics}.`,
      ],
      report: `API JSDoc lint failed: ${totalDiagnostics} is below baseline ${baseline}.`,
    };
  }

  return {
    comparable: true,
    findings: [],
    report: `API JSDoc lint passed: ${totalDiagnostics} known diagnostic(s) at baseline ` +
      `${baseline}, 0 in the ${CLEAN_PACKAGES.size} clean package(s).`,
  };
}

/** One parsed `deno doc --lint` diagnostic. */
export interface DocLintDiagnostic {
  rule: string;
  path: string;
  line?: number;
  message?: string;
}

/**
 * Reads the root deno.json and extracts the workspace array as the authoritative
 * workspace set. Returns paths relative to the repo root (e.g. "packages/common").
 */
export async function readWorkspaceMembers(
  fs: { readTextFile: (path: string) => Promise<string> },
): Promise<string[]> {
  const content = await fs.readTextFile('deno.json');
  const root = JSON.parse(content) as { workspace?: string[] };
  if (!root.workspace) {
    throw new Error('deno.json has no "workspace" field');
  }
  // Normalize: strip leading "./" if present
  return root.workspace.map((p) => p.startsWith('./') ? p.slice(2) : p).sort();
}

/**
 * Derives package short names from workspace paths.
 * - "packages/common" → "common"
 * - "packages/starters/rest-starter" → "rest-starter"
 */
export function workspaceName(path: string): string {
  const match = path.match(/^packages\/([^/]+)(?:\/([^/]+))?/);
  const first = match?.[1];
  const second = match?.[2];
  return (first === 'starters' && second) ? second : (first ?? path);
}

/**
 * Compares the authoritative workspace set against the publication inventory.
 * Returns exact missing/extra errors in both directions.
 */
export function reconcileWorkspaceVsPublication(
  workspace: string[],
  published: readonly string[],
): {
  readonly missingInPublication: string[];
  readonly missingInWorkspace: string[];
} {
  const wsSet = new Set(workspace);
  const pubSet = new Set(published);
  const missingInPublication = workspace.filter((p) => !pubSet.has(p));
  const missingInWorkspace = published.filter((p) => !wsSet.has(p));
  return { missingInPublication, missingInWorkspace };
}

/**
 * The classification of a manifest-read failure, so a caller can distinguish a
 * missing file from a malformed one rather than blanket-catching both into an
 * empty list.
 */
export type ManifestReadFailure =
  | { kind: 'read-failed'; path: string; cause: unknown }
  | { kind: 'malformed-manifest'; path: string; cause: unknown }
  | { kind: 'invalid-export-map'; path: string }
  | { kind: 'no-export-targets'; path: string }
  | { kind: 'missing-target'; path: string; target: string };

/**
 * Parses a deno.json manifest and extracts export targets, preserving exact
 * error classifications rather than blanket-catching all causes into an empty
 * list.
 *
 * Classifications:
 * - missing/unreadable manifest → `{ kind: 'read-failed' }` with path + cause;
 * - malformed JSON → `{ kind: 'malformed-manifest' }` with path + cause;
 * - invalid `exports` type/shape → `{ kind: 'invalid-export-map' }`;
 * - valid manifest with no local export targets → `{ kind: 'no-export-targets' }`.
 *
 * A missing declared target on disk is detected later by the caller (the
 * collector) and reported as `{ kind: 'missing-target' }`.
 *
 * @param manifestPath - Repository-relative path to the deno.json
 * @param fs - File system abstraction
 * @returns The export targets on success, or a failure classification
 */
export async function readManifestExports(
  manifestPath: string,
  fs: { readTextFile: (path: string) => Promise<string> },
): Promise<
  { ok: true; targets: string[] } | { ok: false; failure: ManifestReadFailure }
> {
  let content: string;
  try {
    content = await fs.readTextFile(manifestPath);
  } catch (cause) {
    return {
      ok: false,
      failure: { kind: 'read-failed', path: manifestPath, cause },
    };
  }

  let manifest: { exports?: unknown };
  try {
    manifest = JSON.parse(content) as { exports?: unknown };
  } catch (cause) {
    return {
      ok: false,
      failure: { kind: 'malformed-manifest', path: manifestPath, cause },
    };
  }

  // A valid manifest with no `exports` field at all, or an `exports` that is
  // neither a string nor an object, is an invalid export map.
  if (
    manifest.exports === undefined ||
    manifest.exports === null ||
    (typeof manifest.exports !== 'string' &&
      typeof manifest.exports !== 'object')
  ) {
    return {
      ok: false,
      failure: { kind: 'invalid-export-map', path: manifestPath },
    };
  }

  const targets = expandExportTargets(manifest.exports);
  if (targets.length === 0) {
    return {
      ok: false,
      failure: { kind: 'no-export-targets', path: manifestPath },
    };
  }

  return { ok: true, targets };
}

/**
 * Expands a deno.json export map into a flat list of local source targets.
 *
 * Handles string values (direct paths) and object values (with `.` key for the
 * root export and subpath keys). Normalizes paths to be workspace-relative.
 *
 * @param exports - The exports field from a deno.json
 * @returns Sorted, deduplicated list of local source paths
 */
export function expandExportTargets(exports: unknown): string[] {
  const targets: string[] = [];
  if (typeof exports === 'string') {
    targets.push(exports);
  } else if (exports !== null && typeof exports === 'object') {
    const exp = exports as Record<string, unknown>;

    for (const [, value] of Object.entries(exp)) {
      if (typeof value === 'string') {
        targets.push(value);
      } else if (value !== null && typeof value === 'object') {
        // Object-valued export: look for "." key (root export) and subpaths
        const obj = value as Record<string, unknown>;
        if (obj['.'] !== undefined && typeof obj['.'] === 'string') {
          targets.push(obj['.'] as string);
        }
        // Subpaths are also valid entry points
        for (const [subkey, subvalue] of Object.entries(obj)) {
          if (subkey !== '.' && typeof subvalue === 'string') {
            targets.push(subvalue);
          }
        }
      }
    }
  }

  // Normalize and deduplicate. Collapse any doubled ./ prefixes (e.g.
  // "././src/index.ts" → "./src/index.ts") so a corrupt manifest cannot
  // smuggle a doubled prefix through to the collector.
  const normalized = new Set<string>();
  for (const target of targets) {
    let normalizedPath = target;
    // Strip all leading ./ sequences, then re-add exactly one.
    while (normalizedPath.startsWith('./')) {
      normalizedPath = normalizedPath.slice(2);
    }
    normalizedPath = `./${normalizedPath}`;
    normalized.add(normalizedPath);
  }

  return [...normalized].sort();
}

/**
 * Collects API entry points from the root workspace and publication inventory.
 *
 * Independently reconciles workspace members against published packages, reads
 * each package's deno.json exports map, validates disk existence, and returns
 * sorted/deduplicated targets.
 *
 * @param fs - File system abstraction
 * @returns Sorted targets and package mapping
 */
export async function collectApiEntrypoints(
  fs: {
    readTextFile: (path: string) => Promise<string>;
    readDir: (path: string) => AsyncIterable<Deno.DirEntry>;
    stat: (path: string) => Promise<Deno.FileInfo>;
  },
): Promise<
  {
    targets: string[];
    targetsWithPackage: Array<{ target: string; pkg: string }>;
  }
> {
  // Read authoritative workspace from root deno.json
  const workspace = await readWorkspaceMembers(fs);

  // Independent reconciliation
  const reconciliation = reconcileWorkspaceVsPublication(
    workspace,
    PUBLISHED_PACKAGES,
  );
  if (reconciliation.missingInPublication.length > 0) {
    throw new Error(
      `Workspace members missing from PUBLISHED_PACKAGES: ${
        reconciliation.missingInPublication.join(', ')
      }`,
    );
  }
  if (reconciliation.missingInWorkspace.length > 0) {
    throw new Error(
      `Published packages missing from workspace: ${reconciliation.missingInWorkspace.join(', ')}`,
    );
  }

  const allTargets: string[] = [];
  const targetsWithPackage: Array<{ target: string; pkg: string }> = [];
  const packagesWithExports = new Set<string>();

  // Read each published package's manifest and expand exports, preserving
  // exact error classifications rather than blanket-catching all causes.
  for (const pkgPath of PUBLISHED_PACKAGES) {
    const manifestPath = `${pkgPath}/deno.json`;
    const result = await readManifestExports(manifestPath, fs);

    if (!result.ok) {
      const failure = result.failure;
      switch (failure.kind) {
        case 'read-failed':
          throw new Error(
            `Cannot read manifest ${failure.path}: ${
              (failure.cause as Error)?.message ?? String(failure.cause)
            }`,
          );
        case 'malformed-manifest':
          throw new Error(
            `Manifest ${failure.path} is malformed JSON: ${
              (failure.cause as Error)?.message ?? String(failure.cause)
            }`,
          );
        case 'invalid-export-map':
          throw new Error(
            `Manifest ${failure.path} has an invalid exports map (must be a string or object)`,
          );
        case 'no-export-targets':
          throw new Error(
            `Package ${pkgPath} has no export targets in its deno.json manifest`,
          );
        case 'missing-target':
          throw new Error(
            `Export target ${failure.target} declared in ${failure.path} does not exist on disk`,
          );
      }
    }

    const targets = result.targets;

    // Validate every target exists on disk before including
    for (const target of targets) {
      const workspaceTarget = target.startsWith('./')
        ? `${pkgPath}/${target.slice(2)}`
        : `${pkgPath}/${target}`;
      try {
        await fs.stat(workspaceTarget);
        allTargets.push(workspaceTarget);
      } catch {
        throw new Error(
          `Export target ${workspaceTarget} does not exist on disk`,
        );
      }
    }

    const pkgName = workspaceName(pkgPath);
    packagesWithExports.add(pkgName);
    for (const target of targets) {
      const workspaceTarget = target.startsWith('./')
        ? `${pkgPath}/${target.slice(2)}`
        : `${pkgPath}/${target}`;
      targetsWithPackage.push({ target: workspaceTarget, pkg: pkgName });
    }
  }

  // Sort and deduplicate
  const uniqueTargets = [...new Set(allTargets)].sort();

  // Rebuild targetsWithPackage preserving all packages
  const uniqueTargetsWithPackage: Array<{ target: string; pkg: string }> = [];
  const seenEntries = new Set<string>();
  for (const entry of targetsWithPackage) {
    const key = `${entry.pkg}:${entry.target}`;
    if (!seenEntries.has(key)) {
      seenEntries.add(key);
      uniqueTargetsWithPackage.push(entry);
    }
  }

  return {
    targets: uniqueTargets,
    targetsWithPackage: uniqueTargetsWithPackage,
  };
}

/**
 * Builds the arguments array for `deno doc` command.
 *
 * @param targets - Array of local export targets
 * @param mode - "generate" for HTML output, "check" for lint-only
 * @param outputDir - Output directory for HTML generation
 * @returns Arguments array for Deno.Command
 */
export function buildDenoDocArgs(
  targets: readonly string[],
  mode: 'generate' | 'check',
  outputDir: string,
): string[] {
  // `--quiet` suppresses Deno's own progress output. It is load-bearing, not
  // tidiness: on a COLD npm cache `deno doc` writes `Download https://...` to
  // stderr for every npm specifier the graph reaches (drizzle-orm, @prisma/
  // client, …). The classifier treats unrecognized stderr as a fatal child
  // error, so the gate failed on CI — which always has a cold cache — while
  // passing on every developer machine, which does not. Measured: 2 Download
  // lines without the flag under `--reload=npm:drizzle-orm`, 0 with it.
  const args: string[] = ['doc', '--quiet'];

  if (mode === 'generate') {
    args.push('--html', '--output=' + outputDir, '--name=Setu-TS');
  } else {
    args.push('--lint');
  }

  args.push(...targets);
  return args;
}

/**
 * Parses `deno doc --lint` diagnostic output into structured records.
 *
 * Handles both the plain text format and ANSI-coloured variants.
 *
 * @param output - The stderr/stdout from `deno doc --lint`
 * @returns Parsed diagnostics
 */
export function parseDocLintDiagnostics(output: string): DocLintDiagnostic[] {
  const diagnostics: DocLintDiagnostic[] = [];
  // Strip ANSI escape codes before parsing
  // Use a function that avoids control characters in the regex literal
  const ansiStripRe = new RegExp(
    String.fromCharCode(0x1b) + '\\[[0-9;]*m',
    'g',
  );
  const stripped = output.replace(ansiStripRe, '');
  const lines = stripped.split('\n');

  // deno doc --lint output format:
  // error[rule]: message
  //   --> path:line:col
  // We need to pair error lines with their --> lines
  let currentRule: string | null = null;
  let currentMessage: string | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] as string;

    // Match error line: "error[rule]: message"
    const errorMatch = /^error\[([^\]]+)\]:\s*(.*)$/.exec(line);
    if (errorMatch) {
      currentRule = errorMatch[1];
      currentMessage = errorMatch[2].trim();
      continue;
    }

    // Match path line: "  --> path:line:col"
    const pathMatch = /^\s*-->\s*(.+):(\d+):(\d+)\s*$/.exec(line);
    if (pathMatch && currentRule) {
      diagnostics.push({
        rule: currentRule,
        path: pathMatch[1],
        line: parseInt(pathMatch[2], 10),
        message: currentMessage ?? '',
      });
      currentRule = null;
      currentMessage = null;
    }
  }

  return diagnostics;
}

/**
 * Normalizes a diagnostic path to be repository-relative.
 *
 * Handles both absolute paths (from Deno's output) and relative paths.
 * Strips any leading workspace prefix to produce a consistent path format.
 *
 * @param path - The raw path from a diagnostic
 * @returns Normalized repository-relative path
 */
export function normalizeDiagnosticPath(path: string): string {
  // Strip leading ./ if present
  let normalized = path.startsWith('./') ? path.slice(2) : path;

  // Handle absolute paths by extracting the repo-relative portion
  // Deno may output paths like "/home/user/project/packages/..."
  // We want "packages/..."
  const packagesMatch = normalized.match(/\/packages\/(.+)$/);
  if (packagesMatch) {
    normalized = `packages/${packagesMatch[1]}`;
  }

  return normalized;
}

/**
 * Partitions diagnostics by owning package.
 *
 * Normalizes absolute and relative paths to repository-relative form before
 * classifying by clean-package ownership.
 *
 * @param diagnostics - Parsed diagnostics from parseDocLintDiagnostics
 * @returns Partitioned diagnostics
 */
export function partitionDiagnostics(
  diagnostics: readonly DocLintDiagnostic[],
): {
  readonly cleanPackageFindings: readonly DocLintDiagnostic[];
  readonly knownDebt: readonly DocLintDiagnostic[];
} {
  const cleanPackageFindings: DocLintDiagnostic[] = [];
  const knownDebt: DocLintDiagnostic[] = [];

  for (const diag of diagnostics) {
    // Normalize the path to repository-relative form
    const normalizedPath = normalizeDiagnosticPath(diag.path);

    // Extract package name from path like "packages/<name>/..."
    // Special case: starters are under packages/starters/<name>/...
    const match = normalizedPath.match(/^packages\/([^/]+)(?:\/([^/]+))?/);
    if (!match) {
      knownDebt.push(diag);
      continue;
    }

    const firstSegment = match[1];
    const secondSegment = match[2];
    // If first segment is "starters", the actual package name is the second segment
    const packageName = firstSegment === 'starters' && secondSegment ? secondSegment : firstSegment;
    if (CLEAN_PACKAGES.has(packageName)) {
      cleanPackageFindings.push(diag);
    } else {
      knownDebt.push(diag);
    }
  }

  return { cleanPackageFindings, knownDebt };
}

/** The documented lint-debt exit code: `deno doc --lint` exits 1 when it reports lint diagnostics. */
export const DOC_LINT_EXIT_CODE = 1;

/**
 * The exact summary line `deno doc --lint` prints when it exits non-zero due
 * to lint debt (ANSI-stripped). Used to recognize — not suppress — the summary.
 */
const LINT_SUMMARY_PATTERN = /^(?:error:\s*)?Found \d+ documentation lint errors\.?$/;

/**
 * A line that is a lint diagnostic opener: `error[rule]: message`. The bracket
 * after `error` is what distinguishes a lint diagnostic from a fatal `error:`.
 */
const LINT_DIAGNOSTIC_PATTERN = /^error\[[^\]]+\]:/;

/**
 * A `--> path:line:col` continuation line belonging to a lint diagnostic.
 */
const LINT_LOCATION_PATTERN = /^\s*-->\s/;

/**
 * Code context lines from `deno doc --lint` showing the source around the
 * diagnostic. Two forms: pipe-indented lines (` | source...`) and line-number
 * prefixed lines (`14 | source...`). Both are part of the recognized lint
 * diagnostic output and must be stripped before residual analysis.
 */
const LINT_CODE_CONTEXT_PATTERN = /^\s*(\d+\s+)?\|\s/;

/**
 * Hint lines from `deno doc --lint` (e.g. `= hint: make the...`).
 */
const LINT_HINT_PATTERN = /^\s*=\s*hint:/;

/**
 * Deno's own progress/informational lines, which are not lint output and not
 * errors.
 *
 * `deno doc` writes `Download https://registry.npmjs.org/...` to stderr once
 * per npm specifier whenever the cache is cold. CI is always cold and a
 * developer machine rarely is, so treating these as fatal residual made the
 * gate pass locally and fail on every clean runner. `--quiet` now suppresses
 * them at the source (see {@linkcode buildDenoDocArgs}); this pattern is the
 * second line of defence, so a future Deno that prints progress despite
 * `--quiet` degrades to a correct result rather than a false fatal. It is
 * deliberately anchored and limited to Deno's known prefixes — a blanket
 * "ignore unrecognized output" rule would hide the real failures this
 * classifier exists to catch.
 */
const DENO_PROGRESS_PATTERN = /^(?:Download|Warning|Check|Initialize|Blocking)\s/;

/**
 * Info lines from `deno doc --lint` (e.g. `info: to ensure documentation...`).
 */
const LINT_INFO_PATTERN = /^\s*info:/;

/**
 * Cross-reference annotation lines (e.g. `- this is the referenced type`).
 */
const LINT_REF_ANNOTATION_PATTERN = /^\s*-/;

/**
 * Classifies the raw child-process output of `deno doc --lint` into one of:
 * - `'lint-debt'` — the documented ratchet-eligible shape (exit 1, only lint
 *   diagnostics and the summary line, no independent fatal/error/stack text);
 * - `'fatal'` — an unexpected failure (any nonzero code other than the lint
 *   exit code, OR the lint exit code with independent fatal/error/stack text
 *   that the summary does not account for).
 *
 * The classification is structural: it removes the recognized lint records
 * (diagnostic openers, their `-->` location lines, and the summary line) from
 * each ANSI-stripped stream and then rejects any remaining `error:` /
 * `at ` (stack) / non-empty content. A lint diagnostic whose message contains
 * the literal `error: ` is NOT falsely fatal, because the opener line matches
 * `error[rule]:` and is removed before the residual scan.
 *
 * @param code - The child exit code
 * @param stdout - Raw stdout
 * @param stderr - Raw stderr
 * @returns The classification and the ANSI-stripped streams
 */
export function classifyChildResult(
  code: number,
  stdout: string,
  stderr: string,
): {
  kind: 'success' | 'lint-debt' | 'fatal';
  stdoutStripped: string;
  stderrStripped: string;
} {
  const ansiStripRe = new RegExp(
    String.fromCharCode(0x1b) + '\\[[0-9;]*m',
    'g',
  );
  const stdoutStripped = stdout.replace(ansiStripRe, '');
  const stderrStripped = stderr.replace(ansiStripRe, '');

  if (code === 0) {
    return {
      kind: stdoutStripped.trim() === '' && stderrStripped.trim() === '' ? 'success' : 'fatal',
      stdoutStripped,
      stderrStripped,
    };
  }

  // An unexpected nonzero code (including code 2) is always fatal, regardless
  // of stream content — it is not the documented lint-debt exit shape.
  if (code !== 0 && code !== DOC_LINT_EXIT_CODE) {
    return { kind: 'fatal', stdoutStripped, stderrStripped };
  }

  // For the ratchet-eligible code (1), consume complete lint records. A
  // continuation-like line is recognized only while attached to an opener;
  // otherwise it remains fatal residual output.
  for (const stream of [stdoutStripped, stderrStripped]) {
    const lines = stream.split('\n');
    const residual: string[] = [];
    let inDiagnostic = false;
    let diagnosticHasLocation = false;
    let diagnosticCount = 0;
    let summaryCount: number | undefined;
    for (const line of lines) {
      if (LINT_DIAGNOSTIC_PATTERN.test(line)) {
        if (inDiagnostic && !diagnosticHasLocation) {
          residual.push('malformed diagnostic');
        }
        inDiagnostic = true;
        diagnosticHasLocation = false;
        diagnosticCount += 1;
        continue;
      }
      if (LINT_SUMMARY_PATTERN.test(line)) {
        if (inDiagnostic && !diagnosticHasLocation) {
          residual.push('malformed diagnostic');
        }
        inDiagnostic = false;
        const count = line.match(/Found (\d+) documentation/)?.[1];
        summaryCount = count === undefined ? undefined : Number(count);
        continue;
      }
      if (
        inDiagnostic &&
        (line.trim().length === 0 || LINT_LOCATION_PATTERN.test(line) ||
          LINT_CODE_CONTEXT_PATTERN.test(line) ||
          LINT_HINT_PATTERN.test(line) ||
          LINT_INFO_PATTERN.test(line) ||
          LINT_REF_ANNOTATION_PATTERN.test(line))
      ) {
        if (LINT_LOCATION_PATTERN.test(line)) diagnosticHasLocation = true;
        continue;
      }
      if (line.trim().length === 0) continue;
      // Deno's own progress output is neither a diagnostic nor an error.
      if (DENO_PROGRESS_PATTERN.test(line)) continue;
      if (inDiagnostic && !diagnosticHasLocation) {
        residual.push('malformed diagnostic');
      }
      inDiagnostic = false;
      residual.push(line);
    }
    if (inDiagnostic && !diagnosticHasLocation) {
      residual.push('malformed diagnostic');
    }
    if (summaryCount !== undefined && summaryCount !== diagnosticCount) {
      residual.push('diagnostic summary count mismatch');
    }
    const residualText = residual.join('\n').trim();
    // After removing recognized diagnostics and the exact known summary, every
    // non-whitespace residual in stdout or stderr is fatal. An exit-1 child
    // with exactly baseline diagnostics plus "warning: child aborted after
    // partial output" must fail. Exit zero is modeled as success (lint-debt).
    if (residualText.length > 0) {
      return { kind: 'fatal', stdoutStripped, stderrStripped };
    }
  }

  return { kind: 'lint-debt', stdoutStripped, stderrStripped };
}

/**
 * Runs the API documentation generation.
 *
 * @param mode - "generate" or "check"
 * @param outputDir - Output directory for HTML generation
 * @param fs - File system abstraction
 * @param cmd - Command execution abstraction
 * @param denoVersion - The running Deno version, injectable so ratchet tests
 *   are deterministic rather than dependent on the developer's toolchain.
 *   Defaults to the live `Deno.version.deno`.
 * @returns Exit code and findings
 */
export async function runApiDocs(
  mode: 'generate' | 'check',
  outputDir: string,
  fs: {
    readTextFile: (path: string) => Promise<string>;
    readDir: (path: string) => AsyncIterable<Deno.DirEntry>;
    stat: (path: string) => Promise<Deno.FileInfo>;
    remove: (path: string, options?: { recursive: boolean }) => Promise<void>;
    mkdir: (path: string, options?: { recursive: boolean }) => Promise<void>;
  },
  cmd: {
    run: (
      args: string[],
    ) => Promise<{ code: number; stdout: string; stderr: string }>;
  },
  denoVersion: string = Deno.version.deno,
): Promise<{ code: number; findings: string[] }> {
  const findings: string[] = [];

  // Collect entry points
  const { targets } = await collectApiEntrypoints(fs);

  // Build and run deno doc command
  const args = buildDenoDocArgs(targets, mode, outputDir);

  if (mode === 'generate') {
    // Remove stale output
    try {
      await fs.remove(outputDir, { recursive: true });
    } catch {
      // Ignore if doesn't exist
    }

    await fs.mkdir(outputDir, { recursive: true });
  }

  const result = await cmd.run(['deno', ...args]);

  if (mode === 'check') {
    // deno doc --lint outputs diagnostics to stderr; exit code 1 is the
    // documented lint-debt exit shape. We classify the child result
    // structurally: only the lint-debt shape is ratchet-eligible; every
    // unexpected nonzero code (including code 2) or any independent
    // fatal/error/stack output in either ANSI-stripped stream is fatal.
    const classification = classifyChildResult(
      result.code,
      result.stdout,
      result.stderr,
    );

    if (classification.kind === 'success') {
      return { code: 0, findings };
    }

    if (classification.kind === 'fatal') {
      // Preserve the raw stdout/stderr (not ANSI-stripped) so the failure is
      // actionable. A fatal must never be converted into a baseline-count
      // message or success — even if stderr also contains zero, partial, or
      // exactly baseline-sized parseable diagnostics.
      findings.push(`deno doc --lint failed with exit code ${result.code}`);
      if (result.stderr) {
        findings.push(`stderr: ${result.stderr}`);
      }
      if (result.stdout) {
        findings.push(`stdout: ${result.stdout}`);
      }
      console.error('API JSDoc lint check failed (fatal child error):');
      for (const finding of findings) {
        console.error(`  ${finding}`);
      }
      return { code: result.code === 0 ? 1 : result.code, findings };
    }

    // Ratchet-eligible: parse diagnostics and apply the clean-package + baseline policy.
    const diagnostics = parseDocLintDiagnostics(result.stderr);
    const { cleanPackageFindings } = partitionDiagnostics(diagnostics);

    if (cleanPackageFindings.length > 0) {
      findings.push(
        `Found ${cleanPackageFindings.length} JSDoc diagnostic(s) in CLEAN packages:`,
      );
      for (const diag of cleanPackageFindings) {
        findings.push(
          `  - [${diag.rule}] ${diag.path}:${diag.line} ${diag.message}`,
        );
      }
    }

    const verdict = evaluateBaselineRatchet(diagnostics.length, denoVersion);
    findings.push(...verdict.findings);

    if (findings.length > 0) {
      console.error('API JSDoc lint check failed:');
      for (const finding of findings) {
        console.error(`  ${finding}`);
      }
      return { code: 1, findings };
    }

    // Report the ratchet state on success. A gate that passes in total silence
    // is indistinguishable from a gate that did nothing, and this one's whole
    // job is to make a known, frozen debt VISIBLE rather than merely tolerated.
    // A skipped comparison is reported just as loudly, on stderr, so an
    // unusable reading is never mistaken for a clean one.
    if (verdict.comparable) {
      console.log(verdict.report);
    } else {
      console.error(verdict.report);
    }
  } else {
    // Propagate child-process failures: non-zero exit code is a failure
    if (result.code !== 0) {
      findings.push(`deno doc failed with exit code ${result.code}`);
      if (result.stderr) {
        findings.push(`stderr: ${result.stderr}`);
      }
      if (result.stdout) {
        findings.push(`stdout: ${result.stdout}`);
      }
      return { code: result.code, findings };
    }

    // Verify output was generated
    try {
      await fs.stat(`${outputDir}/index.html`);
    } catch {
      findings.push(`Generated output not found at ${outputDir}/index.html`);
      return { code: 1, findings };
    }
  }

  return { code: 0, findings };
}

/** Main entry point. */
async function main(): Promise<void> {
  const args = Deno.args;
  const mode = args.includes('--check') ? 'check' : 'generate';
  const outputDir = 'docs/api';

  const fs = {
    readTextFile: (path: string) => Deno.readTextFile(path),
    readDir: (path: string) => Deno.readDir(path),
    stat: (path: string) => Deno.stat(path),
    remove: (path: string, options?: { recursive: boolean }) => Deno.remove(path, options),
    mkdir: (path: string, options?: { recursive: boolean }) => Deno.mkdir(path, options),
  };

  const cmd = {
    run: (command: string[]) => {
      const process = new Deno.Command(command[0]!, {
        args: command.slice(1),
        stdout: 'piped',
        stderr: 'piped',
      });
      return process.output().then((output) => ({
        code: output.code,
        stdout: new TextDecoder().decode(output.stdout),
        stderr: new TextDecoder().decode(output.stderr),
      }));
    },
  };

  const { code } = await runApiDocs(mode, outputDir, fs, cmd);

  if (code !== 0) {
    Deno.exit(code);
  }
}

if (import.meta.main) {
  await main();
}
