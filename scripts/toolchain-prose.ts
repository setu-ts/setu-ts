/** Refuse obsolete `deno task` instructions while preserving generated Deno projects. */
import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { run } from './lib/run.ts';

/** One tracked text file, with a repository-relative path. */
export interface ProseFile {
  readonly path: string;
  readonly text: string;
}

/** A line-addressable refusal suitable for the documentation gate. */
export interface ToolchainProseFinding {
  readonly path: string;
  readonly line: number;
  readonly rule: 'P1' | 'P2' | 'P3' | 'P4' | 'P5' | 'P6' | 'P7' | 'P8' | 'stale-allowlist';
  readonly message: string;
}

/** Categorized allowances and the manifests against which commands are checked. */
export interface ToolchainProseRules {
  readonly allowlist: readonly {
    readonly path: string;
    readonly category: 'deno-target' | 'legacy-pin' | 'fixture' | 'matcher';
    readonly reason: string;
    /** URL allowances are separate: a legacy pin example does not authorize a stale link. */
    readonly allowJsrUrl?: true;
    /** npm: reference allowances are separate: a legacy pin example does not authorize a stale npm: mention. */
    readonly allowNpmRef?: true;
  }[];
  readonly generatedDenoTasks: readonly string[];
  readonly rootScripts: readonly string[];
  readonly appScripts: Readonly<Record<string, readonly string[]>>;
}

