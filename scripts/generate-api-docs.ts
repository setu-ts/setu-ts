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

/** Required guide inventory for the docs hub (§5.2 of the plan). */
export const REQUIRED_GUIDES = [
  'docs/getting-started.md',
  'docs/plugin-architecture.md',
  'docs/plugins.md',
  'docs/programmatic-api.md',
  'docs/decorators.md',
  'docs/custom-plugins.md',
  'docs/migration-nestjs.md',
  'docs/migration-fastify.md',
  'docs/examples.md',
  'docs/runtime-deployment.md',
];

/** One parsed `deno doc --lint` diagnostic. */
export interface DocLintDiagnostic {
  rule: string;
  path: string;
  line?: number;
  message?: string;
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
 * Reads a deno.json manifest and extracts export targets.
 *
 * @param manifestPath - Path to the deno.json file
 * @param fs - File system abstraction
 * @returns Array of local source targets, or empty array if manifest not found
 */
export async function readManifestExports(
  manifestPath: string,
  fs: {
    readTextFile: (path: string) => Promise<string>;
  },
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
 * Collects API entry points from published package manifests.
 *
 * Reads each package's deno.json exports map and expands all local string/object
 * export targets. Validates workspace parity (every published package has at
 * least one target) and sorts/deduplicates the result.
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
  const allTargets: string[] = [];
  const targetsWithPackage: Array<{ target: string; pkg: string }> = [];
  const packagesWithExports = new Set<string>();

  // Read each published package's manifest and expand exports
  for (const pkgPath of PUBLISHED_PACKAGES) {
    const manifestPath = `${pkgPath}/deno.json`;
    const targets = await readManifestExports(manifestPath, fs);

    if (targets.length === 0) {
      // Fallback to src/index.ts if manifest has no exports
      const fallback = `${pkgPath}/src/index.ts`;
      try {
        await fs.stat(fallback);
        targets.push(fallback);
      } catch {
        // No fallback either
      }
    }

    if (targets.length > 0) {
      packagesWithExports.add(pkgPath);
      for (const target of targets) {
        // Prepend the package path so the target is workspace-relative.
        // `expandExportTargets` returns paths like "./src/index.ts"; we need
        // "packages/common/src/index.ts" for `deno doc` to resolve them.
        const workspaceTarget = target.startsWith('./')
          ? `${pkgPath}/${target.slice(2)}`
          : `${pkgPath}/${target}`;
        allTargets.push(workspaceTarget);
        // Extract package name from pkgPath (e.g., "packages/kernel" -> "kernel",
        // "packages/starters/rest-starter" -> "rest-starter")
        const pkgMatch = pkgPath.match(/^packages\/([^/]+)(?:\/([^/]+))?/);
        const firstSegment = pkgMatch?.[1];
        const secondSegment = pkgMatch?.[2];
        const pkg = (firstSegment === 'starters' && secondSegment)
          ? secondSegment
          : (pkgMatch?.[1] ?? pkgPath.split('/')[1]);
        targetsWithPackage.push({ target: workspaceTarget, pkg });
      }
    }
  }

  // Validate workspace parity: every published package must have at least one target
  const missingPackages = PUBLISHED_PACKAGES.filter((p) => !packagesWithExports.has(p));
  if (missingPackages.length > 0) {
    throw new Error(
      `Published packages missing export targets: ${missingPackages.join(', ')}`,
    );
  }

  // Sort and deduplicate
  // Targets are unique per-package (e.g., packages/kernel/src/index.ts vs
  // packages/common/src/index.ts), so dedup by the full path including package.
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
  let targets: string[];
  let targetsWithPackage: Array<{ target: string; pkg: string }>;
  try {
    const result = await collectApiEntrypoints(fs);
    targets = result.targets;
    targetsWithPackage = result.targetsWithPackage;
  } catch (error) {
    console.error(`Error collecting API entry points: ${error}`);
    return { code: 1, findings: [`Failed to collect API entry points: ${error}`] };
  }

  // Validate workspace parity
  const packagesWithExports = new Set<string>();
  for (const { pkg } of targetsWithPackage) {
    // "starters" is a directory, not a package — skip it
    if (pkg !== 'starters') {
      packagesWithExports.add(pkg);
    }
  }

  // Check that all published packages have exports
  for (const pkg of PUBLISHED_PACKAGES) {
    // Extract package name: "packages/kernel" -> "kernel", "packages/starters/rest-starter" -> "rest-starter"
    const match = pkg.match(/^packages\/([^/]+)(?:\/([^/]+))?/);
    const firstSegment = match?.[1];
    const secondSegment = match?.[2];
    const packageName = (firstSegment === 'starters' && secondSegment)
      ? secondSegment
      : (match?.[1] ?? pkg);
    if (!packagesWithExports.has(packageName)) {
      findings.push(`Published package '${pkg}' has no export targets`);
    }
  }

  if (findings.length > 0) {
    console.error('Workspace parity check failed:');
    for (const finding of findings) {
      console.error(`  - ${finding}`);
    }
    return { code: 1, findings };
  }

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
    const hasFatalText = /error:\s/.test(stderrStripped) || /error:\s/.test(stdoutStripped);
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
