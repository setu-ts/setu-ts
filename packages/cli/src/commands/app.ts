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
import { APP_VERB, EXIT_ERROR, EXIT_OK, EXIT_USAGE, PROGRAM_NAME } from '../constants.ts';
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
import { withWorkspaceMember } from '../workspace/member-host.ts';
import { TRANSPORTS, type TransportSpec, transportSpec } from '../workspace/transport.ts';
import {
  allocatePort,
  MAX_PORT,
  MEMBERS_DIR,
  MIN_PORT,
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
 * The template a workspace member may not use, and why.
 *
 * Measured, not cautious: `full-stack` emits a `package.json` for its Vite
 * build, which switches Deno to node_modules resolution, and such a project
 * needs `nodeModulesDir` in its own manifest. Deno refuses that in a member —
 * `"nodeModulesDir" field can only be specified in the workspace root deno.json
 * file` — so the member would scaffold cleanly and then fail to resolve its own
 * dependencies. Refusing at scaffold time beats that.
 */
const REFUSED_TEMPLATE = 'full-stack';

/**
 * Prints the command's usage.
 *
 * @param log - Output sink
 */
function printUsage(log: (message: string) => void): void {
  log(
    `Usage: ${PROGRAM_NAME} generate ${APP_VERB} <name> [--template <name>] [--di] [--dir <path>]`,
  );
  log('');
  log(`Adds a service to a Setu workspace: creates ${MEMBERS_DIR}/<name>/, allocates it a`);
  log(`port, and registers it in every other member's static discovery map.`);
  log('');
  log('Options:');
  log('  --template <name>   rest | microservice | nest');
  log('  --di                Register DiPlugin in this member');
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
 * @param args - The parsed arguments, read for `--template` and `--di`
 * @returns The planned files, or the usage refusal to print
 */
function planMember(
  name: string,
  next: WorkspaceManifest,
  args: ParsedArgs,
  transport: TransportSpec,
): { readonly ok: true; readonly files: readonly GeneratedFile[] } | {
  readonly ok: false;
  readonly message: string;
} {
  // Members are Deno projects: a Setu workspace is a Deno workspace, and there
  // is no npm-workspace design here to put a `node` member into.
  const choice = resolveTemplateChoice(args);
  if (!choice.ok) return { ok: false, message: choice.message };
  if (choice.template?.name === REFUSED_TEMPLATE) {
    return {
      ok: false,
      message:
        `The "${REFUSED_TEMPLATE}" template cannot be a workspace member: its frontend build ` +
        `needs \`nodeModulesDir\`, which Deno accepts only in the workspace root deno.json. ` +
        `Scaffold it standalone with \`${PROGRAM_NAME} new <name> --template ${REFUSED_TEMPLATE}\`.`,
    };
  }

  const host = withWorkspaceMember(
    // A workspace member is always a Deno project (`--runtime` is refused
    // above), so no runtime swap can apply here.
    resolveHost(choice.template ?? MINIMAL_HOST, choice.features, 'deno'),
    transport,
    next.transportUrl,
  );
  const memberRoot = joinPath(MEMBERS_DIR, name);

  const files: GeneratedFile[] = projectFiles(name, 'deno', host, choice.features, {
    symbol: SERVICE_PORT_EXPORT,
    from: DISCOVERY_SPECIFIER,
  }).map((file) => ({ ...file, path: joinPath(memberRoot, file.path) }));

  // Every member, not only the new one: adding a service registers it with its
  // callers, which is the whole point — a sibling that never learns the new name
  // resolves it to `[]`.
  for (const member of next.members) {
    files.push({
      path: joinPath(MEMBERS_DIR, member.name, DISCOVERY_MODULE),
      contents: renderDiscoveryModule(member, next.members),
      managed: true,
    });
  }

  files.push({
    path: WORKSPACE_MANIFEST,
    contents: renderWorkspaceManifest(next),
    managed: true,
  });

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

  // Refused rather than ignored: a member is a Deno project by construction, and
  // silently swallowing `--runtime node` would hand back something the flag says
  // it is not. `new` rejects an unknown value the same way.
  const runtimeFlag = stringFlag(args.flags, 'runtime');
  if (runtimeFlag !== undefined && runtimeFlag !== 'deno') {
    deps.error(
      `A workspace member is always a Deno project, so --runtime ${runtimeFlag} cannot apply: ` +
        `a Setu workspace is a Deno workspace.`,
    );
    deps.error(
      `Scaffold a standalone project instead: ` +
        `\`${PROGRAM_NAME} new <name> --runtime ${runtimeFlag}\`.`,
    );
    return EXIT_USAGE;
  }

  // Refused rather than ignored, for the same reason `--runtime` is: a member's
  // port is allocated from the workspace manifest, so a `--port` here would be
  // parsed (it is a value flag) and then silently dropped, handing back a member
  // on a port the user did not choose. `setu new --workspace --port` is where
  // that number belongs.
  if (args.flags['port'] !== undefined) {
    deps.error(
      `--port sets the BASE port of a whole workspace, not one member's: ` +
        `\`${PROGRAM_NAME} new <name> --workspace --port <n>\`.`,
    );
    deps.error(
      `A member's port is allocated from ${WORKSPACE_MANIFEST}; edit it there, then run ` +
        `\`${PROGRAM_NAME} generate ${APP_VERB}\` to rewrite every member's map.`,
    );
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

  const name = names.kebab;
  if (read.manifest.members.some((member) => member.name === name)) {
    deps.error(
      `Workspace member "${name}" already exists in ${joinPath(MEMBERS_DIR, name)}.`,
    );
    deps.error('Choose a different name, or remove that member from the workspace first.');
    return EXIT_ERROR;
  }

  const port = allocatePort(read.manifest);
  if (port === undefined) {
    deps.error(
      `This workspace has no port left to allocate: every number from its base up to ` +
        `${MAX_PORT} is taken.`,
    );
    deps.error(
      `Lower \`basePort\` in ${WORKSPACE_MANIFEST}, or free a port by removing a member.`,
    );
    return EXIT_ERROR;
  }

  const next: WorkspaceManifest = {
    ...read.manifest,
    members: [...read.manifest.members, { name, port }],
  };

  // Total: the manifest reader refuses a transport it does not know, so this
  // resolves without a "cannot happen" branch.
  const plan = planMember(name, next, args, transportSpec(next.transport));
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
  deps.log(`  cd ${joinPath(MEMBERS_DIR, name)} && deno task start`);
  return EXIT_OK;
}
