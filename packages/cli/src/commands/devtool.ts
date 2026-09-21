/**
 * `setu devtool enable` — enabling the devtool on a project that already
 * exists.
 *
 * `setu new --devtool` and `setu generate app <name> --devtool` only CREATE;
 * this command is the entry point for everything else, and its commonest input
 * is a project scaffolded before the devtool letter existed. It is dispatched
 * before the schematic registry and is deliberately NOT a schematic: a
 * `Schematic` is a pure `(names, options) => GeneratedFile[]` with no I/O,
 * while this reads manifests, merges into them, and refuses.
 *
 * Every write into an existing `deno.json` is a MERGE from the parsed object
 * (the `withDependency` precedent), never a rewrite — except that the `tasks`
 * and `imports` maps are NOT sorted here: `denoTasks` emits tasks in a fixed
 * insertion order, so sorting would put this merge permanently at odds with
 * the emitter. A key already present with a different value refuses by name;
 * one byte-identical to what this command would write is a no-op, which is
 * what makes the command idempotent.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';

import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import {
  CONFIG_MODULE,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  PROGRAM_NAME,
  VERSION,
} from '../constants.ts';
import { renderDevEntry } from '../devtool/dev-entry.ts';
import {
  DEFAULT_DEVTOOL_PORT,
  deriveDevTask,
  DEVTOOL_ENTRY_MODULE,
  devtoolCheckTask,
  devtoolDevRunner,
  devtoolRunnerRefusal,
  devtoolRuntimeRefusal,
  legacyFactoryRefusal,
  starterConfigRefusal,
} from '../devtool/planner.ts';
import type { GeneratedFile } from '../utils/file-writer.ts';
import { joinPath, resolveDir, writeFiles } from '../utils/file-writer.ts';
import { DISCOVERY_SPECIFIER, SERVICE_PORT_EXPORT } from '../workspace/discovery-module.ts';
import {
  allocatePort,
  MAX_PORT,
  MEMBERS_DIR,
  readPortFlag,
  readWorkspaceManifest,
  renderWorkspaceManifest,
  WORKSPACE_MANIFEST,
  type WorkspaceManifest,
} from '../workspace/manifest.ts';
import { assumePortAvailable, type PortProbe } from '../workspace/port-probe.ts';
import { LEGACY_DENO_RUN_ALL, workspaceProfile } from '../workspace/runtime-profile.ts';

/** The import-map key the development entry resolves the plugin through. */
const DEVTOOL_DEPENDENCY = '@setu-ts/diagnostics-plugin';

/**
 * The exact specifier the entry's import must resolve to. The create-time
 * paths pin the same range from `packageImports`, so a project scaffolded with
 * `--devtool` and one enabled later carry the identical entry — which is what
 * makes the byte-identical no-op outcome reachable on both.
 */
const DEVTOOL_IMPORT = `jsr:${DEVTOOL_DEPENDENCY}@^${VERSION}`;

/** Dependencies reached by the devtool command. */
export interface DevtoolCommandDependencies {
  /** The filesystem all reads and writes go through. */
  readonly fs: IFileSystem;
  /** The working directory a relative `--dir` resolves against (absolute). */
  readonly cwd: string;
  /** Writes a line of normal output. */
  readonly log: (message: string) => void;
  /** Writes a line of error output. */
  readonly error: (message: string) => void;
  /** Checks whether a candidate port is currently bindable. */
  readonly portAvailable?: PortProbe;
}

/** One planned change to an existing file, or a new file this command creates. */
interface PlannedWrite {
  readonly path: string;
  readonly contents: string;
  /** True when the file does not exist yet — the dry-run wording differs. */
  readonly creating: boolean;
}

/**
 * A `deno.json` opened for merging.
 *
 * Every other top-level key survives untouched: only `tasks` and `imports` are
 * rewritten, and only the keys this command adds. Serialization is
 * insertion-ordered at two-space indent, which is what every other emitter
 * here writes — no sort, because the CLI's own task emitter is
 * insertion-ordered and sorting here would reorder a file the CLI wrote.
 */
