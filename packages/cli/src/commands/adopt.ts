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

import { rewriteLegacyPins } from '../workspace/legacy-pins.ts';
import { formatForTarget } from '../utils/prettier-format.ts';
import type { IFileSystem } from '@setu-ts/common';

import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import {
  APP_VERB,
  EXIT_ERROR,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_USAGE,
  PROGRAM_NAME,
} from '../constants.ts';
import { interruptionMessage, throwIfInterrupted } from '../utils/interruption.ts';
import { isMissingPath } from '../utils/filesystem-errors.ts';
import { deriveNames, escapeName, IDENTIFIER_NAME_RULE, isIdentifierSafe } from '../utils/names.ts';
import {
  assertInsideProject,
  findExisting,
  type GeneratedFile,
  joinPath,
  resolveDir,
  withFileTransaction,
  writeFiles,
} from '../utils/file-writer.ts';
import {
  ADOPTED_DIRECTORIES,
  moveFile,
  planAdoption,
  probeSupport,
  pruneAdoptedDirectories,
  rewriteEntryPort,
} from '../workspace/adopt.ts';
import { detectPlugins } from '../utils/plugin-detector.ts';
import { workspaceContainerFiles } from '../workspace/compose.ts';
import { workspaceK8sFiles } from '../workspace/k8s.ts';
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
import { detectProjectRuntime, workspaceProfile } from '../workspace/runtime-profile.ts';
import { DEFAULT_TRANSPORT, transportSpec } from '../workspace/transport.ts';

import { cliInvocation } from '../templates/project-files.ts';

/**
 * Raised inside the conversion transaction when the conversion cannot finish.
 *
 * A return value would let the transaction commit its already-applied moves, so
 * the refusal is thrown instead: `withFileTransaction` rolls back on a throw and
 * only on a throw. The messages the command would have printed are carried out
 * to the call site, which prints them once the rollback has finished.
 */
class AdoptAbortedError extends Error {
  /** The lines to print, in order. */
  readonly messages: readonly string[];

  /**
   * @param messages - The lines to print, in order
   */
  constructor(messages: readonly string[]) {
    super(messages.join(' '));
    this.name = 'AdoptAbortedError';
    this.messages = messages;
  }
}

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
  /** Cooperative interruption signal checked at write boundaries. */
  readonly interrupt?: AbortSignal;
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

/** The marker files the plugin and runtime probes read in a member directory. */
const MEMBER_PROBE_FILES = ['deno.json', 'deno.jsonc', 'package.json', 'bun.lock', 'bun.lockb'];

/**
 * Whether an interrupted adoption's member directory may feed the probes.
 *
 * The directory and every marker file present in it must resolve exactly to its
 * place in the project: a link planted at `apps/<member>`, or at a manifest
 * inside it, would otherwise feed a foreign manifest into the persisted runtime
 * and probe support. An absent marker is simply absent. Any refusal drops the
 * member directory from the probes; the planning that follows still refuses the
 * move on its own terms.
 *
 * @param fs - The filesystem to probe
 * @param project - The project directory (absolute)
 * @param memberRoot - The planned member, relative to the project
 * @returns Whether the member directory may be probed
 */
async function memberProbeInsideProject(
  fs: IFileSystem,
  project: string,
  memberRoot: string,
): Promise<boolean> {
  const member = joinPath(project, memberRoot);
  try {
    await assertInsideProject(fs, project, member);
    for (const name of MEMBER_PROBE_FILES) {
      const path = joinPath(member, name);
      try {
        await fs.stat(path);
      } catch (cause) {
        if (isMissingPath(cause)) continue;
        return false;
      }
      await assertInsideProject(fs, project, path);
    }
    return true;
  } catch {
    return false;
  }
}

/**
 * Runs `setu adopt`.
 *
 * @param args - Arguments after the verb, already parsed
 * @param deps - Filesystem, working directory, and output sinks
 * @returns `0` on success, `1` on a runtime error, `2` on a usage error
 */
