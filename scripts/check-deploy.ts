/* eslint-disable no-console -- this CI script reports progress, drift and skips. */

/**
 * @module
 *
 * Deployment gate (M39): proves the container images build, the committed Kubernetes manifests
 * still match the chart they are rendered from, the Compose model resolves, and — with a real
 * cluster — that the manifests actually deploy and serve.
 *
 * Since M95a it also proves the deployment a USER gets: a workspace the CLI scaffolds is built
 * with its own generated Dockerfile and must serve `/health` under the security posture the
 * generated manifest sets — a read-only root filesystem and no external network.
 *
 * Modes are separable so the fast structural checks stay usable on every run while the slow
 * cluster proof is opt-in locally and mandatory in CI:
 *
 * ```
 * pnpm run check:deploy                 # render + build + compose + generated
 * pnpm run check:deploy --render        # rendered manifests match the chart
 * pnpm run check:deploy --cluster       # real kind apply + serve + RBAC
 * pnpm run check:deploy --generated     # scaffold → build its image → serve it air-gapped
 * pnpm run check:deploy --workspace     # scaffold a workspace → root test → setu workspace deploy
 * ```
 *
 * A mode whose tooling is absent exits with {@linkcode SKIP_EXIT_CODE} (77) — the same code
 * `scripts/check-apps.ts` reserves — so a missing prerequisite can never read as a pass.
 */

import { randomBytes } from 'node:crypto';
import { stripVTControlCharacters } from 'node:util';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { run as runProcess } from './lib/run.ts';
import { startRegistryOverlay } from './registry-overlay.ts';
import { stat, readdir, readFile, mkdir, mkdtemp, rm, writeFile, rename } from 'node:fs/promises';

/** Exit code reserved for "this check reported a skip", matching `scripts/check-apps.ts`. */
export const SKIP_EXIT_CODE = 77;

/** Examples the image build matrix covers, each chosen for a distinct build property. */
export const BUILD_MATRIX: readonly BuildTarget[] = [
  { app: 'minimal', dockerfile: 'docker/Dockerfile', tag: 'setu/minimal:m39' },
  { app: 'rest-api', dockerfile: 'docker/Dockerfile', tag: 'setu/rest-api:m39' },
  { app: 'realtime', dockerfile: 'docker/Dockerfile', tag: 'setu/realtime:m39' },
  {
    app: 'compiled-binary',
    dockerfile: 'docker/Dockerfile.compiled',
    tag: 'setu/compiled:m39',
  },
];

/**
 * Examples the build matrix does NOT cover, each with the reason and WHY it is not covered.
 *
 * Named rather than silently omitted: a reader must be able to tell "cannot be containerized"
 * from "would add no coverage" from "nobody got round to it". `test/deploy-gate.test.ts` asserts
 * every `apps/` directory appears either here or in {@linkcode BUILD_MATRIX}, so a new example
 * has to be classified deliberately.
 */
export const EXCLUDED_EXAMPLES: readonly ExcludedExample[] = [
  {
    app: 'cloudflare',
    kind: 'unsupported',
    reason:
      'Deploys with `wrangler deploy`, not a container — a Worker has no listen(), so an image of it would be a fiction that builds green.',
  },
  {
    app: 'full-stack',
    kind: 'unsupported',
    reason:
      'Needs the React Router / Vite frontend build first, which is a genuinely different image shape than the server-only examples.',
  },
  {
    app: 'graphql-demo',
    kind: 'unsupported',
    reason:
      'Carries npm client dependencies used only by its manual interop suite; it is not a deployable service.',
  },
  {
    app: 'microservices',
    kind: 'unsupported',
    reason:
      'Its main.ts starts both services, makes its calls and stops in a finally — a self-terminating script, not a server, so an image would exit immediately.',
  },
  // The rest ARE containerizable — `docker build --build-arg APP=<name>` works for each — but
  // they differ from the matrix only in which plugins they import, and the build path does not
  // branch on that. Building all of them would multiply gate runtime for no new coverage.
  {
    app: 'cqrs',
    kind: 'redundant',
    reason: 'Same build shape as rest-api; differs only in the plugins it imports.',
  },
  {
    app: 'database',
    kind: 'redundant',
    reason: 'Same build shape as rest-api; differs only in the plugins it imports.',
  },
  {
    app: 'di-decorators',
    kind: 'redundant',
    reason: 'Same build shape as rest-api; differs only in the plugins it imports.',
  },
  {
    app: 'grpc',
    kind: 'redundant',
    reason: 'Same build shape as rest-api; differs only in the plugins it imports.',
  },
  {
    app: 'multi-tenant',
    kind: 'redundant',
    reason: 'Same build shape as rest-api; differs only in the plugins it imports.',
  },
  {
    app: 'plugin-development',
    kind: 'redundant',
    reason: 'Same build shape as minimal; differs only in the plugins it imports.',
  },
  {
    app: 'realtime-clients',
    kind: 'redundant',
    reason:
      'Its smoke harness starts an ephemeral server; it has no long-lived production image to build.',
  },
  {
    app: 'static-site',
    kind: 'redundant',
    reason: 'Same build shape as minimal; differs only in the plugins it imports.',
  },
  {
    app: 'worker-pool',
    kind: 'redundant',
    reason:
      'Same server image shape as minimal; worker behavior is exercised by its real-thread smoke.',
  },
];

/** One entry in the image build matrix. */
export interface BuildTarget {
  /** Directory name under `apps/`. */
  readonly app: string;
  /** Dockerfile path, repo-root relative. */
  readonly dockerfile: string;
  /** Image tag to build. */
  readonly tag: string;
}

/** An example excluded from the build matrix, with the reason it is excluded. */
export interface ExcludedExample {
  /** Directory name under `apps/`. */
  readonly app: string;
  /**
   * `unsupported` — it cannot meaningfully be containerized at all.
   * `redundant` — an image builds fine, but covers no build behaviour the matrix lacks.
   */
  readonly kind: 'unsupported' | 'redundant';
  /** Why no image is built for it. Never empty. */
  readonly reason: string;
}

/** Which checks a run should perform. */
export interface ModeSet {
  readonly render: boolean;
  readonly build: boolean;
  readonly compose: boolean;
  readonly cluster: boolean;
  /**
   * Scaffold a workspace with the CLI, build its GENERATED Dockerfile, and run the image under
   * `--read-only` with no external network until it serves `/health` (M95a). Every other mode
   * proves this repository's own deployment objects; this is the only one that proves what a
   * user deploys.
   */
  readonly generated: boolean;
  /**
   * Scaffold a Node workspace with a `rest` and a `full-stack` member, run its root `test`, and
   * deploy it into kind with `setu workspace deploy` (M122): rollouts, a request through each
   * Service, the Secret reaching the pod, and the refusal without one. Without a cluster tool it
   * reports a skip, like `--cluster`.
   */
  readonly workspace: boolean;
  /**
   * Render mode rewrites `k8s/manifests/` instead of failing on drift.
   *
   * One implementation serves both directions — the `scripts/generate-api-docs.ts` precedent —
   * so the checker and the generator can never disagree about how a manifest is produced.
   */
  readonly write: boolean;
}

/** Result of one check: passed, failed, or skipped for want of tooling. */
export type CheckOutcome = 'passed' | 'failed' | 'skipped';

/** Difference between the freshly rendered manifests and the committed ones. */
export interface DriftReport {
  /** Rendered but not committed. */
  readonly added: readonly string[];
  /** Committed but no longer rendered. */
  readonly removed: readonly string[];
  /** Present in both with differing content. */
  readonly changed: readonly string[];
}

const DEFAULT_MODES: ModeSet = {
  render: true,
  build: true,
  compose: true,
  cluster: false,
  generated: true,
  workspace: false,
  write: false,
};