/** Committed exceptions; the runner supplies script names from actual package manifests. */
export const TOOLCHAIN_PROSE_RULES: ToolchainProseRules = {
  allowlist: [
    {
      path: 'packages/cli/test/unit/project-files-check.test.ts',
      category: 'deno-target',
      reason: 'Asserts frontend-first check tasks for supported Deno applications.',
    },
    {
      path: 'packages/cli/test/unit/dockerfile.test.ts',
      category: 'deno-target',
      reason: 'Asserts the generated Deno image build-task gate before cache.',
    },
    {
      path: 'packages/cli/src/workspace/compose.ts',
      category: 'deno-target',
      reason: 'Generated Deno application build and task instructions.',
    },
    {
      path: 'packages/cli/test/unit/workspace/compose.test.ts',
      category: 'deno-target',
      reason: 'Generated Deno application build and task instructions.',
    },
    {
      path: 'packages/cli/test/unit/project-files-scripts.test.ts',
      category: 'deno-target',
      reason: 'Asserts supported Deno application development and build tasks.',
    },
    {
      path: 'packages/cli/src/commands/build.ts',
      category: 'deno-target',
      reason: 'Build refusal names the supported Deno application start task.',
    },
    {
      path: 'packages/cli/test/unit/build-command.test.ts',
      category: 'deno-target',
      reason: 'Asserts Deno application guidance from the Node-only build command.',
    },
    {
      path: 'packages/cli/test/unit/agents/render-brief.test.ts',
      category: 'deno-target',
      reason: 'Asserts commands rendered for supported Deno application projects.',
    },
    {
      path: 'packages/cli/test/unit/agents/workspace-brief.test.ts',
      category: 'deno-target',
      reason: 'Asserts commands rendered for supported Deno application workspaces.',
    },
    {
      path: 'test/toolchain-prose.test.ts',
      category: 'fixture',
      reason: 'Planted toolchain and JSR reference violations.',
      allowJsrUrl: true,
    },
    {
      path: 'scripts/toolchain-prose.ts',
      category: 'fixture',
      reason: 'Scanner documentation names the obsolete command it refuses.',
    },
    {
      path: 'PUBLIC_API.md',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'docs/cli.md',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'docs/getting-started.md',
      category: 'legacy-pin',
      reason: 'Recognizes or explains migration of pre-0.9 JSR pins.',
    },
    {
      path: 'docs/react-router-dev.md',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'docs/releasing.md',
      category: 'legacy-pin',
      reason: 'Recognizes or explains migration of pre-0.9 JSR pins.',
    },
    {
      path: 'docs/runtime-deployment.md',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'docs/upgrading.md',
      category: 'legacy-pin',
      reason: 'Recognizes or explains migration of pre-0.9 JSR pins.',
    },
    {
      path: 'packages/cli/README.md',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/app-loader.ts',
      category: 'legacy-pin',
      reason: 'Recognizes or explains migration of pre-0.9 JSR pins.',
    },
    {
      path: 'packages/cli/src/commands/adopt.ts',
      category: 'legacy-pin',
      reason: 'Recognizes or explains migration of pre-0.9 JSR pins.',
    },
    {
      path: 'packages/cli/src/commands/app.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/commands/devtool.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/commands/new.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/devtool/dev-entry.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/devtool/planner.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/devtool/sources.ts',
      category: 'legacy-pin',
      reason: 'Recognizes or explains migration of pre-0.9 JSR pins.',
    },
    {
      path: 'packages/cli/src/templates/full-stack.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/templates/project-files.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/templates/registry.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/workspace/dev-runner.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/workspace/discovery-module.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/workspace/legacy-pins.ts',
      category: 'legacy-pin',
      reason: 'Recognizes or explains migration of pre-0.9 JSR pins.',
    },
    {
      path: 'packages/cli/src/workspace/library.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/workspace/proto-toolchain.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/workspace/root-files.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/workspace/runtime-profile.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/src/workspace/transport.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/e2e/dev-runner-e2e.test.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/e2e/scaffold-runs-e2e.test.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/fixtures/capture-template-baseline.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/fixtures/dev-entry-0.8.0-member.txt',
      category: 'legacy-pin',
      reason: 'Recognizes or explains migration of pre-0.9 JSR pins.',
    },
    {
      path: 'packages/cli/test/fixtures/dev-entry-0.8.0-standalone.txt',
      category: 'legacy-pin',
      reason: 'Recognizes or explains migration of pre-0.9 JSR pins.',
    },
    {
      path: 'packages/cli/test/unit/adopt-command.test.ts',
      category: 'legacy-pin',
      reason: 'Recognizes or explains migration of pre-0.9 JSR pins.',
    },
    {
      path: 'packages/cli/test/unit/app-command.test.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/unit/app-loader.test.ts',
      category: 'legacy-pin',
      reason: 'Recognizes or explains migration of pre-0.9 JSR pins.',
    },
    {
      path: 'packages/cli/test/unit/commands/add.test.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/unit/deno-tasks.test.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/unit/devtool-refusals.test.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/unit/devtool-sources.test.ts',
      category: 'legacy-pin',
      reason: 'Recognizes or explains migration of pre-0.9 JSR pins.',
    },
    {
      path: 'packages/cli/test/unit/generate-command.test.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/unit/generate-inactive-module.test.ts',
      category: 'deno-target',
      reason: 'Builds Deno projects for the feature-scoped generation command tests.',
    },
    {
      path: 'packages/cli/test/unit/generate-module-command.test.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/unit/generate-seam-command.test.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/unit/new-command.test.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/unit/plugin-detector.test.ts',
      category: 'legacy-pin',
      reason: 'Recognizes or explains migration of pre-0.9 JSR pins.',
    },
    {
      path: 'packages/cli/test/unit/templates.test.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/unit/templates/project-files.test.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/unit/workspace/legacy-pins.test.ts',
      category: 'legacy-pin',
      reason: 'Recognizes or explains migration of pre-0.9 JSR pins.',
    },
    {
      path: 'packages/cli/test/unit/workspace/runtime-profile.test.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/cli/test/unit/workspace/transport.test.ts',
      category: 'deno-target',
      reason: 'Commands emitted for or exercised against supported Deno projects.',
    },
    {
      path: 'packages/react-router-plugin/test/unit/vite-dev-externals.test.ts',
      category: 'matcher',
      reason: 'JSR specifiers are inputs to the third-party external matcher.',
    },
    {
      path: 'packages/sdk/test/unit/realtime-module-imports.test.ts',
      category: 'fixture',
      reason: 'Regression inputs for historical registry-qualified SDK imports.',
    },
    {
      path: 'scripts/check-docs.ts',
      category: 'fixture',
      reason: 'Validates README links for immutable historical JSR versions.',
      allowJsrUrl: true,
    },
    {
      path: 'scripts/codemods/std-to-vitest.test.ts',
      category: 'fixture',
      reason: 'Historical registry inputs exercised by tooling tests.',
    },
    {
      path: 'scripts/version-sweep.ts',
      category: 'legacy-pin',
      reason: 'Version sweep recognizes historical registry-qualified pins.',
    },
    {
      path: 'test/cli-install-line.test.ts',
      category: 'fixture',
      reason: 'Historical registry inputs exercised by tooling tests.',
    },
    {
      path: 'test/deno-lane/deno.lock',
      category: 'fixture',
      reason: 'Historical registry inputs exercised by tooling tests.',
    },
    {
      path: 'test/docs-gate.test.ts',
      category: 'fixture',
      reason: 'Historical registry inputs exercised by tooling tests.',
      allowJsrUrl: true,
    },
    {
      path: 'test/unit/bump-version.test.ts',
      category: 'fixture',
      reason: 'Historical registry inputs exercised by tooling tests.',
    },
    {
      path: 'test/unit/check-since-tags.test.ts',
      category: 'fixture',
      reason: 'Historical registry inputs exercised by tooling tests.',
      allowJsrUrl: true,
    },
    {
      path: 'test/unit/npm-specifier-audit.test.ts',
      category: 'fixture',
      reason: 'Historical registry inputs exercised by tooling tests.',
    },
    {
      path: 'test/version-sweep.test.ts',
      category: 'fixture',
      reason: 'Historical registry inputs exercised by tooling tests.',
    },
    {
      path: 'website/test/docs-links.test.ts',
      category: 'fixture',
      reason: 'Historical registry inputs exercised by tooling tests.',
      allowJsrUrl: true,
    },
  ],
  generatedDenoTasks: ['build', 'check', 'dev', 'install', 'proto:gen', 'start', 'test'],
  rootScripts: [],
  appScripts: {},
};