export async function runAdoptCommand(args: ParsedArgs, deps: AdoptDependencies): Promise<number> {
  if (args.flags['help'] === true || args.flags['h'] === true) {
    printUsage(deps.log);
    return EXIT_OK;
  }

  const project = resolveDir(deps.cwd, stringFlag(args.flags, 'dir'));

  // Refused before anything is planned: converting a workspace into a workspace
  // would write a second root over the first.
  const existing = await readWorkspaceManifest(deps.fs, project);
  if (existing.ok) {
    deps.error(
      `${escapeName(joinPath(project, WORKSPACE_MANIFEST))} already exists: this IS a workspace.`,
    );
    deps.error(
      `Add a service to it with \`${cliInvocation(existing.manifest.runtime)} generate ${APP_VERB} <name>\`.`,
    );
    return EXIT_ERROR;
  }

  const rawName =
    stringFlag(args.flags, 'name') ??
    project
      .split('/')
      .filter((part) => part !== '')
      .at(-1) ??
    '';
  const names = deriveNames(rawName);
  if (!isIdentifierSafe(names)) {
    deps.error(
      `Cannot use "${escapeName(rawName)}" as a member name: ${IDENTIFIER_NAME_RULE} ` +
        `Pass --name <member>.`,
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

  // Read from the project's own manifest BEFORE anything moves, and persisted in
  // the member record: the Kubernetes renderer has only the manifest, and later
  // `generate app` / `ports --reallocate` re-renders must keep the same answer.
  // An interrupted adoption may already have moved the manifest under the planned
  // member, so both locations are probed; a fresh adoption has no member and the
  // union is the root's own answer. The member is read only when it is really
  // inside the project: a link planted at `apps/<member>` must not feed a foreign
  // manifest into the probes, so it is ignored here and the planning below refuses.
  const memberDir = (await memberProbeInsideProject(deps.fs, project, memberRoot))
    ? joinPath(project, memberRoot)
    : undefined;
  const plugins = new Set([
    ...(await detectPlugins(deps.fs, project)),
    ...(memberDir === undefined ? [] : await detectPlugins(deps.fs, memberDir)),
  ]);
  const support = probeSupport(plugins);

  // The toolchain the project already uses, not a choice: a project with a
  // package.json is a Node or Bun one, and converting it into a Deno workspace
  // would leave a root whose members its toolchain cannot install.
  const profile = workspaceProfile(await detectProjectRuntime(deps.fs, project, memberDir));

  const manifest = {
    version: WORKSPACE_VERSION,
    runtime: profile.runtime,
    basePort,
    // The default, deliberately: a project being converted has whatever broker its
    // own config already names, and rewriting that here would change how a running
    // service talks without being asked to. `--transport` belongs to a workspace
    // created fresh.
    transport: DEFAULT_TRANSPORT,
    members: [{ name: names.kebab, port: basePort, ...support }],
  };
  const transport = transportSpec(DEFAULT_TRANSPORT);

  // The root's own files, minus the one the project keeps at this level.
  // `.gitignore` is NOT adopted, so a project that has one keeps it exactly where
  // it is: a repository's ignore rules belong at its root, and the developer's
  // copy may say more than ours would.
  //
  // `README.md` is deliberately absent from this set even though the project has
  // one, because that copy MOVES into the member — suppressing the root's on the
  // strength of a file that is about to leave is how the workspace ends up with
  // no README at all.
  const keepExisting = new Set(['.gitignore']);
  const present = new Set<string>();
  for (const path of keepExisting) {
    try {
      await deps.fs.stat(joinPath(project, path));
      present.add(path);
    } catch {
      // Absent: the workspace root's own copy is written instead.
    }
  }

  const created: GeneratedFile[] = workspaceRootFiles(names.kebab, basePort, transport, profile)
    .filter((file) => !present.has(file.path))
    .map((file) =>
      file.path === WORKSPACE_MANIFEST
        ? { ...file, contents: renderWorkspaceManifest(manifest) }
        : file,
    );

  // Files the conversion writes beside the moves — currently the member's own
  // `.gitignore` for a moved dotenv file. They go through this same batch, so an
  // interruption rolls them back with everything else.
  for (const file of plan.creates ?? []) created.push(file);

  created.push({
    path: joinPath(memberRoot, DISCOVERY_MODULE),
    contents: renderDiscoveryModule(manifest.members[0]!, manifest.members, profile),
  });
  for (const file of workspaceContainerFiles(manifest, transport, profile)) created.push(file);
  for (const file of workspaceK8sFiles(manifest, transport)) created.push(file);

  const planned = created.map((file) => ({ ...file, path: joinPath(project, file.path) }));

  // The check runs against the POST-MOVE state, because the moves happen first:
  // anything this is about to relocate is no longer at the root by the time the
  // root's own copy is written. Derived from the plan rather than named as a
  // literal — an earlier version exempted `deno.json` alone, which is exactly the
  // set for a Deno project and misses `package.json` and `.npmrc`, so converting
  // any npm or Bun project refused every time.
  const vacated = new Set(plan.files.map((file) => joinPath(project, file.from)));
  let collisions: readonly string[];
  try {
    collisions = await findExisting(
      deps.fs,
      planned.filter((file) => !vacated.has(file.path)),
    );
  } catch (cause) {
    deps.error(
      `Failed to inspect existing files: ${escapeName(
        cause instanceof Error ? cause.message : String(cause),
      )}`,
    );
    return EXIT_ERROR;
  }

  // Every path this writes or moves TO is checked here, BEFORE a dry run prints a
  // plan and before the transaction moves anything. The planner checks the
  // member's own generated files and every move's SOURCE; the root's generated
  // files are added above, and the moves' destinations are otherwise unchecked
  // until `moveFile` runs. A link committed at one of either (`.dockerignore` for
  // a write, `apps/svc/README.md` for a move) makes the real run refuse while
  // `findExisting` reports the link as absent — so the world would learn about it
  // only after the moves had started, and a dry run would have promised a clean
  // plan for it. That would be worse than no dry run.
  for (const path of [
    ...planned.map((file) => file.path),
    ...plan.files.map((file) => joinPath(project, file.to)),
  ]) {
    try {
      await assertInsideProject(deps.fs, project, path);
    } catch (cause) {
      deps.error(cause instanceof Error ? cause.message : String(cause));
      return EXIT_ERROR;
    }
  }

  if (args.flags['dry-run'] === true) {
    for (const file of plan.files) {
      deps.log(`would move ${escapeName(file.from)} -> ${escapeName(file.to)}`);
    }
    for (const file of planned) deps.log(`would create ${escapeName(file.path)}`);
    // Reported here too: a dry run that prints a clean plan for a conversion the
    // real run refuses is worse than no dry run.
    for (const path of collisions) deps.log(`WOULD REFUSE: ${escapeName(path)} already exists`);
    return collisions.length > 0 ? EXIT_ERROR : EXIT_OK;
  }

  if (collisions.length > 0) {
    deps.error('Refusing to overwrite existing files:');
    for (const path of collisions) deps.error(`  ${escapeName(path)}`);
    return EXIT_ERROR;
  }

  const originalDeps = deps;
  const perform = async (fs: IFileSystem): Promise<number> => {
    const deps = { ...originalDeps, fs };
    // Moves first, so the root's `deno.json` is written into a directory the
    // project's own has already left.
    for (const file of plan.files) {
      const moved = await moveFile(deps.fs, project, file);
      throwIfInterrupted(deps.interrupt);
      if (!moved.ok) {
        throw new AdoptAbortedError([moved.message]);
      }
      deps.log(`moved ${escapeName(file.from)} -> ${escapeName(file.to)}`);
    }

    // The directories those files came out of: `moveFile` removes files, so an
    // emptied `src/` would otherwise sit beside `apps/` looking like a second place
    // source lives.
    const kept = await pruneAdoptedDirectories(deps.fs, project, ADOPTED_DIRECTORIES);
    for (const directory of kept) {
      deps.log(`kept ${directory}/ — it still holds files this did not move`);
    }

    try {
      await writeFiles(
        deps.fs,
        await formatForTarget(planned, profile.runtime, project, deps.error),
        deps.interrupt === undefined
          ? { root: project }
          : { root: project, signal: deps.interrupt },
      );
    } catch (cause) {
      const interrupted = interruptionMessage(cause);
      if (interrupted !== undefined) {
        throw cause;
      }
      throw new AdoptAbortedError([
        `Failed to write: ${escapeName(cause instanceof Error ? cause.message : String(cause))}`,
      ]);
    }
    for (const file of planned) deps.log(`created ${escapeName(file.path)}`);

    // The entry has to bind the allocated port rather than the literal it carried as
    // a standalone project, or the member answers nothing at the address its
    // siblings will dial.
    const entryPath = joinPath(project, joinPath(memberRoot, 'main.ts'));
    let rewritten: string | undefined;
    try {
      const entry = new TextDecoder().decode(await deps.fs.readFile(entryPath));
      rewritten = rewriteEntryPort(entry, SERVICE_PORT_EXPORT, DISCOVERY_SPECIFIER);
    } catch (cause) {
      if (!isMissingPath(cause)) {
        throw new AdoptAbortedError([
          `Failed to read ${escapeName(entryPath)}: ${escapeName(
            cause instanceof Error ? cause.message : String(cause),
          )}`,
        ]);
      }
      // A Workers project has src/index.ts and no main.ts to rewrite.
    }
    if (rewritten !== undefined) {
      try {
        await writeFiles(
          deps.fs,
          await formatForTarget(
            [{ path: entryPath, contents: rewritten, managed: true }],
            profile.runtime,
            project,
            deps.error,
          ),
          deps.interrupt === undefined
            ? { root: project }
            : { root: project, signal: deps.interrupt },
        );
      } catch (cause) {
        const interrupted = interruptionMessage(cause);
        if (interrupted !== undefined) {
          throw cause;
        }
        throw new AdoptAbortedError([
          `Failed to rewrite ${escapeName(entryPath)}: ${escapeName(
            cause instanceof Error ? cause.message : String(cause),
          )}`,
        ]);
      }
    }

    // A pre-0.9 project pins the framework through JSR or its npm alias, which
    // the workspace root no longer maps. Its manifest moves onto the npm names.
    const manifestKind = profile.manifestKind;
    // A Deno member's manifest is `deno.json` or `deno.jsonc` (both move), the
    // first found — Deno's own order. It may carry JSONC comments, which the
    // rewrite reads and keeps.
    let manifestPath = '';
    let pinSource: string | undefined;
    for (const file of manifestKind === 'deno' ? ['deno.json', 'deno.jsonc'] : ['package.json']) {
      manifestPath = joinPath(project, joinPath(memberRoot, file));
      try {
        pinSource = new TextDecoder().decode(await deps.fs.readFile(manifestPath));
        break;
      } catch (cause) {
        if (!isMissingPath(cause)) throw cause;
      }
    }
    const pins =
      pinSource === undefined
        ? { contents: undefined, rewrites: [] }
        : rewriteLegacyPins(pinSource, manifestKind);
    if (pins.unreadable !== undefined) {
      // Never silent: the project still pins the framework however it did before,
      // and the workspace root maps no JSR registry for it.
      deps.error(
        `Could not read ${escapeName(manifestPath)} to move its framework pins onto npm: ${escapeName(
          pins.unreadable,
        )}`,
      );
      deps.error(
        'Rewrite any jsr:@setu-ts/* or npm:@jsr/setu-ts__* pins to the npm packages by hand.',
      );
    }
    if (pins.contents !== undefined) {
      await writeFiles(
        deps.fs,
        await formatForTarget(
          [{ path: manifestPath, contents: pins.contents, managed: true }],
          profile.runtime,
          project,
          deps.error,
        ),
        deps.interrupt === undefined
          ? { root: project }
          : { root: project, signal: deps.interrupt },
      );
      for (const pin of pins.rewrites) {
        deps.log(
          `moved ${escapeName(pin.name)} from ${escapeName(pin.from)} to ${escapeName(pin.to)}`,
        );
      }
    }

    deps.log('');
    deps.log(`Converted into a workspace with ${names.kebab} on port ${basePort}.`);
    // Printed only after the conversion succeeded: a "move it by hand" note
    // beside a conversion that was refused or rolled back would describe work
    // the developer never has to do.
    for (const note of plan.notes ?? []) deps.log(note);
    if (rewritten === undefined) {
      deps.log('');
      deps.log(`Its entry does not carry the start line this rewrites, so bind the allocated`);
      deps.log(`port yourself — two lines in ${joinPath(memberRoot, 'main.ts')}:`);
      deps.log(`  import { ${SERVICE_PORT_EXPORT} } from '${DISCOVERY_SPECIFIER}';`);
      deps.log(`  await app.start({ port: ${SERVICE_PORT_EXPORT} });`);
    }
    deps.log('');
    deps.log('Next:');
    deps.log(
      `  ${cliInvocation(profile.runtime)} generate ${APP_VERB} <name>   # add a second service`,
    );
    // From the profile, which is the project's own detected toolchain: a converted
    // Node project has no `deno task`.
    deps.log(`  ${profile.runScript('dev')}   # run every member`);
    return EXIT_OK;
  };
  try {
    return await withFileTransaction(deps.fs, perform, deps.interrupt);
  } catch (cause) {
    const interrupted = interruptionMessage(cause);
    if (interrupted !== undefined) {
      deps.error(interrupted);
      return EXIT_INTERRUPTED;
    }
    // The transaction has already undone every move and write by the time this
    // runs: a throw is what asked it to. Reporting "part-way" here would describe
    // a tree that no longer exists.
    if (cause instanceof AdoptAbortedError) {
      for (const message of cause.messages) deps.error(message);
      deps.error('Nothing was changed: every move was undone.');
      return EXIT_ERROR;
    }
    deps.error(
      `Failed to adopt: ${escapeName(cause instanceof Error ? cause.message : String(cause))}`,
    );
    return EXIT_ERROR;
  }
}
