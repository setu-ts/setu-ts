/* eslint-disable no-console -- a gate prints what it found (AI_GUIDELINES §11.5/§11.6) */
/**
 * The Node-manifest generator and drift gate (M111a plan §3.1).
 *
 * Writes every workspace member's `package.json` and `tsconfig.json`, the root
 * solution `tsconfig.json`, app type-check configs, Deno lane config, and the root `package.json`
 * `workspaces` field, from four inputs: each member's `deno.json`
 * (`name`/`version`/`exports`), a scan of every TypeScript file under its
 * `src` and `test` trees, the committed external-range table
 * (`scripts/node-dependency-ranges.ts`), and that table's classification
 * overrides. `--check` regenerates in memory and fails on any difference;
 * `--write` writes the files.
 *
 * The scan masks comments and template bodies (the same masking as
 * `scripts/npm-specifier-audit.ts`, AI_GUIDELINES §11.1) before reading import
 * specifiers, because JSDoc `@example` blocks and generated-project template
 * text would otherwise invent dependency edges, and a scanner that invents an
 * edge can close a reference cycle.
 *
 * Classification (plan §3.1):
 *   - `src` imports `@setu-ts/<x>`            → `dependencies: workspace:^` + a project reference
 *   - `src` statically imports an external as a value → `dependencies`
 *   - `src` reaches an external only by dynamic `import()` or `import type`
 *     → optional `peerDependencies` (+ `peerDependenciesMeta`) AND an
 *     identical-range `devDependencies` mirror — required, not cosmetic: Deno
 *     ignores `peerDependencies` and types an unresolved optional peer as `any`
 *   - imported by tests only                  → `devDependencies` (`workspace:^` or the table's range)
 *   - a `src`-level workspace cycle           → refused by name (tsc references must be acyclic)
 *
 * It also enforces the two manifest-side invariants the plan names: no bare-keyed
 * alias survives in a member `deno.json` (§3.2 — both toolchains read
 * dependencies from `package.json`), and `decorator-plugin`'s manifest may not
 * declare `sideEffects: false` or a list omitting the `Symbol.metadata` module
 * (§3.4 safeguard 2).
 *
 * Usage:
 *   node scripts/node-manifests.ts --write
 *   node scripts/node-manifests.ts --check
 *
 * @module
 */

import { readFile, readdir, writeFile, mkdir } from 'node:fs/promises';
import { type Dirent } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { workspaceApps, workspaceMembers } from './lib/workspace.ts';

import { DENO_LANE_TESTS, DENO_ONLY_SOURCES } from './test-lanes.ts';
import { type ImportEdge, scanImportEdges } from './npm-specifier-audit.ts';
import { PACKAGE_METADATA } from './jsr-metadata.ts';
import { REPOSITORY_URL } from './npm-release-gate.ts';
import { auditSideEffects, SIDE_EFFECT_MODULES } from './side-effects.ts';
import {
  EXTERNAL_RANGES,
  type Override,
  OVERRIDES,
  WORKSPACE_SCOPE,
} from './node-dependency-ranges.ts';

// ── Pure core ─────────────────────────────────────────────────────────────────

/** A member's `deno.json` exports entry, normalised to subpath → source path. */
export interface ExportEntry {
  readonly subpath: string;
  readonly source: string;
}

/** One workspace member as the generator sees it (pure input). */
export interface MemberInput {
  /** Repository-relative directory, e.g. `packages/kernel` or `packages/starters/rest-starter`. */
  readonly dir: string;
  readonly name: string;
  readonly version: string;
  readonly exports: readonly ExportEntry[];
  /**
   * The member's `deno.json` as committed. The generator rewrites only its
   * `imports` block ({@linkcode renderDenoJson}); every other byte is kept.
   */
  readonly denoJson: string;
  /** Every scanned source file: repository-relative path → source text. */
  readonly files: ReadonlyMap<string, string>;
  /** Current content of the member's committed `package.json`, when one exists (for the sideEffects guard). */
  readonly currentPackageJson?: string;
}

/** A fully classified dependency set for one member. */
export interface ClassifiedMember {
  readonly dependencies: ReadonlyMap<string, string>;
  readonly peerDependencies: ReadonlyMap<string, string>;
  readonly devDependencies: ReadonlyMap<string, string>;
  /** Workspace member dirs this member references from `src` (acyclic by refusal). */
  readonly references: readonly string[];
}

/** The outcome of generating the whole workspace. */
export interface GenerationResult {
  /** Repository-relative file path → exact committed content. */
  readonly files: ReadonlyMap<string, string>;
  /** Hard refusals (a cycle, an unresolvable specifier, a bare alias, a sideEffects violation). */
  readonly refusals: readonly string[];
}

/** The build tools every member carries, pinned identically (plan §3.6). */
const BUILD_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
  typescript: '6.0.3',
  '@types/node': '^24',
};

/** The members whose `src` references the `Deno` global get its ambient types (plan §3.6). */
const TEST_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
  vitest: '5.0.3',
  '@vitest/coverage-v8': '5.0.3',
  esbuild: '0.28.2',
  '@hono/node-server': '^2.0.0',
};

/** The repository's formatter and linter, root-only and pinned like the test tools (M111e1 §3.5). */
const LINT_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
  prettier: '3.9.10',
  eslint: '10.12.0',
  '@eslint/js': '10.0.1',
  '@eslint/compat': '2.1.1',
  '@eslint-community/eslint-plugin-eslint-comments': '4.8.1',
  'typescript-eslint': '8.71.2',
  globals: '17.13.0',
  espree: '11.2.0',
};