const P1 = /deno\s+task\b|jsr:@setu-ts\/|@jsr\/setu-ts__|Deno-first/i;
const P6 = /jsr\.io\/@setu-ts\b/i;
/** P7: an `npm:` specifier in a quoted import position. Backtick-quoted text is P8's business. */
const P7 = /(?:\bfrom\s+|\bimport\s+|\bimport\(\s*)["']npm:/g;
/** P8: any `npm:<pkg>` reference; `pnpm:` and a "from npm:" registry mention do not match. */
const P8 = /\bnpm:([A-Za-z@][A-Za-z0-9@._/^~-]*)/g;
/** A Deno install command with the specifier as an argument: a legitimate Deno-target instruction. */
/**
 * A Deno install command and its arguments: the arguments run until the first
 * shell delimiter or code-span backtick, the same boundary P3 uses.
 */
const DENO_INSTALL = /\bdeno\s+(?:add|install)\b[^\n`<>;|&]*/g;
/** A line ending in a shell continuation (`\\` plus optional trailing whitespace). */
const CONTINUED = /\\\s*$/;

function history(path: string): boolean {
  return /^(?:CHANGELOG\.md$|ROADMAP\.md$|plans\/(?:archive\/|reviews\/|milestone-[^/]+\.md$))/.test(
    path,
  );
}

function instructions(path: string): boolean {
  return /^(?:(?:AGENTS|AI_GUIDELINES|CONTRIBUTING|CLAUDE)\.md|plans\/TEMPLATE\.md|\.roo\/.*|docs\/(?:releasing|examples)\.md|apps\/(?:[^/]+\/)?README\.md)$/.test(
    path,
  );
}

/** Scan in memory; no filesystem, environment, or process state affects the result. */
export function scanToolchainProse(
  files: readonly ProseFile[],
  rules: ToolchainProseRules,
): ToolchainProseFinding[] {
  const findings: ToolchainProseFinding[] = [];
  const used = new Set<string>();
  for (const { path, text } of files) {
    if (history(path)) continue;
    const allowance = rules.allowlist.find((entry) => entry.path === path);
    let inStatus = false;
    const lines = text.split(/\r?\n/);
    for (const [index, line] of lines.entries()) {
      if (path === 'CLAUDE.md' && /^## /.test(line)) inStatus = line === '## Current status';
      if (inStatus) continue;
      const report = (rule: ToolchainProseFinding['rule'], message: string): void => {
        findings.push({ path, line: index + 1, rule, message });
      };
      if (P1.test(line)) {
        if (allowance) used.add(path);
        else report('P1', 'Stale repository command or Setu-TS JSR reference');
      }
      if (P6.test(line)) {
        if (allowance?.allowJsrUrl) used.add(path);
        else report('P6', 'Setu-TS JSR URL stops at 0.8.0; link to npm');
      }
      for (const match of line.matchAll(/\bdeno\s+task\s+([\w:-]+)/gi)) {
        if (
          rules.rootScripts.includes(match[1]!) &&
          !rules.generatedDenoTasks.includes(match[1]!)
        ) {
          report('P2', `Repository task must use pnpm: ${match[0]}`);
        }
      }
      // A backslash-continued command is joined ONCE, from the line that starts
      // it, and each match is reported at the line holding its first character.
      // Re-joining from every line of a chain made the scan cubic (O5).
      if (index === 0 || !CONTINUED.test(lines[index - 1]!)) {
        const pieces: string[] = [];
        const starts: number[] = [];
        let length = 0;
        for (let next = index; ; next++) {
          const continued = CONTINUED.test(lines[next]!) && next + 1 < lines.length;
          // Strip the continuation from the piece itself, never from the growing
          // join: a regex over the whole join per line is quadratic again.
          const text = continued ? lines[next]!.replace(CONTINUED, '') + ' ' : lines[next]!;
          starts.push(length);
          pieces.push(text);
          length += text.length;
          if (!continued) break;
        }
        const commandLine = pieces.join('');
        let piece = 0;
        for (const match of commandLine.matchAll(/\b(?:deno|jsr)\s+add\b([^\n`<>;|&]*)/gi)) {
          if (/(?:^|\s|["'])@setu-ts\//.test(match[1]!)) {
            while (piece + 1 < starts.length && starts[piece + 1]! <= match.index!) piece++;
            findings.push({
              path,
              line: index + piece + 1,
              rule: 'P3',
              message: 'Bare Setu-TS add argument resolves from JSR; use npm:@setu-ts/',
            });
          }
        }
      }
      if (path.endsWith('.md')) {
        const p7NpmStarts = new Set<number>();
        // Matches arrive in increasing order, so the backtick count before each
        // quote is carried forward rather than recounted: one pass per line.
        let ticksBefore = 0;
        let counted = 0;
        for (const match of line.matchAll(P7)) {
          if (match.index === undefined) continue;
          const quote = match.index + match[0].length - 5;
          for (; counted < quote; counted++) if (line[counted] === '`') ticksBefore++;
          if (ticksBefore % 2 === 1) continue;
          p7NpmStarts.add(match.index + match[0].length - 4);
          report('P7', 'Node cannot load an npm: specifier; import the bare package name');
        }
        // The spans holding Deno install arguments, found once per line: an
        // `npm:` reference inside one is that command's argument, and one after
        // the command's delimiter is ordinary prose that P8 still checks.
        const installs = [...line.matchAll(DENO_INSTALL)].map((install) => [
          install.index,
          install.index + install[0].length,
        ]);
        let span = 0;
        for (const match of line.matchAll(P8)) {
          const pkg = match[1] ?? '';
          if (pkg.startsWith('@setu-ts/') || pkg.startsWith('@jsr/')) continue;
          if (match.index === undefined) continue;
          if (p7NpmStarts.has(match.index)) continue;
          while (span < installs.length && installs[span]![1]! <= match.index) span++;
          const install = installs[span];
          if (install !== undefined && install[0]! < match.index) continue;
          if (allowance?.allowNpmRef) used.add(path);
          else
            report(
              'P8',
              'packages install and import by bare name since 0.9.0; drop the npm: prefix',
            );
        }
      }
      if (!instructions(path)) continue;
      for (const match of line.matchAll(
        /\bpnpm\s+(?:--dir\s+apps\/([\w-]+)\s+)?run\s+([\w:-]+)/g,
      )) {
        const scripts = match[1] === undefined ? rules.rootScripts : rules.appScripts[match[1]];
        if (!scripts?.includes(match[2]!)) report('P4', `Missing package.json script: ${match[0]}`);
      }
      if (path !== 'CLAUDE.md' && /\bdeno\s+(?:lint|doc|audit)\b|deno-lint-ignore/i.test(line)) {
        report('P5', 'Repository gate uses ESLint, TypeDoc or pnpm audit');
      }
    }
  }
  for (const entry of rules.allowlist) {
    if (!used.has(entry.path)) {
      findings.push({
        path: entry.path,
        line: 1,
        rule: 'stale-allowlist',
        message: `Unused ${entry.category} allowance: ${entry.reason}`,
      });
    }
  }
  return findings;
}