const ALL_MODE_FLAGS = [
  '--render',
  '--build',
  '--compose',
  '--cluster',
  '--generated',
  '--workspace',
  '--write',
] as const;

/**
 * Turns argv into the set of checks to run.
 *
 * With no mode flag the default set runs (render + build + compose); naming any flag runs exactly
 * the named ones. An unrecognized flag is REFUSED rather than ignored, so a typo cannot silently
 * reduce the gate to nothing.
 *
 * @param args - Raw arguments, typically `process.argv.slice(2)`
 * @returns The modes to run
 * @throws {Error} If an argument is not one of the known mode flags
 */
export function parseModes(args: readonly string[]): ModeSet {
  if (args.length === 0) return DEFAULT_MODES;
  // `--write` is a modifier, not a mode: on its own it would select no checks at all.
  if (args.every((arg) => arg === '--write')) {
    throw new Error('--write modifies --render; it selects no check on its own');
  }

  const unknown = args.filter((arg) => !(ALL_MODE_FLAGS as readonly string[]).includes(arg));
  if (unknown.length > 0) {
    throw new Error(
      `Unknown flag(s): ${unknown.join(', ')}. Known flags: ${ALL_MODE_FLAGS.join(', ')}`,
    );
  }

  return {
    render: args.includes('--render'),
    build: args.includes('--build'),
    compose: args.includes('--compose'),
    cluster: args.includes('--cluster'),
    generated: args.includes('--generated'),
    workspace: args.includes('--workspace'),
    write: args.includes('--write'),
  };
}

/**
 * Compares freshly rendered manifests against the committed ones.
 *
 * Both maps are keyed by file name. An empty render against a non-empty committed set reports
 * every committed file as `removed`, so a render that silently produced nothing fails loudly
 * rather than passing vacuously.
 *
 * @param rendered - Freshly rendered manifests, by file name
 * @param committed - Committed manifests, by file name
 * @returns The added, removed and changed file names, each sorted
 */
export function renderDrift(
  rendered: ReadonlyMap<string, string>,
  committed: ReadonlyMap<string, string>,
): DriftReport {
  const added: string[] = [];
  const removed: string[] = [];
  const changed: string[] = [];

  for (const [name, content] of rendered) {
    const existing = committed.get(name);
    if (existing === undefined) {
      added.push(name);
    } else if (existing !== content) {
      changed.push(name);
    }
  }
  for (const name of committed.keys()) {
    if (!rendered.has(name)) removed.push(name);
  }

  return {
    added: added.sort(),
    removed: removed.sort(),
    changed: changed.sort(),
  };
}

/** True when the report records no difference at all. */
export function isClean(report: DriftReport): boolean {
  return report.added.length === 0 && report.removed.length === 0 && report.changed.length === 0;
}

/**
 * Returns the required tools that are absent, in the order given.
 *
 * @param required - Tool names the mode needs
 * @param present - Tool names found on PATH
 * @returns The missing names, so a skip message can say which
 */
/**
 * The last lines of a failed step's captured output, indented for the report.
 *
 * A quiet step's output is otherwise discarded, so a failed image build printed only a cross
 * mark: a CI failure then gave no reason to read (M111e3).
 *
 * @param output - The step's combined stdout and stderr
 * @param lines - How many trailing non-blank lines to keep
 * @returns The indented tail, or an empty string when there was no output
 */
export function failureTail(output: string, lines = 30): string {
  return output
    .split('\n')
    .filter((line) => line.trim() !== '')
    .slice(-lines)
    .map((line) => `      ${line}`)
    .join('\n');
}

export function missingTools(required: readonly string[], present: readonly string[]): string[] {
  return required.filter((tool) => !present.includes(tool));
}

/**
 * Absolute paths at which `tool` would be found, given a `PATH` value.
 *
 * Presence is resolved by LOOKING for the executable rather than by running it with a guessed
 * version flag. Version flags are not uniform — `helm --version` exits 1 (it wants a bare
 * `version`), and `kubectl --version` exits 1 (it wants `version --client`) — and probing with
 * the wrong one reports an INSTALLED tool as missing, which becomes a false SKIP: a gate that
 * checked nothing while exiting like it had. A path lookup cannot rot as those CLIs change.
 *
 * @param tool - Executable name
 * @param pathValue - The `PATH` environment value; empty yields no candidates
 * @returns Candidate absolute paths, in `PATH` order
 */
export function pathCandidates(tool: string, pathValue: string): string[] {
  return pathValue
    .split(':')
    .filter((entry) => entry.length > 0)
    .map((entry) => `${entry.replace(/\/$/, '')}/${tool}`);
}

async function onPath(tool: string): Promise<boolean> {
  for (const candidate of pathCandidates(tool, process.env['PATH'] ?? '')) {
    try {
      const info = await stat(candidate);
      if (info.isFile() || info.isSymbolicLink()) return true;
    } catch {
      // Not at this PATH entry; try the next.
      continue;
    }
  }
  return false;
}

async function run(
  command: readonly string[],
  options: {
    readonly quiet?: boolean;
    readonly cwd?: string;
    readonly env?: Readonly<Record<string, string>>;
  } = {},
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const quiet = options.quiet === true;
  const output = await runProcess(command[0]!, command.slice(1), {
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    ...(options.env === undefined ? {} : { env: { ...process.env, ...options.env } }),
    inherit: !quiet,
  });
  return {
    success: output.code === 0,
    // `output.stdout` throws when the stream was inherited rather than piped, so both are only
    // read in the quiet case. Callers that need either always pass quiet.
    stdout: quiet ? output.stdout : '',
    // Where kubectl puts the reason a wait timed out, which is the one thing worth printing when
    // the probe pod never reaches a terminal phase.
    stderr: quiet ? output.stderr : '',
  };
}

async function readManifestDir(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const entry of await readdir(directory, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith('.yaml')) {
      files.set(entry.name, await readFile(`${directory}/${entry.name}`, 'utf8'));
    }
  }
  return files;
}

async function checkRender(write: boolean): Promise<CheckOutcome> {
  console.log('\n▸ render: committed manifests match the chart');

  if (!(await onPath('helm'))) {
    console.log('  SKIP — missing tool(s): helm');
    return 'skipped';
  }

  const temporary = await await mkdir('.tmp', { recursive: true }).then(() =>
    mkdtemp('.tmp/test-'),
  );
  try {
    const rendered = await run(
      [
        'helm',
        'template',
        'setu',
        'k8s/chart',
        '-f',
        'k8s/render-values.yaml',
        // Pinned, and it must match NAMESPACE below. `helm template` defaults Release.Namespace to
        // "default", which silently produced a RoleBinding whose ServiceAccount subject named the
        // wrong namespace — the objects applied fine and the app simply had no permission.
        '--namespace',
        NAMESPACE,
        '--output-dir',
        temporary,
      ],
      { quiet: true },
    );
    if (!rendered.success) {
      console.error('  helm template failed');
      return 'failed';
    }

    const fresh = await readManifestDir(`${temporary}/setu-ts/templates`);
    const committed = await readManifestDir(MANIFEST_DIR);
    if (write) {
      for (const name of committed.keys()) {
        if (!fresh.has(name)) await rm(`${MANIFEST_DIR}/${name}`);
      }
      for (const [name, content] of fresh) {
        await writeFile(`${MANIFEST_DIR}/${name}`, content);
      }
      console.log(`  ✓ wrote ${fresh.size} manifest(s) to ${MANIFEST_DIR}/`);
      return 'passed';
    }

    const report = renderDrift(fresh, committed);

    if (isClean(report)) {
      console.log(`  ✓ ${committed.size} manifest(s) up to date`);
      return 'passed';
    }

    console.error('  ✗ k8s/manifests/ is out of date with k8s/chart/');
    for (const name of report.added) console.error(`      + ${name} (rendered, not committed)`);
    for (const name of report.removed) console.error(`      - ${name} (committed, not rendered)`);
    for (const name of report.changed) console.error(`      ~ ${name} (content differs)`);
    console.error('    Re-render with: pnpm run deploy:render');
    return 'failed';
  } finally {
    await rm(temporary, { recursive: true });
  }
}

