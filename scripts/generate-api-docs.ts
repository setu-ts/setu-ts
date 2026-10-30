/**
 * Generate the website's API HTML and validate repository JSDoc with TypeDoc.
 * The check ratchet is measured on the pinned TypeDoc version with every published
 * package explicitly requiring documentation. Any diagnostic in a clean package,
 * an increased count, a decreased count without a baseline update, or a version mismatch fails.
 * @module
 */

import { run as runProcess } from './lib/run.ts';
import { type Stats } from 'node:fs';
import { readFile, stat, rm, mkdir } from 'node:fs/promises';
/* eslint-disable no-console -- repository documentation gate */
import { workspaceMembers } from './lib/workspace.ts';
import { PUBLISHED_PACKAGES } from './release-packages.ts';

/**
 * Packages with zero in-scope TypeDoc diagnostics (see {@linkcode inRatchetScope}),
 * measured in M111e2. A superset of the set `deno doc --lint` kept clean.
 */
export const CLEAN_PACKAGES = new Set([
  'auth-plugin',
  'common',
  'config-plugin',
  'cqrs-plugin',
  'create',
  'decorator-plugin',
  'di-plugin',
  'diagnostics-plugin',
  'exceptions',
  'feature-flags-plugin',
  'full-stack-starter',
  'http-security-plugin',
  'idempotency-plugin',
  'kernel',
  'localization-plugin',
  'logger-plugin',
  'microservice-starter',
  'openapi-plugin',
  'realtime-backplane-plugin',
  'resilience-plugin',
  'rest-starter',
  'scheduler-plugin',
  'secrets-plugin',
  'service-discovery-plugin',
  'session-plugin',
  'sse-plugin',
  'static-plugin',
  'telemetry-plugin',
  'validation-plugin',
  'view-plugin',
  'worker-pool-plugin',
]);
/**
 * In-scope diagnostics on TypeDoc 0.28.20 (554 before excluding anonymous
 * object-type members); the previous Deno count is not comparable.
 */
export const DOC_LINT_BASELINE = 236;
/** Exact TypeDoc version on which the diagnostic debt was measured. */
export const DOC_LINT_BASELINE_TYPEDOC = '0.28.20';

/** Ratchet verdict, including whether the toolchain is comparable. */
export interface BaselineVerdict {
  /** Whether this toolchain can be compared against the baseline at all. */
  readonly comparable: boolean;
  /** Findings that must fail the gate; empty when the ratchet is satisfied. */
  readonly findings: readonly string[];
  /** The line describing the outcome. Always present, never empty. */
  readonly report: string;
}

/**
 * Compare only on the pinned TypeDoc version. A mismatch fails without count advice.
 * Both an increase and a decrease require an explicit baseline decision.
 * @param totalDiagnostics - Diagnostic count from this run
 * @param typedocVersion - TypeDoc version producing the diagnostics
 * @param baseline - Frozen count
 * @param baselineTypedocVersion - Version on which the baseline was measured
 * @returns Whether the gate must fail and the explanation
 */
