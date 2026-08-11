/**
 * The `setu adopt` command — converts an existing project into a workspace.
 *
 * A top-level verb rather than a `generate` one, because it is neither a
 * schematic nor an addition to an existing workspace: it CREATES the workspace,
 * which is `new`'s business, and it operates on a directory that already has a
 * project in it, which `new` refuses by design. Folding it into either would mean
 * a flag that inverts that command's own overwrite rule.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';

import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import { APP_VERB, EXIT_ERROR, EXIT_OK, EXIT_USAGE, PROGRAM_NAME } from '../constants.ts';
import { deriveNames, isIdentifierSafe } from '../utils/names.ts';
import {
  findExisting,
  type GeneratedFile,
  joinPath,
  resolveDir,
  writeFiles,
} from '../utils/file-writer.ts';
import {
  ADOPTED_DIRECTORIES,
  moveFile,
  planAdoption,
  pruneAdoptedDirectories,
  rewriteEntryPort,
} from '../workspace/adopt.ts';
import { workspaceContainerFiles } from '../workspace/compose.ts';
import {
  DISCOVERY_MODULE,
  DISCOVERY_SPECIFIER,
  renderDiscoveryModule,
  SERVICE_PORT_EXPORT,
} from '../workspace/discovery-module.ts';
import {
  DEFAULT_BASE_PORT,
  MEMBERS_DIR,
  readPortFlag,
  readWorkspaceManifest,
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  WORKSPACE_VERSION,
} from '../workspace/manifest.ts';
import { workspaceRootFiles } from '../workspace/root-files.ts';
import { DEFAULT_TRANSPORT, transportSpec } from '../workspace/transport.ts';

/** Everything `runAdoptCommand` reaches the outside world through. */
export interface AdoptDependencies {
  /** The filesystem to read the project through and write the workspace with. */
  readonly fs: IFileSystem;
  /** The working directory `--dir` resolves against (absolute). */
  readonly cwd: string;
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
  log(`Usage: ${PROGRAM_NAME} adopt [--name <member>] [--port <n>] [--dir <path>]`);
  log('');
  log('Converts the project in this directory into a workspace holding it as the');
  log(`first member: its own files move into ${MEMBERS_DIR}/<name>/ and a workspace`);
  log('root is written above them.');
  log('');
  log('Only files this CLI emits are moved. Anything else — .git, CI configuration,');
  log('deno.lock, node_modules — stays at the root, which is where a workspace');
  log('wants them.');
  log('');
  log('Options:');
  log('  --name <member>     The member name (default: the directory name)');
  log('  --port <n>          The port it binds, and the workspace base');
  log('  --dir <path>        The project to convert, instead of the working directory');
  log('  --dry-run           Print what would happen, change nothing');
}

/**
 * Runs `setu adopt`.
 *
 * @param args - Arguments after the verb, already parsed
 * @param deps - Filesystem, working directory, and output sinks
 * @returns `0` on success, `1` on a runtime error, `2` on a usage error
 */