async function checkBuild(): Promise<CheckOutcome> {
  console.log('\n▸ build: container images');

  if (!(await onPath('docker'))) {
    console.log('  SKIP — missing tool(s): docker');
    return 'skipped';
  }

  // Report what is deliberately NOT built, so "excluded on purpose" is visible to whoever runs
  // the gate rather than living only in a test assertion.
  for (const excluded of EXCLUDED_EXAMPLES) {
    if (excluded.kind === 'unsupported') {
      console.log(`  – ${excluded.app} (not containerizable): ${excluded.reason}`);
    }
  }
  const redundant = EXCLUDED_EXAMPLES.filter((e) => e.kind === 'redundant').map((e) => e.app);
  console.log(
    `  – ${redundant.length} example(s) buildable but not gated: ${redundant.join(', ')}`,
  );

  let ok = true;
  for (const target of BUILD_MATRIX) {
    const built = await run(
      [
        'docker',
        'build',
        '--quiet',
        '-f',
        target.dockerfile,
        '--build-arg',
        `APP=${target.app}`,
        '-t',
        target.tag,
        '.',
      ],
      { quiet: true },
    );
    console.log(`  ${built.success ? '✓' : '✗'} ${target.app} → ${target.tag}`);
    if (!built.success) {
      ok = false;
      const tail = failureTail(`${built.stdout}\n${built.stderr}`);
      if (tail !== '') console.error(tail);
    }
  }
  return ok ? 'passed' : 'failed';
}

async function checkCompose(): Promise<CheckOutcome> {
  console.log('\n▸ compose: local development stack');

  if (!(await onPath('docker'))) {
    console.log('  SKIP — missing tool(s): docker');
    return 'skipped';
  }

  let ok = true;
  for (const args of [
    ['docker', 'compose', '-f', 'docker/compose.yaml', 'config'],
    ['docker', 'compose', '-f', 'docker/compose.yaml', '--profile', 'telemetry', 'config'],
  ]) {
    const result = await run(args, { quiet: true });
    const label = args.includes('telemetry') ? 'telemetry profile' : 'default profile';
    console.log(`  ${result.success ? '✓' : '✗'} ${label} resolves`);
    if (!result.success) ok = false;
  }
  return ok ? 'passed' : 'failed';
}

/**
 * Parameters of the generated-deployment proof, fixed rather than derived.
 *
 * Every value is a CONSTANT so two runs produce byte-identical scaffolds: Docker layers key on
 * file content, so an identical `deno.json` turns the second run's build into cache hits instead
 * of a second full jsr.io resolution. A different port or workspace name per run would be
 * uncacheable by construction.
 */
const GENERATED_WORKSPACE = 'acme';
const GENERATED_MEMBER = 'orders';
const GENERATED_PORT = 3000;
const GENERATED_IMAGE_PREFIX = 'setu/generated-gate:m95a';
const GENERATED_CONTAINER_PREFIX = 'setu-generated-gate';
/** Extra generated image case proving the CSS build is copied into production. */
export const GENERATED_VIEW_CASE = 'node-rest-view';
const GENERATED_PROBE_ATTEMPTS = 120;
const GENERATED_PROBE_INTERVAL_MS = 1_000;

/**
 * The `setu` arguments that add the generated gate's member: a microservice WITH the devtool, so
 * every built image is proved to exclude what `--devtool` adds (M101f V8-21) — a member without it
 * would make the exclusion check below pass vacuously.
 */
export const GENERATED_MEMBER_ARGS: readonly string[] = [
  'g',
  'app',
  GENERATED_MEMBER,
  '--devtool',
  '--template',
  'microservice',
];

/**
 * The manifest layouts each built: a commented `deno.json`, a `deno.jsonc`, and a member whose
 * imports are inherited from the workspace root — the import pruning must hold in all three.
 */
export const GENERATED_LAYOUTS: readonly string[] = [
  'commented-json',
  'jsonc',
  'inherited-imports',
];

/**
 * The shell check run inside the built image: no development entry, and no connector PACKAGE in
 * the module cache or the project's `node_modules`.
 *
 * It matches package PATHS, never file contents: the framework now installs from npm, whose
 * tarballs carry each package's README, and the events and queue READMEs name the connector in
 * prose — a content grep reported both as cached connector source. The first clause is a positive
 * control: a cache that moved, or holds no framework package at all, would otherwise let the
 * absence check pass without having looked anywhere.
 */
export const PRODUCTION_DEVTOOL_PROBE: string = [
  `test -n "$(find /deno-dir -path '*@setu-ts/kernel*' -print -quit)"`,
  `test ! -e /srv/apps/${GENERATED_MEMBER}/main.dev.ts`,
  // `|| true`: a member with no `node_modules` makes find exit non-zero, which must not end the
  // chain before the absence is checked.
  `found="$(find /deno-dir /srv/node_modules -path '*diagnostics-plugin*' 2>/dev/null || true)"`,
  `echo "$found"`,
  `test -z "$found"`,
].join(' && ');

/**
 * Converts a file URL into the native path `Deno.Command` expects.
 *
 * `URL.pathname` deliberately retains percent encoding, which makes a checkout path containing a
 * space become a nonexistent `%20` path when it is passed to `deno run`.
 *
 * @param fileUrl - The source file URL
 * @returns The decoded native filesystem path
 */
export function nativeFilePath(fileUrl: URL): string {
  return fileURLToPath(fileUrl);
}

/**
 * How the gate runs the CLI: as the published `setu` binary runs — `src/bin.ts` on Node, its
 * TypeScript loaded through `tsx` and `@setu-ts/*` mapped to this tree's sources. Absolute, because
 * scaffold steps run with the WORKSPACE as their cwd.
 */
export const CLI_COMMAND: readonly string[] = [
  'node',
  '--import',
  new URL('../scripts/lib/source-register.ts', import.meta.url).href,
  '--import',
  new URL('../packages/cli/node_modules/tsx/dist/esm/index.mjs', import.meta.url).href,
  nativeFilePath(new URL('../packages/cli/src/bin.ts', import.meta.url)),
];

/** Resources owned by one generated-deployment gate invocation. */
export interface GeneratedResources {
  /** Unique Docker image tag for this invocation. */
  readonly image: string;
  /** Unique Docker container name for this invocation. */
  readonly container: string;
  /** Broker sharing an isolated loopback namespace with the application. */
  readonly broker: string;
}

/**
 * Gives a generated-deployment check Docker resources it alone owns.
 *
 * Parallel checks share a Docker daemon in CI and locally, so a fixed name lets one run delete
 * another's container. Docker layer caching remains content-addressed even though the final tag
 * is unique.
 *
 * @returns The image tag and container name for this invocation
 */
export function generatedResources(): GeneratedResources {
  const suffix = crypto.randomUUID();
  return {
    image: `${GENERATED_IMAGE_PREFIX}-${suffix}`,
    container: `${GENERATED_CONTAINER_PREFIX}-${suffix}`,
    broker: `${GENERATED_CONTAINER_PREFIX}-broker-${suffix}`,
  };
}

