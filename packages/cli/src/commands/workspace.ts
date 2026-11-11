/** Workspace maintenance commands. */

import { formatForTarget } from '../utils/prettier-format.ts';
import { DEVTOOL_ENTRY_MODULE, isDevEntry, renderDevEntry } from '../devtool/dev-entry.ts';
import type { IFileSystem } from '@setu-ts/common';

import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import { EXIT_ERROR, EXIT_INTERRUPTED, EXIT_OK, EXIT_USAGE, PROGRAM_NAME } from '../constants.ts';
import { interruptionMessage } from '../utils/interruption.ts';
import { escapeName } from '../utils/names.ts';
import {
  type GeneratedFile,
  joinPath,
  readExistingText,
  resolveDir,
  writeFiles,
} from '../utils/file-writer.ts';
import { workspaceContainerFiles } from '../workspace/compose.ts';
import {
  DISCOVERY_MODULE,
  DISCOVERY_SPECIFIER,
  renderDiscoveryModule,
  SERVICE_PORT_EXPORT,
} from '../workspace/discovery-module.ts';
import { workspaceK8sFiles } from '../workspace/k8s.ts';
import {
  allocateDevtoolPort,
  devtoolRangeStart,
  MAX_PORT,
  MEMBERS_DIR,
  readWorkspaceManifest,
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  type WorkspaceManifest,
  manifestProblemDetail,
} from '../workspace/manifest.ts';
import { assumePortAvailable, type PortProbe } from '../workspace/port-probe.ts';
import { workspaceProfile } from '../workspace/runtime-profile.ts';
import { cliInvocation } from '../templates/project-files.ts';
import { BROKERS, brokerSpec, getBroker } from '../workspace/transport.ts';
import { getRpc, RPC_STYLES } from '../workspace/rpc.ts';
import { planTransportChange, type TransportChange } from '../workspace/rewire.ts';
import { describeReconcileFailure, reconcileMembers } from '../workspace/reconcile.ts';
import type { CommandRunner } from '../utils/run-command.ts';
import { runWorkspaceBuild, runWorkspaceDeploy } from './workspace-ops.ts';
import { planInspectorRewrite } from '../workspace/development-ports.ts';
import { detectPlugins } from '../utils/plugin-detector.ts';
import { allocateDevPort } from '../workspace/manifest.ts';

/** Dependencies reached by workspace maintenance commands. */
export interface WorkspaceCommandDependencies {
  readonly fs: IFileSystem;
  readonly cwd: string;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  readonly portAvailable?: PortProbe;
  readonly interrupt?: AbortSignal;
  /** The CLI's clock, for the timestamp image tag outside a git repository. */
  readonly now?: () => number;
  /** Runs `docker`, `kind`, `kubectl` and `git` for `build` and `deploy`. */
  readonly runCommand?: CommandRunner;
}

/**
 * Reassigns all member ports to currently bindable ports at or above basePort.
 *
 * A member's devtool port moves WITH it, from the connector range: the two
 * addresses a devtool launcher reads for one member — the application port in
 * every sibling's discovery map, the devtool port in this manifest — must be
 * reassigned as one unit, or a reallocation leaves the manifest's devtool
 * address pointing at whatever process won the old port. A member carrying no
 * devtool port gains none, exactly as before.
 */
async function reallocate(
  manifest: WorkspaceManifest,
  probe: PortProbe,
  fullStack: ReadonlySet<string>,
): Promise<WorkspaceManifest | undefined> {
  const members = [];
  let candidate = manifest.basePort;
  for (const member of manifest.members) {
    while (candidate <= MAX_PORT && !(await probe(candidate))) candidate++;
    if (candidate > MAX_PORT) return undefined;
    const nextMember = { ...member, port: candidate };
    delete nextMember.devtoolPort;
    delete nextMember.inspectPort;
    delete nextMember.vitePort;
    members.push(nextMember);
    candidate++;
  }
  let next: WorkspaceManifest = { ...manifest, members };
  for (const old of manifest.members) {
    if (old.devtoolPort === undefined) continue;
    let port = allocateDevtoolPort(next);
    while (port !== undefined && !(await probe(port))) {
      port = allocateDevtoolPort({
        ...next,
        members: [...next.members, { name: '__occupied__', port, devtoolPort: port }],
      });
    }
    if (port === undefined) return undefined;
    next = {
      ...next,
      devtoolBasePort: devtoolRangeStart(manifest),
      members: next.members.map((member) =>
        member.name === old.name ? { ...member, devtoolPort: port } : member,
      ),
    };
  }
  for (const old of manifest.members) {
    for (const field of (old.vitePort !== undefined || fullStack.has(old.name)
      ? ['inspectPort', 'vitePort']
      : ['inspectPort']) as readonly ('inspectPort' | 'vitePort')[]) {
      let port = allocateDevPort(next);
      while (port !== undefined && !(await probe(port)))
        port = allocateDevPort({
          ...next,
          members: [...next.members, { name: '__occupied__', port, inspectPort: port }],
        });
      if (port === undefined) return undefined;
      const assigned = port;
      next = {
        ...next,
        members: next.members.map((member) =>
          member.name === old.name ? { ...member, [field]: assigned } : member,
        ),
      };
    }
  }
  return next;
}

