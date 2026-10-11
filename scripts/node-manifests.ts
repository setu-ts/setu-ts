// deno-lint-ignore-file no-console -- a gate prints what it found (AI_GUIDELINES §11.5/§11.6)
/**
 * The Node-manifest generator and drift gate (M111a plan §3.1).
 *
 * Writes every workspace member's `package.json` and `tsconfig.json`, the root
 * solution `tsconfig.json`, `pnpm-workspace.yaml`, and the root `package.json`
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
 *   deno run --allow-read --allow-write scripts/node-manifests.ts --write
 *   deno run --allow-read scripts/node-manifests.ts --check
 *
 * @module
 */

import { type ImportEdge, scanImportEdges } from './npm-specifier-audit.ts';
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
  'typescript': '6.0.3',
  '@types/node': '^24',
};

/** The members whose `src` references the `Deno` global get its ambient types (plan §3.6). */
const DENO_TYPES_MEMBERS: readonly string[] = ['packages/runtime', 'packages/cli'];

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
export function lookupRange(
  name: string,
  file: string,
  refusals: string[],
): string | null {
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
        refusals.push(
          `${edge.file}: imports "${edge.specifier}", which is not a workspace member`,
        );
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
    const scanned = dependencies.get(override.dependency) ??
      peerDependencies.get(override.dependency) ??
      devDependencies.get(override.dependency);
    if (scanned === undefined && override.kind === 'dev-dependency-types') {
      // A types companion is not itself imported; it must accompany its typed package.
      const typed = peerDependencies.get(override.dependency.replace(/^@types\//, ''));
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
/** A dependency map as an object with its keys in code-unit order, independent of insertion order. */
function sortedRecord(map: ReadonlyMap<string, string>): Record<string, string> {
  return Object.fromEntries([...map].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)));
}

export function renderPackageJson(member: MemberInput, classified: ClassifiedMember): string {
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
    type: 'module',
    license: 'MIT',
    engines: { node: '>=22' },
    files: ['dist', 'README.md'],
    exports,
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
  return `${
    JSON.stringify(
      { files: [], references: dirs.map((dir) => ({ path: `./${dir}` })) },
      null,
      2,
    )
  }\n`;
}

/**
 * Renders `pnpm-workspace.yaml`, listing every member explicitly.
 *
 * `ignoreWorkspaceCycles` is load-bearing, not a workaround: the TEST-only
 * workspace edges are cyclic by design (kernel's tests import runtime and
 * testing; runtime's tests import kernel — the plan's §1 probe recorded that
 * 40 of 51 members' tests import packages their src does not), pnpm's
 * resolver allows them, and `pnpm -r` refuses only the topological ORDERING.
 * Each member's build is `tsc -b`, which orders its own project references,
 * so an arbitrary member order is correct.
 *
 * `allowBuilds` DENIES the two dependencies that ship install scripts
 * (`protobufjs`, `sse4_crc32`, both reached only through the Google Cloud
 * SDKs). pnpm 12 fails `install --frozen-lockfile` with ERR_PNPM_IGNORED_BUILDS
 * while a script is undecided, and approving one would run third-party code on
 * every install for a dependency no test exercises for real.
 */
export function renderPnpmWorkspace(dirs: readonly string[]): string {
  const lines = dirs.map((dir) => `  - ${dir}`);
  return (
    `packages:\n${lines.join('\n')}\n` +
    '\n' +
    '# Dev-only workspace edges are cyclic (test-only imports, plan §3.1); each\n' +
    "# member's build is `tsc -b`, which orders its own references.\n" +
    'ignoreWorkspaceCycles: true\n' +
    '\n' +
    '# Install scripts are denied, never approved: both are transitive deps of\n' +
    '# the Google Cloud SDKs the tests reach only through fakes and guarded\n' +
    '# suites. pnpm 12 refuses a frozen install while either is undecided.\n' +
    'allowBuilds:\n' +
    '  protobufjs: false\n' +
    '  sse4_crc32: false\n'
  );
}

/** Renders the root `package.json` (private workspace root, §3.2/§3.6). */
export function renderRootPackageJson(dirs: readonly string[]): string {
  return `${
    JSON.stringify(
      {
        name: 'setu-ts',
        private: true,
        packageManager: 'pnpm@12.11.2',
        engines: { node: '>=22' },
        workspaces: dirs,
        devDependencies: { ...BUILD_DEV_DEPENDENCIES },
      },
      null,
      2,
    )
  }\n`;
}

/** Renders `tsconfig.base.json` — the eight strictness options verbatim plus the Node-build options (§3.6). */
export function renderTsconfigBase(): string {
  return `${
    JSON.stringify(
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
    )
  }\n`;
}

/**
 * §3.4 safeguard 2: `decorator-plugin`'s manifest may not carry a `sideEffects`
 * that lets a bundler drop `Symbol.metadata` installation. In 111a no manifest
 * declares `sideEffects`; the guard is for 111c.
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
      aliases.set(spec, `npm:${base}@${range}${spec.slice(base.length)}`);
    }
  }
  return aliases;
}

/**
 * The member `deno.json` with its `imports` block regenerated: the bare
 * aliases from {@linkcode externalAliases} plus any `npm:`/`jsr:`-keyed pin
 * already present (openapi-plugin's two zod majors, kept until 111b), sorted.
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

  const block = Object.keys(merged).length === 0
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
export function generateWorkspace(members: readonly MemberInput[]): GenerationResult {
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
    files.set(`${member.dir}/tsconfig.json`, renderTsconfig(member, cls));
    files.set(`${member.dir}/deno.json`, renderDenoJson(member.denoJson, externalAliases(member)));
  }
  files.set('tsconfig.base.json', renderTsconfigBase());
  files.set('tsconfig.json', renderSolutionTsconfig(dirs));
  files.set('pnpm-workspace.yaml', renderPnpmWorkspace(dirs));
  files.set('package.json', renderRootPackageJson(dirs));
  return { files, refusals };
}

// ── I/O seam ──────────────────────────────────────────────────────────────────

/** Reads a JSON file, or null when absent/unparseable. */
async function readJson(path: string): Promise<unknown | null> {
  try {
    return JSON.parse(await Deno.readTextFile(path));
  } catch {
    return null;
  }
}

/** Every `.ts`/`.tsx` file under `dir`, repository-relative. */
async function* walkSources(root: string, dir: string): AsyncGenerator<string> {
  // Sorted, because `readDir` yields filesystem order — which differs between
  // a developer's disk and a CI checkout, and so would reorder the generated
  // manifests and fail `--check` on a tree that is not out of date.
  const entries: Deno.DirEntry[] = [];
  for await (const entry of Deno.readDir(`${root}/${dir}`)) entries.push(entry);
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const path = `${dir}/${entry.name}`;
    if (entry.isDirectory) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      yield* walkSources(root, path);
    } else if (entry.isFile && /\.(ts|tsx|mts)$/.test(entry.name)) {
      yield path;
    }
  }
}