/**
 * Installs the scaffold exactly as its printed next step requests, resolves the
 * selected application's entry point into that root lockfile, then builds its
 * Dockerfile.
 *
 * The framework resolves from npm (through the overlay), and the npm section of
 * the lockfile is deterministic — measured in M111d across three cold installs
 * with fresh caches, which wrote byte-identical sections. That is why no edge is
 * stripped here any more: the strip existed because Deno recorded a JSR
 * package's npm edges nondeterministically, which the npm path does not.
 *
 * @param root - Generated workspace root
 * @param image - Image tag owned by this invocation
 * @param registry - The overlay URL every install resolves the framework from
 * @param execute - Subprocess seam for the ordered-command regression test
 * @returns The install/cache failure, or the image build result
 */
export async function buildGeneratedImage(
  root: string,
  image: string,
  registry: string,
  execute: typeof run = run,
): ReturnType<typeof run> {
  // NO_COLOR so the summary line can be matched as written.
  const env = { NPM_CONFIG_REGISTRY: registry, NO_COLOR: '1' };
  const installed = await execute(['deno', 'install'], { quiet: true, cwd: root, env });
  if (!installed.success) return installed;

  const cached = await execute(
    ['deno', 'cache', '--lock=deno.lock', `apps/${GENERATED_MEMBER}/main.ts`],
    { quiet: true, cwd: root, env },
  );
  if (!cached.success) return cached;

  // The image's own install step resolves the framework from the same registry, reached on the
  // host's loopback — hence the host network for the BUILD only; the container runs with none.
  return await execute(
    [
      'docker',
      'build',
      '--quiet',
      '--network',
      'host',
      '-f',
      `${root}/docker/Dockerfile`,
      '--build-arg',
      `MEMBER=${GENERATED_MEMBER}`,
      '--build-arg',
      `NPM_CONFIG_REGISTRY=${registry}`,
      '-t',
      image,
      root,
    ],
    { quiet: true },
  );
}

/** Installs a generated Node or Bun project's lockfile, then builds its own Dockerfile. */
export async function buildGeneratedNodeImage(
  root: string,
  image: string,
  registry: string,
  workspace: boolean,
  execute: typeof run = run,
  runtime: 'node' | 'bun' = 'node',
): ReturnType<typeof run> {
  const install =
    runtime === 'bun' ? ['bun', 'install'] : ['npm', 'install', '--no-audit', '--no-fund'];
  const installed = await execute(install, {
    quiet: true,
    cwd: root,
    env: { NPM_CONFIG_REGISTRY: registry },
  });
  if (!installed.success) return installed;
  return execute(
    [
      'docker',
      'build',
      '--quiet',
      '--network',
      'host',
      '-f',
      `${root}/${workspace ? 'docker/' : ''}Dockerfile`,
      ...(workspace ? ['--build-arg', `MEMBER=${GENERATED_MEMBER}`] : []),
      '--build-arg',
      `NPM_CONFIG_REGISTRY=${registry}`,
      '-t',
      image,
      root,
    ],
    { quiet: true },
  );
}

/** Generated Node images must serve with no writable root and no external network. */
async function checkGeneratedNode(
  directory: string,
  registry: string,
  workspace: boolean,
  runtime: 'node' | 'bun' = 'node',
  view = false,
): Promise<boolean> {
  const name = view ? GENERATED_VIEW_CASE : `${runtime}-${workspace ? 'workspace' : 'standalone'}`;
  const root = `${directory}/${name}`;
  const resources = generatedResources();
  const cli = (args: readonly string[]) =>
    run([...CLI_COMMAND, ...args], { quiet: true, cwd: directory });
  try {
    const created = await cli([
      'new',
      name,
      '--runtime',
      runtime,
      ...(workspace ? ['--workspace'] : ['--template', 'rest']),
    ]);
    if (!created.success) throw new Error(created.stderr);
    if (workspace) {
      const member = await cli([
        'generate',
        'app',
        GENERATED_MEMBER,
        '--template',
        'rest',
        '--dir',
        root,
      ]);
      const library = await cli([
        'generate',
        'library',
        'shared',
        '--scope',
        'm120',
        '--dir',
        root,
      ]);
      if (!member.success || !library.success) throw new Error(member.stderr + library.stderr);
      const mainPath = `${root}/apps/${GENERATED_MEMBER}/main.ts`;
      const source = await readFile(mainPath, 'utf8');
      await writeFile(
        mainPath,
        "import { shared } from '@m120/shared';\n" +
          source.replace(
            'await app.start(',
            "app.router.get('/library', (ctx) => ctx.response.json({ value: shared('image') }));\nawait app.start(",
          ),
      );
    }
    if (view) {
      const added = await cli(['add', 'view', '--dir', root]);
      if (!added.success) throw new Error(added.stderr);
    }
    const built = await buildGeneratedNodeImage(
      root,
      resources.image,
      registry,
      workspace,
      run,
      runtime,
    );
    if (!built.success) throw new Error(built.stdout + built.stderr);
    const started = await run(
      [
        'docker',
        'run',
        '-d',
        '--name',
        resources.container,
        '--read-only',
        '--network',
        'none',
        resources.image,
      ],
      { quiet: true },
    );
    if (!started.success) throw new Error(started.stderr);
    for (let attempt = 0; attempt < GENERATED_PROBE_ATTEMPTS; attempt++) {
      const probe = await run(
        [
          'docker',
          'exec',
          resources.container,
          'wget',
          '-q',
          '-O',
          '-',
          'http://127.0.0.1:3000/health',
        ],
        { quiet: true },
      );
      if (probe.success) {
        if (workspace) {
          const library = await run(
            [
              'docker',
              'exec',
              resources.container,
              'wget',
              '-q',
              '-O',
              '-',
              'http://127.0.0.1:3000/library',
            ],
            { quiet: true },
          );
          if (!library.success || !library.stdout.includes('shared: image'))
            throw new Error(`Library value missing: ${library.stdout}${library.stderr}`);
        }
        if (view) {
          const page = await run(
            [
              'docker',
              'exec',
              resources.container,
              'wget',
              '-q',
              '-O',
              '-',
              'http://127.0.0.1:3000/ui',
            ],
            { quiet: true },
          );
          const css = await run(
            [
              'docker',
              'exec',
              resources.container,
              'wget',
              '-S',
              '-O',
              '-',
              'http://127.0.0.1:3000/assets/app.css',
            ],
            { quiet: true },
          );
          if (
            !page.success ||
            !page.stdout.includes('data-shell="frame"') ||
            !css.success ||
            !css.stdout.includes('.h-dvh') ||
            !/content-type: text\/css/i.test(css.stderr)
          ) {
            throw new Error(
              `View or CSS missing from read-only image: ${page.stderr}${css.stderr}`,
            );
          }
          console.log('  ✓ /ui 200 and /assets/app.css 200 text/css with .h-dvh');
        }
        console.log(
          `  ✓ ${name} served /health${workspace ? ' and bundled library value' : ''} read-only, network none`,
        );
        return true;
      }
      const state = await run(
        ['docker', 'inspect', '-f', '{{.State.Running}}', resources.container],
        { quiet: true },
      );
      if (state.stdout.trim() !== 'true') break;
      await new Promise((resolve) => setTimeout(resolve, GENERATED_PROBE_INTERVAL_MS));
    }
    throw new Error(`The generated ${runtime} image did not serve /health`);
  } catch (cause) {
    const logs = await run(['docker', 'logs', resources.container], { quiet: true });
    console.error(
      `  ✗ ${name}: ${cause instanceof Error ? cause.message : String(cause)}\n${logs.stdout}${logs.stderr}`,
    );
    return false;
  } finally {
    await run(['docker', 'rm', '-f', resources.container], { quiet: true });
    await run(['docker', 'image', 'rm', '-f', resources.image], { quiet: true });
  }
}