/** Plans every managed file whose content contains a workspace port. */
function managedFiles(manifest: WorkspaceManifest): readonly GeneratedFile[] {
  const profile = workspaceProfile(manifest.runtime);
  const transport = brokerSpec(manifest.broker, manifest.redisClient);
  return [
    ...manifest.members
      .filter((member) => member.devtoolPort !== undefined)
      .map((member) => ({
        path: joinPath(MEMBERS_DIR, member.name, DEVTOOL_ENTRY_MODULE),
        contents: renderDevEntry(
          {
            devtoolPort: member.devtoolPort!,
            port: { symbol: SERVICE_PORT_EXPORT, from: DISCOVERY_SPECIFIER },
          },
          manifest.runtime,
        ),
      })),
    ...manifest.members.map((member) => ({
      path: joinPath('apps', member.name, DISCOVERY_MODULE),
      contents: renderDiscoveryModule(member, manifest.members, profile),
    })),
    { path: WORKSPACE_MANIFEST, contents: renderWorkspaceManifest(manifest) },
    ...workspaceContainerFiles(manifest, transport, profile),
    ...workspaceK8sFiles(manifest, transport),
  ];
}

/** The usage lines of the two transport operations. */
const BROKER_USAGE = `Usage: ${PROGRAM_NAME} workspace broker <name> [--broker-url <url>] [--redis-client <ioredis|node-redis>] [--force] [--dir <path>] [--dry-run]`;
const RPC_USAGE = `Usage: ${PROGRAM_NAME} workspace rpc <member> <${RPC_STYLES.join('|')}> [--force] [--dir <path>] [--dry-run]`;

/**
 * Reads `workspace broker <name>` or `workspace rpc <member> <style>` into a change.
 *
 * The broker's endpoint follows the same rules `setu new --workspace` applies:
 * refused for the in-process broker, which has nothing to address, and for the
 * two cloud brokers, whose connection value is a project id or a secret read
 * from the environment. `--redis-client` applies only to the Redis broker.
 *
 * @param args - The parsed arguments, the operation first
 * @returns The change, or the usage refusal
 */
function readTransportChange(
  args: ParsedArgs,
):
  | { readonly ok: true; readonly change: TransportChange }
  | { readonly ok: false; readonly message: string } {
  const [operation, first, second] = args.positionals;
  if (operation === 'rpc') {
    if (first === undefined || second === undefined) return { ok: false, message: RPC_USAGE };
    const style = getRpc(second);
    if (style === undefined) {
      return {
        ok: false,
        message: `Unknown RPC style "${escapeName(second)}". Expected one of: ${RPC_STYLES.join(', ')}.`,
      };
    }
    return { ok: true, change: { kind: 'rpc', member: first, rpc: style.name } };
  }
  if (first === undefined) return { ok: false, message: BROKER_USAGE };
  const client = args.flags['redis-client'];
  if (client !== undefined && client !== 'ioredis' && client !== 'node-redis') {
    return {
      ok: false,
      message: `Unknown --redis-client "${escapeName(String(client))}". Expected ioredis | node-redis.`,
    };
  }
  const spec = getBroker(first);
  if (spec === undefined) {
    return {
      ok: false,
      message:
        getRpc(first) === undefined
          ? `Unknown broker "${escapeName(first)}". Expected one of: ${BROKERS.join(', ')}.`
          : `"${first}" is how a service is called, not a broker: change it per member with \`${PROGRAM_NAME} workspace rpc <member> ${first}\`.`,
    };
  }
  if (client !== undefined && spec.name !== 'redis') {
    return { ok: false, message: '--redis-client applies only to `workspace broker redis`.' };
  }
  const url = args.flags['broker-url'];
  if (url !== undefined) {
    if (typeof url !== 'string') return { ok: false, message: '--broker-url needs a value.' };
    if (spec.connection === undefined) {
      return {
        ok: false,
        message: `--broker ${spec.name} runs inside each member, so --broker-url has nothing to address.`,
      };
    }
    if (!spec.connection.urlOverridable) {
      return {
        ok: false,
        message: `--broker ${spec.name} is not configured by URL: its connection value is read from ${spec.connection.variable} at run time.`,
      };
    }
  }
  return {
    ok: true,
    change: {
      kind: 'broker',
      broker: spec.name,
      ...(typeof url === 'string' ? { brokerUrl: url } : {}),
      ...(client === 'node-redis' ? { redisClient: 'node-redis' as const } : {}),
    },
  };
}

