/**
 * The `setu generate app` command — adds a member to a workspace.
 *
 * Not a schematic. `Schematic` is a PURE `(names, options) => GeneratedFile[]`
 * that performs no I/O, and this command reads the workspace manifest,
 * allocates a port from it, and regenerates every existing member's discovery
 * module. Hoisting all of that into `SchematicOptions` would put workspace state
 * on a published interface no other schematic reads. It is dispatched from
 * `generate` the way `custom` already is, so both verbs share one `--dir`, one
 * `--dry-run`, and one help surface.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';

import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import {
  APP_VERB,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  PROGRAM_NAME,
  TEMPLATES,
} from '../constants.ts';
import { MINIMAL_HOST } from '../templates/minimal.ts';
import { projectFiles, resolveHost } from '../templates/project-files.ts';
import { resolveTemplateChoice } from '../templates/choice.ts';
import { deriveNames, isIdentifierSafe } from '../utils/names.ts';
import {
  findExisting,
  firstDuplicatePath,
  type GeneratedFile,
  joinPath,
  writeFiles,
} from '../utils/file-writer.ts';
import {
  DISCOVERY_MODULE,
  DISCOVERY_SPECIFIER,
  renderDiscoveryModule,
  SERVICE_PORT_EXPORT,
} from '../workspace/discovery-module.ts';
import { workspaceContainerFiles } from '../workspace/compose.ts';
import { workspaceK8sFiles } from '../workspace/k8s.ts';
import { workspaceProfile, type WorkspaceRuntimeProfile } from '../workspace/runtime-profile.ts';
import { withWorkspaceMember } from '../workspace/member-host.ts';
import { planRootNodeModulesDir, ROOT_MANIFEST } from '../workspace/root-manifest.ts';
import { TRANSPORTS, type TransportSpec, transportSpec } from '../workspace/transport.ts';
import {
  allocatePort,
  MAX_PORT,
  MEMBERS_DIR,
  MIN_PORT,
  readPortFlag,
  readWorkspaceManifest,
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
  type WorkspaceManifest,
  type WorkspaceManifestProblem,
} from '../workspace/manifest.ts';

/**
 * Everything `runAppCommand` reaches the outside world through.
 */
export interface AppDependencies {
  /** The filesystem to read the workspace through and write the member with. */
  readonly fs: IFileSystem;
  /** The workspace root to operate on (absolute, already `--dir`-resolved). */
  readonly dir: string;
  /** Writes a line of normal output. */
  readonly log: (message: string) => void;
  /** Writes a line of error output. */
  readonly error: (message: string) => void;
}

/**
 * Prints the command's usage.
 *
 * @param log - Output sink
 */
function printUsage(log: (message: string) => void): void {
  log(
    `Usage: ${PROGRAM_NAME} generate ${APP_VERB} <name> [--template <name>] ` +
      `[--port <n>] [--dir <path>]`,
  );
  log('');
  log(`Adds a service to a Setu workspace: creates ${MEMBERS_DIR}/<name>/, allocates it a`);
  log(`port, and registers it in every other member's static discovery map.`);
  log('');
  log('Options:');
  // From the constant, not a hand-written list: this said
  // an incomplete hand-written list while `full-stack` was refused, and would have
  // gone on saying it after the refusal was lifted.
  log(`  --template <name>   ${TEMPLATES.join(' | ')}`);
  log('  --port <n>          Bind this port instead of the next one the CLI would allocate');
  log('  --dir <path>        The workspace root, instead of the working directory');
  log('  --dry-run           Print what would be created, write nothing');
  log('');
  log(`The transport is the workspace's, recorded in ${WORKSPACE_MANIFEST}, and every member`);
  log('inherits it — services can only talk over a bus they share.');
}

/**
 * Reports why the target directory is not a usable workspace.
 *
 * @param dir - The directory that was probed
 * @param error - Error sink
 * @returns The exit code to return
 */