/**
 * Proves the deployment a user actually gets, which until M95a nothing did.
 *
 * Every other mode exercises this repository's own `docker/` and `k8s/`; the files a scaffolded
 * workspace deploys with were generated, managed, and never once built by a gate. This mode
 * scaffolds a real workspace with the real CLI, builds its generated Dockerfile, and runs the
 * image under the posture the generated Kubernetes manifest sets — `readOnlyRootFilesystem: true`
 * with exactly one writable path (`/tmp`, mirrored here as a tmpfs) — and no external network,
 * which is an air-gapped cluster's reachability. Its Redis broker owns a `--network none`
 * namespace; the application shares it, so only loopback Redis remains reachable. Success is a
 * SERVED `/health` response, not a live
 * process: the failure this closes kills the process at import, but a warm-list regression
 * could equally leave it running and unable to serve, and a gate that watched only for an exit
 * would call that a pass.
 *
 * The probe runs INSIDE the container because its network namespace leaves no interface a host
 * poll could reach; the container that dies at import is caught by its state check, and its logs
 * are printed before the failure is reported.
 *
 * @returns The outcome of the generated-deployment check
 */
async function checkGenerated(): Promise<CheckOutcome> {
  console.log('\n▸ generated: a scaffolded workspace serves under its own security posture');

  if (!(await onPath('docker'))) {
    console.log('  SKIP — missing tool(s): docker');
    return 'skipped';
  }

  await mkdir('.tmp', { recursive: true });
  // Absolute: the CLI runs with this directory as its cwd, so a relative `--dir` below would be
  // resolved against it a second time (`.tmp/test-x/.tmp/test-x/acme`).
  const workspace = resolve(await mkdtemp('.tmp/test-'));
  const root = `${workspace}/${GENERATED_WORKSPACE}`;
  const resources = generatedResources();
  // Nothing is on npm until the cut, and the scaffold pins the CLI's own version, so the
  // framework installs from the tree's own packs; everything else through it from npm.
  let overlay: Awaited<ReturnType<typeof startRegistryOverlay>> | undefined;
  try {
    // Inside the `try`: packing the tree can fail (no `pnpm install`, a build error), and that
    // must report as this mode failing — with the temp workspace removed — not escape the run.
    try {
      overlay = await startRegistryOverlay({ root: process.cwd() });
    } catch (cause) {
      console.error(
        `  ✗ the local registry overlay did not start (run \`pnpm install\` first): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return 'failed';
    }
    // Scaffold exactly what a user gets, with the real CLI as a subprocess. Scaffolding writes
    // files, then the printed install step resolves the workspace before the image build.
    const cli = (args: readonly string[]) =>
      run([...CLI_COMMAND, ...args], { quiet: true, cwd: workspace });
    const created = await cli([
      'new',
      GENERATED_WORKSPACE,
      '--workspace',
      '--runtime',
      'deno',
      '--transport',
      'redis',
      '--port',
      String(GENERATED_PORT),
    ]);
    const member = await cli([...GENERATED_MEMBER_ARGS, '--dir', root]);
    if (!created.success || !member.success) {
      console.error('  ✗ scaffolding the workspace failed');
      if (!created.success) console.error(created.stderr);
      if (!member.success) console.error(member.stderr);
      return 'failed';
    }
    // M120 §3.15: a library adds a workspace symlink under node_modules, and a root
    // `nodeModulesDir: "auto"` — which a full-stack member sets (M36c), though a redis
    // workspace cannot take one — is the pair under which every member's image once
    // died read-only re-creating that symlink. The key is set as that member would.
    const library = await cli(['generate', 'library', 'shared', '--scope', 'm120', '--dir', root]);
    if (!library.success) {
      console.error('  ✗ adding the library failed');
      console.error(library.stderr);
      return 'failed';
    }
    const rootManifestPath = `${root}/deno.json`;
    const rootManifest = JSON.parse(await readFile(rootManifestPath, 'utf8')) as Record<
      string,
      unknown
    >;
    await writeFile(
      rootManifestPath,
      `${JSON.stringify({ ...rootManifest, nodeModulesDir: 'auto' }, null, 2)}\n`,
    );

    // Build the user Dockerfile against all supported manifest layouts. The last
    // layout also proves a member can inherit imports from the workspace root.
    const memberManifest = `${root}/apps/${GENERATED_MEMBER}/deno.json`;
    const memberJsonc = `${memberManifest}c`;
    const memberSource = await readFile(memberManifest, 'utf8');
    for (const layout of GENERATED_LAYOUTS) {
      if (layout === 'commented-json') {
        await writeFile(memberManifest, `// Member configuration\n${memberSource}`);
      } else if (layout === 'jsonc') {
        await rename(memberManifest, memberJsonc);
      } else {
        const member = JSON.parse(memberSource) as { imports?: Record<string, string> };
        const rootPath = `${root}/deno.json`;
        const rootManifest = JSON.parse(await readFile(rootPath, 'utf8')) as {
          imports?: Record<string, string>;
        };
        rootManifest.imports = { ...rootManifest.imports, ...member.imports };
        delete member.imports;
        await writeFile(rootPath, `${JSON.stringify(rootManifest, null, 2)}\n`);
        await writeFile(
          memberJsonc,
          `// Imports inherited from the root\n${JSON.stringify(member, null, 2)}\n`,
        );
      }
      console.log(`  installing and building the generated image (${layout}) …`);
      const built = await buildGeneratedImage(root, resources.image, overlay.url);
      if (!built.success) {
        console.error(`  ✗ the generated workspace failed to install or build (${layout})`);
        console.error(built.stderr);
        return 'failed';
      }
      const connectorCache = await run(
        [
          'docker',
          'run',
          '--rm',
          '--read-only',
          '--network',
          'none',
          '--entrypoint',
          'sh',
          resources.image,
          '-c',
          PRODUCTION_DEVTOOL_PROBE,
        ],
        { quiet: true },
      );
      if (!connectorCache.success) {
        console.error(`  ✗ production carries a devtool entry or cached connector (${layout})`);
        // The probe's grep prints every matching path, which is what says WHERE.
        console.error(connectorCache.stdout + connectorCache.stderr);
        return 'failed';
      }
      console.log(`  ✓ production excludes the devtool (${layout})`);
    }

    // Lazy driver imports must actually run. The old memory-only scaffold passed
    // even with --no-lock after install. Redis loads the ioredis driver and its
    // transitive npm modules. Redis and the app share a network-none namespace:
    // loopback reaches the broker, while npm/jsr remain unreachable.
    const broker = await run(
      ['docker', 'run', '-d', '--name', resources.broker, '--network', 'none', 'redis:7'],
      { quiet: true },
    );
    if (!broker.success) {
      console.error(broker.stderr);
      return 'failed';
    }
    let brokerReady = false;
    for (let attempt = 0; attempt < 30; attempt += 1) {
      const ready = await run(['docker', 'exec', resources.broker, 'redis-cli', 'ping'], {
        quiet: true,
      });
      if (ready.success) {
        brokerReady = true;
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, GENERATED_PROBE_INTERVAL_MS));
    }
    if (!brokerReady) {
      const logs = await run(['docker', 'logs', resources.broker], { quiet: true });
      console.error(`  ✗ isolated Redis did not become ready: ${logs.stdout}${logs.stderr}`);
      return 'failed';
    }

    // Deliberately WITHOUT --rm: a container that crash-loops at import is the failure this
    // gate exists to catch, and its logs — the only record of which specifier Deno tried to
    // record — must survive until they are read below. `resources.container` is unique to this
    // invocation, so cleanup can never remove a concurrent check's container.
    const started = await run(
      [
        'docker',
        'run',
        '-d',
        '--name',
        resources.container,
        '--read-only',
        '--network',
        `container:${resources.broker}`,
        '--tmpfs',
        '/tmp',
        resources.image,
      ],
      { quiet: true },
    );
    if (!started.success) {
      console.error('  ✗ the image did not start');
      console.error(started.stderr);
      return 'failed';
    }

    let served = false;
    for (let attempt = 0; attempt < GENERATED_PROBE_ATTEMPTS; attempt += 1) {
      const probe = await run(
        [
          'docker',
          'exec',
          resources.container,
          'wget',
          '-q',
          '-O',
          '/dev/null',
          `http://127.0.0.1:${GENERATED_PORT}/health`,
        ],
        { quiet: true },
      );
      if (probe.success) {
        served = true;
        break;
      }
      // A container that exited is the defect, caught early: read its logs instead of polling
      // a corpse for the remaining attempts.
      const state = await run(
        ['docker', 'inspect', '-f', '{{.State.Running}}', resources.container],
        { quiet: true },
      );
      if (state.stdout.trim() !== 'true') break;
      await new Promise((resolve) => setTimeout(resolve, GENERATED_PROBE_INTERVAL_MS));
    }

    const logs = await run(['docker', 'logs', resources.container], { quiet: true });
    if (!served) {
      console.error(
        '  ✗ the member never served /health under --read-only with no external network',
      );
      console.error(logs.stdout + logs.stderr);
      return 'failed';
    }
    console.log('  ✓ served /health under --read-only with no external network');
    for (const workspaceCase of [true, false]) {
      if (!(await checkGeneratedNode(workspace, overlay.url, workspaceCase))) return 'failed';
    }
    if (!(await checkGeneratedNode(workspace, overlay.url, false, 'node', true))) return 'failed';
    // M120 §3.11/§3.14: a Bun member importing a library, so the image proves the
    // root bunfig.toml's hoisted linker reaches the production install. The host
    // install needs Bun; without it the case is skipped by name, like a missing
    // docker, never silently (CI installs it).
    if (!(await onPath('bun'))) {
      console.log('  SKIP — bun-workspace: missing tool(s): bun');
    } else if (!(await checkGeneratedNode(workspace, overlay.url, true, 'bun'))) {
      return 'failed';
    }
    return 'passed';
  } finally {
    await run(['docker', 'rm', '-f', resources.container], { quiet: true });
    await run(['docker', 'rm', '-f', '-v', resources.broker], { quiet: true });
    await run(['docker', 'image', 'rm', '-f', resources.image], { quiet: true });
    await overlay?.close();
    await rm(workspace, { recursive: true });
  }
}