/**
 * Runs `setu workspace broker` or `setu workspace rpc` (M138).
 *
 * Plans the whole change with `planTransportChange`, then writes it in one
 * transaction — or writes nothing, when any member's config does not read its
 * transport module, a member manifest cannot be merged, or code still uses what
 * the change removes (unless `--force`).
 *
 * @param args - The parsed arguments, the operation first
 * @param deps - Filesystem and output sinks
 * @returns `0` on success or a no-op, `1` on a refusal, `2` on a usage error
 */
async function runTransportOperation(
  args: ParsedArgs,
  deps: WorkspaceCommandDependencies,
): Promise<number> {
  if (args.flags['help'] === true || args.flags['h'] === true) {
    deps.log(args.positionals[0] === 'rpc' ? RPC_USAGE : BROKER_USAGE);
    return EXIT_OK;
  }
  if (args.flags['dir'] !== undefined && stringFlag(args.flags, 'dir') === undefined) {
    deps.error('--dir needs a path.');
    return EXIT_USAGE;
  }
  const read = readTransportChange(args);
  if (!read.ok) {
    deps.error(read.message);
    return EXIT_USAGE;
  }
  return await applyTransportChange(
    deps,
    resolveDir(deps.cwd, stringFlag(args.flags, 'dir')),
    read.change,
    {
      dryRun: args.flags['dry-run'] === true,
      force: args.flags['force'] === true,
      reconcile: false,
    },
  );
}

/**
 * Plans and writes one transport change in a workspace (M138).
 *
 * The one apply step behind `setu workspace broker|rpc` and a member's
 * `setu add grpc`: it reads and reconciles the manifest, plans the whole change,
 * then writes it in one transaction — or writes nothing, when any member's config
 * does not read its transport module, a member manifest cannot be merged, or code
 * still uses what the change removes (unless `force`).
 *
 * @param deps - Filesystem and output sinks
 * @param dir - The workspace root (absolute)
 * @param change - The validated change
 * @param options - `dryRun` prints the plan; `force` passes orphan refusals;
 * `reconcile` plans even when the manifest already records the change
 * @returns `0` on success or a no-op, `1` on a refusal, `2` for an unknown member
 */
