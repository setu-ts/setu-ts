/**
 * `setu workspace build` and `setu workspace deploy` (M122): the operations a workspace root
 * runs across every member, read from `setu.workspace.json` at run time so they follow members
 * as they are added, with no generated script to keep in step.
 *
 * Everything that can be decided without changing anything is decided first — the manifest, the
 * lockfile, the tag, the namespace, every member's secrets, the kube context, the manifest that
 * will be applied — so a refusal never leaves half a deploy behind.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';
import { parseEnv } from '@setu-ts/common';
import type { ParsedArgs } from '../args.ts';
import { stringFlag, stringFlags } from '../args.ts';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, PROGRAM_NAME } from '../constants.ts';
import {
  assertInsideProject,
  joinPath,
  readExistingText,
  resolveDir,
} from '../utils/file-writer.ts';
import { isMissingPath } from '../utils/filesystem-errors.ts';
import { escapeName } from '../utils/names.ts';
import { COMMAND_NOT_FOUND, type CommandRunner } from '../utils/run-command.ts';
import { DOCKERFILE, memberEnvironment } from '../workspace/compose.ts';
import {
  prepareDeployManifest,
  readsMemberSecret,
  stampSecretVersion,
} from '../workspace/deploy-manifest.ts';
import { defaultImageTag, imageReference, isValidImageTag } from '../workspace/image-tag.ts';
import { K8S_DIR } from '../workspace/k8s.ts';
import {
  MEMBERS_DIR,
  readWorkspaceManifest,
  WORKSPACE_MANIFEST,
  type WorkspaceManifest,
} from '../workspace/manifest.ts';
import { describeReconcileFailure, reconcileMembers } from '../workspace/reconcile.ts';
import { workspaceProfile } from '../workspace/runtime-profile.ts';
import {
  SECRET_VERSION_ANNOTATION,
  declaredSecretNames,
  envFromBlock,
  memberSecretName,
  missingSecretNames,
  renderMemberSecret,
  secretValuesPath,
} from '../workspace/secrets.ts';
import { transportSpec } from '../workspace/transport.ts';

/** Dependencies of the two operations. */
export interface WorkspaceOpsDependencies {
  readonly fs: IFileSystem;
  readonly cwd: string;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  readonly now: () => number;
  readonly runCommand?: CommandRunner;
}

/** The generated manifest deploy applies. */
const MEMBERS_FILE = `${K8S_DIR}/members.yaml`;

/** A rollout wait in kubectl's and Helm's duration form. */
const TIMEOUT_PATTERN = /^[1-9][0-9]*(s|m|h)$/;

/** The default rollout wait. */
const DEFAULT_TIMEOUT = '120s';

/** A DNS-1123 label: what a namespace name must be. */
const DNS_LABEL = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

/**
 * A registry prefix: a host (optionally with a port) and lowercase path segments. Checked because
 * it is written into the applied manifest's `image:` lines.
 */
const REGISTRY_PREFIX =
  /^[a-z0-9]([a-z0-9.-]*[a-z0-9])?(:[0-9]+)?(\/[a-z0-9]+([._-][a-z0-9]+)*)*\/?$/;

/** A `resourceVersion` as the API server writes one: opaque, but never empty or punctuated. */
const RESOURCE_VERSION = /^[0-9A-Za-z._-]{1,64}$/;

