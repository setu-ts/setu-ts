// deno-lint-ignore-file no-console -- this CI script reports progress, drift and skips.
/**
 * @module
 *
 * Deployment gate (M39): proves the container images build, the committed Kubernetes manifests
 * still match the chart they are rendered from, the Compose model resolves, and — with a real
 * cluster — that the manifests actually deploy and serve.
 *
 * Modes are separable so the fast structural checks stay usable on every run while the slow
 * cluster proof is opt-in locally and mandatory in CI:
 *
 * ```
 * deno task check:deploy                 # render + build + compose
 * deno task check:deploy --render        # rendered manifests match the chart
 * deno task check:deploy --cluster       # real kind apply + serve + RBAC
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
  write: false,
};

const ALL_MODE_FLAGS = [
  '--render',
  '--build',
  '--compose',
  '--cluster',
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
  options: { readonly quiet?: boolean } = {},
): Promise<{ success: boolean; stdout: string }> {
  const quiet = options.quiet === true;
  const output = await new Deno.Command(command[0], {
    args: [...command.slice(1)],
    stdout: quiet ? 'piped' : 'inherit',
    stderr: quiet ? 'piped' : 'inherit',
  }).output();
  return {
    success: output.success,
    // `output.stdout` throws when the stream was inherited rather than piped, so it is only
    // read in the quiet case. Callers that need stdout always pass quiet.
    stdout: quiet ? new TextDecoder().decode(output.stdout) : '',
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
    console.log('  serving a request through the Service …');
    const served = await run(
      kubectl(
        'run',
        'gate-probe',
        '-n',
        NAMESPACE,
        '--rm',
        '-i',
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
    const status = served.stdout.trim();
    if (!served.success || !status.startsWith('200')) {
      console.error(`  ✗ request through the Service returned "${status}", expected 200`);
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