export async function applyTransportChange(
  deps: WorkspaceCommandDependencies,
  dir: string,
  change: TransportChange,
  options: { readonly dryRun: boolean; readonly force: boolean; readonly reconcile: boolean },
): Promise<number> {
  const manifest = await readWorkspaceManifest(deps.fs, dir);
  if (!manifest.ok) {
    deps.error(
      `No usable ${WORKSPACE_MANIFEST} in ${escapeName(dir)}, so this is not a Setu workspace.`,
    );
    const detail = manifestProblemDetail(manifest.problem);
    if (detail !== undefined) deps.error(detail);
    return EXIT_ERROR;
  }
  if (change.kind === 'rpc' && !manifest.manifest.members.some((m) => m.name === change.member)) {
    deps.error(
      `No workspace member "${escapeName(change.member)}". Members: ${
        manifest.manifest.members.map((m) => escapeName(m.name)).join(', ') || 'none'
      }.`,
    );
    return EXIT_USAGE;
  }
  const reconciliation = await reconcileMembers(deps.fs, dir, manifest.manifest);
  if (!reconciliation.ok) {
    deps.error(describeReconcileFailure(reconciliation));
    return EXIT_ERROR;
  }
  const already =
    change.kind === 'rpc' &&
    (manifest.manifest.members.find((m) => m.name === change.member)?.rpc ?? 'http') === change.rpc;
  const plan = await planTransportChange(deps.fs, dir, manifest.manifest, change, {
    force: options.force,
    reconcile: options.reconcile,
  });
  if (!plan.ok) {
    for (const message of plan.messages) deps.error(message);
    deps.error('Nothing was written.');
    return EXIT_ERROR;
  }
  if (plan.unchanged) {
    deps.log(
      change.kind === 'broker'
        ? `The workspace already uses the ${change.broker} broker; nothing changed.`
        : `${escapeName(change.member)} is already ${change.rpc}; nothing changed.`,
    );
    return EXIT_OK;
  }
  for (const warning of plan.warnings) deps.error(`warning: ${warning}`);
  const files = plan.files.map((file) => ({ ...file, path: joinPath(dir, file.path) }));
  if (options.dryRun) {
    for (const file of files) deps.log(`would write ${escapeName(file.path)}`);
    for (const note of plan.notes) deps.log(note);
    return EXIT_OK;
  }
  try {
    const outcomes = await writeFiles(
      deps.fs,
      await formatForTarget(files, plan.manifest.runtime, dir, deps.error),
      deps.interrupt === undefined ? { root: dir } : { root: dir, signal: deps.interrupt },
    );
    for (const outcome of outcomes) deps.log(`${outcome.outcome} ${escapeName(outcome.path)}`);
  } catch (cause) {
    const interrupted = interruptionMessage(cause);
    if (interrupted !== undefined) {
      deps.error(interrupted);
      return EXIT_INTERRUPTED;
    }
    deps.error(
      `Failed to change the workspace transport: ${escapeName(
        cause instanceof Error ? cause.message : String(cause),
      )}`,
    );
    return EXIT_ERROR;
  }
  for (const note of plan.notes) deps.log(note);
  const install =
    workspaceProfile(plan.manifest.runtime).manifestKind === 'deno'
      ? 'deno install'
      : `${plan.manifest.runtime === 'bun' ? 'bun' : 'npm'} install`;
  deps.log(
    change.kind === 'broker'
      ? `Switched every member to the ${change.broker} broker. Run \`${install}\` at the workspace root.`
      : already
        ? `${escapeName(change.member)} already serves ${change.rpc}; its transport module and packages are up to date. Run \`${install}\` at the workspace root.`
        : `Switched ${escapeName(change.member)} to ${change.rpc}. Run \`${install}\` at the workspace root.`,
  );
  return EXIT_OK;
}