/** A Kubernetes label value. */
const LABEL_VALUE = /^[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/;

/** The usage line for `setu workspace build`. */
export const BUILD_USAGE: string =
  `Usage: ${PROGRAM_NAME} workspace build [--dir <path>] [--tag <tag>] [--registry <prefix>] ` +
  `[--build-arg <KEY=VALUE>]… [--network <name>] [--dry-run]`;

/** The usage line for `setu workspace deploy`. */
export const DEPLOY_USAGE: string =
  `Usage: ${PROGRAM_NAME} workspace deploy [--dir <path>] [--context <name>] [--namespace <name>] ` +
  `[--registry <prefix>] [--tag <tag>] [--timeout <duration>] [--build-arg <KEY=VALUE>]… ` +
  `[--network <name>] [--dry-run]`;

const BUILD_HELP: readonly string[] = [
  BUILD_USAGE,
  '  --dir <path>          The workspace root (default: the current directory)',
  '  --tag <tag>           Image tag (default: the short commit; <commit>-dirty-<UTC time> with changes)',
  '  --registry <prefix>   Name images <prefix>/<member>:<tag>; build never pushes',
  '  --build-arg <KEY=VALUE>  Pass a build argument to every image, e.g. NPM_CONFIG_REGISTRY=<url> (repeatable)',
  '  --network <name>      Network for the build steps, e.g. host for a registry on localhost',
  '  --dry-run             Print the builds, run nothing',
];

const DEPLOY_HELP: readonly string[] = [
  DEPLOY_USAGE,
  '  --dir <path>          The workspace root (default: the current directory)',
  '  --context <name>      kubectl context (default: the current one)',
  '  --namespace <name>    Namespace to deploy into (default: the workspace directory name)',
  '  --registry <prefix>   Push images there; required unless the context is kind-<cluster>',
  '  --tag <tag>           Image tag (default: the short commit; <commit>-dirty-<UTC time> with changes)',
  '  --timeout <duration>  Rollout wait per member, e.g. 300s or 5m (default: 120s)',
  '  --build-arg <KEY=VALUE>  Pass a build argument to every image (repeatable)',
  '  --network <name>      Network for the build steps, e.g. host',
  '  --dry-run             Check everything and print the plan, change nothing',
];

/** Options both operations read. */
interface ICommonOptions {
  readonly dir: string;
  readonly tag?: string;
  readonly registry?: string;
  /** Forwarded to every `docker build`: build arguments and the build network. */
  readonly buildFlags: readonly string[];
  readonly dryRun: boolean;
}

/** A workspace both operations act on. */
interface IWorkspace {
  readonly dir: string;
  readonly manifest: WorkspaceManifest;
  readonly run: CommandRunner;
  readonly tag: string;
}

type Outcome<T> =
  { readonly ok: true; readonly value: T } | { readonly ok: false; readonly code: number };

/**
 * Reads a valued flag, refusing one given without a value.
 *
 * @returns The value, `undefined` when absent, or `false` after reporting a usage error
 */
function valueFlag(
  args: ParsedArgs,
  name: string,
  deps: WorkspaceOpsDependencies,
): string | undefined | false {
  if (args.flags[name] === undefined) return undefined;
  const value = stringFlag(args.flags, name);
  if (value === undefined || value === '') {
    deps.error(`--${name} needs a value.`);
    return false;
  }
  return value;
}

/** Parses the options both operations share. */
function commonOptions(args: ParsedArgs, deps: WorkspaceOpsDependencies): ICommonOptions | false {
  const dir = valueFlag(args, 'dir', deps);
  const tag = valueFlag(args, 'tag', deps);
  const registry = valueFlag(args, 'registry', deps);
  const network = valueFlag(args, 'network', deps);
  if (dir === false || tag === false || registry === false || network === false) return false;
  const buildArgs =
    args.flags['build-arg'] === undefined ? [] : stringFlags(args.flags, 'build-arg');
  if (buildArgs === undefined || buildArgs.some((arg) => !/^[A-Za-z_][A-Za-z0-9_]*=/.test(arg))) {
    deps.error(
      '--build-arg takes KEY=VALUE, such as --build-arg NPM_CONFIG_REGISTRY=https://npm.example.com/.',
    );
    return false;
  }
  if (registry !== undefined && !REGISTRY_PREFIX.test(registry)) {
    deps.error(
      `--registry ${escapeName(registry)} is not a registry prefix such as ghcr.io/acme or localhost:5000.`,
    );
    return false;
  }
  if (tag !== undefined && !isValidImageTag(tag)) {
    deps.error(
      `--tag ${escapeName(tag)} is not a valid image tag: use letters, digits, '_', '.' and '-', starting with a letter, digit or '_' (at most 128).`,
    );
    return false;
  }
  return {
    dir: resolveDir(deps.cwd, dir),
    ...(tag === undefined ? {} : { tag }),
    ...(registry === undefined ? {} : { registry }),
    buildFlags: [
      ...buildArgs.flatMap((arg) => ['--build-arg', arg]),
      ...(network === undefined ? [] : ['--network', network]),
    ],
    dryRun: args.flags['dry-run'] === true,
  };
}

/** The message of a thrown value; `parseEnv` names the line, never its value. */
function messageOf(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** Whether a path exists, through the CLI's filesystem. */
async function exists(fs: IFileSystem, path: string): Promise<boolean> {
  try {
    await fs.stat(path);
    return true;
  } catch (cause) {
    if (isMissingPath(cause)) return false;
    throw cause;
  }
}

/** What reading one workspace file produced. */
type WorkspaceRead =
  | { readonly ok: true; readonly text: string | undefined }
  | { readonly ok: false; readonly message: string };

/**
 * Reads a file the operator or a contributor controls, inside the workspace only.
 *
 * Never through a link (M122 audit F2): a branch replacing `k8s/secrets/<member>` with a committed
 * symlink would otherwise load any dotenv file on the host — another project's `.env` — into a pod
 * that branch's code runs in, and the link also hid a tracked file from `git ls-files`. Regular
 * files only (a FIFO hung the deploy) and at most 1 MiB, the CLI's bound for files it inspects. A
 * read failure is reported, not thrown.
 *
 * @param fs - The CLI's filesystem
 * @param root - The workspace root
 * @param relative - The file, relative to the root
 * @returns The text, `undefined` when absent, or the reason it was refused
 */
async function readWorkspaceText(
  fs: IFileSystem,
  root: string,
  relative: string,
): Promise<WorkspaceRead> {
  const path = joinPath(root, relative);
  try {
    await assertInsideProject(fs, root, path);
    return { ok: true, text: await readExistingText(fs, path) };
  } catch (cause) {
    return { ok: false, message: `${relative}: ${messageOf(cause)}` };
  }
}

/** Opens the workspace: manifest, members, lockfile, runner and tag. */
async function openWorkspace(
  options: ICommonOptions,
  deps: WorkspaceOpsDependencies,
): Promise<Outcome<IWorkspace>> {
  const run = deps.runCommand;
  if (run === undefined) {
    deps.error(
      'This host cannot run docker, kind or kubectl, so the workspace cannot be built here.',
    );
    return { ok: false, code: EXIT_ERROR };
  }
  const read = await readWorkspaceManifest(deps.fs, options.dir);
  if (!read.ok) {
    deps.error(
      `No usable ${WORKSPACE_MANIFEST} in ${escapeName(options.dir)}, so this is not a Setu workspace.`,
    );
    return { ok: false, code: EXIT_ERROR };
  }
  const reconciliation = await reconcileMembers(deps.fs, options.dir, read.manifest);
  if (!reconciliation.ok) {
    deps.error(describeReconcileFailure(reconciliation));
    return { ok: false, code: EXIT_ERROR };
  }
  if (read.manifest.members.length === 0) {
    deps.error(
      `${WORKSPACE_MANIFEST} has no members yet. Add one with ${PROGRAM_NAME} generate app <name>.`,
    );
    return { ok: false, code: EXIT_ERROR };
  }
  // A member name becomes an image name, a Deployment, a Service and a Secret: all of them need a
  // DNS-1123 label. Every name the CLI generates is one; a hand-edited one is refused here rather
  // than spliced into YAML.
  const invalid = read.manifest.members.find((member) => !DNS_LABEL.test(member.name));
  if (invalid !== undefined) {
    deps.error(
      `Member ${escapeName(invalid.name)} in ${WORKSPACE_MANIFEST} is not a valid image and Kubernetes name (lowercase letters, digits and '-', at most 63).`,
    );
    return { ok: false, code: EXIT_ERROR };
  }
  // Every generated Dockerfile installs from the root lockfile, so without one the first build
  // would fail deep inside Docker with a package-manager error.
  const profile = workspaceProfile(read.manifest.runtime);
  if (!(await exists(deps.fs, joinPath(options.dir, profile.lockfile)))) {
    deps.error(
      `${profile.lockfile} is missing from the workspace root, and every member image installs from it. Run \`${profile.install}\` there first.`,
    );
    return { ok: false, code: EXIT_ERROR };
  }
  const tag = options.tag ?? (await defaultImageTag(run, options.dir, deps.now));
  return { ok: true, value: { dir: options.dir, manifest: read.manifest, run, tag } };
}

/** Reports a failed external command, naming a tool that is not installed. */
function reportFailure(
  deps: WorkspaceOpsDependencies,
  tool: string,
  what: string,
  code: number,
  detail = '',
): void {
  if (code === COMMAND_NOT_FOUND) {
    deps.error(`${what} failed: ${tool} is not installed or not on PATH.`);
    return;
  }
  deps.error(`${what} failed (exit ${code}).${detail === '' ? '' : `\n${detail.trimEnd()}`}`);
}

/** The `docker build` argument list for one member. */
function dockerBuildArgs(
  member: string,
  image: string,
  extra: readonly string[],
): readonly string[] {
  return [
    'build',
    '-f',
    DOCKERFILE,
    ...extra,
    '--build-arg',
    `MEMBER=${member}`,
    // Always passed: with NPMRC unset the secret mounts as an empty file, which npm ignores
    // (measured), exactly as the generated Compose file does.
    '--secret',
    'id=npmrc,env=NPMRC',
    '-t',
    image,
    '.',
  ];
}

/** Builds every member's image, in manifest order, stopping at the first failure. */
async function buildImages(
  workspace: IWorkspace,
  images: ReadonlyMap<string, string>,
  options: ICommonOptions,
  deps: WorkspaceOpsDependencies,
): Promise<boolean> {
  const dryRun = options.dryRun;
  for (const [member, image] of images) {
    const args = dockerBuildArgs(member, image, options.buildFlags);
    if (dryRun) {
      deps.log(`  would run: docker ${args.join(' ')}`);
      continue;
    }
    deps.log(`Building ${member} → ${image}`);
    const result = await workspace.run('docker', args, { cwd: workspace.dir, stream: true });
    if (result.code !== 0) {
      reportFailure(deps, 'docker', `Building ${member}`, result.code);
      return false;
    }
  }
  return true;
}

/** The images every member is built under. */
function memberImages(workspace: IWorkspace, registry: string | undefined): Map<string, string> {
  return new Map(
    workspace.manifest.members.map((member) => [
      member.name,
      imageReference(member.name, workspace.tag, registry),
    ]),
  );
}

/**
 * Runs `setu workspace build`.
 *
 * @param args - Arguments after `workspace build`
 * @param deps - Filesystem, output, clock and command runner
 * @returns The exit code
 */
export async function runWorkspaceBuild(
  args: ParsedArgs,
  deps: WorkspaceOpsDependencies,
): Promise<number> {
  if (args.flags['help'] === true || args.flags['h'] === true) {
    for (const line of BUILD_HELP) deps.log(line);
    return EXIT_OK;
  }
  const options = commonOptions(args, deps);
  if (options === false) return EXIT_USAGE;
  const opened = await openWorkspace(options, deps);
  if (!opened.ok) return opened.code;
  const images = memberImages(opened.value, options.registry);
  if (options.dryRun) deps.log(`Dry run: ${images.size} image(s) would be built.`);
  if (!(await buildImages(opened.value, images, options, deps))) return EXIT_ERROR;
  if (!options.dryRun) {
    deps.log(`Built ${images.size} image(s):`);
    for (const image of images.values()) deps.log(`  ${image}`);
  }
  return EXIT_OK;
}

/** One member's Secret, ready to apply. */
interface IMemberSecret {
  readonly member: string;
  readonly names: readonly string[];
  readonly manifest: string;
}

/**
 * git's messages in English, so "not a git repository" can be recognized; and discovery that
 * crosses filesystems, so a workspace mounted below an enclosing repository is still found inside
 * it (audit 4, A4-2: git otherwise stopped at the mount point and the check deployed a committed
 * file).
 */
const GIT_ENV = { LC_ALL: 'C', GIT_DISCOVERY_ACROSS_FILESYSTEM: '1' } as const;

/**
 * Whether a values file is committed, failing closed (M122 audit F2, re-audit N1). The deploy
 * continues only for a work tree whose `git ls-files` says "not tracked", or for a directory git
 * itself calls "not a git repository" while searching the parent directories. git runs with every
 * inherited `GIT_*` variable removed (audit 3, L1). Every other answer refuses: a missing `git`, a repository
 * git declines to read (dubious ownership, `safe.bareRepository`), `GIT_DIR` pointing elsewhere, or
 * `false` from inside a bare repository's directory — each of which made the old "any non-zero exit
 * means no repository" rule deploy a committed file.
 *
 * @returns The refusal, or `undefined` when the file is not tracked
 */
async function trackedByGit(
  workspace: IWorkspace,
  valuesPath: string,
): Promise<string | undefined> {
  const options = { cwd: workspace.dir, env: GIT_ENV, unsetPrefixes: ['GIT_'] };
  const inside = await workspace.run('git', ['rev-parse', '--is-inside-work-tree'], options);
  if (inside.code === COMMAND_NOT_FOUND) {
    return `git is not installed or not on PATH, so ${valuesPath} cannot be checked for being committed.`;
  }
  if (inside.code !== 0) {
    // Only git's own discovery failure: with GIT_DIR set, the message names that directory instead.
    if (/not a git repository \(or any of the parent directories\)/.test(inside.stderr)) {
      return undefined;
    }
    const reason = inside.stderr.trim().split('\n')[0] ?? '';
    return `git could not inspect this workspace (exit ${inside.code}: ${reason}), so ${valuesPath} cannot be checked for being committed.`;
  }
  if (inside.stdout.trim() !== 'true') {
    return `git does not report a work tree here (${JSON.stringify(inside.stdout.trim())}), so ${valuesPath} cannot be checked for being committed.`;
  }
  const listed = await workspace.run('git', ['ls-files', '--error-unmatch', valuesPath], options);
  if (listed.code === 1) return undefined;
  if (listed.code === 0) {
    return `${valuesPath} is tracked by git. Remove it from the index (git rm --cached ${valuesPath}) and rotate its values before deploying.`;
  }
  return `git could not say whether ${valuesPath} is committed (exit ${listed.code}); refusing to deploy it.`;
}

/** Collects every member's Secret, or every problem with them. */
async function collectSecrets(
  workspace: IWorkspace,
  namespace: string,
  label: string,
  membersYaml: string,
  deps: WorkspaceOpsDependencies,
): Promise<IMemberSecret[] | undefined> {
  const transport = transportSpec(workspace.manifest.transport);
  const problems: string[] = [];
  const secrets: IMemberSecret[] = [];
  for (const member of workspace.manifest.members) {
    const siblings = workspace.manifest.members.filter((other) => other.name !== member.name);
    const generated = new Set(Object.keys(memberEnvironment(siblings, transport)));
    const examplePath = `${MEMBERS_DIR}/${member.name}/.env.example`;
    const valuesPath = secretValuesPath(member.name);
    const exampleRead = await readWorkspaceText(deps.fs, workspace.dir, examplePath);
    const valuesRead = await readWorkspaceText(deps.fs, workspace.dir, valuesPath);
    if (!exampleRead.ok || !valuesRead.ok) {
      for (const read of [exampleRead, valuesRead]) if (!read.ok) problems.push(read.message);
      continue;
    }
    const example = exampleRead.text;
    const valuesText = valuesRead.text;
    let declared: readonly string[];
    let values: Readonly<Record<string, string>>;
    try {
      declared = example === undefined ? [] : declaredSecretNames(example, generated);
    } catch (cause) {
      problems.push(`${examplePath}: ${messageOf(cause)}`);
      continue;
    }
    try {
      values = valuesText === undefined ? {} : parseEnv(valuesText);
    } catch (cause) {
      // The parser names the line, never its value.
      problems.push(`${valuesPath}: ${messageOf(cause)}`);
      continue;
    }
    const missing = missingSecretNames(declared, values);
    if (missing.length > 0) {
      problems.push(
        `${member.name} needs ${missing.join(', ')} in ${valuesPath}${valuesText === undefined ? ' (the file does not exist)' : ''}.`,
      );
      continue;
    }
    if (valuesText === undefined && declared.length === 0) continue;
    const tracked = await trackedByGit(workspace, valuesPath);
    if (tracked !== undefined) {
      problems.push(tracked);
      continue;
    }
    if (!readsMemberSecret(membersYaml, member.name)) {
      problems.push(
        `${MEMBERS_FILE} does not read ${memberSecretName(member.name)} for ${member.name}: it predates M122. Add this under the ${member.name} container (after its env: block), or regenerate the file with ${PROGRAM_NAME} generate app:\n${envFromBlock(member.name)}`,
      );
      continue;
    }
    secrets.push({
      member: member.name,
      names: Object.keys(values),
      manifest: renderMemberSecret(member.name, namespace, label, values),
    });
  }
  if (problems.length === 0) return secrets;
  deps.error('Deploy refused; nothing was built or applied:');
  for (const problem of problems) deps.error(`  ${problem}`);
  return undefined;
}

/** The kube context deploy uses, and the kind cluster behind it when there is one. */
async function resolveContext(
  workspace: IWorkspace,
  explicit: string | undefined,
  deps: WorkspaceOpsDependencies,
): Promise<{ readonly context: string; readonly kindCluster?: string } | undefined> {
  let context = explicit;
  if (context === undefined) {
    const current = await workspace.run('kubectl', ['config', 'current-context'], {
      cwd: workspace.dir,
    });
    if (current.code !== 0 || current.stdout.trim() === '') {
      if (current.code === COMMAND_NOT_FOUND) {
        reportFailure(deps, 'kubectl', 'Reading the current kubectl context', current.code);
      } else {
        deps.error('kubectl has no current context. Pass --context <name>.');
      }
      return undefined;
    }
    context = current.stdout.trim();
  }
  const kind = /^kind-(.+)$/.exec(context);
  return kind === null ? { context } : { context, kindCluster: kind[1]! };
}

/** How one manifest is applied. */
interface IApply {
  readonly manifest: string;
  readonly what: string;
  /** A Secret: server-side, its resourceVersion printed, and kubectl's stderr never shown. */
  readonly secret?: true;
}

/**
 * Applies one manifest from stdin.
 *
 * kubectl's stderr is shown for every other object, never for a Secret (M122 audit F3): it can
 * quote the values it rejected, and redacting them was incomplete for a value contained in
 * another and for JSON-escaped forms.
 *
 * @returns kubectl's stdout (a Secret's resourceVersion), or `undefined` after reporting a failure
 */
async function applyManifest(
  workspace: IWorkspace,
  context: string,
  apply: IApply,
  deps: WorkspaceOpsDependencies,
): Promise<string | undefined> {
  const args = [
    '--context',
    context,
    'apply',
    ...(apply.secret === true
      ? // --force-conflicts: deploy owns `<member>-env`. A Secret first created by a client-side
        // apply (or by hand) has its keys owned by another field manager, and taking those keys
        // over is otherwise refused as a conflict (measured on kind, M122).
        [
          '--server-side',
          '--field-manager=setu',
          '--force-conflicts',
          '-o',
          'jsonpath={.metadata.resourceVersion}',
        ]
      : []),
    '-f',
    '-',
  ];
  const result = await workspace.run('kubectl', args, {
    cwd: workspace.dir,
    input: apply.manifest,
  });
  if (result.code !== 0) {
    reportFailure(
      deps,
      'kubectl',
      `Applying ${apply.what}`,
      result.code,
      apply.secret === true
        ? "kubectl's message is not shown for a Secret, because it can quote the values. Check the values file and this context's access to Secrets."
        : result.stderr,
    );
    return undefined;
  }
  deps.log(`  applied ${apply.what}`);
  return result.stdout;
}

/**
 * The Secret version a Deployment's applied pod template carries, from kubectl's JSON output of
 * `.spec.template.metadata.annotations`; `undefined` when there is none or it cannot be read.
 *
 * @param json - kubectl's output
 * @returns The annotation's value
 */
function templateVersion(json: string): string | undefined {
  try {
    const annotations: unknown = JSON.parse(json.trim() === '' ? '{}' : json);
    if (typeof annotations !== 'object' || annotations === null) return undefined;
    const value = (annotations as Record<string, unknown>)[SECRET_VERSION_ANNOTATION];
    return typeof value === 'string' ? value : undefined;
  } catch {
    return undefined;
  }
}

/** Reads a Secret's resourceVersion, or `''` when it does not exist yet. */
async function secretVersion(
  workspace: IWorkspace,
  context: string,
  namespace: string,
  name: string,
  deps: WorkspaceOpsDependencies,
): Promise<string | undefined> {
  const result = await workspace.run(
    'kubectl',
    [
      '--context',
      context,
      '-n',
      namespace,
      'get',
      'secret',
      name,
      '--ignore-not-found',
      '-o',
      'jsonpath={.metadata.resourceVersion}',
    ],
    { cwd: workspace.dir },
  );
  if (result.code !== 0) {
    reportFailure(deps, 'kubectl', `Reading Secret ${name}`, result.code, result.stderr);
    return undefined;
  }
  return result.stdout.trim();
}

/** Parses the options only deploy reads. */
function deployOptions(
  args: ParsedArgs,
  dir: string,
  deps: WorkspaceOpsDependencies,
):
  | {
      readonly context?: string;
      readonly namespace: string;
      readonly label: string;
      readonly timeout: string;
    }
  | false {
  const context = valueFlag(args, 'context', deps);
  const namespace = valueFlag(args, 'namespace', deps);
  const timeout = valueFlag(args, 'timeout', deps);
  if (context === false || namespace === false || timeout === false) return false;
  if (timeout !== undefined && !TIMEOUT_PATTERN.test(timeout)) {
    deps.error(
      `--timeout ${escapeName(timeout)} is not a duration: use seconds, minutes or hours, such as 300s or 5m.`,
    );
    return false;
  }
  const directory = dir.replace(/\/+$/, '').split('/').pop() ?? '';
  const chosen = namespace ?? directory;
  if (!DNS_LABEL.test(chosen)) {
    deps.error(
      `${escapeName(chosen)} is not a valid namespace name (lowercase letters, digits and '-', at most 63). Pass --namespace <name>.`,
    );
    return false;
  }
  return {
    ...(context === undefined ? {} : { context }),
    namespace: chosen,
    label: LABEL_VALUE.test(directory) ? directory : chosen,
    timeout: timeout ?? DEFAULT_TIMEOUT,
  };
}

/**
 * Runs `setu workspace deploy`.
 *
 * @param args - Arguments after `workspace deploy`
 * @param deps - Filesystem, output, clock and command runner
 * @returns The exit code
 */
export async function runWorkspaceDeploy(
  args: ParsedArgs,
  deps: WorkspaceOpsDependencies,
): Promise<number> {
  if (args.flags['help'] === true || args.flags['h'] === true) {
    for (const line of DEPLOY_HELP) deps.log(line);
    return EXIT_OK;
  }
  const options = commonOptions(args, deps);
  if (options === false) return EXIT_USAGE;
  const deploy = deployOptions(args, options.dir, deps);
  if (deploy === false) return EXIT_USAGE;
  const opened = await openWorkspace(options, deps);
  if (!opened.ok) return opened.code;
  const workspace = opened.value;

  const membersRead = await readWorkspaceText(deps.fs, workspace.dir, MEMBERS_FILE);
  if (!membersRead.ok) {
    deps.error(membersRead.message);
    return EXIT_ERROR;
  }
  const membersYaml = membersRead.text;
  if (membersYaml === undefined) {
    deps.error(
      `${MEMBERS_FILE} is missing. ${PROGRAM_NAME} generate app writes it; restore it before deploying.`,
    );
    return EXIT_ERROR;
  }
  const target = await resolveContext(workspace, deploy.context, deps);
  if (target === undefined) return EXIT_ERROR;
  if (target.kindCluster === undefined && options.registry === undefined) {
    deps.error(
      `Context ${escapeName(target.context)} is not a kind cluster, so images must be pushed: pass --registry <prefix>.`,
    );
    return EXIT_USAGE;
  }
  const images = memberImages(workspace, options.registry);
  const prepared = prepareDeployManifest(membersYaml, {
    namespace: deploy.namespace,
    workspace: deploy.label,
    images,
  });
  if (!prepared.ok) {
    deps.error(prepared.message);
    return EXIT_ERROR;
  }
  const secrets = await collectSecrets(
    workspace,
    deploy.namespace,
    deploy.label,
    membersYaml,
    deps,
  );
  if (secrets === undefined) return EXIT_ERROR;

  const ship =
    target.kindCluster === undefined
      ? `push each image to ${options.registry}`
      : `load each image into kind cluster ${target.kindCluster}`;
  deps.log(
    `${options.dryRun ? 'Dry run: would deploy' : 'Deploying'} ${images.size} member(s) to ${deploy.namespace} on ${target.context} (tag ${workspace.tag}; ${ship}).`,
  );
  if (!(await buildImages(workspace, images, options, deps))) return EXIT_ERROR;

  if (options.dryRun) {
    for (const image of images.values()) {
      deps.log(
        target.kindCluster === undefined
          ? `  would run: docker push ${image}`
          : `  would run: kind load docker-image ${image} --name ${target.kindCluster}`,
      );
    }
    deps.log(`  would apply: Namespace ${deploy.namespace}`);
    for (const secret of secrets) {
      deps.log(
        `  would apply (server-side): Secret ${memberSecretName(secret.member)} with ${secret.names.length === 0 ? 'no keys' : secret.names.join(', ')}`,
      );
    }
    deps.log(`  would apply: ${MEMBERS_FILE} with the namespace and images filled in`);
    deps.log(
      "  would roll out: each member whose Secret version changes (its pod template's setu-ts.dev/secret-version)",
    );
    for (const member of images.keys()) {
      deps.log(`  would wait: rollout of deployment/${member} (timeout ${deploy.timeout})`);
    }
    return EXIT_OK;
  }

  for (const image of images.values()) {
    const [tool, shipArgs] =
      target.kindCluster === undefined
        ? (['docker', ['push', image]] as const)
        : (['kind', ['load', 'docker-image', image, '--name', target.kindCluster]] as const);
    const shipped = await workspace.run(tool, shipArgs, { cwd: workspace.dir, stream: true });
    if (shipped.code !== 0) {
      reportFailure(deps, tool, `Shipping ${image}`, shipped.code);
      return EXIT_ERROR;
    }
  }

  const namespaceManifest = `apiVersion: v1\nkind: Namespace\nmetadata:\n  name: ${deploy.namespace}\n`;
  const ctx = target.context;
  if (
    (await applyManifest(
      workspace,
      ctx,
      { manifest: namespaceManifest, what: `Namespace ${deploy.namespace}` },
      deps,
    )) === undefined
  ) {
    return EXIT_ERROR;
  }
  // A Secret whose contents changed reaches running pods only through a new rollout: `envFrom` is
  // read at container start, and a rotation on a clean tree keeps both the tag and the manifest
  // (M122 audit F1). Each member's Secret resourceVersion — which reveals nothing about the values
  // — is written into its pod template, so a changed Secret changes the template and Kubernetes
  // rolls out by itself; a deploy re-run after failing part-way still sees the difference
  // (re-audit N2). A members.yaml from before that annotation existed has no slot: those members
  // fall back to comparing versions and `kubectl rollout restart`.
  let manifest = prepared.text;
  const fallback: string[] = [];
  const stamped = new Map<string, string>();
  for (const secret of secrets) {
    const name = memberSecretName(secret.member);
    const before = await secretVersion(workspace, ctx, deploy.namespace, name, deps);
    if (before === undefined) return EXIT_ERROR;
    const after = await applyManifest(
      workspace,
      ctx,
      {
        manifest: secret.manifest,
        what: `Secret ${name} (${secret.names.length} key(s))`,
        secret: true,
      },
      deps,
    );
    if (after === undefined) return EXIT_ERROR;
    // Validated before it goes into YAML: an empty or quoted value would stamp nothing, or write
    // into the pod template (audit 3, L3).
    if (!RESOURCE_VERSION.test(after.trim())) {
      deps.error(
        `kubectl returned an unexpected resourceVersion for Secret ${name}; nothing more was applied.`,
      );
      return EXIT_ERROR;
    }
    const stamp = stampSecretVersion(manifest, secret.member, after.trim());
    manifest = stamp.text;
    if (stamp.stamped) stamped.set(secret.member, after.trim());
    else if (after.trim() !== before) fallback.push(secret.member);
  }
  let existing: ReadonlySet<string> = new Set();
  if (fallback.length > 0) {
    const listed = await workspace.run(
      'kubectl',
      ['--context', ctx, '-n', deploy.namespace, 'get', 'deployments', '-o', 'name'],
      { cwd: workspace.dir },
    );
    if (listed.code !== 0) {
      reportFailure(deps, 'kubectl', 'Listing Deployments', listed.code, listed.stderr);
      return EXIT_ERROR;
    }
    existing = new Set(listed.stdout.split('\n').map((line) => line.trim().split('/').pop() ?? ''));
  }
  if ((await applyManifest(workspace, ctx, { manifest, what: MEMBERS_FILE }, deps)) === undefined) {
    return EXIT_ERROR;
  }
  // The stamp is a text edit, so the cluster is asked what it now holds (audit 4, A4-1). A stamped
  // member whose applied pod template does not carry its Secret version — a hand-edited file the
  // text match misread — is restarted rather than left on the old value. A pre-annotation manifest
  // restarts a changed member only when its Deployment already existed: a new one reads the Secret.
  const restart = fallback.filter((name) => existing.has(name));
  for (const [member, version] of stamped) {
    const read = await workspace.run(
      'kubectl',
      [
        '--context',
        ctx,
        '-n',
        deploy.namespace,
        'get',
        `deployment/${member}`,
        '-o',
        'jsonpath={.spec.template.metadata.annotations}',
      ],
      { cwd: workspace.dir },
    );
    if (read.code !== 0) {
      reportFailure(deps, 'kubectl', `Reading deployment/${member}`, read.code, read.stderr);
      return EXIT_ERROR;
    }
    if (templateVersion(read.stdout) !== version) restart.push(member);
  }
  for (const member of restart) {
    const restarted = await workspace.run(
      'kubectl',
      ['--context', ctx, '-n', deploy.namespace, 'rollout', 'restart', `deployment/${member}`],
      { cwd: workspace.dir },
    );
    if (restarted.code !== 0) {
      reportFailure(
        deps,
        'kubectl',
        `Restarting ${member} for its changed Secret`,
        restarted.code,
        restarted.stderr,
      );
      return EXIT_ERROR;
    }
    deps.log(`  restarted deployment/${member}: its Secret changed`);
  }

  for (const member of images.keys()) {
    const rollout = await workspace.run(
      'kubectl',
      [
        '--context',
        target.context,
        '-n',
        deploy.namespace,
        'rollout',
        'status',
        `deployment/${member}`,
        `--timeout=${deploy.timeout}`,
      ],
      { cwd: workspace.dir, stream: true },
    );
    if (rollout.code !== 0) {
      deps.error(
        `${member} did not finish rolling out within ${deploy.timeout}. Inspect it with:\n` +
          `  kubectl --context ${target.context} -n ${deploy.namespace} describe deployment/${member}\n` +
          `  kubectl --context ${target.context} -n ${deploy.namespace} logs deployment/${member}`,
      );
      return EXIT_ERROR;
    }
  }
  deps.log(`Deployed ${images.size} member(s) to ${deploy.namespace} with tag ${workspace.tag}.`);
  return EXIT_OK;
}
