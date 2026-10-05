/** Workspace maintenance commands. */

import { devEntryVariants, DEVTOOL_ENTRY_MODULE, renderDevEntry } from '../devtool/dev-entry.ts';
import type { IFileSystem } from '@setu-ts/common';

import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import { EXIT_ERROR, EXIT_INTERRUPTED, EXIT_OK, EXIT_USAGE, PROGRAM_NAME } from '../constants.ts';
import { interruptionMessage } from '../utils/interruption.ts';
import { escapeName } from '../utils/names.ts';
import { type GeneratedFile, joinPath, resolveDir, writeFiles } from '../utils/file-writer.ts';
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
} from '../workspace/manifest.ts';
import { assumePortAvailable, type PortProbe } from '../workspace/port-probe.ts';
import { workspaceProfile } from '../workspace/runtime-profile.ts';
import { transportSpec } from '../workspace/transport.ts';
import { describeReconcileFailure, reconcileMembers } from '../workspace/reconcile.ts';

/** Dependencies reached by workspace maintenance commands. */
export interface WorkspaceCommandDependencies {
  readonly fs: IFileSystem;
  readonly cwd: string;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  readonly portAvailable?: PortProbe;
  readonly interrupt?: AbortSignal;
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
): Promise<WorkspaceManifest | undefined> {
  const members = [];
  let candidate = manifest.basePort;
  for (const member of manifest.members) {
    while (candidate <= MAX_PORT && !(await probe(candidate))) candidate++;
    if (candidate > MAX_PORT) return undefined;
    const nextMember = { ...member, port: candidate };
    delete nextMember.devtoolPort;
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
        member.name === old.name ? { ...member, devtoolPort: port } : member
      ),
    };
  }
  return next;
}

/** Plans every managed file whose content contains a workspace port. */
function managedFiles(manifest: WorkspaceManifest): readonly GeneratedFile[] {
  const profile = workspaceProfile(manifest.runtime);
  const transport = transportSpec(manifest.transport);
  return [
    ...manifest.members.filter((member) => member.devtoolPort !== undefined).map((member) => ({
      path: joinPath(MEMBERS_DIR, member.name, DEVTOOL_ENTRY_MODULE),
      contents: renderDevEntry({
        devtoolPort: member.devtoolPort!,
        port: { symbol: SERVICE_PORT_EXPORT, from: DISCOVERY_SPECIFIER },
      }),
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

/** Runs `setu workspace ports --reallocate`. */
export async function runWorkspaceCommand(
  args: ParsedArgs,
  deps: WorkspaceCommandDependencies,
): Promise<number> {
  if (args.flags['help'] === true || args.flags['h'] === true) {
    deps.log(`Usage: ${PROGRAM_NAME} workspace ports --reallocate [--dir <path>] [--dry-run]`);
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
    deps.error(`No usable ${WORKSPACE_MANIFEST} in ${dir}, so this is not a Setu workspace.`);
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
        `${
          escapeName(path)
        }: the member records devtool port ${member.devtoolPort} but this entry is missing, so the launcher has nothing to start; recreate it with setu devtool enable ${
          escapeName(member.name)
        }, then run this again.`,
      );
      return EXIT_ERROR;
    }
    if (!devEntryVariants(member.devtoolPort).includes(source)) {
      deps.error(
        `${
          escapeName(path)
        }: the devtool launcher accepts only the CLI's rendering of this file, so an edited entry cannot be launched; restore it (delete it and run setu devtool enable ${
          escapeName(member.name)
        }) or move the port literal yourself.`,
      );
      return EXIT_ERROR;
    }
  }
  const next = await reallocate(read.manifest, deps.portAvailable ?? assumePortAvailable);
  if (next === undefined) {
    deps.error(`No bindable ports remain between ${read.manifest.basePort} and ${MAX_PORT}.`);
    return EXIT_ERROR;
  }
  const files = managedFiles(next).map((file) => ({ ...file, path: joinPath(dir, file.path) }));
  if (args.flags['dry-run'] === true) {
    for (const file of files) deps.log(`would update ${escapeName(file.path)}`);
    return EXIT_OK;
  }
  try {
    const outcomes = await writeFiles(
      deps.fs,
      files,
      deps.interrupt === undefined ? {} : { signal: deps.interrupt },
    );
    for (const outcome of outcomes) deps.log(`${outcome.outcome} ${escapeName(outcome.path)}`);
  } catch (cause) {
    const interrupted = interruptionMessage(cause);
    if (interrupted !== undefined) {
      deps.error(interrupted);
      return EXIT_INTERRUPTED;
    }
    deps.error(
      `Failed to update workspace ports: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return EXIT_ERROR;
  }
  deps.log('Reallocated workspace ports and regenerated discovery and deployment files.');
  return EXIT_OK;
}