const MANIFEST_DIR = 'k8s/manifests';

const CLUSTER_NAME = 'setu-deploy-gate';
const NAMESPACE = 'setu';
const RELEASE = 'setu';

/** The workspace the M122 gate scaffolds, its namespace, and its members' first port. */
const WORKSPACE_GATE = { name: 'shop', namespace: 'setu-m122', port: 3700 } as const;

/**
 * Requests `url` from inside the cluster through a one-shot curl pod and returns the status code.
 *
 * The code is read from the pod's logs, not an attached stream, for the race `checkCluster`
 * documents.
 */
async function serviceStatus(context: string, namespace: string, url: string): Promise<string> {
  const kubectl = (...args: string[]) => [
    'kubectl',
    '--context',
    context,
    '-n',
    namespace,
    ...args,
  ];
  const pod = 'm122-probe';
  await run(kubectl('delete', 'pod', pod, '--ignore-not-found'), { quiet: true });
  const started = await run(
    kubectl(
      'run',
      pod,
      '--restart=Never',
      '--image=curlimages/curl:8.11.1',
      '--command',
      '--',
      'curl',
      '-sS',
      '-o',
      '/dev/null',
      '-w',
      '%{http_code}',
      url,
    ),
    { quiet: true },
  );
  if (!started.success) return `probe pod did not start: ${started.stderr.trim()}`;
  await run(
    kubectl('wait', '--for=jsonpath={.status.phase}=Succeeded', `pod/${pod}`, '--timeout=90s'),
    { quiet: true },
  );
  const logs = await run(kubectl('logs', `pod/${pod}`), { quiet: true });
  await run(kubectl('delete', 'pod', pod, '--ignore-not-found'), { quiet: true });
  return logs.stdout.trim();
}

/**
 * The M122 gate: a workspace's root `test`, then `setu workspace deploy` into a real kind
 * cluster, then the same checks a developer would make by hand.
 *
 * @param clusterModeFollows - Whether `--cluster` runs after this and owns deleting the cluster
 */