interface DenoJsonHandle {
  /** The live tasks map — mutate it to plan an edit. */
  readonly tasks: Record<string, string>;
  /** The tasks map as it was when the file was read. */
  readonly originalTasks: string;
  /** The live imports map — mutate it to plan an edit. */
  readonly imports: Record<string, string>;
  /** The imports map as it was when the file was read. */
  readonly originalImports: string;
  /** Re-serializes the file with the mutated tasks and imports maps. */
  readonly serialize: () => string;
  /** The absolute path, for refusals. */
  readonly path: string;
}

/**
 * Opens a `deno.json` for merging.
 *
 * @param path - The absolute path, for refusals
 * @param source - The file's current contents
 * @returns The handle
 * @throws {SyntaxError} When the source is not JSON — callers refuse with
 * the file named rather than letting this escape
 */
function openDenoJson(path: string, source: string): DenoJsonHandle {
  const record = JSON.parse(source) as Record<string, unknown>;
  const rawTasks = record['tasks'];
  const tasks: Record<string, string> = rawTasks !== null && typeof rawTasks === 'object'
    ? { ...(rawTasks as Record<string, string>) }
    : {};
  const rawImports = record['imports'];
  const hadImports = rawImports !== null && typeof rawImports === 'object';
  const imports: Record<string, string> = hadImports
    ? { ...(rawImports as Record<string, string>) }
    : {};
  return {
    tasks,
    originalTasks: JSON.stringify(tasks),
    imports,
    originalImports: JSON.stringify(imports),
    path,
    serialize: () => {
      const out: Record<string, unknown> = { ...record, tasks };
      // A file that declared no imports map gains one only when a pin was
      // added — a tasks-only merge (the root widening) must not grow the file
      // with an empty key.
      if (hadImports || Object.keys(imports).length > 0) out['imports'] = imports;
      else delete out['imports'];
      return `${JSON.stringify(out, null, 2)}\n`;
    },
  };
}

/**
 * Merges one task into a handle's map.
 *
 * @param handle - The manifest being merged into
 * @param key - The task name
 * @param expected - The exact body this command would write
 * @returns The refusal message when the task exists with a DIFFERENT value —
 * a task a developer wrote is theirs, and silently replacing it is the failure
 * mode this command exists to avoid — or `undefined` when merged or already
 * byte-identical
 */
function mergeTask(
  handle: DenoJsonHandle,
  key: string,
  expected: string,
): string | undefined {
  const current = handle.tasks[key];
  if (current === expected) return undefined;
  if (current !== undefined) {
    return (
      `Refusing to replace the existing "${key}" task in ${handle.path}:\n` +
      `  current: ${current}\n` +
      `  would write: ${expected}\n` +
      `A task you wrote is yours to change; update it to match, or remove it, and run this again.`
    );
  }
  handle.tasks[key] = expected;
  return undefined;
}

/**
 * Merges the diagnostics-plugin pin into a handle's imports map.
 *
 * The development entry imports `@setu-ts/diagnostics-plugin`, so the project
 * MUST declare it or its own check task fails on an unresolvable specifier —
 * which is what a pre-devtool project's import map lacks, and what the
 * create-time paths get from `withDevtool`'s packageImports. Three outcomes,
 * the same contract as the tasks: absent → add; byte-identical → no-op;
 * different → refuse by name (a pin a developer rewrote is theirs).
 *
 * @param handle - The manifest being merged into
 * @param expected - The full specifier to record
 * @returns The refusal message when the specifier exists with a DIFFERENT
 * value, or `undefined` when merged or already byte-identical
 */
function mergeImport(
  handle: DenoJsonHandle,
  expected: string,
): string | undefined {
  const current = handle.imports[DEVTOOL_DEPENDENCY];
  if (current === expected) return undefined;
  if (current !== undefined) {
    return (
      `Refusing to replace the existing "${DEVTOOL_DEPENDENCY}" import in ${handle.path}:\n` +
      `  current: ${current}\n` +
      `  would write: ${expected}\n` +
      `A pin you rewrote is yours to change; update it to match, or remove it, and run this again.`
    );
  }
  handle.imports[DEVTOOL_DEPENDENCY] = expected;
  return undefined;
}