function reportNoWorkspace(
  dir: string,
  problem: WorkspaceManifestProblem,
  error: (message: string) => void,
): number {
  if (problem.kind === 'absent') {
    error(`No ${WORKSPACE_MANIFEST} in ${dir}, so this is not a Setu workspace.`);
    error(`Create one with \`${PROGRAM_NAME} new <name> --workspace\`, then run this inside it.`);
    return EXIT_ERROR;
  }
  if (problem.kind === 'unsupported-version') {
    error(
      `${joinPath(dir, WORKSPACE_MANIFEST)} declares version ${problem.version}, ` +
        `and this CLI understands version ${WORKSPACE_VERSION}.`,
    );
    error('Upgrade the CLI, or check the file into version control and roll it back.');
    return EXIT_ERROR;
  }
  if (problem.kind === 'invalid-port') {
    error(
      `${joinPath(dir, WORKSPACE_MANIFEST)} gives ${problem.field} the port ${problem.port}, ` +
        `which no service can bind: it must be an integer between ${MIN_PORT} and ${MAX_PORT}.`,
    );
    error(
      "Every port here is written into a member's own entry point and into every sibling's " +
        'discovery map, so this would break the whole workspace.',
    );
    return EXIT_ERROR;
  }
  if (problem.kind === 'unknown-transport') {
    error(
      `${joinPath(dir, WORKSPACE_MANIFEST)} names the transport "${problem.transport}", ` +
        `which this CLI does not know. Expected one of: ${TRANSPORTS.join(', ')}.`,
    );
    error(
      'Refused rather than defaulted: quietly moving every member off the bus this workspace ' +
        'asked for would leave services that cannot reach each other and nothing saying why.',
    );
    return EXIT_ERROR;
  }
  error(`${joinPath(dir, WORKSPACE_MANIFEST)} is not a readable workspace manifest.`);
  error(`It must be JSON carrying \`version\`, \`basePort\`, and a \`members\` array.`);
  return EXIT_ERROR;
}

/**
 * Builds the whole plan: the member's project, every member's discovery module,
 * and the rewritten manifest.
 *
 * The new member's discovery module comes from the regeneration pass ONLY,
 * never also from its host's files — `findExisting` probes the filesystem and
 * cannot see one path planned twice, so both would be written with the last
 * silently winning.
 *
 * @param name - The member's kebab-case name
 * @param next - The manifest as it will be after this member is added
 * @param args - The parsed arguments, read for `--template`
 * @returns The planned files, or the usage refusal to print
 */
function planMember(
  name: string,
  next: WorkspaceManifest,
  args: ParsedArgs,
  transport: TransportSpec,
  profile: WorkspaceRuntimeProfile,
  rootManifest: string,
): { readonly ok: true; readonly files: readonly GeneratedFile[] } | {
  readonly ok: false;
  readonly message: string;
} {
  const choice = resolveTemplateChoice(args);
  if (!choice.ok) return { ok: false, message: choice.message };

  const extra: GeneratedFile[] = [];

  // A template with a frontend build needs `node_modules`, which only the root
  // may enable. Measured: a real `react-router build` and an SSR 200 both work
  // inside a member once the root declares it.
  if (choice.template?.manifest?.npmBuildScript !== undefined) {
    // …but the transport must be able to reach it first. A starter-composed
    // template owns its whole plugin set, so a transport that appends a plugin
    // or rewrites `MessagingPlugin`'s arguments would have its contribution
    // SILENTLY DROPPED by the renderer's factory branch — the member would join
    // a workspace on a bus it is not actually connected to.
    const contributes = transport.plugins.length > 0 || transport.messagingArgs !== undefined;
    if (choice.template.appFactory !== undefined && contributes) {
      return {
        ok: false,
        message: `The "${choice.template.name}" template composes its whole plugin set through ` +
          `${choice.template.appFactory.symbol}, so this workspace's "${transport.name}" ` +
          `transport cannot reach it — the plugin it contributes would be dropped and the member ` +
          `would look connected while talking to nobody. Add it to a workspace on ` +
          `--transport http or memory, or scaffold it standalone with ` +
          `\`${PROGRAM_NAME} new <name> --template ${choice.template.name}\`.`,
      };
    }

    // Deno only. `nodeModulesDir` is a Deno setting that turns on the real
    // `node_modules` directory npm and Bun have BY CONSTRUCTION — so on an npm
    // workspace there is nothing to enable, and asking for the field would mean
    // reading a `deno.json` that does not exist there. Left ungated, the absent
    // file lands in the unparseable-root branch and the member is refused with
    // advice that would change nothing if followed.
    if (profile.manifestKind === 'deno') {
      const plan = planRootNodeModulesDir(rootManifest, name);
      if (plan.kind === 'refused') return { ok: false, message: plan.message };
      if (plan.kind === 'update') extra.push(plan.file);
    }
  }

  // The WORKSPACE's runtime, never a per-member flag: members share one root
  // manifest and one lockfile, so a member built with a different toolchain than
  // the root that installs it is not a member at all. A runtime swap can still
  // apply — the template data decides that, per target, exactly as it does for a
  // standalone project.
  const host = withWorkspaceMember(
    resolveHost(choice.template ?? MINIMAL_HOST, profile.runtime),
    transport,
    name,
    profile,
    // Omitted rather than passed as `undefined`: `exactOptionalPropertyTypes` is
    // on, and the parameter is optional.
    ...(next.transportUrl === undefined ? [] : [next.transportUrl]) as [string?],
  );
  const memberRoot = joinPath(MEMBERS_DIR, name);

  const files: GeneratedFile[] = projectFiles(name, profile.runtime, host, {
    symbol: SERVICE_PORT_EXPORT,
    from: DISCOVERY_SPECIFIER,
  }).map((file) => ({ ...file, path: joinPath(memberRoot, file.path) }));

  // Every member, not only the new one: adding a service registers it with its
  // callers, which is the whole point — a sibling that never learns the new name
  // resolves it to `[]`.
  for (const member of next.members) {
    files.push({
      path: joinPath(MEMBERS_DIR, member.name, DISCOVERY_MODULE),
      contents: renderDiscoveryModule(member, next.members, profile),
      managed: true,
    });
  }

  files.push({
    path: WORKSPACE_MANIFEST,
    contents: renderWorkspaceManifest(next),
    managed: true,
  });

  // Regenerated for the whole workspace on every member, exactly as the discovery
  // modules are: a stack that names two of three members is worse than none, and
  // the ports it publishes come from the same manifest the maps do.
  for (const file of workspaceContainerFiles(next, transport, profile)) files.push(file);
  for (const file of workspaceK8sFiles(next, transport)) files.push(file);

  for (const file of extra) files.push(file);

  return { ok: true, files };
}

