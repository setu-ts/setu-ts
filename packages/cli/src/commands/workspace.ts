/** Workspace maintenance commands. */

import type { IFileSystem } from '@setu-ts/common';

import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, PROGRAM_NAME } from '../constants.ts';
import { type GeneratedFile, joinPath, resolveDir, writeFiles } from '../utils/file-writer.ts';
import { workspaceContainerFiles } from '../workspace/compose.ts';
import { DISCOVERY_MODULE, renderDiscoveryModule } from '../workspace/discovery-module.ts';
import { workspaceK8sFiles } from '../workspace/k8s.ts';
import {
  MAX_PORT,
  readWorkspaceManifest,
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  type WorkspaceManifest,
} from '../workspace/manifest.ts';
import { assumePortAvailable, type PortProbe } from '../workspace/port-probe.ts';
import { workspaceProfile } from '../workspace/runtime-profile.ts';
import { transportSpec } from '../workspace/transport.ts';

/** Dependencies reached by workspace maintenance commands. */
export interface WorkspaceCommandDependencies {
  readonly fs: IFileSystem;
  readonly cwd: string;
  readonly log: (message: string) => void;
  readonly error: (message: string) => void;
  readonly portAvailable?: PortProbe;
}

/** Reassigns all member ports to currently bindable ports at or above basePort. */
async function reallocate(
  manifest: WorkspaceManifest,
  probe: PortProbe,
): Promise<WorkspaceManifest | undefined> {
  const members = [];
  let candidate = manifest.basePort;
  for (const member of manifest.members) {
    while (candidate <= MAX_PORT && !(await probe(candidate))) candidate++;
    if (candidate > MAX_PORT) return undefined;
    members.push({ ...member, port: candidate });
    candidate++;
  }
  return { ...manifest, members };
}

/** Plans every managed file whose content contains a workspace port. */
function managedFiles(manifest: WorkspaceManifest): readonly GeneratedFile[] {
  const profile = workspaceProfile(manifest.runtime);
  const transport = transportSpec(manifest.transport);
  return [
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
    deps.log(`Usage: ${PROGRAM_NAME} workspace ports --reallocate [--dir <path>]`);
    return EXIT_OK;
  }
  if (args.positionals[0] !== 'ports' || args.flags['reallocate'] !== true) {
    deps.error(`Usage: ${PROGRAM_NAME} workspace ports --reallocate [--dir <path>]`);
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
  const next = await reallocate(read.manifest, deps.portAvailable ?? assumePortAvailable);
  if (next === undefined) {
    deps.error(`No bindable ports remain between ${read.manifest.basePort} and ${MAX_PORT}.`);
    return EXIT_ERROR;
  }
  const files = managedFiles(next).map((file) => ({ ...file, path: joinPath(dir, file.path) }));
  if (args.flags['dry-run'] === true) {
    for (const file of files) deps.log(`would update ${file.path}`);
    return EXIT_OK;
  }
  try {
    await writeFiles(deps.fs, files);
  } catch (cause) {
    deps.error(
      `Failed to update workspace ports: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return EXIT_ERROR;
  }
  deps.log('Reallocated workspace ports and regenerated discovery and deployment files.');
  return EXIT_OK;
}
