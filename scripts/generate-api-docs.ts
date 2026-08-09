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
 * Parses a deno.json manifest and extracts export targets.
 * Returns empty array if manifest is missing, unreadable, or malformed.
 */
export async function readManifestExports(
  manifestPath: string,
  fs: { readTextFile: (path: string) => Promise<string> },
): Promise<string[]> {
  try {
    const content = await fs.readTextFile(manifestPath);
    const manifest = JSON.parse(content) as { exports?: unknown };
    return expandExportTargets(manifest.exports);
  } catch {
    return [];
  }
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
  if (typeof exports === 'string') {
    return [exports];
  }
  if (exports === null || typeof exports !== 'object') {
    return [];
  }

  const targets: string[] = [];
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

  // Normalize and deduplicate
  const normalized = new Set<string>();
  for (const target of targets) {
    // Keep the ./ prefix so package extraction works correctly
    const normalizedPath = target.startsWith('./') ? target : `./${target}`;
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

  // Read each published package's manifest and expand exports
  for (const pkgPath of PUBLISHED_PACKAGES) {
    const manifestPath = `${pkgPath}/deno.json`;
    const targets = await readManifestExports(manifestPath, fs);

    if (targets.length === 0) {
      // Reject no-export manifests — this is a failure, not a valid empty state
      throw new Error(
        `Package ${pkgPath} has no export targets in its deno.json manifest`,
      );
    }

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
    // deno doc --lint outputs diagnostics to stderr; exit code 1 is expected
    // when diagnostics exist — we parse them and apply the ratchet policy.
    //
    // CRITICAL: deno doc --lint exits 1 for BOTH lint diagnostics AND fatal
    // errors (module not found, permission denied, etc.). Fatal errors produce
    // `error:` lines (no `[rule]` bracket), not `error[rule]:` lines. We must
    // distinguish fatal child failures from normal lint debt runs:
    // - Fatal exit + zero parseable diagnostics → propagate the original error
    // - Fatal exit + partial parseable diagnostics → still fatal (fatal text present)
    // - Normal lint exit (code 0 or 1 with parseable diagnostics) → apply ratchet
    // deno doc --lint may emit fatal errors to either stderr or stdout.
    // Strip ANSI from both streams before classification so ANSI-coloured
    // fatal text is still detected.
    const ansiStripRe = new RegExp(String.fromCharCode(0x1b) + '\\[[0-9;]*m', 'g');
    const stderrStripped = result.stderr.replace(ansiStripRe, '');
    const stdoutStripped = result.stdout.replace(ansiStripRe, '');
    // Fatal errors use `error: message` (space after colon); lint diagnostics
    // use `error[rule]: message` (bracket after colon). Only the former is fatal.
    // The summary line `error: Found N documentation lint errors.` is NOT fatal —
    // it appears whenever deno doc --lint exits non-zero due to lint debt.
    const isLintSummary = /Found \d+ documentation lint errors/.test(stderrStripped) ||
      /Found \d+ documentation lint errors/.test(stdoutStripped);
    const hasFatalText = !isLintSummary &&
      (/error: /.test(stderrStripped) || /error: /.test(stdoutStripped));
    const diagnostics = parseDocLintDiagnostics(result.stderr);
    const { cleanPackageFindings } = partitionDiagnostics(diagnostics);

    // A fatal invocation/resolution/permission/module error must never be
    // converted into a baseline-count message or success — even if stderr
    // also contains zero, partial, or exactly baseline-sized parseable
    // diagnostics.
    if (result.code !== 0 && hasFatalText) {
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
      return { code: result.code, findings };
    }

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
