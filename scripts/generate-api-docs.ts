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
 * - The total diagnostic count must not exceed DOC_LINT_BASELINE (776)
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

/** The frozen baseline diagnostic count from the M38 plan (§1.1). */
export const DOC_LINT_BASELINE = 776;

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
): Promise<{ ok: true; targets: string[] } | { ok: false; failure: ManifestReadFailure }> {
  let content: string;
  try {
    content = await fs.readTextFile(manifestPath);
  } catch (cause) {
    return { ok: false, failure: { kind: 'read-failed', path: manifestPath, cause } };
  }

  let manifest: { exports?: unknown };
  try {
    manifest = JSON.parse(content) as { exports?: unknown };
  } catch (cause) {
    return { ok: false, failure: { kind: 'malformed-manifest', path: manifestPath, cause } };
  }

  // A valid manifest with no `exports` field at all, or an `exports` that is
  // neither a string nor an object, is an invalid export map.
  if (
    manifest.exports === undefined ||
    manifest.exports === null ||
    (typeof manifest.exports !== 'string' && typeof manifest.exports !== 'object')
  ) {
    return { ok: false, failure: { kind: 'invalid-export-map', path: manifestPath } };
  }

  const targets = expandExportTargets(manifest.exports);
  if (targets.length === 0) {
    return { ok: false, failure: { kind: 'no-export-targets', path: manifestPath } };
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
): Promise<{ targets: string[]; targetsWithPackage: Array<{ target: string; pkg: string }> }> {
  // Read authoritative workspace from root deno.json
  const workspace = await readWorkspaceMembers(fs);

  // Independent reconciliation
  const reconciliation = reconcileWorkspaceVsPublication(workspace, PUBLISHED_PACKAGES);
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

  return { targets: uniqueTargets, targetsWithPackage: uniqueTargetsWithPackage };
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
  const args: string[] = ['doc'];

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
const LINT_SUMMARY_PATTERN = /Found \d+ documentation lint errors/;

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
 * A stack-trace line (`    at file:line:col`) that a fatal error prints. The
 * `m` flag is required: a stack frame is rarely at the START of the residual
 * (it follows the error header, e.g. `TypeError: foo\n    at file:///x.ts`),
 * so `^` must anchor to the start of each LINE, not the start of the whole
 * string. Without `m`, a stack trace not at position 0 is missed and a fatal
 * whose residual contains no `error: ` literal is misclassified as lint debt.
 */
const STACK_TRACE_PATTERN = /^\s+at\s+/m;

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
): { kind: 'lint-debt' | 'fatal'; stdoutStripped: string; stderrStripped: string } {
  const ansiStripRe = new RegExp(String.fromCharCode(0x1b) + '\\[[0-9;]*m', 'g');
  const stdoutStripped = stdout.replace(ansiStripRe, '');
  const stderrStripped = stderr.replace(ansiStripRe, '');

  // An unexpected nonzero code (including code 2) is always fatal, regardless
  // of stream content — it is not the documented lint-debt exit shape.
  if (code !== 0 && code !== DOC_LINT_EXIT_CODE) {
    return { kind: 'fatal', stdoutStripped, stderrStripped };
  }

  // For the ratchet-eligible code (1) or code 0, remove recognized lint records
  // from each stream and reject any independent fatal/error/stack residual.
  for (const stream of [stdoutStripped, stderrStripped]) {
    const lines = stream.split('\n');
    const residual: string[] = [];
    for (const line of lines) {
      // Recognized lint diagnostic opener: error[rule]: message
      if (LINT_DIAGNOSTIC_PATTERN.test(line)) continue;
      // Recognized lint location continuation: --> path:line:col
      if (LINT_LOCATION_PATTERN.test(line)) continue;
      // Recognized lint summary line: Found N documentation lint errors.
      if (LINT_SUMMARY_PATTERN.test(line)) continue;
      residual.push(line);
    }
    const residualText = residual.join('\n');
    // Any remaining `error:` line is an independent fatal (module-not-found,
    // permission denied, etc.) — NOT a lint diagnostic (those were removed).
    if (/error: /.test(residualText)) {
      return { kind: 'fatal', stdoutStripped, stderrStripped };
    }
    // Any remaining stack-trace line is an independent fatal.
    if (STACK_TRACE_PATTERN.test(residualText)) {
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
    run: (args: string[]) => Promise<{ code: number; stdout: string; stderr: string }>;
  },
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
    const classification = classifyChildResult(result.code, result.stdout, result.stderr);

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
        findings.push(`  - [${diag.rule}] ${diag.path}:${diag.line} ${diag.message}`);
      }
    }

    const totalDiagnostics = diagnostics.length;
    if (totalDiagnostics > DOC_LINT_BASELINE) {
      findings.push(
        `Total JSDoc diagnostics (${totalDiagnostics}) exceeds baseline (${DOC_LINT_BASELINE}).`,
      );
    } else if (totalDiagnostics < DOC_LINT_BASELINE) {
      findings.push(
        `Total JSDoc diagnostics (${totalDiagnostics}) is BELOW baseline (${DOC_LINT_BASELINE}).`,
      );
      findings.push(
        `Update DOC_LINT_BASELINE constant in scripts/generate-api-docs.ts to ${totalDiagnostics}.`,
      );
    }

    if (findings.length > 0) {
      console.error('API JSDoc lint check failed:');
      for (const finding of findings) {
        console.error(`  ${finding}`);
      }
      return { code: 1, findings };
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