/**
 * Collects a rewrite for every manifest whose merges actually changed it.
 *
 * Called only after every merge has succeeded, so a refusal never leaves a
 * half-planned write behind and `--dry-run` reports the exact plan rather than
 * a prediction.
 *
 * @param planned - The write list, appended to in file order
 * @param handles - Every manifest opened for this run
 */
function planManifestWrites(planned: PlannedWrite[], handles: readonly DenoJsonHandle[]): void {
  for (const handle of handles) {
    const tasksChanged = JSON.stringify(handle.tasks) !== handle.originalTasks;
    const importsChanged = JSON.stringify(handle.imports) !== handle.originalImports;
    if (!tasksChanged && !importsChanged) continue;
    planned.push({ path: handle.path, contents: handle.serialize(), creating: false });
  }
}

/** Prints the command's usage. */
function printUsage(log: (message: string) => void): void {
  log(
    `Usage: ${PROGRAM_NAME} devtool enable [member] [--devtool-port <n>] [--dir <path>] [--dry-run]`,
  );
  log('');
  log('Enables the local diagnostics connector on a project that already exists:');
  log('writes main.dev.ts, adds the `dev` and `check` tasks, and widens the root');
  log('workspace `dev` task with the credential-variable grant it forwards.');
  log('');
  log('Inside a workspace the member name is required. Outside one, no member');
  log('name is accepted.');
  log('');
  log('Options:');
  log(
    '  --devtool-port <n>  The loopback port the connector binds (default ' +
      `${DEFAULT_DEVTOOL_PORT} standalone; allocated in a workspace)`,
  );
  log('  --dir <path>        Operate on this directory instead of the CWD');
  log('  --dry-run           Print what would change, write nothing');
}

/** The usage line shared by every subcommand refusal. */
const USAGE =
  `Usage: ${PROGRAM_NAME} devtool enable [member] [--devtool-port <n>] [--dir <path>] [--dry-run]`;

/**
 * Runs `setu devtool enable`.
 *
 * @param args - Arguments after the `devtool` verb, already parsed
 * @param deps - Filesystem, working directory, and output sinks
 * @returns `0` on success, `1` on a runtime error, `2` on a usage error
 */
export async function runDevtoolCommand(
  args: ParsedArgs,
  deps: DevtoolCommandDependencies,
): Promise<number> {
  if (args.flags['help'] === true || args.flags['h'] === true) {
    printUsage(deps.log);
    return EXIT_OK;
  }
  if (args.positionals[0] !== 'enable') {
    deps.error(USAGE);
    return EXIT_USAGE;
  }

  const requestedPort = readPortFlag(args.flags, 'devtool-port');
  if (!requestedPort.ok) {
    deps.error(requestedPort.message);
    return EXIT_USAGE;
  }

  const dir = resolveDir(deps.cwd, stringFlag(args.flags, 'dir'));
  const memberName = args.positionals[1];

  const read = await readWorkspaceManifest(deps.fs, dir);
  if (read.ok) {
    return enableInWorkspace(read.manifest, dir, memberName, requestedPort.port, args, deps);
  }
  // An UNREADABLE manifest is not "no workspace": guessing standalone could
  // write devtool files beside a manifest the developer believes governs the
  // directory. Refused with the same treatment every other command gives it.
  if (read.problem.kind !== 'absent') {
    deps.error(
      `A ${WORKSPACE_MANIFEST} exists in ${dir} but cannot be read (version` +
        ` ${
          read.problem.kind === 'unsupported-version' ? read.problem.version : 'unknown or invalid'
        }),` +
        ` so the devtool cannot tell whether this is a workspace. Fix or remove the manifest first.`,
    );
    return EXIT_ERROR;
  }
  return enableStandalone(dir, memberName, requestedPort.port, args, deps);
}

/** Why an inapplicable project was refused, worded the way the plan names. */
function reportInapplicable(deps: DevtoolCommandDependencies, message: string): number {
  deps.error(message);
  return EXIT_ERROR;
}

/**
 * Enables the devtool on one member of an existing workspace: the member's dev
 * entry and tasks, the root `dev` task's grant, and the recorded devtool port.
 *
 * @param manifest - The workspace as it currently reads
 * @param dir - The workspace root (absolute)
 * @param memberName - The `enable` subcommand's member positional
 * @param requestedPort - The explicit `--devtool-port`, when given
 * @param args - The parsed arguments, read for `--dry-run`
 * @param deps - Filesystem, working directory, and output sinks
 * @returns The exit code
 */