/** Reads one member's inputs from the tree under `root`. */
async function readMember(root: string, dir: string): Promise<MemberInput> {
  const denoJson = await Deno.readTextFile(`${root}/${dir}/deno.json`).catch(() => '');
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
        files.set(file, await Deno.readTextFile(`${root}/${file}`));
      }
    } catch {
      // No such directory: the member declares none.
    }
  }
  const currentPackageJson = await Deno.readTextFile(`${root}/${dir}/package.json`).catch(() =>
    null
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

/** Reads the workspace layout from the `deno.json` under `root`. */
async function readMembers(root: string): Promise<MemberInput[]> {
  const config = (await readJson(`${root}/deno.json`)) as { workspace?: readonly string[] } | null;
  if (config?.workspace === undefined) throw new Error('deno.json: no workspace list');
  const members: MemberInput[] = [];
  for (const entry of config.workspace) {
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
      current = await Deno.readTextFile(`${root}/${path}`);
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
  const { files, refusals } = generateWorkspace(members);
  if (refusals.length > 0) {
    for (const refusal of refusals) console.error(`✗ ${refusal}`);
    console.error(`${refusals.length} refusal(s).`);
    return 1;
  }
  if (mode === 'write') {
    for (const [path, content] of files) {
      const current = await Deno.readTextFile(`${root}/${path}`).catch(() => null);
      if (current !== content) await Deno.writeTextFile(`${root}/${path}`, content);
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
  Deno.exit(await runNodeManifests(Deno.args));
}