async function checkWorkspace(clusterModeFollows: boolean): Promise<CheckOutcome> {
  console.log('\n▸ workspace: root test, build and deploy into kind (M122)');
  const required = ['kind', 'kubectl', 'docker', 'npm'];
  const present: string[] = [];
  for (const tool of required) if (await onPath(tool)) present.push(tool);
  const missing = missingTools(required, present);
  if (missing.length > 0) {
    console.log(`  SKIP — missing tool(s): ${missing.join(', ')}`);
    return 'skipped';
  }

  const context = `kind-${CLUSTER_NAME}`;
  const kubectl = (...args: string[]) => ['kubectl', '--context', context, ...args];
  const existing = await run(['kind', 'get', 'clusters'], { quiet: true });
  const created = !existing.stdout.split('\n').includes(CLUSTER_NAME);
  if (created) {
    console.log(`  creating cluster ${CLUSTER_NAME} …`);
    if (!(await run(['kind', 'create', 'cluster', '--name', CLUSTER_NAME])).success) {
      console.error('  ✗ could not create the kind cluster');
      return 'failed';
    }
  }

  await mkdir('.tmp', { recursive: true });
  const directory = resolve(await mkdtemp('.tmp/test-'));
  const root = `${directory}/${WORKSPACE_GATE.name}`;
  const tag = 'm122';
  let overlay: Awaited<ReturnType<typeof startRegistryOverlay>> | undefined;
  try {
    try {
      overlay = await startRegistryOverlay({ root: process.cwd() });
    } catch (cause) {
      console.error(
        `  ✗ the local registry overlay did not start (run \`pnpm install\` first): ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
      return 'failed';
    }
    const cli = (args: readonly string[], quiet = true) =>
      run([...CLI_COMMAND, ...args], { quiet, cwd: directory });
    for (const args of [
      [
        'new',
        WORKSPACE_GATE.name,
        '--workspace',
        '--runtime',
        'node',
        '--transport',
        'http',
        '--port',
        String(WORKSPACE_GATE.port),
      ],
      ['generate', 'app', 'orders', '--template', 'rest', '--dir', root],
      ['generate', 'app', 'portal', '--template', 'full-stack', '--dir', root],
    ]) {
      const step = await cli(args);
      if (!step.success) {
        console.error(`  ✗ setu ${args.join(' ')} failed\n${step.stdout}${step.stderr}`);
        return 'failed';
      }
    }
    const installed = await run(['npm', 'install', '--no-audit', '--no-fund'], {
      quiet: true,
      cwd: root,
      env: { NPM_CONFIG_REGISTRY: overlay.url },
    });
    if (!installed.success) {
      console.error(`  ✗ npm install failed\n${installed.stderr}`);
      return 'failed';
    }

    // The root test script: every member's tests through npm's own recursion.
    const tested = await run(['npm', 'test'], { quiet: true, cwd: root });
    for (const member of ['orders', 'portal']) {
      if (!tested.stdout.includes(`> ${member}@`)) {
        console.error(`  ✗ the root test script did not run ${member}'s tests\n${tested.stdout}`);
        return 'failed';
      }
    }
    if (!tested.success) {
      console.error(`  ✗ the root test script failed\n${tested.stdout}${tested.stderr}`);
      return 'failed';
    }
    console.log("  ✓ the root test script ran every member's tests");

    const deployArgs = [
      'workspace',
      'deploy',
      '--dir',
      root,
      '--context',
      context,
      '--namespace',
      WORKSPACE_GATE.namespace,
      '--tag',
      tag,
      '--timeout',
      '300s',
      '--build-arg',
      `NPM_CONFIG_REGISTRY=${overlay.url}`,
      '--network',
      'host',
    ];

    // Without the portal's values file deploy refuses, and the cluster stays unchanged.
    const refused = await cli(deployArgs);
    const absent = await run(kubectl('get', 'namespace', WORKSPACE_GATE.namespace), {
      quiet: true,
    });
    if (refused.success || !refused.stderr.includes('portal needs') || absent.success) {
      console.error(
        `  ✗ deploy without k8s/secrets/portal/.env did not refuse cleanly\n${refused.stdout}${refused.stderr}`,
      );
      return 'failed';
    }
    console.log('  ✓ deploy refuses a missing secret and changes nothing');

    // The session plugin refuses a secret shorter than 32 characters; 32 random bytes is 43.
    const secret = randomBytes(32).toString('base64url');
    await mkdir(`${root}/k8s/secrets/portal`, { recursive: true });
    await writeFile(
      `${root}/k8s/secrets/portal/.env`,
      `TRUSTED_PROXIES=\nSESSION_SECRET=${secret}\n`,
    );

    console.log('  deploying with setu workspace deploy …');
    const deployed = await cli(deployArgs, false);
    if (!deployed.success) {
      console.error('  ✗ setu workspace deploy failed');
      await run(kubectl('-n', WORKSPACE_GATE.namespace, 'get', 'pods'));
      await run(kubectl('-n', WORKSPACE_GATE.namespace, 'describe', 'pods'));
      // A crash-looping container's reason is in its previous run's output, not in describe.
      for (const member of ['orders', 'portal']) {
        console.error(`  --- ${member} logs (previous run, then current) ---`);
        await run(
          kubectl(
            '-n',
            WORKSPACE_GATE.namespace,
            'logs',
            `deploy/${member}`,
            '--previous',
            '--tail=80',
          ),
        );
        await run(kubectl('-n', WORKSPACE_GATE.namespace, 'logs', `deploy/${member}`, '--tail=80'));
      }
      return 'failed';
    }

    for (const [member, port] of [
      ['orders', WORKSPACE_GATE.port],
      ['portal', WORKSPACE_GATE.port + 1],
    ] as const) {
      const status = await serviceStatus(
        context,
        WORKSPACE_GATE.namespace,
        `http://${member}:${port}/health`,
      );
      if (status !== '200') {
        console.error(`  ✗ ${member} /health through its Service returned "${status}"`);
        return 'failed';
      }
    }
    console.log('  ✓ both members serve /health through their Services');

    const seen = await run(
      kubectl(
        '-n',
        WORKSPACE_GATE.namespace,
        'exec',
        'deploy/portal',
        '--',
        'printenv',
        'SESSION_SECRET',
      ),
      { quiet: true },
    );
    if (seen.stdout.trim() !== secret) {
      console.error('  ✗ the portal pod does not carry SESSION_SECRET from its Secret');
      return 'failed';
    }
    const annotations = await run(
      kubectl(
        '-n',
        WORKSPACE_GATE.namespace,
        'get',
        'secret',
        'portal-env',
        '-o',
        'jsonpath={.metadata.annotations}',
      ),
      { quiet: true },
    );
    if (
      annotations.stdout.includes('last-applied-configuration') ||
      annotations.stdout.includes(secret)
    ) {
      console.error('  ✗ the Secret carries a last-applied-configuration annotation');
      return 'failed';
    }
    console.log('  ✓ the Secret reaches the pod and carries no plaintext annotation');
    return (await checkDenoWorkspaceTest(directory, overlay.url)) ? 'passed' : 'failed';
  } finally {
    await run(kubectl('delete', 'namespace', WORKSPACE_GATE.namespace, '--wait=false'), {
      quiet: true,
    });
    for (const member of ['orders', 'portal']) {
      await run(['docker', 'image', 'rm', '-f', `${member}:${tag}`], { quiet: true });
    }
    await overlay?.close();
    await rm(directory, { recursive: true, force: true });
    if (created && !clusterModeFollows && process.env['KEEP_CLUSTER'] === undefined) {
      console.log(`  deleting cluster ${CLUSTER_NAME} …`);
      await run(['kind', 'delete', 'cluster', '--name', CLUSTER_NAME], { quiet: true });
    }
  }
}

/**
 * A Deno workspace tested from its root. Deno's recursion includes the root, so a root `test`
 * task running it would call itself without end (measured, M122): the generated root has none,
 * and `deno task --recursive test` must run the member's tests exactly once.
 *
 * @returns Whether it passed; a missing Deno is reported as a skip of this case, by name
 */
async function checkDenoWorkspaceTest(directory: string, registry: string): Promise<boolean> {
  if (!(await onPath('deno'))) {
    console.log('  SKIP — deno-workspace test: missing tool(s): deno');
    return true;
  }
  const root = `${directory}/denows`;
  const cli = (args: readonly string[]) =>
    run([...CLI_COMMAND, ...args], { quiet: true, cwd: directory });
  for (const args of [
    ['new', 'denows', '--workspace', '--runtime', 'deno', '--transport', 'http'],
    ['generate', 'app', 'api', '--template', 'rest', '--dir', root],
  ]) {
    const step = await cli(args);
    if (!step.success) {
      console.error(`  ✗ setu ${args.join(' ')} failed\n${step.stderr}`);
      return false;
    }
  }
  const env = { NPM_CONFIG_REGISTRY: registry };
  const installed = await run(['deno', 'install'], { quiet: true, cwd: root, env });
  if (!installed.success) {
    console.error(`  ✗ deno install failed\n${installed.stderr}`);
    return false;
  }
  const manifest = JSON.parse(await readFile(`${root}/deno.json`, 'utf8')) as {
    tasks?: Record<string, string>;
  };
  if (manifest.tasks?.['test'] !== undefined) {
    console.error('  ✗ the Deno root declares a test task, which recurses into itself');
    return false;
  }
  const tested = await run(['deno', 'task', '--recursive', 'test'], {
    quiet: true,
    cwd: root,
    env,
  });
  // Stripped: Deno colours its summary even under NO_COLOR here (measured).
  const output = stripVTControlCharacters(`${tested.stdout}${tested.stderr}`);
  // `deno test` prints one `ok | N passed | …` summary per run, prefixed `[member#task]` under
  // `--recursive`; two would mean the member ran twice.
  const runs = (output.match(/\bok \| \d+ passed/g) ?? []).length;
  if (!tested.success || runs !== 1) {
    console.error(
      `  ✗ deno task --recursive test ran the member ${runs} time(s)\n${output.slice(-4000)}`,
    );
    return false;
  }
  console.log('  ✓ deno task --recursive test ran the member exactly once');
  return true;
}