async function enableInWorkspace(
  manifest: WorkspaceManifest,
  dir: string,
  memberName: string | undefined,
  requestedPort: number | undefined,
  args: ParsedArgs,
  deps: DevtoolCommandDependencies,
): Promise<number> {
  const runtimeRefusal = devtoolRuntimeRefusal(manifest.runtime);
  if (runtimeRefusal !== undefined) return reportInapplicable(deps, runtimeRefusal);

  if (memberName === undefined) {
    deps.error(
      `A member name is required inside a workspace: \`${PROGRAM_NAME} devtool enable <member>\`.` +
        ` Members: ${manifest.members.map((member) => member.name).join(', ') || 'none'}.`,
    );
    return EXIT_USAGE;
  }

  const member = manifest.members.find((candidate) => candidate.name === memberName);
  if (member === undefined) {
    deps.error(
      `Workspace member "${memberName}" is not in ${WORKSPACE_MANIFEST}.` +
        ` Members: ${manifest.members.map((entry) => entry.name).join(', ') || 'none'}.`,
    );
    return EXIT_ERROR;
  }
  // Idempotent, per the merge contract: a member already carrying a devtool
  // port has nothing left to merge, so the command reports and writes
  // nothing rather than refusing — running it twice is not an error.
  if (member.devtoolPort !== undefined) {
    deps.log(
      `Member "${member.name}" already carries a devtool port (${member.devtoolPort});` +
        ` the devtool is already enabled for it, so there is nothing to do.`,
    );
    return EXIT_OK;
  }

  const memberRoot = joinPath(MEMBERS_DIR, member.name);

  const configPath = joinPath(dir, memberRoot, CONFIG_MODULE);
  let configSource: string;
  try {
    configSource = new TextDecoder().decode(await deps.fs.readFile(configPath));
  } catch {
    return reportInapplicable(
      deps,
      `No ${CONFIG_MODULE} in ${joinPath(memberRoot)} — this is not a Setu-TS project member.`,
    );
  }
  const legacy = legacyFactoryRefusal(configSource);
  if (legacy !== undefined) return reportInapplicable(deps, legacy);
  const starter = starterConfigRefusal(configSource);
  if (starter !== undefined) return reportInapplicable(deps, starter);

  const handles: DenoJsonHandle[] = [];
  const planned: PlannedWrite[] = [];

  const memberManifestPath = joinPath(dir, memberRoot, 'deno.json');
  let memberSource: string;
  try {
    memberSource = new TextDecoder().decode(await deps.fs.readFile(memberManifestPath));
  } catch {
    return reportInapplicable(
      deps,
      `No deno.json in ${joinPath(memberRoot)} — this is not a Setu-TS project member.`,
    );
  }
  let memberHandle: DenoJsonHandle;
  try {
    memberHandle = openDenoJson(memberManifestPath, memberSource);
  } catch {
    deps.error(`Cannot read ${memberManifestPath} as JSON; fix it and run this again.`);
    return EXIT_ERROR;
  }
  handles.push(memberHandle);

  const start = memberHandle.tasks['start'];
  if (start === undefined) {
    return reportInapplicable(
      deps,
      `The member has no "start" task in ${memberManifestPath}; the devtool derives the` +
        ` \`dev\` task from it, and there is nothing to derive from.`,
    );
  }
  const devTask = deriveDevTask(start);
  if (devTask === undefined) {
    return reportInapplicable(
      deps,
      `Cannot derive a "dev" task from the current "start" task:\n` +
        `  ${start}\n` +
        `The devtool requires a start task that runs main.ts directly, so the two tasks` +
        ` differ only in the entry module. Change the entry, then run this again.`,
    );
  }
  const devRefusal = mergeTask(memberHandle, 'dev', devTask);
  if (devRefusal !== undefined) return reportInapplicable(deps, devRefusal);
  const checkRefusal = mergeTask(memberHandle, 'check', devtoolCheckTask());
  if (checkRefusal !== undefined) return reportInapplicable(deps, checkRefusal);
  // The entry imports the diagnostics plugin, so the MEMBER's import map must
  // pin it — the root map is untouched: the root has no development entry of
  // its own.
  const importRefusal = mergeImport(memberHandle, DEVTOOL_IMPORT);
  if (importRefusal !== undefined) return reportInapplicable(deps, importRefusal);

  // The root `dev` task is a MODIFICATION of an existing string, not an added
  // key, and `managedFiles` contains no deno.json — so this command is the
  // only place it can happen. Three outcomes: unmodified CLI output is
  // widened; already widened is a no-op; anything else is the developer's edit
  // and refuses with its current value.
  const rootManifestPath = joinPath(dir, 'deno.json');
  let rootSource: string;
  try {
    rootSource = new TextDecoder().decode(await deps.fs.readFile(rootManifestPath));
  } catch {
    return reportInapplicable(
      deps,
      `No deno.json in ${dir}: a Deno workspace root declares one, and the root \`dev\`` +
        ` task's grant must be widened in place for the devtool to run.`,
    );
  }
  let rootHandle: DenoJsonHandle;
  try {
    rootHandle = openDenoJson(rootManifestPath, rootSource);
  } catch {
    deps.error(`Cannot read ${rootManifestPath} as JSON; fix it and run this again.`);
    return EXIT_ERROR;
  }
  handles.push(rootHandle);
  const expectedRunAll = workspaceProfile('deno').runAll;
  const currentRunAll = rootHandle.tasks['dev'];
  if (currentRunAll === expectedRunAll) {
    // Already widened — a workspace created after the grant existed.
  } else if (currentRunAll === LEGACY_DENO_RUN_ALL) {
    // Mutated only; planManifestWrites renders it once, after every merge has
    // succeeded.
    rootHandle.tasks['dev'] = expectedRunAll;
  } else {
    return reportInapplicable(
      deps,
      `Refusing to replace the existing "dev" task in ${rootManifestPath}:\n` +
        `  current: ${currentRunAll ?? '(none)'}\n` +
        `  would write: ${expectedRunAll}\n` +
        `A task you wrote is yours to change; update it to match, or remove it, and run this again.`,
    );
  }

  // The root `dev` task is only half the handoff: the SCRIPT it runs has to
  // read the three variables and hand them to one child. A workspace created
  // before the devtool carries the old runner, which nothing regenerates —
  // widening the task above while leaving that script stale is a command that
  // reports success and leaves the connector unreachable.
  const runner = devtoolDevRunner();
  const runnerPath = joinPath(dir, runner.path);
  let existingRunner: string | undefined;
  try {
    existingRunner = new TextDecoder().decode(await deps.fs.readFile(runnerPath));
  } catch {
    existingRunner = undefined;
  }
  const runnerRefusal = devtoolRunnerRefusal(existingRunner, runner.path);
  if (runnerRefusal !== undefined) return reportInapplicable(deps, runnerRefusal);

  const devtoolPort = await resolveDevtoolPort(manifest, requestedPort, deps);
  if (typeof devtoolPort === 'string') return reportInapplicable(deps, devtoolPort);

  const entryPath = joinPath(dir, memberRoot, DEVTOOL_ENTRY_MODULE);
  const entry = renderDevEntry({
    devtoolPort,
    port: { symbol: SERVICE_PORT_EXPORT, from: DISCOVERY_SPECIFIER },
  });
  let existingEntry: string | undefined;
  try {
    existingEntry = new TextDecoder().decode(await deps.fs.readFile(entryPath));
  } catch {
    existingEntry = undefined;
  }
  if (existingEntry !== undefined && existingEntry !== entry) {
    return reportInapplicable(
      deps,
      `Refusing to overwrite ${joinPath(memberRoot, DEVTOOL_ENTRY_MODULE)}: it exists with` +
        ` different contents. The file is yours once written — review it, remove it, and` +
        ` run this again.`,
    );
  }

  const nextManifest: WorkspaceManifest = {
    ...manifest,
    members: manifest.members.map((entry_) =>
      entry_.name === member.name ? { ...entry_, devtoolPort } : entry_
    ),
  };

  planManifestWrites(planned, handles);
  if (existingRunner === undefined) {
    planned.push({ path: runnerPath, contents: runner.contents, creating: true });
  }
  if (existingEntry === undefined) {
    planned.push({ path: entryPath, contents: entry, creating: true });
  }
  planned.push({
    path: joinPath(dir, WORKSPACE_MANIFEST),
    contents: renderWorkspaceManifest(nextManifest),
    creating: false,
  });

  if (args.flags['dry-run'] === true) {
    for (const write of planned) {
      deps.log(`${write.creating ? 'would create' : 'would update'} ${write.path}`);
    }
    return EXIT_OK;
  }

  try {
    await writeFiles(deps.fs, planned as readonly GeneratedFile[]);
  } catch (cause) {
    deps.error(
      `Failed to enable the devtool: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return EXIT_ERROR;
  }

  for (const write of planned) deps.log(`${write.creating ? 'created' : 'updated'} ${write.path}`);
  deps.log('');
  deps.log(
    `Enabled the devtool for ${member.name}: the connector listens on` +
      ` 127.0.0.1:${devtoolPort} while the member runs.`,
  );
  deps.log('Next, from the workspace root:');
  deps.log(`  SETU_DEVTOOL_MEMBER=${member.name} deno task dev`);
  deps.log('The launcher supplies the session credentials through the environment.');
  return EXIT_OK;
}

/**
 * Enables the devtool on a standalone Deno project.
 *
 * @param dir - The project directory (absolute)
 * @param memberName - The `enable` subcommand's member positional
 * @param requestedPort - The explicit `--devtool-port`, when given
 * @param args - The parsed arguments, read for `--dry-run`
 * @param deps - Filesystem, working directory, and output sinks
 * @returns The exit code
 */
async function enableStandalone(
  dir: string,
  memberName: string | undefined,
  requestedPort: number | undefined,
  args: ParsedArgs,
  deps: DevtoolCommandDependencies,
): Promise<number> {
  if (memberName !== undefined) {
    deps.error(
      `\`${PROGRAM_NAME} devtool enable\` takes no member name outside a workspace:` +
        ` ${dir} carries no ${WORKSPACE_MANIFEST}, so there is no member to name.`,
    );
    return EXIT_USAGE;
  }

  const manifestPath = joinPath(dir, 'deno.json');
  let manifestSource: string;
  try {
    manifestSource = new TextDecoder().decode(await deps.fs.readFile(manifestPath));
  } catch {
    return reportInapplicable(
      deps,
      `No deno.json in ${dir} — this is not a Setu-TS project.`,
    );
  }
  let handle: DenoJsonHandle;
  try {
    handle = openDenoJson(manifestPath, manifestSource);
  } catch {
    deps.error(`Cannot read ${manifestPath} as JSON; fix it and run this again.`);
    return EXIT_ERROR;
  }

  const configPath = joinPath(dir, CONFIG_MODULE);
  let configSource: string;
  try {
    configSource = new TextDecoder().decode(await deps.fs.readFile(configPath));
  } catch {
    return reportInapplicable(
      deps,
      `No ${CONFIG_MODULE} in ${dir} — this is not a Setu-TS project.`,
    );
  }
  const legacy = legacyFactoryRefusal(configSource);
  if (legacy !== undefined) return reportInapplicable(deps, legacy);
  const starter = starterConfigRefusal(configSource);
  if (starter !== undefined) return reportInapplicable(deps, starter);

  const start = handle.tasks['start'];
  if (start === undefined) {
    return reportInapplicable(
      deps,
      `This project has no "start" task in ${manifestPath}; the devtool derives the` +
        ` \`dev\` task from it, and there is nothing to derive from.`,
    );
  }
  const devTask = deriveDevTask(start);
  if (devTask === undefined) {
    return reportInapplicable(
      deps,
      `Cannot derive a "dev" task from the current "start" task:\n` +
        `  ${start}\n` +
        `The devtool requires a start task that runs main.ts directly, so the two tasks` +
        ` differ only in the entry module. Change the entry, then run this again.`,
    );
  }

  const planned: PlannedWrite[] = [];
  const devRefusal = mergeTask(handle, 'dev', devTask);
  if (devRefusal !== undefined) return reportInapplicable(deps, devRefusal);
  const checkRefusal = mergeTask(handle, 'check', devtoolCheckTask());
  if (checkRefusal !== undefined) return reportInapplicable(deps, checkRefusal);
  const importRefusal = mergeImport(handle, DEVTOOL_IMPORT);
  if (importRefusal !== undefined) return reportInapplicable(deps, importRefusal);

  const devtoolPort = requestedPort ?? DEFAULT_DEVTOOL_PORT;
  const entryPath = joinPath(dir, DEVTOOL_ENTRY_MODULE);
  const entry = renderDevEntry({ devtoolPort });
  let existingEntry: string | undefined;
  try {
    existingEntry = new TextDecoder().decode(await deps.fs.readFile(entryPath));
  } catch {
    existingEntry = undefined;
  }
  if (existingEntry !== undefined && existingEntry !== entry) {
    return reportInapplicable(
      deps,
      `Refusing to overwrite ${DEVTOOL_ENTRY_MODULE}: it exists with different contents.` +
        ` The file is yours once written — review it, remove it, and run this again.`,
    );
  }

  planManifestWrites(planned, [handle]);
  if (existingEntry === undefined) {
    planned.push({ path: entryPath, contents: entry, creating: true });
  }

  if (args.flags['dry-run'] === true) {
    for (const write of planned) {
      deps.log(`${write.creating ? 'would create' : 'would update'} ${write.path}`);
    }
    return EXIT_OK;
  }

  if (planned.length === 0) {
    deps.log(`The devtool is already enabled on this project.`);
    return EXIT_OK;
  }

  try {
    await writeFiles(deps.fs, planned as readonly GeneratedFile[]);
  } catch (cause) {
    deps.error(
      `Failed to enable the devtool: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
    return EXIT_ERROR;
  }

  for (const write of planned) deps.log(`${write.creating ? 'created' : 'updated'} ${write.path}`);
  deps.log('');
  deps.log(
    `Enabled the devtool: the connector listens on 127.0.0.1:${devtoolPort} while the project runs.`,
  );
  deps.log('Next:');
  deps.log('  deno task dev');
  deps.log('The launcher supplies the session credentials through the environment.');
  return EXIT_OK;
}

/**
 * Resolves the devtool port for a workspace member: the explicit flag,
 * collision-checked against every recorded port, or the next port the widened
 * allocator hands out — probed for bindability when a probe is available, so a
 * port another process holds is skipped exactly as an application port is.
 *
 * @param manifest - The workspace as it currently reads
 * @param requestedPort - The explicit `--devtool-port`, when given
 * @param deps - Filesystem, working directory, and output sinks
 * @returns The port, or the refusal message
 */
async function resolveDevtoolPort(
  manifest: WorkspaceManifest,
  requestedPort: number | undefined,
  deps: DevtoolCommandDependencies,
): Promise<number | string> {
  const probe = deps.portAvailable ?? assumePortAvailable;
  if (requestedPort !== undefined) {
    const taken = manifest.members.find(
      (member) => member.port === requestedPort || member.devtoolPort === requestedPort,
    );
    if (taken !== undefined) {
      return (
        `Port ${requestedPort} is already used by the member "${taken.name}" in this workspace` +
        `${taken.devtoolPort === requestedPort ? ' (its devtool port)' : ''}. Two listeners on` +
        ` one port cannot both bind, and the launcher would connect to whichever process won.`
      );
    }
    if (deps.portAvailable !== undefined && !(await probe(requestedPort))) {
      return `Port ${requestedPort} is already in use outside this workspace.`;
    }
    return requestedPort;
  }

  let candidate = allocatePort(manifest);
  while (candidate !== undefined && !(await probe(candidate))) {
    // Same marker trick the application port uses: a member carrying the
    // occupied value as its port pushes the allocator past it.
    candidate = allocatePort({
      ...manifest,
      members: [...manifest.members, { name: '__occupied__', port: candidate }],
    });
  }
  if (candidate === undefined) {
    return `This workspace has no port left to allocate: every number from its base up to` +
      ` ${MAX_PORT} is taken.`;
  }
  return candidate;
}