/** Runs `setu workspace ports --reallocate`, `setu workspace build` or `setu workspace deploy`. */
export async function runWorkspaceCommand(
  args: ParsedArgs,
  deps: WorkspaceCommandDependencies,
): Promise<number> {
  const operation = args.positionals[0];
  if (operation === 'build' || operation === 'deploy') {
    const opsDeps = {
      fs: deps.fs,
      cwd: deps.cwd,
      log: deps.log,
      error: deps.error,
      now: deps.now ?? (() => 0),
      ...(deps.runCommand === undefined ? {} : { runCommand: deps.runCommand }),
    };
    const rest = { ...args, positionals: args.positionals.slice(1) };
    return operation === 'build'
      ? await runWorkspaceBuild(rest, opsDeps)
      : await runWorkspaceDeploy(rest, opsDeps);
  }
  if (operation === 'broker' || operation === 'rpc') return await runTransportOperation(args, deps);
  if (args.flags['help'] === true || args.flags['h'] === true) {
    deps.log(`Usage: ${PROGRAM_NAME} workspace ports --reallocate [--dir <path>] [--dry-run]`);
    deps.log(`       ${PROGRAM_NAME} workspace broker <name> | rpc <member> <style> --help`);
    deps.log(`       ${PROGRAM_NAME} workspace build|deploy --help`);
    return EXIT_OK;
  }
  if (args.positionals[0] !== 'ports' || args.flags['reallocate'] !== true) {
    deps.error(`Usage: ${PROGRAM_NAME} workspace ports --reallocate [--dir <path>] [--dry-run]`);
    return EXIT_USAGE;
  }
  if (args.flags['dir'] !== undefined && stringFlag(args.flags, 'dir') === undefined) {
    deps.error('--dir needs a path.');
    return EXIT_USAGE;
  }

  const dir = resolveDir(deps.cwd, stringFlag(args.flags, 'dir'));
  const read = await readWorkspaceManifest(deps.fs, dir);
  if (!read.ok) {
    deps.error(
      `No usable ${WORKSPACE_MANIFEST} in ${escapeName(dir)}, so this is not a Setu workspace.`,
    );
    const detail = manifestProblemDetail(read.problem);
    if (detail !== undefined) deps.error(detail);
    return EXIT_ERROR;
  }
  const reconciliation = await reconcileMembers(deps.fs, dir, read.manifest);
  if (!reconciliation.ok) {
    deps.error(describeReconcileFailure(reconciliation));
    return EXIT_ERROR;
  }
  for (const member of read.manifest.members) {
    if (member.devtoolPort === undefined) continue;
    const path = joinPath(dir, MEMBERS_DIR, member.name, DEVTOOL_ENTRY_MODULE);
    let source: string | undefined;
    try {
      source = new TextDecoder().decode(await deps.fs.readFile(path));
    } catch {
      source = undefined;
    }
    if (source === undefined) {
      deps.error(
        `${escapeName(
          path,
        )}: the member records devtool port ${member.devtoolPort} but this entry is missing, so the launcher has nothing to start; recreate it with ${cliInvocation(read.manifest.runtime)} devtool enable ${escapeName(
          member.name,
        )}, then run this again.`,
      );
      return EXIT_ERROR;
    }
    if (!isDevEntry(source, member.devtoolPort)) {
      deps.error(
        `${escapeName(
          path,
        )}: the devtool launcher accepts only the CLI's rendering of this file, so an edited entry cannot be launched; restore it (delete it and run ${cliInvocation(read.manifest.runtime)} devtool enable ${escapeName(
          member.name,
        )}) or move the port literal yourself.`,
      );
      return EXIT_ERROR;
    }
  }
  const fullStack = new Set<string>();
  for (const member of read.manifest.members)
    if (
      (await detectPlugins(deps.fs, joinPath(dir, MEMBERS_DIR, member.name))).has(
        'react-router-plugin',
      )
    )
      fullStack.add(member.name);
  const next = await reallocate(
    read.manifest,
    deps.portAvailable ?? assumePortAvailable,
    fullStack,
  );
  if (next === undefined) {
    deps.error(`No bindable ports remain between ${read.manifest.basePort} and ${MAX_PORT}.`);
    return EXIT_ERROR;
  }
  const files = managedFiles(next).map((file) => ({ ...file, path: joinPath(dir, file.path) }));
  for (const member of next.members) {
    const old = read.manifest.members.find((entry) => entry.name === member.name)!;
    // Discovery now exports the new VITE_PORT, but dev.ts is the developer's file:
    // one that does not read it keeps its own port, so say which lines to set.
    if (member.vitePort !== undefined) {
      const devPath = joinPath(dir, MEMBERS_DIR, member.name, 'dev.ts');
      const dev = await readExistingText(deps.fs, devPath).catch(() => undefined);
      if (dev !== undefined && !(dev.includes(DISCOVERY_SPECIFIER) && /\bVITE_PORT\b/.test(dev))) {
        deps.log(
          `Set the two development port lines in ${escapeName(devPath)} from the discovery module (Vite port ${member.vitePort}):`,
        );
        deps.log(`  import { SERVICE_PORT, VITE_PORT } from '${DISCOVERY_SPECIFIER}';`);
        deps.log('  const port = SERVICE_PORT; const vitePort = VITE_PORT;');
      }
    }
    if (old.inspectPort === undefined) {
      deps.log(
        `Set start:debug in ${escapeName(joinPath(dir, MEMBERS_DIR, member.name))} to use --inspect=127.0.0.1:${member.inspectPort}; no old inspector port was recorded, so the script was left unchanged.`,
      );
      continue;
    }
    files.push(
      ...(await planInspectorRewrite(
        deps.fs,
        joinPath(dir, MEMBERS_DIR, member.name),
        next.runtime,
        member.inspectPort!,
        deps.log,
        old.inspectPort,
      )),
    );
  }
  if (args.flags['dry-run'] === true) {
    for (const file of files) deps.log(`would update ${escapeName(file.path)}`);
    return EXIT_OK;
  }
  try {
    const outcomes = await writeFiles(
      deps.fs,
      await formatForTarget(files, next.runtime, dir, deps.error),
      deps.interrupt === undefined ? { root: dir } : { root: dir, signal: deps.interrupt },
    );
    for (const outcome of outcomes) deps.log(`${outcome.outcome} ${escapeName(outcome.path)}`);
  } catch (cause) {
    const interrupted = interruptionMessage(cause);
    if (interrupted !== undefined) {
      deps.error(interrupted);
      return EXIT_INTERRUPTED;
    }
    deps.error(
      `Failed to update workspace ports: ${escapeName(
        cause instanceof Error ? cause.message : String(cause),
      )}`,
    );
    return EXIT_ERROR;
  }
  deps.log('Reallocated workspace ports and regenerated discovery and deployment files.');
  return EXIT_OK;
}
