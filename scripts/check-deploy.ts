// deno-lint-ignore-file no-console -- this CI script reports progress, drift and skips.
import { fromFileUrl } from 'jsr:@std/path@^1.1.6';
import { walk } from 'jsr:@std/fs@^1.0.19';

/**
 * @module
 *
 * Deployment gate (M39): proves the container images build, the committed Kubernetes manifests
 * still match the chart they are rendered from, the Compose model resolves, and — with a real
 * cluster — that the manifests actually deploy and serve.
 *
 * Since M95a it also proves the deployment a USER gets: a workspace the CLI scaffolds is built
 * with its own generated Dockerfile and must serve `/health` under the security posture the
 * generated manifest sets — read-only root filesystem, no network.
 *
 * Modes are separable so the fast structural checks stay usable on every run while the slow
 * cluster proof is opt-in locally and mandatory in CI:
 *
 * ```
 * deno task check:deploy                 # render + build + compose + generated
 * deno task check:deploy --render        # rendered manifests match the chart
 * deno task check:deploy --cluster       # real kind apply + serve + RBAC
 * deno task check:deploy --generated     # scaffold → build its image → serve it air-gapped
 * ```
 *
 * A mode whose tooling is absent exits with {@linkcode SKIP_EXIT_CODE} (77) — the same code
 * `scripts/check-apps.ts` reserves — so a missing prerequisite can never read as a pass.
 */

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
   * `--read-only --network none` until it serves `/health` (M95a). Every other mode proves this
   * repository's own deployment objects; this is the only one that proves what a user deploys.
   */
  readonly generated: boolean;
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
  write: false,
};

const ALL_MODE_FLAGS = [
  '--render',
  '--build',
  '--compose',
  '--cluster',
  '--generated',
  '--write',
] as const;

/**
 * Turns argv into the set of checks to run.
 *
 * With no mode flag the default set runs (render + build + compose); naming any flag runs exactly
 * the named ones. An unrecognized flag is REFUSED rather than ignored, so a typo cannot silently
 * reduce the gate to nothing.
 *
 * @param args - Raw arguments, typically `Deno.args`
 * @returns The modes to run
 * @throws {Error} If an argument is not one of the known mode flags
 */
export function parseModes(args: readonly string[]): ModeSet {
  if (args.length === 0) return DEFAULT_MODES;
  // `--write` is a modifier, not a mode: on its own it would select no checks at all.
  if (args.every((arg) => arg === '--write')) {
    throw new Error('--write modifies --render; it selects no check on its own');
  }

  const unknown = args.filter(
    (arg) => !(ALL_MODE_FLAGS as readonly string[]).includes(arg),
  );
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
  return (
    report.added.length === 0 &&
    report.removed.length === 0 &&
    report.changed.length === 0
  );
}

/**
 * Returns the required tools that are absent, in the order given.
 *
 * @param required - Tool names the mode needs
 * @param present - Tool names found on PATH
 * @returns The missing names, so a skip message can say which
 */
export function missingTools(
  required: readonly string[],
  present: readonly string[],
): string[] {
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
  for (const candidate of pathCandidates(tool, Deno.env.get('PATH') ?? '')) {
    try {
      const info = await Deno.stat(candidate);
      if (info.isFile || info.isSymlink) return true;
    } catch {
      // Not at this PATH entry; try the next.
      continue;
    }
  }
  return false;
}

async function run(
  command: readonly string[],
  options: { readonly quiet?: boolean; readonly cwd?: string } = {},
): Promise<{ success: boolean; stdout: string; stderr: string }> {
  const quiet = options.quiet === true;
  const output = await new Deno.Command(command[0], {
    args: [...command.slice(1)],
    ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
    stdout: quiet ? 'piped' : 'inherit',
    stderr: quiet ? 'piped' : 'inherit',
  }).output();
  return {
    success: output.success,
    // `output.stdout` throws when the stream was inherited rather than piped, so both are only
    // read in the quiet case. Callers that need either always pass quiet.
    stdout: quiet ? new TextDecoder().decode(output.stdout) : '',
    // Where kubectl puts the reason a wait timed out, which is the one thing worth printing when
    // the probe pod never reaches a terminal phase.
    stderr: quiet ? new TextDecoder().decode(output.stderr) : '',
  };
}