/** Read tracked text and current manifest scripts, then apply the pure scanner. */
export async function runToolchainProseCheck(root: string): Promise<ToolchainProseFinding[]> {
  const tracked = await run(
    'git',
    ['ls-files', '--cached', '--others', '--exclude-standard', '-z'],
    { cwd: root },
  );
  if (tracked.code !== 0) throw new Error(`git ls-files failed: ${tracked.stderr}`);
  const paths = tracked.stdout
    .split('\0')
    .filter(
      (path) =>
        /\.(?:md|ts|tsx|mjs|js|json|jsonc|yaml|yml|toml|astro|txt)$/.test(path) ||
        ['.gitignore', '.prettierignore', 'test/deno-lane/deno.lock'].includes(path),
    );
  // New scripts/tests also need checking before staging; tracked existing files remain authoritative.
  const files = await Promise.all(
    paths.map(async (path) => ({ path, text: await readFile(resolve(root, path), 'utf8') })),
  );
  const scripts = async (path: string): Promise<string[]> => {
    const manifest = JSON.parse(await readFile(resolve(root, path, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    };
    return Object.keys(manifest.scripts);
  };
  const appScripts: Record<string, readonly string[]> = {};
  for (const entry of await readdir(resolve(root, 'apps'), { withFileTypes: true })) {
    if (entry.isDirectory()) appScripts[entry.name] = await scripts(`apps/${entry.name}`);
  }
  return scanToolchainProse(files, {
    ...TOOLCHAIN_PROSE_RULES,
    rootScripts: await scripts('.'),
    appScripts,
  });
}