export async function runAdoptCommand(
  args: ParsedArgs,
  deps: AdoptDependencies,
): Promise<number> {
  if (args.flags['help'] === true || args.flags['h'] === true) {
    printUsage(deps.log);
    return EXIT_OK;
  }

  const project = resolveDir(deps.cwd, stringFlag(args.flags, 'dir'));

  // Refused before anything is planned: converting a workspace into a workspace
  // would write a second root over the first.
  const existing = await readWorkspaceManifest(deps.fs, project);
  if (existing.ok) {
    deps.error(`${joinPath(project, WORKSPACE_MANIFEST)} already exists: this IS a workspace.`);
    deps.error(`Add a service to it with \`${PROGRAM_NAME} generate ${APP_VERB} <name>\`.`);
    return EXIT_ERROR;
  }

  const rawName = stringFlag(args.flags, 'name') ??
    project.split('/').filter((part) => part !== '').at(-1) ?? '';
  const names = deriveNames(rawName);
  if (!isIdentifierSafe(names)) {
    deps.error(
      `Cannot use "${rawName}" as a member name: it must contain a letter and must not start ` +
        `with a digit. Pass --name <member>.`,
    );
    return EXIT_USAGE;
  }

  const port = readPortFlag(args.flags);
  if (!port.ok) {
    deps.error(port.message);
    return EXIT_USAGE;
  }
  const basePort = port.port ?? DEFAULT_BASE_PORT;

  const memberRoot = joinPath(MEMBERS_DIR, names.kebab);
  const plan = await planAdoption(deps.fs, project, memberRoot);
  if (!plan.ok) {
    deps.error(plan.message);
    return EXIT_ERROR;
  }

  const manifest = {
    version: WORKSPACE_VERSION,
    basePort,
    // The default, deliberately: a project being converted has whatever broker its
    // own config already names, and rewriting that here would change how a running
    // service talks without being asked to. `--transport` belongs to a workspace
    // created fresh.
    transport: DEFAULT_TRANSPORT,
    members: [{ name: names.kebab, port: basePort }],
  };
  const transport = transportSpec(DEFAULT_TRANSPORT);

  // The root's own files, minus the two the project already owns at this level.
  // `README.md` moves into the member with the rest of its source; `.gitignore`
  // stays exactly where it is, because a repository's ignore rules belong at its
  // root and the developer's copy may say more than ours would.
  const keepExisting = new Set(['README.md', '.gitignore']);
  const present = new Set<string>();
  for (const path of keepExisting) {
    try {
      await deps.fs.stat(joinPath(project, path));
      present.add(path);
    } catch {
      // Absent: the workspace root's own copy is written instead.
    }
  }

  const created: GeneratedFile[] = workspaceRootFiles(names.kebab, basePort, transport)
    .filter((file) => !present.has(file.path))
    .map((file) =>
      file.path === WORKSPACE_MANIFEST
        ? { ...file, contents: renderWorkspaceManifest(manifest) }
        : file
    );

  created.push({
    path: joinPath(memberRoot, DISCOVERY_MODULE),
    contents: renderDiscoveryModule(manifest.members[0]!, manifest.members),
  });
  for (const file of workspaceContainerFiles(manifest, transport)) created.push(file);

  const planned = created.map((file) => ({ ...file, path: joinPath(project, file.path) }));

  if (args.flags['dry-run'] === true) {
    for (const file of plan.files) {
      deps.log(`would move ${file.from} -> ${file.to}`);
    }
    for (const file of planned) deps.log(`would create ${file.path}`);
    return EXIT_OK;
  }

  // The root manifest is the one collision that matters: the project has a
  // `deno.json` of its own, and it MOVES into the member before the root's is
  // written, so the check runs against the post-move state rather than this one.
  const collisions = await findExisting(
    deps.fs,
    planned.filter((file) => !file.path.endsWith('/deno.json')),
  );
  if (collisions.length > 0) {
    deps.error('Refusing to overwrite existing files:');
    for (const path of collisions) deps.error(`  ${path}`);
    return EXIT_ERROR;
  }

  // Moves first, so the root's `deno.json` is written into a directory the
  // project's own has already left.
  for (const file of plan.files) {
    const moved = await moveFile(deps.fs, project, file);
    if (!moved.ok) {
      deps.error(moved.message);
      deps.error(
        'Stopped part-way. Every file moved so far exists in both places, so nothing is lost — ' +
          'finish or undo the move by hand.',
      );
      return EXIT_ERROR;
    }
    deps.log(`moved ${file.from} -> ${file.to}`);
  }

  // The directories those files came out of: `moveFile` removes files, so an
  // emptied `src/` would otherwise sit beside `apps/` looking like a second place
  // source lives.
  const kept = await pruneAdoptedDirectories(deps.fs, project, ADOPTED_DIRECTORIES);
  for (const directory of kept) {
    deps.log(`kept ${directory}/ — it still holds files this did not move`);
  }

  try {
    await writeFiles(deps.fs, planned);
  } catch (cause) {
    deps.error(`Failed to write: ${cause instanceof Error ? cause.message : String(cause)}`);
    return EXIT_ERROR;
  }
  for (const file of planned) deps.log(`created ${file.path}`);

  // The entry has to bind the allocated port rather than the literal it carried as
  // a standalone project, or the member answers nothing at the address its
  // siblings will dial.
  const entryPath = joinPath(project, joinPath(memberRoot, 'main.ts'));
  let rewritten: string | undefined;
  try {
    const entry = new TextDecoder().decode(await deps.fs.readFile(entryPath));
    rewritten = rewriteEntryPort(entry, SERVICE_PORT_EXPORT, DISCOVERY_SPECIFIER);
    if (rewritten !== undefined) {
      await deps.fs.writeFile(entryPath, new TextEncoder().encode(rewritten));
    }
  } catch {
    // No entry at all: a Workers project has `src/index.ts` and binds no port.
  }

  deps.log('');
  deps.log(`Converted into a workspace with ${names.kebab} on port ${basePort}.`);
  if (rewritten === undefined) {
    deps.log('');
    deps.log(`Its entry does not carry the port literal this rewrites, so bind the allocated`);
    deps.log(`port yourself — two lines in ${joinPath(memberRoot, 'main.ts')}:`);
    deps.log(`  import { ${SERVICE_PORT_EXPORT} } from '${DISCOVERY_SPECIFIER}';`);
    deps.log(`  await app.start({ port: ${SERVICE_PORT_EXPORT} });`);
  }
  deps.log('');
  deps.log('Next:');
  deps.log(`  ${PROGRAM_NAME} generate ${APP_VERB} <name>   # add a second service`);
  deps.log(`  deno task dev                       # run every member`);
  return EXIT_OK;
}