async function readManifestDir(directory: string): Promise<Map<string, string>> {
  const files = new Map<string, string>();
  for await (const entry of Deno.readDir(directory)) {
    if (entry.isFile && entry.name.endsWith('.yaml')) {
      files.set(entry.name, await Deno.readTextFile(`${directory}/${entry.name}`));
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

  const temporary = await Deno.makeTempDir({ prefix: 'setu-render-' });
  try {
    const rendered = await run([
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
    ], { quiet: true });
    if (!rendered.success) {
      console.error('  helm template failed');
      return 'failed';
    }

    const fresh = await readManifestDir(`${temporary}/setu-ts/templates`);
    const committed = await readManifestDir(MANIFEST_DIR);
    if (write) {
      for (const name of committed.keys()) {
        if (!fresh.has(name)) await Deno.remove(`${MANIFEST_DIR}/${name}`);
      }
      for (const [name, content] of fresh) {
        await Deno.writeTextFile(`${MANIFEST_DIR}/${name}`, content);
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
    console.error('    Re-render with: deno task deploy:render');
    return 'failed';
  } finally {
    await Deno.remove(temporary, { recursive: true });
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
    const built = await run([
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
    ], { quiet: true });
    console.log(`  ${built.success ? '✓' : '✗'} ${target.app} → ${target.tag}`);
    if (!built.success) ok = false;
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
  for (
    const args of [
      ['docker', 'compose', '-f', 'docker/compose.yaml', 'config'],
      ['docker', 'compose', '-f', 'docker/compose.yaml', '--profile', 'telemetry', 'config'],
    ]
  ) {
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
const GENERATED_PROBE_ATTEMPTS = 120;
const GENERATED_PROBE_INTERVAL_MS = 1_000;

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
  return fromFileUrl(fileUrl);
}

/** The CLI's executable entry (`main.ts` owns the process boundary), absolute: scaffold steps
 * run with the WORKSPACE as their cwd. */
const CLI_ENTRY = nativeFilePath(new URL('../packages/cli/src/main.ts', import.meta.url));

/**
 * The version a generated scaffold can actually resolve from the registry.
 *
 * `setu new` stamps generated projects with the CLI's OWN version, and the
 * image build below resolves that version from jsr.io for real — which is the
 * point of this check, and is also why it cannot pass on a release branch: the
 * version being released is not published yet, so `deno cache` inside the image
 * fails with `Could not find version of '@setu-ts/common'`. That is not a defect
 * in the scaffold; a version that does not exist is untestable by construction.
 *
 * So the check asks the registry. When the pinned version is published it is
 * used unchanged, which is the faithful case and the one that holds on `main`.
 * When it is not, the newest PUBLISHED version is substituted and the
 * substitution is printed: the generated Dockerfile, its permissions and its
 * security posture are still proved against real jsr.io resolution, which is
 * what this gate exists for.
 *
 * A registry that cannot be reached returns `null`, leaving the pinned version
 * in place: failing loudly on an unresolvable specifier is better than silently
 * building something other than what was asked for.
 *
 * @param pinned - The version the scaffold was stamped with
 * @returns The version to build against, or `null` when the registry is unreachable
 */
export async function resolvableScaffoldVersion(
  pinned: string,
  fetchImpl: (url: string) => Promise<Response> = (url) => fetch(url),
): Promise<string | null> {
  let meta: { readonly latest?: string; readonly versions?: Record<string, unknown> };
  try {
    const response = await fetchImpl('https://jsr.io/@setu-ts/kernel/meta.json');
    if (!response.ok) return null;
    meta = JSON.parse(await response.text()) as typeof meta;
  } catch {
    return null;
  }
  if (Object.hasOwn(meta.versions ?? {}, pinned)) return pinned;
  return meta.latest ?? null;
}

/**
 * The `@setu-ts` version a scaffolded workspace was stamped with.
 *
 * Read from the emitted files rather than from this repository's manifests, so
 * it is whatever `setu new` actually wrote.
 *
 * @param root - The scaffolded workspace root
 * @returns The pinned version, or `null` when no specifier carries one
 */
export async function scaffoldPinnedVersion(root: string): Promise<string | null> {
  for await (const entry of walk(root, { exts: ['.json'], includeDirs: false })) {
    const match = /jsr:@setu-ts\/[a-z0-9-]+@\^?([0-9][^"']*)/.exec(
      await Deno.readTextFile(entry.path),
    );
    if (match?.[1] !== undefined) return match[1];
  }
  return null;
}

/**
 * Rewrites every `@setu-ts` specifier in a scaffold from one version to another.
 *
 * @param root - The scaffolded workspace root
 * @param from - The version the scaffold carries
 * @param to - The version to build against
 */
export async function repinScaffold(root: string, from: string, to: string): Promise<void> {
  const pattern = new RegExp(
    `(@setu-ts/[a-z0-9-]+@\\^?)${from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`,
    'g',
  );
  for await (const entry of walk(root, { exts: ['.json', '.ts', '.tsx'], includeDirs: false })) {
    const source = await Deno.readTextFile(entry.path);
    const rewritten = source.replace(pattern, `$1${to}`);
    if (rewritten !== source) await Deno.writeTextFile(entry.path, rewritten);
  }
}

/** Resources owned by one generated-deployment gate invocation. */
export interface GeneratedResources {
  /** Unique Docker image tag for this invocation. */
  readonly image: string;
  /** Unique Docker container name for this invocation. */
  readonly container: string;
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
  };
}

/**
 * Proves the deployment a user actually gets, which until M95a nothing did.
 *
 * Every other mode exercises this repository's own `docker/` and `k8s/`; the files a scaffolded
 * workspace deploys with were generated, managed, and never once built by a gate. This mode
 * scaffolds a real workspace with the real CLI, builds its generated Dockerfile, and runs the
 * image under the posture the generated Kubernetes manifest sets — `readOnlyRootFilesystem: true`
 * with exactly one writable path (`/tmp`, mirrored here as a tmpfs) — and no network, which is
 * an air-gapped cluster's reachability. Success is a SERVED `/health` response, not a live
 * process: the failure this closes kills the process at import, but a warm-list regression
 * could equally leave it running and unable to serve, and a gate that watched only for an exit
 * would call that a pass.
 *
 * The probe runs INSIDE the container because `--network none` leaves no interface a host
 * poll could reach; the container that dies at import is caught by its state check, and its
 * logs are printed before the failure is reported.
 *
 * @returns The outcome of the generated-deployment check
 */
async function checkGenerated(): Promise<CheckOutcome> {
  console.log('\n▸ generated: a scaffolded workspace serves under its own security posture');

  if (!(await onPath('docker'))) {
    console.log('  SKIP — missing tool(s): docker');
    return 'skipped';
  }

  const workspace = await Deno.makeTempDir({ prefix: 'setu-generated-' });
  const root = `${workspace}/${GENERATED_WORKSPACE}`;
  const resources = generatedResources();
  try {
    // Scaffold exactly what a user gets, with the real CLI as a subprocess. Scaffolding writes
    // files and resolves nothing: the framework packages resolve later, inside the image build —
    // the same order a user's first `docker build` sees.
    const cli = (args: readonly string[]) =>
      run([Deno.execPath(), 'run', '-A', CLI_ENTRY, ...args], { quiet: true, cwd: workspace });
    const created = await cli([
      'new',
      GENERATED_WORKSPACE,
      '--workspace',
      '--port',
      String(GENERATED_PORT),
    ]);
    const member = await cli([
      'g',
      'app',
      GENERATED_MEMBER,
      '--template',
      'microservice',
      '--dir',
      root,
    ]);
    if (!created.success || !member.success) {
      console.error('  ✗ scaffolding the workspace failed');
      if (!created.success) console.error(created.stderr);
      if (!member.success) console.error(member.stderr);
      return 'failed';
    }

    // A release branch pins the version being released, which is not on the registry until the
    // tag run publishes it — so the build below could never resolve it. Substitute the newest
    // published version in that case, and say so: the scaffold, its Dockerfile and its security
    // posture are still proved against real jsr.io resolution, which is what this gate is for.
    const pinned = await scaffoldPinnedVersion(root);
    if (pinned !== null) {
      const resolvable = await resolvableScaffoldVersion(pinned);
      if (resolvable !== null && resolvable !== pinned) {
        console.log(
          `  ${pinned} is not published yet — building against ${resolvable}, the newest that is`,
        );
        await repinScaffold(root, pinned, resolvable);
      }
    }

    // The GENERATED Dockerfile, not this repository's own — the defect lives in what `setu`
    // emits. Framework resolution from jsr.io happens here, on the build's network; the run
    // below is the part that must not need one.
    console.log('  building the generated image (jsr.io resolution happens here) …');
    const built = await run([
      'docker',
      'build',
      '--quiet',
      '-f',
      `${root}/docker/Dockerfile`,
      '--build-arg',
      `MEMBER=${GENERATED_MEMBER}`,
      '-t',
      resources.image,
      root,
    ], { quiet: true });
    if (!built.success) {
      console.error('  ✗ the generated Dockerfile failed to build');
      console.error(built.stderr);
      return 'failed';
    }

    // Deliberately WITHOUT --rm: a container that crash-loops at import is the failure this
    // gate exists to catch, and its logs — the only record of which specifier Deno tried to
    // record — must survive until they are read below. `resources.container` is unique to this
    // invocation, so cleanup can never remove a concurrent check's container.
    const started = await run([
      'docker',
      'run',
      '-d',
      '--name',
      resources.container,
      '--read-only',
      '--network',
      'none',
      '--tmpfs',
      '/tmp',
      resources.image,
    ], { quiet: true });
    if (!started.success) {
      console.error('  ✗ the image did not start');
      console.error(started.stderr);
      return 'failed';
    }

    let served = false;
    for (let attempt = 0; attempt < GENERATED_PROBE_ATTEMPTS; attempt += 1) {
      const probe = await run([
        'docker',
        'exec',
        resources.container,
        'wget',
        '-q',
        '-O',
        '/dev/null',
        `http://127.0.0.1:${GENERATED_PORT}/health`,
      ], { quiet: true });
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
      console.error('  ✗ the member never served /health under --read-only --network none');
      console.error(logs.stdout + logs.stderr);
      return 'failed';
    }
    console.log('  ✓ served /health under --read-only --network none');
    return 'passed';
  } finally {
    await run(['docker', 'rm', '-f', resources.container], { quiet: true });
    await run(['docker', 'image', 'rm', '-f', resources.image], { quiet: true });
    await Deno.remove(workspace, { recursive: true });
  }
}

const MANIFEST_DIR = 'k8s/manifests';

const CLUSTER_NAME = 'setu-deploy-gate';
const NAMESPACE = 'setu';
const RELEASE = 'setu';

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
      const built = await run([
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
      ], { quiet: true });
      if (!built.success) {
        console.error(`  ✗ could not build ${image}`);
        return 'failed';
      }
    }

    console.log(`  loading ${image} into the cluster …`);
    if (
      !(await run(['kind', 'load', 'docker-image', image, '--name', CLUSTER_NAME])).success
    ) {
      console.error('  ✗ kind load failed');
      return 'failed';
    }

    await run(kubectl('create', 'namespace', NAMESPACE), { quiet: true });

    console.log('  applying the COMMITTED manifests …');
    const applied = await run(
      kubectl('apply', '-n', NAMESPACE, '-f', 'k8s/manifests/'),
      { quiet: true },
    );
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
    if (Deno.env.get('KEEP_CLUSTER') === undefined) {
      console.log(`  deleting cluster ${CLUSTER_NAME} …`);
      await run(['kind', 'delete', 'cluster', '--name', CLUSTER_NAME], { quiet: true });
    }
  }
}

async function main(): Promise<void> {
  let modes: ModeSet;
  try {
    modes = parseModes(Deno.args);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    Deno.exit(2);
  }

  const results: CheckOutcome[] = [];
  if (modes.render) results.push(await checkRender(modes.write));
  if (modes.build) results.push(await checkBuild());
  if (modes.compose) results.push(await checkCompose());
  if (modes.generated) results.push(await checkGenerated());
  if (modes.cluster) results.push(await checkCluster());

  if (results.includes('failed')) {
    console.error('\ncheck:deploy FAILED');
    Deno.exit(1);
  }
  // A skip is reported with its own exit code rather than folded into success, so an absent
  // prerequisite can never be mistaken for a passing gate. CI must not permit it.
  if (results.includes('skipped')) {
    console.warn('\ncheck:deploy SKIPPED (tooling absent)');
    Deno.exit(SKIP_EXIT_CODE);
  }
  console.log('\ncheck:deploy OK');
}

if (import.meta.main) {
  await main();
}