/**
 * Runs `setu generate app`.
 *
 * Refuses outside a workspace, refuses a duplicate member, and checks every
 * planned path for an existing file BEFORE the first write. The regenerated
 * discovery modules and the manifest are {@linkcode GeneratedFile.managed}, so
 * rewriting them is not an overwrite; the member's own source is not, so a name
 * that already has files on disk is still refused.
 *
 * @param args - Arguments after the `generate` verb, already parsed
 * @param deps - Filesystem, workspace root, and output sinks
 * @returns `0` on success, `1` on a runtime error, `2` on a usage error
 */
export async function runAppCommand(
  args: ParsedArgs,
  deps: AppDependencies,
): Promise<number> {
  if (args.flags['help'] === true || args.flags['h'] === true) {
    printUsage(deps.log);
    return EXIT_OK;
  }

  const rawName = args.positionals[1];
  if (rawName === undefined) {
    printUsage(deps.error);
    return EXIT_USAGE;
  }

  // Read through the same helper `setu new --workspace --port` uses, so the two
  // flag sites cannot disagree about what a bindable port is.
  const requested = readPortFlag(args.flags);
  if (!requested.ok) {
    deps.error(requested.message);
    return EXIT_USAGE;
  }

  // The transport belongs to the WORKSPACE: members can only meet on a bus they
  // share, so a per-member choice would make a workspace whose services cannot
  // reach each other expressible in one flag.
  for (const flag of ['transport', 'transport-url']) {
    if (args.flags[flag] !== undefined) {
      deps.error(
        `--${flag} is a workspace-wide choice, not a per-member one: members can only talk ` +
          `over a transport they share.`,
      );
      deps.error(
        `Set it when you create the workspace: ` +
          `\`${PROGRAM_NAME} new <name> --workspace --${flag} <value>\`. ` +
          `This workspace already records its own in ${WORKSPACE_MANIFEST}.`,
      );
      return EXIT_USAGE;
    }
  }

  const names = deriveNames(rawName);
  if (!isIdentifierSafe(names)) {
    deps.error(
      `Invalid name "${rawName}": it must contain a letter and must not start with a digit.`,
    );
    return EXIT_USAGE;
  }

  const read = await readWorkspaceManifest(deps.fs, deps.dir);
  if (!read.ok) return reportNoWorkspace(deps.dir, read.problem, deps.error);

  // A member's runtime is the WORKSPACE's. The flag is accepted when it agrees
  // and refused when it does not, rather than silently scaffolding a member the
  // root's toolchain cannot install: members share one root manifest and one
  // lockfile, so a Node member inside a Deno workspace is not a member at all.
  const runtimeFlag = stringFlag(args.flags, 'runtime');
  if (runtimeFlag !== undefined && runtimeFlag !== read.manifest.runtime) {
    deps.error(
      `This is a ${read.manifest.runtime} workspace, so --runtime ${runtimeFlag} cannot apply to ` +
        `one of its members: they share a root manifest and a lockfile, and the root is what ` +
        `installs them.`,
    );
    deps.error(
      `Create a separate workspace for it: ` +
        `\`${PROGRAM_NAME} new <name> --workspace --runtime ${runtimeFlag}\`.`,
    );
    return EXIT_USAGE;
  }

  const name = names.kebab;
  if (read.manifest.members.some((member) => member.name === name)) {
    deps.error(
      `Workspace member "${name}" already exists in ${joinPath(MEMBERS_DIR, name)}.`,
    );
    deps.error('Choose a different name, or remove that member from the workspace first.');
    return EXIT_ERROR;
  }

  // An explicit `--port` wins over allocation, but never over another member: two
  // services on one port means the second fails to bind, while every sibling's
  // map still names both — so one name silently resolves to the OTHER service.
  // Refusing here is the only place that can see it, since the collision is
  // between a flag and a file.
  const taken = read.manifest.members.find((member) => member.port === requested.port);
  if (taken !== undefined) {
    deps.error(
      `Port ${requested.port} is already bound by the member "${taken.name}" in this workspace.`,
    );
    deps.error(
      `Two members on one port cannot both start, and every sibling's map would name both — ` +
        `so requests for one would reach the other. Choose another port, or omit --port and ` +
        `let the CLI allocate one.`,
    );
    return EXIT_ERROR;
  }

  const port = requested.port ?? allocatePort(read.manifest);
  if (port === undefined) {
    deps.error(
      `This workspace has no port left to allocate: every number from its base up to ` +
        `${MAX_PORT} is taken.`,
    );
    deps.error(
      `Lower \`basePort\` in ${WORKSPACE_MANIFEST}, or pass --port to choose one directly.`,
    );
    return EXIT_ERROR;
  }

  const next: WorkspaceManifest = {
    ...read.manifest,
    members: [...read.manifest.members, { name, port }],
  };

  // Read unconditionally, because whether it is NEEDED depends on the template,
  // which `planMember` resolves. An unreadable root is not an error by itself —
  // only a frontend member has to edit it — so the failure is carried as an empty
  // string and turned into a refusal there, naming the member that needed it.
  let rootManifest = '';
  try {
    rootManifest = new TextDecoder().decode(
      await deps.fs.readFile(joinPath(deps.dir, ROOT_MANIFEST)),
    );
  } catch {
    // Left empty: `planRootNodeModulesDir` refuses an unparseable root.
  }

  // Total: the manifest reader refuses a transport it does not know, so this
  // resolves without a "cannot happen" branch.
  const profile = workspaceProfile(next.runtime);
  const plan = planMember(name, next, args, transportSpec(next.transport), profile, rootManifest);
  if (!plan.ok) {
    deps.error(plan.message);
    return EXIT_USAGE;
  }

  const duplicate = firstDuplicatePath(plan.files);
  if (duplicate !== undefined) {
    deps.error(`Refusing to plan ${duplicate} twice; it would be written and then overwritten.`);
    return EXIT_ERROR;
  }

  const files = plan.files.map((file) => ({ ...file, path: joinPath(deps.dir, file.path) }));

  if (args.flags['dry-run'] === true) {
    for (const file of files) deps.log(`would create ${file.path}`);
    return EXIT_OK;
  }

  const existing = await findExisting(deps.fs, files);
  if (existing.length > 0) {
    deps.error('Refusing to overwrite existing files:');
    for (const path of existing) deps.error(`  ${path}`);
    return EXIT_ERROR;
  }

  try {
    await writeFiles(deps.fs, files);
  } catch (cause) {
    deps.error(`Failed to write: ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT_ERROR;
  }

  for (const file of files) deps.log(`created ${file.path}`);
  deps.log('');
  deps.log(`Added ${name} on port ${port}. Next:`);
  // From the profile, and from `runScript` rather than `manifestKind`: a Node
  // member has no `deno task`, and a Bun one — which shares npm's manifest shape
  // and none of its commands — would otherwise be told to run `npm start` right
  // after being told to run `bun install`.
  deps.log(
    `  ${profile.install} && cd ${joinPath(MEMBERS_DIR, name)} && ` +
      `${profile.runScript('start')}`,
  );
  return EXIT_OK;
}