export function evaluateBaselineRatchet(
  totalDiagnostics: number,
  typedocVersion: string,
  baseline: number = DOC_LINT_BASELINE,
  baselineTypedocVersion: string = DOC_LINT_BASELINE_TYPEDOC,
): BaselineVerdict {
  if (typedocVersion !== baselineTypedocVersion) {
    return {
      comparable: false,
      findings: [
        `TypeDoc version ${typedocVersion} does not match the pinned ${baselineTypedocVersion}.`,
      ],
      report: `API JSDoc ratchet failed: TypeDoc version mismatch (${typedocVersion}, expected ${baselineTypedocVersion}). Do NOT update DOC_LINT_BASELINE from this run.`,
    };
  }

  if (totalDiagnostics > baseline) {
    return {
      comparable: true,
      findings: [`Total JSDoc diagnostics (${totalDiagnostics}) exceeds baseline (${baseline}).`],
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
    report:
      `API JSDoc lint passed: ${totalDiagnostics} known diagnostic(s) at baseline ` +
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
 * Reads pnpm-workspace.yaml and extracts framework members as the authoritative
 * workspace set. Returns paths relative to the repo root (e.g. "packages/common").
 */
export function readWorkspaceMembers(fs: {
  readTextFile: (path: string) => Promise<string>;
}): Promise<string[]> {
  return workspaceMembers('.', fs.readTextFile);
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
  return first === 'starters' && second ? second : (first ?? path);
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
): Promise<{ ok: true; targets: string[] } | { ok: false; failure: ManifestReadFailure }> {
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
    (typeof manifest.exports !== 'string' && typeof manifest.exports !== 'object')
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
export async function collectApiEntrypoints(fs: {
  readTextFile: (path: string) => Promise<string>;
  stat: (path: string) => Promise<Pick<Stats, 'isFile' | 'isDirectory' | 'size'>>;
}): Promise<{
  targets: string[];
  targetsWithPackage: Array<{ target: string; pkg: string }>;
}> {
  // Read authoritative workspace from root deno.json
  const workspace = await readWorkspaceMembers(fs);

  // Independent reconciliation
  const reconciliation = reconcileWorkspaceVsPublication(workspace, PUBLISHED_PACKAGES);
  if (reconciliation.missingInPublication.length > 0) {
    throw new Error(
      `Workspace members missing from PUBLISHED_PACKAGES: ${reconciliation.missingInPublication.join(
        ', ',
      )}`,
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
          throw new Error(`Package ${pkgPath} has no export targets in its deno.json manifest`);
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
        throw new Error(`Export target ${workspaceTarget} does not exist on disk`);
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
 * Builds the TypeDoc arguments for HTML generation or the lint-only check.
 *
 * @param targets - Array of local export targets
 * @param mode - "generate" for HTML output, "check" for lint-only
 * @param outputDir - Output directory for HTML generation
 * @returns Arguments for the selected documentation engine
 */
export function buildApiDocArgs(
  targets: readonly string[],
  mode: 'generate' | 'check',
  outputDir: string,
): string[] {
  if (mode === 'check') {
    return [
      'node_modules/typedoc/bin/typedoc',
      '--options',
      'typedoc.check.json',
      '--entryPoints',
      ...targets,
    ];
  }
  return [
    'node_modules/typedoc/bin/typedoc',
    '--options',
    'typedoc.check.json',
    '--emit',
    'docs',
    '--out',
    outputDir,
    '--name',
    'Setu-TS',
    // The API index lists modules. TypeDoc would otherwise render the repository README there,
    // which the website already serves as its home page; its 475 KB logo was the API index's
    // largest contentful paint (5.1 s under Lighthouse's mobile throttling).
    '--readme',
    'none',
    // Each module is a leaf of the sidebar: its page still lists every symbol, but the sidebar no
    // longer holds every symbol of every package. Expanded, main.js built 15,907 DOM elements on
    // every page, which put the API index's Lighthouse performance at 0.82-0.87 on CI runners
    // against the website's 0.9 budget.
    ...targets.flatMap((target) => ['--navigationLeaves', apiModuleName(target)]),
    '--validation.notDocumented',
    'false',
    '--validation.notExported',
    'false',
    '--entryPoints',
    ...targets,
  ];
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
  if (output.includes('[warning]')) return parseTypedocDiagnostics(output);
  const diagnostics: DocLintDiagnostic[] = [];
  // Strip ANSI escape codes before parsing
  // Use a function that avoids control characters in the regex literal
  const ansiStripRe = new RegExp(String.fromCharCode(0x1b) + '\\[[0-9;]*m', 'g');
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
export function partitionDiagnostics(diagnostics: readonly DocLintDiagnostic[]): {
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
 * them at the source (see {@linkcode buildApiDocArgs}); this pattern is the
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
  const ansiStripRe = new RegExp(String.fromCharCode(0x1b) + '\\[[0-9;]*m', 'g');
  const stdoutStripped = stdout.replace(ansiStripRe, '');
  const stderrStripped = stderr.replace(ansiStripRe, '');

  if (/\[(?:warning|error)\]/.test(stdoutStripped + stderrStripped)) {
    const combined = stdoutStripped + '\n' + stderrStripped;
    const diagnostics = parseTypedocDiagnostics(combined);
    const summaries = [
      ...combined.matchAll(/\[(?:warning|error)\] Found (\d+) errors? and (\d+) warnings?/g),
    ];
    const complete =
      summaries.length === 1 &&
      Number(summaries[0]![1]) === 0 &&
      Number(summaries[0]![2]) === diagnostics.length;
    const residual = combined
      .split('\n')
      .filter((line) => line.trim() && !line.includes('[warning]') && !/^\s*\d+\s/.test(line));
    const owned = diagnostics.every((diag) => diag.path.startsWith('packages/'));
    return {
      kind: code === 0 && complete && owned && !residual.length ? 'lint-debt' : 'fatal',
      stdoutStripped,
      stderrStripped,
    };
  }
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
        (line.trim().length === 0 ||
          LINT_LOCATION_PATTERN.test(line) ||
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
 * @param typedocVersion - The running TypeDoc version, injectable so ratchet tests
 *   are deterministic rather than dependent on the developer's toolchain.
 *   Defaults to `Application.VERSION` from the installed TypeDoc.
 * @returns Exit code and findings
 */
export async function runApiDocs(
  mode: 'generate' | 'check',
  outputDir: string,
  fs: {
    readTextFile: (path: string) => Promise<string>;
    stat: (path: string) => Promise<Pick<Stats, 'isFile' | 'isDirectory' | 'size'>>;
    remove: (path: string, options?: { recursive: boolean }) => Promise<unknown>;
    mkdir: (path: string, options?: { recursive: boolean }) => Promise<unknown>;
  },
  cmd: {
    run: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  },
  typedocVersion?: string,
): Promise<{ code: number; findings: string[] }> {
  const findings: string[] = [];

  // Collect entry points
  const { targets } = await collectApiEntrypoints(fs);

  // Build the selected documentation command
  const args = buildApiDocArgs(targets, mode, outputDir);

  if (mode === 'generate') {
    // Remove stale output
    try {
      await fs.remove(outputDir, { recursive: true });
    } catch {
      // Ignore if doesn't exist
    }

    await fs.mkdir(outputDir, { recursive: true });
  }

  const result = await cmd.run([process.execPath, ...args]);

  if (mode === 'check') {
    // deno doc --lint outputs diagnostics to stderr; exit code 1 is the
    // documented lint-debt exit shape. We classify the child result
    // structurally: only the lint-debt shape is ratchet-eligible; every
    // unexpected nonzero code (including code 2) or any independent
    // fatal/error/stack output in either ANSI-stripped stream is fatal.
    const classification = classifyChildResult(result.code, result.stdout, result.stderr);

    if (classification.kind === 'fatal') {
      // Preserve the raw stdout/stderr (not ANSI-stripped) so the failure is
      // actionable. A fatal must never be converted into a baseline-count
      // message or success — even if stderr also contains zero, partial, or
      // exactly baseline-sized parseable diagnostics.
      findings.push(`typedoc validation failed with exit code ${result.code}`);
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
    const diagnostics = parseDocLintDiagnostics(result.stdout + '\n' + result.stderr).filter(
      inRatchetScope,
    );
    const { cleanPackageFindings } = partitionDiagnostics(diagnostics);

    if (cleanPackageFindings.length > 0) {
      findings.push(`Found ${cleanPackageFindings.length} JSDoc diagnostic(s) in CLEAN packages:`);
      for (const diag of cleanPackageFindings) {
        findings.push(`  - [${diag.rule}] ${diag.path}:${diag.line} ${diag.message}`);
      }
    }

    const verdict = evaluateBaselineRatchet(
      diagnostics.length,
      typedocVersion ?? (await import('typedoc')).Application.VERSION,
    );
    findings.push(...verdict.findings);

    if (findings.length > 0) {
      console.error('API JSDoc lint check failed:');
      for (const finding of findings) {
        console.error(`  ${finding}`);
      }
      return { code: 1, findings };
    }

    // Passing debt remains visible rather than indistinguishable from a no-op.
    console.log(verdict.report);
  } else {
    // Propagate child-process failures: non-zero exit code is a failure
    if (result.code !== 0) {
      findings.push(`typedoc HTML failed with exit code ${result.code}`);
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
      for (const target of targets) await fs.stat(`${outputDir}/${apiModulePage(target)}`);
    } catch {
      findings.push(`Generated output missing: ${outputDir}/index.html or a required module page`);
      return { code: 1, findings };
    }
  }

  return { code: 0, findings };
}

/** Main entry point. */
export async function runApiDocsMain(
  args: readonly string[] = process.argv.slice(2),
): Promise<number> {
  const mode = args.includes('--check') ? 'check' : 'generate';
  const outputDir = 'docs/api';

  const fs = {
    readTextFile: (path: string) => readFile(path, 'utf8'),
    stat,
    remove: rm,
    mkdir,
  };

  // TypeDoc 0.28.20's dist/cli.js calls process.exit() immediately after logging
  // its summary. Pipes can discard queued writes when the reader is descheduled.
  // Regular-file stdio makes Node's writes synchronous; read only after close.
  const cmd = {
    run: (command: string[]) => runProcess(command[0]!, command.slice(1), { capture: 'file' }),
  };

  const { code } = await runApiDocs(mode, outputDir, fs, cmd);

  if (code !== 0 || mode === 'generate') return code;
  return (await runApiDocs('generate', outputDir, fs, cmd)).code;
}

if (import.meta.main) process.exitCode = await runApiDocsMain();

/**
 * Whether a diagnostic is one the ratchet counts. TypeDoc also reports a missing
 * comment on each member of an anonymous object type (`Foo.__type.bar`), which
 * `deno doc --lint` never required; counting those would change the rule this
 * gate carries over rather than port it, so they are out of scope.
 */
export function inRatchetScope(diagnostic: DocLintDiagnostic): boolean {
  return !(diagnostic.rule === 'notDocumented' && /\.__type\b/.test(diagnostic.message ?? ''));
}

/** Parse TypeDoc's pinned CLI warning dialect, retaining an owner for every diagnostic. */
export function parseTypedocDiagnostics(output: string): DocLintDiagnostic[] {
  const ansi = new RegExp(String.fromCharCode(0x1b) + '\\[[0-9;]*m', 'g');
  const diagnostics: DocLintDiagnostic[] = [];
  for (const line of output.replace(ansi, '').split('\n')) {
    if (!line.includes('[warning]') || /\[warning\] Found \d+ errors? and \d+ warnings?/.test(line))
      continue;
    const location = /(?:\.\/)?(packages\/(?:starters\/)?[^\s:]+):(\d+)(?::\d+)?/.exec(line);
    const declared = /defined in @setu-ts\/([^/\s`]+)\/(src\/[^\s,]+)/.exec(line);
    const owner = /(?:signature |\[warning\] )([^/\s`]+)\/src/.exec(line);
    const pkg = declared?.[1] ?? owner?.[1];
    const directory =
      pkg === undefined
        ? undefined
        : `packages/${pkg.endsWith('-starter') ? 'starters/' : ''}${pkg}`;
    const path =
      location?.[1] ??
      (declared
        ? `${directory}/${declared[2]}`
        : directory === undefined
          ? ''
          : `${directory}/src`);
    diagnostics.push({
      rule: line.includes('does not have any documentation')
        ? 'notDocumented'
        : line.includes('not included in the documentation')
          ? 'notExported'
          : 'typedoc',
      path,
      ...(location ? { line: Number(location[2]) } : {}),
      message: line.slice(line.indexOf('[warning]') + 9).trim(),
    });
  }
  return diagnostics;
}

/** TypeDoc's module name for a configured source entry point (`packages/kernel/src/index.ts` → `kernel/src`). */
export function apiModuleName(target: string): string {
  return target
    .replace(/^\.\//, '')
    .replace(/^packages\//, '')
    .replace(/\/index\.ts$/, '')
    .replace(/\.ts$/, '');
}

/** TypeDoc's module page for a configured source entry point. */
export function apiModulePage(target: string): string {
  return `modules/${apiModuleName(target).replaceAll('/', '_')}.html`;
}