async function checkCluster(): Promise<CheckOutcome> {
  console.log('\n▸ cluster: real apply + serve on kind');

  const required = ['kind', 'kubectl', 'helm', 'docker'];
  const present: string[] = [];
  for (const tool of required) {
    if (await onPath(tool)) present.push(tool);
  }
  const missing = missingTools(required, present);
  if (missing.length > 0) {
    console.log(`  SKIP — missing tool(s): ${missing.join(', ')}`);
    return 'skipped';
  }

  const context = `kind-${CLUSTER_NAME}`;
  const kubectl = (...args: string[]) => ['kubectl', '--context', context, ...args];

  const existing = await run(['kind', 'get', 'clusters'], { quiet: true });
  const reuse = existing.stdout.split('\n').includes(CLUSTER_NAME);
  if (!reuse) {
    console.log(`  creating cluster ${CLUSTER_NAME} …`);
    if (!(await run(['kind', 'create', 'cluster', '--name', CLUSTER_NAME])).success) {
      console.error('  ✗ could not create the kind cluster');
      return 'failed';
    }
  } else {
    console.log(`  reusing cluster ${CLUSTER_NAME}`);
  }

  try {
    // The image the committed manifests reference. It must exist locally; the build mode makes
    // it, and `kind load` copies it into the node so imagePullPolicy: IfNotPresent finds it.
    const image = 'setu/rest-api:m39';
    if (!(await run(['docker', 'image', 'inspect', image], { quiet: true })).success) {
      console.log(`  building ${image} first …`);
      const built = await run(
        [
          'docker',
          'build',
          '--quiet',
          '-f',
          'docker/Dockerfile',
          '--build-arg',
          'APP=rest-api',
          '-t',
          image,
          '.',
        ],
        { quiet: true },
      );
      if (!built.success) {
        console.error(`  ✗ could not build ${image}`);
        return 'failed';
      }
    }

    console.log(`  loading ${image} into the cluster …`);
    if (!(await run(['kind', 'load', 'docker-image', image, '--name', CLUSTER_NAME])).success) {
      console.error('  ✗ kind load failed');
      return 'failed';
    }

    await run(kubectl('create', 'namespace', NAMESPACE), { quiet: true });

    console.log('  applying the COMMITTED manifests …');
    const applied = await run(kubectl('apply', '-n', NAMESPACE, '-f', 'k8s/manifests/'), {
      quiet: true,
    });
    if (!applied.success) {
      console.error('  ✗ kubectl apply failed');
      await run(kubectl('apply', '-n', NAMESPACE, '-f', 'k8s/manifests/'));
      return 'failed';
    }

    const deployment = `deployment/${RELEASE}-setu-ts`;
    console.log('  waiting for rollout (readiness probe must pass) …');
    const rolled = await run(
      kubectl('rollout', 'status', '-n', NAMESPACE, deployment, '--timeout=180s'),
    );
    if (!rolled.success) {
      console.error('  ✗ rollout did not complete — probes or image are wrong');
      await run(kubectl('get', 'pods', '-n', NAMESPACE));
      await run(kubectl('describe', 'pods', '-n', NAMESPACE));
      return 'failed';
    }
    console.log('  ✓ rollout complete');

    // Serve a request THROUGH the Service, so a selector matching no pod fails here — the defect
    // schema validation cannot see.
    //
    // The status code is read from the probe pod's LOGS, not from `kubectl run -i`'s attached
    // stream. That stream is a race: kubectl has to attach before a container whose whole job is one
    // curl has already exited, and on a loaded runner it loses. When it does, the command still
    // succeeds and still prints — just kubectl's own deletion notice and nothing from the pod — so
    // the gate failed with `returned "pod "gate-probe" deleted from setu namespace", expected 200`
    // on a branch that had touched neither the manifests nor the chart. Logs come from the API
    // server after the fact and cannot be missed.
    console.log('  serving a request through the Service …');
    await run(kubectl('delete', 'pod', 'gate-probe', '-n', NAMESPACE, '--ignore-not-found'), {
      quiet: true,
    });
    const started = await run(
      kubectl(
        'run',
        'gate-probe',
        '-n',
        NAMESPACE,
        '--restart=Never',
        '--image=curlimages/curl:8.11.1',
        '--command',
        '--',
        'curl',
        '-sS',
        '-o',
        '/dev/null',
        '-w',
        '%{http_code}',
        `http://${RELEASE}-setu-ts:3000/live`,
      ),
      { quiet: true },
    );
    if (!started.success) {
      console.error(`  ✗ could not start the probe pod: ${started.stderr.trim()}`);
      return 'failed';
    }

    // Either terminal phase ends the wait. Waiting only for `Succeeded` would spend the whole
    // timeout on the failure this check exists to catch — a Service selector matching no pod, where
    // curl exits non-zero and the pod goes `Failed`.
    const settled = await run(
      kubectl(
        'wait',
        // One argument: passing the value separately makes kubectl read it as a second resource.
        '--for=jsonpath={.status.phase}=Succeeded',
        'pod/gate-probe',
        '-n',
        NAMESPACE,
        '--timeout=90s',
      ),
      { quiet: true },
    );
    const logs = await run(kubectl('logs', 'pod/gate-probe', '-n', NAMESPACE), { quiet: true });
    const status = logs.stdout.trim();
    await run(kubectl('delete', 'pod', 'gate-probe', '-n', NAMESPACE, '--ignore-not-found'), {
      quiet: true,
    });

    if (!settled.success || status !== '200') {
      console.error(`  ✗ request through the Service returned "${status}", expected 200`);
      if (!settled.success) {
        console.error(`    probe pod never succeeded: ${settled.stderr.trim()}`);
      }
      return 'failed';
    }
    console.log('  ✓ Service → pod → /live returned 200');

    // RBAC: assert the ServiceAccount can actually read EndpointSlices. A wrong apiGroup or verb
    // renders and applies cleanly, so only an authorization check catches it.
    const subject = `system:serviceaccount:${NAMESPACE}:${RELEASE}-setu-ts`;
    const canList = await run(
      kubectl(
        'auth',
        'can-i',
        'list',
        'endpointslices.discovery.k8s.io',
        '-n',
        NAMESPACE,
        `--as=${subject}`,
      ),
      { quiet: true },
    );
    const canWatch = await run(
      kubectl(
        'auth',
        'can-i',
        'watch',
        'endpointslices.discovery.k8s.io',
        '-n',
        NAMESPACE,
        `--as=${subject}`,
      ),
      { quiet: true },
    );
    const listOk = canList.stdout.trim() === 'yes';
    const watchOk = canWatch.stdout.trim() === 'yes';
    if (!listOk || !watchOk) {
      console.error(
        `  ✗ discovery RBAC insufficient (list=${canList.stdout.trim()}, watch=${canWatch.stdout.trim()})`,
      );
      return 'failed';
    }
    console.log('  ✓ ServiceAccount can list and watch endpointslices');

    return 'passed';
  } finally {
    await run(kubectl('delete', 'namespace', NAMESPACE, '--wait=false'), { quiet: true });
    if (process.env['KEEP_CLUSTER'] === undefined) {
      console.log(`  deleting cluster ${CLUSTER_NAME} …`);
      await run(['kind', 'delete', 'cluster', '--name', CLUSTER_NAME], { quiet: true });
    }
  }
}

async function main(): Promise<void> {
  let modes: ModeSet;
  try {
    modes = parseModes(process.argv.slice(2));
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 2;
    return;
  }

  const results: CheckOutcome[] = [];
  if (modes.render) results.push(await checkRender(modes.write));
  if (modes.build) results.push(await checkBuild());
  if (modes.compose) results.push(await checkCompose());
  if (modes.generated) results.push(await checkGenerated());
  // Before --cluster, which deletes the cluster when it finishes (unless KEEP_CLUSTER).
  if (modes.workspace) results.push(await checkWorkspace(modes.cluster));
  if (modes.cluster) results.push(await checkCluster());

  if (results.includes('failed')) {
    console.error('\ncheck:deploy FAILED');
    process.exitCode = 1;
    return;
  }
  // A skip is reported with its own exit code rather than folded into success, so an absent
  // prerequisite can never be mistaken for a passing gate. CI must not permit it.
  if (results.includes('skipped')) {
    console.warn('\ncheck:deploy SKIPPED (tooling absent)');
    process.exitCode = SKIP_EXIT_CODE;
    return;
  }
  console.log('\ncheck:deploy OK');
}

if (import.meta.main) {
  await (async () => {
    await main();
  })();
}