const DENO_TYPES_MEMBERS: readonly string[] = ['packages/runtime', 'packages/cli'];

/**
 * The supported Node range, written into every member manifest and the root. The floor on each
 * line is its first release carrying the 2026-10-21 security fixes (Node 22.23.4, 24.22.1 and 26.12.1);
 * Node 22 stays supported because five packages need only `Promise.withResolvers`.
 */
export const NODE_ENGINES_RANGE = '^22.23.4 || ^24.22.1 || >=26.12.1';

/** The package whose manifest the §3.4 safeguard-2 guard applies to. */
const DECORATOR_PLUGIN_DIR = 'packages/decorator-plugin';
const SYMBOL_METADATA_EXPORT = './dist/metadata/symbol-metadata.js';

/** Normalises a `deno.json` `exports` value (string or object form) to entries. */
export function normalizeExports(exports: unknown): readonly ExportEntry[] {
  if (typeof exports === 'string') return [{ subpath: '.', source: exports }];
  if (typeof exports === 'object' && exports !== null) {
    return Object.entries(exports as Record<string, string>).map(([subpath, source]) => ({
      subpath: subpath === '.' ? '.' : subpath,
      source,
    }));
  }
  return [];
}

/** Strips a `./src/`-rooted source path to its `dist/` twin for one extension. */
function distPath(source: string, extension: '.js' | '.d.ts'): string {
  const withoutLeading = source.replace(/^\.\//, '');
  const fromSrc = withoutLeading.replace(/^src\//, 'dist/');
  return `./${fromSrc.replace(/\.tsx?$/, extension)}`;
}

/** True when a specifier is workspace-internal (`@setu-ts/...` or a `jsr:` twin of one). */
function isWorkspaceSpecifier(specifier: string): boolean {
  return specifier.startsWith(WORKSPACE_SCOPE) || specifier.startsWith(`jsr:${WORKSPACE_SCOPE}`);
}

/** The bare package name behind a workspace specifier. */
function workspaceName(specifier: string): string {
  return specifier.startsWith('jsr:') ? specifier.slice(4) : specifier;
}

/** True when a specifier is a relative path or a runtime builtin — never a dependency. */
function isRelativeOrBuiltin(specifier: string): boolean {
  return (
    specifier.startsWith('./') ||
    specifier.startsWith('../') ||
    specifier.startsWith('/') ||
    specifier.startsWith('node:')
  );
}

/**
 * The base package name behind a possibly-subpath specifier: `hono/jsx` →
 * `hono`, `@aws-sdk/client-s3/…` → `@aws-sdk/client-s3`. A `package.json`
 * dependency is keyed by the package, never by a subpath of it.
 */
export function basePackageName(specifier: string): string {
  const segments = specifier.split('/');
  return specifier.startsWith('@') ? segments.slice(0, 2).join('/') : (segments[0] ?? specifier);
}

/** The `EXTERNAL_RANGES` lookup, refusing an external the committed table does not carry. */
export function lookupRange(name: string, file: string, refusals: string[]): string | null {
  const range = EXTERNAL_RANGES[name];
  if (range === undefined) {
    refusals.push(
      `${file}: external "${name}" has no range in scripts/node-dependency-ranges.ts — ` +
        `add it (one range table for both toolchains, plan §3.1/§3.2)`,
    );
    return null;
  }
  return range;
}

/** The overrides that apply to one member. */
function overridesFor(dir: string): readonly Override[] {
  return OVERRIDES.filter((o) => o.package === dir);
}

/**
 * Classifies one member's edges into the three dependency fields plus its
 * project references (plan §3.1). Pure; every refusal it can produce names the
 * offending file and specifier.
 */
export function classifyMember(
  member: MemberInput,
  nameToDir: ReadonlyMap<string, string>,
): { classified: ClassifiedMember; refusals: string[] } {
  const refusals: string[] = [];
  const dependencies = new Map<string, string>();
  const peerDependencies = new Map<string, string>();
  const devDependencies = new Map<string, string>();
  const references = new Set<string>();

  const srcEdges: ImportEdge[] = [];
  const testEdges: ImportEdge[] = [];
  for (const [file, source] of member.files) {
    const edges = scanImportEdges(source, file);
    for (const edge of edges) {
      if (file.startsWith(`${member.dir}/src/`)) srcEdges.push(edge);
      else testEdges.push(edge);
    }
  }

  const noteRef = (depDir: string): void => {
    if (depDir !== member.dir) references.add(depDir);
  };

  // src edges.
  for (const edge of srcEdges) {
    if (isRelativeOrBuiltin(edge.specifier)) continue;
    if (isWorkspaceSpecifier(edge.specifier)) {
      // A subpath import (`@setu-ts/runtime/worker`) keys its dependency by the
      // BASE package — a dependency name cannot carry a path segment — and the
      // subpath resolves through that package's own exports map.
      const depName = basePackageName(workspaceName(edge.specifier));
      const depDir = nameToDir.get(depName);
      if (depDir === undefined) {
        refusals.push(`${edge.file}: imports "${edge.specifier}", which is not a workspace member`);
        continue;
      }
      dependencies.set(depName, 'workspace:^');
      noteRef(depDir);
      continue;
    }
    if (edge.specifier.startsWith('jsr:') || edge.specifier.startsWith('npm:')) {
      refusals.push(
        `${edge.file}: "${edge.specifier}" is a prefixed specifier in src — Node resolves ` +
          `neither npm: nor jsr: (plan §3.3). Rewrite it to a bare specifier.`,
      );
      continue;
    }
    if (edge.specifier.startsWith('@std/')) {
      refusals.push(
        `${edge.file}: "${edge.specifier}" is a Deno-only std alias in src (plan C1: nothing ` +
          `in src imports @std; the string belongs in generated-project text)`,
      );
      continue;
    }
    const packageName = basePackageName(edge.specifier);
    const range = lookupRange(packageName, edge.file, refusals);
    if (range === null) continue;
    if (edge.mode === 'value') {
      dependencies.set(packageName, range);
    } else if (!dependencies.has(packageName)) {
      peerDependencies.set(packageName, range);
      devDependencies.set(packageName, range);
    }
  }

  // A value import anywhere in src wins over a type/dynamic one elsewhere in
  // src, whichever file was scanned first: the peer+dev mirror exists so an
  // OPTIONAL load still resolves, which is moot once the package is required.
  for (const name of dependencies.keys()) {
    if (peerDependencies.delete(name)) devDependencies.delete(name);
  }

  // test-only edges (workspace or external; `jsr:`/`@std/` stay Deno-resolved until 111b).
  for (const edge of testEdges) {
    if (isRelativeOrBuiltin(edge.specifier)) continue;
    if (isWorkspaceSpecifier(edge.specifier)) {
      const name = basePackageName(workspaceName(edge.specifier));
      // A member's tests import it by its own name; a package that dev-depends
      // on itself is noise in every published manifest.
      if (name === member.name) continue;
      if (!dependencies.has(name) && !peerDependencies.has(name)) {
        devDependencies.set(name, 'workspace:^');
      }
      continue;
    }
    if (edge.specifier.startsWith('jsr:') || edge.specifier.startsWith('npm:')) continue;
    if (edge.specifier.startsWith('@std/')) continue;
    const packageName = basePackageName(edge.specifier);
    if (dependencies.has(packageName) || peerDependencies.has(packageName)) continue;
    const range = lookupRange(packageName, edge.file, refusals);
    if (range === null) continue;
    devDependencies.set(packageName, range);
  }

  // Classification overrides, each applied only when the scan actually found the dependency;
  // an override whose target is absent is itself a refusal (the table cannot drift ahead of the code).
  for (const override of overridesFor(member.dir)) {
    const scanned =
      dependencies.get(override.dependency) ??
      peerDependencies.get(override.dependency) ??
      devDependencies.get(override.dependency);
    if (scanned === undefined && override.kind === 'dev-dependency-types') {
      // A types companion is not itself imported; it must accompany its typed package.
      const typedName = override.dependency.replace(/^@types\//, '');
      const typed =
        peerDependencies.get(typedName) ??
        dependencies.get(typedName) ??
        devDependencies.get(typedName);
      if (typed === undefined) {
        refusals.push(
          `override ${member.dir} → ${override.dependency}: its typed package is not a ` +
            `dependency of this member (${override.reason})`,
        );
        continue;
      }
      const typesRange = lookupRange(override.dependency, member.dir, refusals);
      if (typesRange !== null) devDependencies.set(override.dependency, typesRange);
      continue;
    }
    if (scanned === undefined) {
      refusals.push(
        `override ${member.dir} → ${override.dependency} matches nothing this member imports ` +
          `(${override.reason}) — remove the override or restore the import`,
      );
      continue;
    }
    if (override.kind === 'regular-dependency') {
      peerDependencies.delete(override.dependency);
      devDependencies.delete(override.dependency);
      dependencies.set(override.dependency, scanned);
    } else if (override.kind === 'dev-dependency-types') {
      devDependencies.set(override.dependency, scanned);
    }
  }

  // Build tools every member needs to compile (pnpm's strict layout does not put
  // the root's .bin on a member script's PATH; the version is pinned exactly).
  for (const [tool, version] of Object.entries(BUILD_DEV_DEPENDENCIES)) {
    if (!devDependencies.has(tool) && !dependencies.has(tool)) {
      devDependencies.set(tool, version);
    }
  }
  if (DENO_TYPES_MEMBERS.includes(member.dir)) {
    devDependencies.set('@types/deno', '2.7.0');
  }

  return {
    classified: { dependencies, peerDependencies, devDependencies, references: [...references] },
    refusals,
  };
}

/**
 * Finds a `src`-level workspace dependency cycle across classified members
 * (dev-only edges are excluded: pnpm allows them and tsc gets no reference for
 * them). Returns the cycle as a readable path, or null when the graph is acyclic.
 */
export function findSrcCycle(
  members: readonly ClassifiedMember[],
  dirs: readonly string[],
): string | null {
  const index = new Map(dirs.map((d, i) => [d, i]));
  const color = new Uint8Array(dirs.length); // 0 unvisited, 1 on stack, 2 done
  const parent = new Int32Array(dirs.length).fill(-1);

  const dfs = (node: number): string | null => {
    color[node] = 1;
    for (const ref of members[node].references) {
      const next = index.get(ref);
      if (next === undefined) continue;
      if (color[next] === 1) {
        const cycle: string[] = [dirs[next], dirs[node]];
        let walk = node;
        while (walk !== next) {
          walk = parent[walk];
          if (walk === -1) break;
          cycle.push(dirs[walk]);
        }
        return cycle.reverse().join(' → ');
      }
      if (color[next] === 0) {
        parent[next] = node;
        const found = dfs(next);
        if (found !== null) return found;
      }
    }
    color[node] = 2;
    return null;
  };

  for (let i = 0; i < dirs.length; i += 1) {
    if (color[i] === 0) {
      const found = dfs(i);
      if (found !== null) return found;
    }
  }
  return null;
}

/** Renders one member's `package.json` content (two-space JSON, trailing newline). */
/**
 * The executables a member installs, as `package.json` `bin` maps (M111d §3.2).
 *
 * Each target is a module reached ONLY through `bin` — never through
 * `exports` — and is approved in `SIDE_EFFECT_MODULES`, since an executable
 * runs on load. Rendered here so `--check` compares it like every other field.
 */
export const BIN_ENTRIES: Readonly<Record<string, Readonly<Record<string, string>>>> = {
  'packages/cli': { setu: './dist/bin.js' },
  'packages/create': { create: './dist/bin.js' },
};

/** A dependency map as an object with its keys in code-unit order, independent of insertion order. */
function sortedRecord(map: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function renderPackageJson(member: MemberInput, classified: ClassifiedMember): string {
  const description = PACKAGE_METADATA[member.name.replace(/^@setu-ts\//, '')]?.description;
  if (description === undefined) throw new Error(`${member.name}: missing package description`);
  const effects = Object.keys(SIDE_EFFECT_MODULES)
    .filter((path) => path.startsWith(`${member.dir}/`))
    .map((path) => distPath(path.slice(member.dir.length + 1), '.js'));
  const exports: Record<string, { types: string; default: string }> = {};
  for (const entry of member.exports) {
    exports[entry.subpath] = {
      types: distPath(entry.source, '.d.ts'),
      default: distPath(entry.source, '.js'),
    };
  }
  const pkg: Record<string, unknown> = {
    name: member.name,
    version: member.version,
    description,
    repository: { type: 'git', url: REPOSITORY_URL, directory: member.dir },
    homepage: `https://github.com/setu-ts/setu-ts/tree/main/${member.dir}`,
    bugs: { url: 'https://github.com/setu-ts/setu-ts/issues' },
    publishConfig: { access: 'public' },
    sideEffects: effects.length === 0 ? false : effects,
    type: 'module',
    license: 'MIT',
    engines: { node: NODE_ENGINES_RANGE },
    files: ['dist', 'src', 'README.md', 'LICENSE', 'AGENT_CARD.md'],
    exports,
    ...(BIN_ENTRIES[member.dir] === undefined ? {} : { bin: BIN_ENTRIES[member.dir] }),
    scripts: { build: 'tsc -b' },
  };
  if (classified.dependencies.size > 0) {
    pkg.dependencies = sortedRecord(classified.dependencies);
  }
  if (classified.peerDependencies.size > 0) {
    const peers = sortedRecord(classified.peerDependencies);
    pkg.peerDependencies = peers;
    pkg.peerDependenciesMeta = Object.fromEntries(
      Object.keys(peers).map((name) => [name, { optional: true }]),
    );
  }
  if (classified.devDependencies.size > 0) {
    pkg.devDependencies = sortedRecord(classified.devDependencies);
  }
  return `${JSON.stringify(pkg, null, 2)}\n`;
}

/** The `extends` path from a member dir to the root `tsconfig.base.json`. */
function baseExtends(dir: string): string {
  const depth = dir.split('/').length;
  return `${'../'.repeat(depth)}tsconfig.base.json`;
}

/** The `references` path from one member dir to another. */
function relativeRef(from: string, to: string): string {
  const fromParts = from.split('/');
  const toParts = to.split('/');
  let common = 0;
  while (common < fromParts.length && fromParts[common] === toParts[common]) common += 1;
  const up = '../'.repeat(fromParts.length - common);
  return `${up}${toParts.slice(common).join('/')}`;
}

/** Renders one member's `tsconfig.json` content. */
export function renderTsconfig(member: MemberInput, classified: ClassifiedMember): string {
  const compilerOptions: Record<string, unknown> = {
    rootDir: 'src',
    outDir: 'dist',
  };
  if (DENO_TYPES_MEMBERS.includes(member.dir)) {
    compilerOptions.types = ['node', 'deno'];
  }
  const config: Record<string, unknown> = {
    extends: baseExtends(member.dir),
    compilerOptions,
    include: ['src'],
  };
  if (classified.references.length > 0) {
    config.references = classified.references
      .slice()
      .sort()
      .map((ref) => ({ path: relativeRef(member.dir, ref) }));
  }
  return `${JSON.stringify(config, null, 2)}\n`;
}

/** Renders the root solution `tsconfig.json` referencing every member. */
export function renderSolutionTsconfig(dirs: readonly string[]): string {
  return `${JSON.stringify(
    { files: [], references: dirs.map((dir) => ({ path: `./${dir}` })) },
    null,
    2,
  )}\n`;
}

/** Renders the root `package.json` (private workspace root, §3.2/§3.6). */
export function renderRootPackageJson(): string {
  return `${JSON.stringify(
    {
      name: 'setu-ts',
      private: true,
      packageManager: 'pnpm@12.11.2',
      engines: { node: NODE_ENGINES_RANGE },
      type: 'module',
      scripts: {
        check: 'tsc -p tsconfig.check.json --noEmit',
        'ci:local': 'node scripts/local-ci.ts',
        'check:apps': 'node scripts/check-apps.ts',
        'check:browser': 'node apps/full-stack/browser/harness.ts',
        'check:docs':
          'node scripts/check-docs.ts && node scripts/check-prose-assertions.ts && node scripts/check-example-behaviour.ts && node scripts/check-since-tags.ts && node scripts/check-changelog-coverage.ts && node scripts/generate-api-docs.ts --check',
        'check:since-tags': 'node scripts/check-since-tags.ts',
        'check:changelog-coverage': 'node scripts/check-changelog-coverage.ts',
        'check:api-docs': 'node scripts/generate-api-docs.ts --check',
        'check:compat':
          'SETU_TEST_MEMBER=packages/validation-plugin pnpm exec vitest run packages/validation-plugin/test/unit/validation-service.test.ts && SETU_TEST_MEMBER=packages/openapi-plugin pnpm exec vitest run packages/openapi-plugin/test/unit/zod-to-openapi.test.ts packages/openapi-plugin/test/unit/zod4-to-openapi.test.ts packages/openapi-plugin/test/unit/zod4-dedup.test.ts packages/openapi-plugin/test/integration/openapi-zod4-integration.test.ts && SETU_TEST_MEMBER=packages/database-plugin pnpm exec vitest run packages/database-plugin/test/integration/real-import.test.ts packages/database-plugin/test/integration/real-drizzle-adapter.test.ts',
        'check:script-coverage': 'pnpm run test:tooling:coverage',
        'docs:api': 'node scripts/generate-api-docs.ts',
        'release:docs': 'node scripts/generate-api-docs.ts',
        'check:plan': 'node scripts/plan-lint.ts',
        'check:node-build': 'node scripts/check-node-build.ts',
        'check:versions': 'node scripts/version-sweep.ts',
        'check:deploy': 'node scripts/check-deploy.ts',
        'deploy:render': 'node scripts/check-deploy.ts --render --write',
        test: 'node scripts/test-node.ts',
        'test:coverage': 'node scripts/test-node.ts --coverage',
        'test:coverage:pkg': 'node scripts/test-node.ts --coverage',
        audit: 'node scripts/audit.ts',
        'audit:ci': 'node scripts/audit.ts',
        'release:verify': 'node scripts/verify-release.ts',
        'release:bump': 'node scripts/bump-version.ts',
        'release:verify-repos': 'node scripts/verify-jsr-repos.ts',
        'release:resolved-set': 'node scripts/release-resolved-set.ts',
        'dependency:drift': 'node scripts/dependency-drift.ts',
        'release:create-packages': 'node scripts/create-jsr-packages.ts',
        'release:placeholders': 'node scripts/write-npm-placeholders.ts',
        'release:publish': 'node scripts/npm-publish.ts',
        'release:link-repos': 'node scripts/link-jsr-repos.ts',
        'release:archive-old-scope': 'node scripts/archive-old-scope.ts',
        'release:set-metadata': 'node scripts/set-jsr-metadata.ts',
        lint: 'eslint .',
        fmt: 'pnpm exec prettier --write . && deno fmt --no-config --line-width=100 --single-quote packages/sdk/test/fixtures/generated-client.ts packages/sdk/test/fixtures/inline-shapes-client.ts packages/sdk/test/fixtures/name-collision-client.ts packages/sdk/test/fixtures/params-client.ts packages/sdk/test/fixtures/redirect-client.ts',
        'fmt:check':
          'pnpm exec prettier --check . && deno fmt --no-config --line-width=100 --single-quote --check packages/sdk/test/fixtures/generated-client.ts packages/sdk/test/fixtures/inline-shapes-client.ts packages/sdk/test/fixtures/name-collision-client.ts packages/sdk/test/fixtures/params-client.ts packages/sdk/test/fixtures/redirect-client.ts',
        'docs:exports': 'node scripts/generate-package-exports.ts',
        'examples:manifest': 'node scripts/generate-example-manifest.ts',
        'test:deno-lane': 'node scripts/test-deno-lane.ts',
        'test:tooling': 'SETU_TEST_MEMBER=tooling vitest run',
        'test:tooling:coverage': 'SETU_TEST_MEMBER=tooling vitest run --coverage',
        format: 'prettier --write .',
        'format:check': 'prettier --check .',
      },
      devDependencies: {
        ...BUILD_DEV_DEPENDENCIES,
        ...TEST_DEV_DEPENDENCIES,
        ...LINT_DEV_DEPENDENCIES,
        typedoc: '0.28.20',
        yaml: '2.9.1',
        hono: EXTERNAL_RANGES.hono,
        zod: EXTERNAL_RANGES['zod-v4']!.replace('npm:zod@', ''),
        graphql: EXTERNAL_RANGES.graphql,
        'drizzle-orm': EXTERNAL_RANGES['drizzle-orm'],
      },
    },
    null,
    2,
  )}\n`;
}

/** Renders `tsconfig.base.json` — the eight strictness options verbatim plus the Node-build options (§3.6). */
export function renderTsconfigBase(): string {
  return `${JSON.stringify(
    {
      compilerOptions: {
        target: 'es2024',
        lib: ['es2024', 'esnext.decorators', 'dom', 'dom.iterable'],
        module: 'nodenext',
        moduleResolution: 'nodenext',
        strict: true,
        noUnusedLocals: true,
        noUnusedParameters: true,
        noImplicitReturns: true,
        noFallthroughCasesInSwitch: true,
        noImplicitOverride: true,
        exactOptionalPropertyTypes: true,
        useUnknownInCatchVariables: true,
        rewriteRelativeImportExtensions: true,
        declaration: true,
        declarationMap: true,
        sourceMap: true,
        isolatedDeclarations: true,
        composite: true,
        verbatimModuleSyntax: true,
        skipLibCheck: true,
        types: ['node'],
      },
    },
    null,
    2,
  )}\n`;
}

/**
 * §3.4 safeguard 2: `decorator-plugin`'s manifest may not carry a `sideEffects`
 * that lets a bundler drop `Symbol.metadata` installation. M111c emits an
 * explicit retention list; this guard remains the independent backstop.
 */
export function checkDecoratorSideEffects(dir: string, content: string): string | null {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(content) as Record<string, unknown>;
  } catch {
    return `${dir}/package.json is not valid JSON`;
  }
  const sideEffects = parsed.sideEffects;
  if (sideEffects === undefined) return null;
  if (sideEffects === false) {
    return (
      `${dir}/package.json declares "sideEffects": false — a bundler may drop ` +
      `${SYMBOL_METADATA_EXPORT}, and every decorated class then crashes at definition ` +
      `on Node and Bun (plan §3.4 safeguard 2)`
    );
  }
  if (Array.isArray(sideEffects) && !sideEffects.includes(SYMBOL_METADATA_EXPORT)) {
    return (
      `${dir}/package.json declares a sideEffects list omitting ${SYMBOL_METADATA_EXPORT} ` +
      `(plan §3.4 safeguard 2)`
    );
  }
  return null;
}

/**
 * Every bare external specifier `member` imports (src and tests), mapped to
 * `npm:<package>@<range><subpath>` from the committed range table.
 *
 * Why the member's `deno.json` carries these: Deno honours a workspace
 * member's `package.json` only for a program rooted INSIDE the workspace, while
 * an example application and a CLI e2e project type-check framework SOURCE
 * from outside it, where only the member's import map applies. Generating the
 * map from the same table as `package.json` keeps one source for both
 * toolchains (plan §10, correction 10). An external with no range is skipped
 * here — {@linkcode classifyMember} already refuses it by name.
 *
 * @param member - The member whose files are scanned
 * @returns Specifier → `npm:` target, unordered
 */
export function externalAliases(member: MemberInput): ReadonlyMap<string, string> {
  const aliases = new Map<string, string>();
  for (const [file, source] of member.files) {
    for (const edge of scanImportEdges(source, file)) {
      const spec = edge.specifier;
      if (isRelativeOrBuiltin(spec) || isWorkspaceSpecifier(spec)) continue;
      if (/^(npm|jsr):|^@std\//.test(spec)) continue;
      const base = basePackageName(spec);
      const range = EXTERNAL_RANGES[base];
      if (range === undefined) continue;
      const target = range.startsWith('npm:') ? range : `npm:${base}@${range}`;
      aliases.set(spec, `${target}${spec.slice(base.length)}`);
    }
  }
  return aliases;
}

/**
 * The member `deno.json` with its `imports` block regenerated: the bare
 * aliases from {@linkcode externalAliases} plus any `npm:`/`jsr:`-keyed pin
 * already present, sorted.
 *
 * Only the `imports` block is spliced; every other byte stays as `deno fmt`
 * wrote it, because re-serializing the whole file would unfold the short
 * arrays fmt keeps on one line. An empty result removes the block.
 *
 * @param raw - The committed `deno.json` text
 * @param aliases - The generated bare aliases
 * @returns The `deno.json` text to commit
 */
export function renderDenoJson(raw: string, aliases: ReadonlyMap<string, string>): string {
  const current = (JSON.parse(raw) as { imports?: Record<string, string> }).imports ?? {};
  const merged: Record<string, string> = {};
  const entries = [
    ...Object.entries(current).filter(([key]) => /^(npm|jsr):/.test(key)),
    ...aliases,
  ].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  for (const [key, value] of entries) merged[key] = value;

  const block =
    Object.keys(merged).length === 0
      ? ''
      : `"imports": ${JSON.stringify(merged, null, 2).replaceAll('\n', '\n  ')}`;
  const start = raw.search(/"imports"\s*:\s*\{/);
  if (start === -1) {
    if (block === '') return raw;
    const close = raw.lastIndexOf('}');
    const before = raw.slice(0, close).replace(/\s*$/, '');
    return `${before},\n  ${block}\n${raw.slice(close)}`;
  }
  const end = raw.indexOf('}', raw.indexOf('{', start)) + 1;
  if (block !== '') return `${raw.slice(0, start)}${block}${raw.slice(end)}`;
  // Removing the block takes its leading comma and indentation with it.
  const head = raw.slice(0, start).replace(/,\s*$/, '');
  return `${head}${raw.slice(end)}`;
}

/** Generates every committed file from the pure inputs. */
export function generateWorkspace(members: readonly MemberInput[], license = ''): GenerationResult {
  const files = new Map<string, string>();
  const refusals: string[] = [];

  const nameToDir = new Map<string, string>();
  for (const member of members) {
    if (nameToDir.has(member.name)) {
      refusals.push(`duplicate workspace member name: ${member.name}`);
      continue;
    }
    nameToDir.set(member.name, member.dir);
  }

  const classified: ClassifiedMember[] = [];
  const dirs: string[] = [];
  for (const member of members) {
    if (PACKAGE_METADATA[member.name.replace(/^@setu-ts\//, '')] === undefined) {
      refusals.push(`${member.name}: missing package description`);
    }
    const sourceFiles = new Map(
      [...member.files].filter(([file]) => file.startsWith(`${member.dir}/src/`)),
    );
    refusals.push(...auditSideEffects(sourceFiles).refusals);
    if (member.dir === DECORATOR_PLUGIN_DIR && member.currentPackageJson !== undefined) {
      const violation = checkDecoratorSideEffects(member.dir, member.currentPackageJson);
      if (violation !== null) refusals.push(violation);
    }
    const result = classifyMember(member, nameToDir);
    refusals.push(...result.refusals);
    classified.push(result.classified);
    dirs.push(member.dir);
  }

  const cycle = findSrcCycle(classified, dirs);
  if (cycle !== null) {
    refusals.push(
      `src-level workspace dependency cycle: ${cycle} — tsc project references must be ` +
        `acyclic (AI_GUIDELINES §11.3/§12.3)`,
    );
  }

  if (refusals.length > 0) return { files, refusals };

  for (let i = 0; i < members.length; i += 1) {
    const member = members[i] as MemberInput;
    const cls = classified[i] as ClassifiedMember;
    files.set(`${member.dir}/package.json`, renderPackageJson(member, cls));
    files.set(`${member.dir}/LICENSE`, license);
    files.set(`${member.dir}/tsconfig.json`, renderTsconfig(member, cls));
    files.set(`${member.dir}/deno.json`, renderDenoJson(member.denoJson, externalAliases(member)));
  }
  files.set('tsconfig.base.json', renderTsconfigBase());
  files.set('tsconfig.check.json', renderCheckTsconfig());
  files.set('tsconfig.json', renderSolutionTsconfig(dirs));
  files.set('package.json', renderRootPackageJson());
  return { files, refusals };
}

// ── I/O seam ──────────────────────────────────────────────────────────────────

/** Generate the standalone native-runtime lane's import map and strict options. */
export function renderLaneConfig(members: readonly MemberInput[], laneJson: string): string {
  const lane = JSON.parse(laneJson) as {
    imports: Record<string, string>;
    scopes: Record<string, Record<string, string>>;
  };
  const imports = { ...lane.imports };
  const permissions: Record<string, unknown> = {};
  for (const member of members) {
    if (DENO_LANE_TESTS.some((path) => path.startsWith(`${member.dir}/test/`))) {
      const manifest = JSON.parse(member.denoJson) as { test: { permissions: unknown } };
      permissions[member.dir.slice('packages/'.length)] = manifest.test.permissions;
    }
    for (const entry of member.exports) {
      const name = member.name + (entry.subpath === '.' ? '' : entry.subpath.slice(1));
      imports[name] = './' + relative(resolve('test/deno-lane'), resolve(member.dir, entry.source));
    }
  }
  const base = JSON.parse(renderTsconfigBase()) as {
    compilerOptions: Record<string, unknown>;
  };
  const options: Record<string, unknown> = {};
  for (const key of [
    'strict',
    'noUnusedLocals',
    'noUnusedParameters',
    'noImplicitReturns',
    'noFallthroughCasesInSwitch',
    'noImplicitOverride',
    'exactOptionalPropertyTypes',
    'useUnknownInCatchVariables',
  ])
    options[key] = base.compilerOptions[key];
  return (
    JSON.stringify(
      {
        compilerOptions: {
          ...options,
          lib: ['deno.ns', 'deno.window', 'dom', 'dom.iterable', 'esnext'],
        },
        nodeModulesDir: 'auto',
        permissions,
        imports,
        scopes: lane.scopes,
      },
      null,
      2,
    ) + '\n'
  );
}

/** Every `.ts`/`.tsx` file under `dir`, repository-relative. */
async function* walkSources(root: string, dir: string): AsyncGenerator<string> {
  // Sorted, because `readDir` yields filesystem order — which differs between
  // a developer's disk and a CI checkout, and so would reorder the generated
  // manifests and fail `--check` on a tree that is not out of date.
  const entries: Dirent[] = [];
  for await (const entry of await readdir(`${root}/${dir}`, { withFileTypes: true }))
    entries.push(entry);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* walkSources(root, path);
    } else if (entry.isFile() && /\.(ts|tsx|mts)$/.test(entry.name)) {
      yield path;
    }
  }
}

/** Reads one member's inputs from the tree under `root`. */
async function readMember(root: string, dir: string): Promise<MemberInput> {
  const denoJson = await readFile(`${root}/${dir}/deno.json`, 'utf8').catch(() => '');
  let config: { name?: string; version?: string; exports?: unknown } | null;
  try {
    config = JSON.parse(denoJson);
  } catch {
    config = null;
  }
  if (config === null || config.name === undefined || config.version === undefined) {
    throw new Error(`${dir}: no parsable deno.json with name+version`);
  }
  const files = new Map<string, string>();
  for (const sub of ['src', 'test']) {
    try {
      for await (const file of walkSources(root, `${dir}/${sub}`)) {
        files.set(file, await readFile(`${root}/${file}`, 'utf8'));
      }
    } catch {
      // No such directory: the member declares none.
    }
  }
  const currentPackageJson = await readFile(`${root}/${dir}/package.json`, 'utf8').catch(
    () => null,
  );
  return {
    dir,
    name: config.name,
    version: config.version,
    exports: normalizeExports(config.exports),
    denoJson,
    files,
    // Omitted, never `undefined`, when absent (exactOptionalPropertyTypes).
    ...(currentPackageJson === null ? {} : { currentPackageJson }),
  };
}

/** Reads framework members from the authored pnpm workspace inventory. */
async function readMembers(root: string): Promise<MemberInput[]> {
  const members: MemberInput[] = [];
  for (const entry of await workspaceMembers(root)) {
    members.push(await readMember(root, entry.replace(/^\.\//, '')));
  }
  return members;
}

/** The `--check` comparison: every generated file must match the tree byte for byte. */
async function checkAgainstTree(
  root: string,
  generated: ReadonlyMap<string, string>,
): Promise<string[]> {
  const differences: string[] = [];
  for (const [path, content] of generated) {
    let current: string;
    try {
      current = await readFile(`${root}/${path}`, 'utf8');
    } catch {
      differences.push(`${path}: missing (run node-manifests --write)`);
      continue;
    }
    if (current !== content) differences.push(`${path}: differs from the generated manifest`);
  }
  // Extra generated roots must not be absent from the tree in the other direction:
  // a member package.json that the generator would DELETE (member removed from the
  // workspace) is caught by the workspace-list check above, not here.
  return differences;
}

/**
 * Entry point. Returns the exit code rather than calling `Deno.exit` (testable).
 *
 * @param root - The workspace root; every generated path is relative to it
 */
export async function runNodeManifests(args: readonly string[], root = '.'): Promise<number> {
  const mode = args.includes('--write') ? 'write' : args.includes('--check') ? 'check' : null;
  if (mode === null) {
    console.error('usage: node-manifests.ts --check | --write');
    return 2;
  }
  const members = await readMembers(root);
  const { files: generated, refusals } = generateWorkspace(
    members,
    await readFile(`${root}/LICENSE`, 'utf8'),
  );
  const files = new Map(generated);
  if (refusals.length === 0) {
    const lane = await readFile(`${root}/test/deno-lane/deno.json`, 'utf8');
    files.set('test/deno-lane/lane.config.json', renderLaneConfig(members, lane));
    files.set('tsconfig.apps.json', renderAppsTsconfig());
    for (const app of await workspaceApps(root)) {
      files.set(`${app}/tsconfig.json`, renderAppTsconfig(app));
    }
  }
  if (refusals.length > 0) {
    for (const refusal of refusals) console.error(`✗ ${refusal}`);
    console.error(`${refusals.length} refusal(s).`);
    return 1;
  }
  if (mode === 'write') {
    for (const [path, content] of files) {
      const current = await readFile(`${root}/${path}`, 'utf8').catch(() => null);
      if (current !== content) {
        await mkdir(dirname(`${root}/${path}`), { recursive: true });
        await writeFile(`${root}/${path}`, content);
      }
    }
    console.log(`Wrote ${files.size} generated file(s).`);
    return 0;
  }
  const differences = await checkAgainstTree(root, files);
  if (differences.length > 0) {
    for (const difference of differences) console.error(`✗ ${difference}`);
    console.error(
      `${differences.length} drift(s) — run node-manifests --write after editing imports.`,
    );
    return 1;
  }
  console.log(`node-manifests --check: ${files.size} generated file(s) agree with the tree.`);
  return 0;
}

if (import.meta.main) {
  await (async () => {
    process.exitCode = await runNodeManifests(process.argv.slice(2));
    return;
  })();
}

/** Type-check both source and tests; the native Deno lane owns its exclusions. */
export function renderCheckTsconfig(): string {
  return (
    JSON.stringify(
      {
        extends: './tsconfig.base.json',
        compilerOptions: {
          composite: false,
          declaration: false,
          declarationMap: false,
          isolatedDeclarations: false,
          noEmit: true,
          allowImportingTsExtensions: true,
          jsx: 'react-jsx',
          jsxImportSource: 'hono/jsx',
          types: ['node', './packages/runtime/node_modules/@types/deno'],
          paths: sourcePaths(),
        },
        include: [
          'packages/*/src',
          'packages/*/test',
          'packages/starters/*/src',
          'packages/starters/*/test',
          'scripts',
          'test',
        ],
        exclude: [
          ...DENO_LANE_TESTS,
          ...DENO_ONLY_SOURCES,
          'test/deno-lane',
          'test/fixtures/snippets',
        ],
      },
      null,
      2,
    ) + '\n'
  );
}

/** The shared source aliases for repository and app type checking. */
export function sourcePaths(prefix = './'): Record<string, string[]> {
  const paths = {
    '@setu-ts/rest-starter': ['./packages/starters/rest-starter/src/index.ts'],
    '@setu-ts/microservice-starter': ['./packages/starters/microservice-starter/src/index.ts'],
    '@setu-ts/full-stack-starter': ['./packages/starters/full-stack-starter/src/index.ts'],
    '@setu-ts/*': ['./packages/*/src/index.ts'],
    '@setu-ts/runtime/worker': ['./packages/runtime/src/worker/define-worker-task.ts'],
    '@setu-ts/cli/main': ['./packages/cli/src/main.ts'],
    '@setu-ts/localization-plugin/format': ['./packages/localization-plugin/src/format/index.ts'],
  };
  return Object.fromEntries(
    Object.entries(paths).map(([key, values]) => [
      key,
      values.map((value) => prefix + value.slice(2)),
    ]),
  );
}

/** Root options for apps that consume source without emitting it. */
export function renderAppsTsconfig(): string {
  return (
    JSON.stringify(
      {
        extends: './tsconfig.base.json',
        compilerOptions: {
          noEmit: true,
          composite: false,
          declaration: false,
          declarationMap: false,
          isolatedDeclarations: false,
          allowImportingTsExtensions: true,
          rewriteRelativeImportExtensions: false,
          typeRoots: ['./node_modules/@types', './packages/runtime/node_modules/@types'],
          types: ['node', 'deno'],
          paths: sourcePaths(),
        },
      },
      null,
      2,
    ) + '\n'
  );
}

/** Generated per-app roots; full-stack replaces paths to add its React route alias. */
export function renderAppTsconfig(app: string): string {
  return (
    JSON.stringify(
      {
        extends: '../../tsconfig.apps.json',
        ...(app === 'apps/full-stack'
          ? {
              compilerOptions: {
                jsx: 'react-jsx',
                paths: { ...sourcePaths('../../'), '~/*': ['./app/*'] },
              },
            }
          : {}),
        include: [
          '**/*.ts',
          '**/*.tsx',
          ...(app === 'apps/full-stack' ? ['node_modules/vite/client.d.ts'] : []),
        ],
      },
      null,
      2,
    ) + '\n'
  );
}
