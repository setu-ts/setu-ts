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
 * Collects API entry points from PUBLISHED_PACKAGES.
 *
 * PUBLISHED_PACKAGES contains full paths like "packages/common/src/index.ts".
 *
 * @param fs - File system abstraction for testing
 * @returns Sorted targets and package mapping
 */
export async function collectApiEntrypoints(
  fs: {
    readTextFile: (path: string) => Promise<string>;
    readDir: (path: string) => AsyncIterable<Deno.DirEntry>;
    stat: (path: string) => Promise<Deno.FileInfo>;
  },
): Promise<{ targets: string[]; targetsWithPackage: Array<{ target: string; pkg: string }> }> {
  // PUBLISHED_PACKAGES contains paths like "packages/common", append /src/index.ts
  // Special case: CLI also has src/main.ts as an entry point
  const baseTargets = PUBLISHED_PACKAGES.map((p) => `${p}/src/index.ts`);
  const extraTargets = ['packages/cli/src/main.ts'];
  const targets = [...baseTargets, ...extraTargets].sort();
  const targetsWithPackage: Array<{ target: string; pkg: string }> = [];

  for (const target of targets) {
    // Extract package name from path like "packages/common/src/index.ts"
    const match = target.match(/^packages\/([^/]+)/);
    const pkg = match ? match[1] : 'unknown';
    targetsWithPackage.push({ target, pkg });
  }

  // Validate all targets exist
  for (const { target } of targetsWithPackage) {
    try {
      await fs.stat(target);
    } catch {
      throw new Error(`Export target '${target}' does not exist`);
    }
  }

  return { targets, targetsWithPackage };
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
    args.push('--html', '--output', outputDir, '--name', 'Setu-TS');
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
 * Partitions diagnostics by owning package.
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
    // Extract package name from path like "packages/<name>/..."
    // Special case: starters are under packages/starters/<name>/...
    const match = diag.path.match(/^packages\/([^/]+)(?:\/([^/]+))?/);
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
  // PUBLISHED_PACKAGES contains full paths like "packages/common/src/index.ts"
  // targetsWithPackage contains the same paths with package name extraction
  // We need to check that every published package contributed at least one target
  const packagesWithExports = new Set<string>();
  for (const { target } of targetsWithPackage) {
    // Extract package name from full path like "packages/common/src/index.ts"
    const match = target.match(/^packages\/([^/]+)/);
    if (match) {
      packagesWithExports.add(match[1]);
    }
  }

  // Check that all published packages have exports
  for (const pkg of PUBLISHED_PACKAGES) {
    // Extract package name from path like "packages/common/src/index.ts"
    const match = pkg.match(/^packages\/([^/]+)/);
    const packageName = match ? match[1] : pkg;
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
    // deno doc --lint outputs diagnostics to stderr
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
    if (result.code !== 0) {
      findings.push(`deno doc failed with exit code ${result.code}`);
      if (result.stderr) {
        findings.push(`Output: ${result.stderr}`);
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
