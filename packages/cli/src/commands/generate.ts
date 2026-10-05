/**
 * The `setu generate` command — plugin-aware code generation.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';
import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import {
  APP_VERB,
  EXIT_ERROR,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_USAGE,
  isTargetRuntime,
  LIBRARY_VERB,
  PROGRAM_NAME,
  TARGET_RUNTIMES,
  type TargetRuntime,
} from '../constants.ts';
import { runAppCommand } from './app.ts';
import type { PortProbe } from '../workspace/port-probe.ts';
import { runLibraryCommand } from './library.ts';
import {
  deriveNames,
  escapeName,
  IDENTIFIER_NAME_RULE,
  isIdentifierSafe,
  overlongComponent,
} from '../utils/names.ts';
import { detectPlugins } from '../utils/plugin-detector.ts';
import { detectTargetRuntime, RuntimeMarkerUnreadableError } from '../utils/runtime-detector.ts';
import { detectProject } from '../utils/project-detector.ts';
import {
  findExisting,
  type GeneratedFile,
  joinPath,
  resolveDir,
  writeFiles,
} from '../utils/file-writer.ts';
import {
  CUSTOM_SCHEMATIC,
  getSchematic,
  listSchematics,
  type Schematic,
  type SchematicOptions,
} from '../schematics/registry.ts';
import { loadCustomSchematic, type ModuleLoader } from '../schematics/custom.ts';
import { scanModules } from '../utils/module-scanner.ts';
import { scanArtifacts } from '../utils/artifact-scanner.ts';
import { findNameConflict } from '../utils/name-conflicts.ts';
import { scanSeamSpecs } from '../seams/registry.ts';
import { readMigrationNames } from '../utils/migration-scanner.ts';
import {
  legacyLayoutNotice,
  legacyRegistrarNotice,
  readConfigModule,
  readLegacyHttpFiles,
} from '../utils/legacy-layout.ts';
import { interruptionMessage } from '../utils/interruption.ts';

/**
 * Everything `runGenerateCommand` reaches the outside world through.
 */
export interface GenerateDependencies {
  /** The filesystem to detect plugins on and write generated files through. */
  readonly fs: IFileSystem;
  /** The project directory to operate on (absolute). */
  readonly cwd: string;
  /** Wall-clock milliseconds, for timestamped output. */
  readonly now: () => number;
  /** Writes a line of normal output. */
  readonly log: (message: string) => void;
  /** Writes a line of error output. */
  readonly error: (message: string) => void;
  /** Loads a custom schematic module; defaults to a real dynamic `import()`. */
  readonly load?: ModuleLoader;
  /** Checks whether a workspace port can bind before an app is assigned one. */
  readonly portAvailable?: PortProbe;
  /** Cooperative interruption signal checked at write boundaries. */
  readonly interrupt?: AbortSignal;
}

/**
 * Prints the schematics available in the target project.
 *
 * Gated schematics whose plugin is absent are listed as unavailable, naming the
 * package to install.
 *
 * @param installed - The `@setu-ts` packages detected in the project
 * @param log - Output sink
 */
function printSchematics(installed: ReadonlySet<string>, log: (message: string) => void): void {
  log(`Usage: ${PROGRAM_NAME} generate <schematic> <name> [options]`);
  log('');
  log('Schematics:');
  for (const { name, requiresPlugin } of listSchematics()) {
    if (requiresPlugin === undefined) {
      log(`  ${name}`);
    } else if (installed.has(requiresPlugin)) {
      log(`  ${name}`);
    } else {
      log(
        `  ${name}  (unavailable — run \`${PROGRAM_NAME} add ` +
          `${requiresPlugin.replace(/-plugin$/, '')}\`)`,
      );
    }
  }
  log(`  ${CUSTOM_SCHEMATIC} <schematic-name>  (from .setu-ts/schematics/)`);
  log(`  ${APP_VERB} <name>  (adds a service to a workspace)`);
  log(`  ${LIBRARY_VERB} <name>  (adds shared code to a workspace)`);
  log('');
  log('Options:');
  log('  --dry-run          Print what would be created, write nothing');
  log('  --dir <path>       Generate into this directory instead of the CWD');
  log(
    `  --runtime <target>  ${TARGET_RUNTIMES.join(' | ')} (detected from the project by default)`,
  );
}

/**
 * Runs `setu generate`.
 *
 * Resolves the schematic (built-in or custom), refuses a gated schematic whose
 * plugin is not installed, checks every planned path for an existing file
 * BEFORE the first write, and writes nothing at all under `--dry-run`.
 *
 * @param args - Arguments after the `generate` verb, already parsed
 * @param deps - Filesystem, clock, and output sinks
 * @returns `0` on success — including the bare `generate` listing, which is
 *   informational rather than an error — `1` on a runtime error, `2` on a usage
 *   error
 */
export async function runGenerateCommand(
  args: ParsedArgs,
  deps: GenerateDependencies,
): Promise<number> {
  const dir = resolveDir(deps.cwd, stringFlag(args.flags, 'dir'));

  // Dispatched FIRST, before `--help` and before the plugin scan: `app` adds a
  // workspace member rather than generating a file into a project, so it has its
  // own usage text, and the detected plugin set of a workspace ROOT (which
  // installs nothing) would say nothing about the member being created.
  if (args.positionals[0] === APP_VERB) {
    return await runAppCommand(args, {
      fs: deps.fs,
      dir,
      log: deps.log,
      error: deps.error,
      ...(deps.portAvailable === undefined ? {} : { portAvailable: deps.portAvailable }),
      ...(deps.interrupt === undefined ? {} : { interrupt: deps.interrupt }),
    });
  }

  // Dispatched beside `app`, and for the same reasons: it is not a schematic, and
  // the detected plugin set of a workspace ROOT — which installs nothing — would
  // say nothing about a library that depends on no plugin at all.
  if (args.positionals[0] === LIBRARY_VERB) {
    return await runLibraryCommand(args, {
      fs: deps.fs,
      dir,
      log: deps.log,
      error: deps.error,
      ...(deps.interrupt === undefined ? {} : { interrupt: deps.interrupt }),
    });
  }

  // `--help` is never an error, with or without a schematic named.
  if (args.flags['help'] === true || args.flags['h'] === true) {
    const installed = await detectPlugins(deps.fs, dir);
    printSchematics(installed, deps.log);
    return EXIT_OK;
  }

  // Validated ABOVE the bare-arm listing so the informational listing cannot
  // silently swallow an invalid `--runtime` (exiting 0 over a typo read as
  // success). Rejected rather than defaulted: a custom schematic branches on
  // `options.runtime`, so silently swallowing a typo would change the
  // generated output with no diagnostic. `new` rejects it the same way.
  const runtimeValue = args.flags['runtime'];
  if (runtimeValue !== undefined && typeof runtimeValue !== 'string') {
    deps.error(
      `Option --runtime requires a value. Expected one of: ${TARGET_RUNTIMES.join(', ')}.`,
    );
    return EXIT_USAGE;
  }
  if (typeof runtimeValue === 'string' && !isTargetRuntime(runtimeValue)) {
    deps.error(
      `Unknown runtime "${escapeName(runtimeValue)}". Expected one of: ${
        TARGET_RUNTIMES.join(', ')
      }.`,
    );
    return EXIT_USAGE;
  }
  const runtimeFlag = runtimeValue;

  const schematicName = args.positionals[0];
  if (schematicName === undefined) {
    // Informational, exactly like the `--help` branch above: the listing is
    // ordinary output (identical text, same log sink), so an error exit
    // contradicted the guidance it carried. Everything that genuinely fails —
    // an invalid `--runtime` (refused above), a missing name, an unknown
    // schematic, over-arity — still exits 2.
    printSchematics(await detectPlugins(deps.fs, dir), deps.log);
    return EXIT_OK;
  }

  let schematic: Schematic | undefined;
  let name: string | undefined;
  let customName: string | undefined;
  let requiredPlugin: string | undefined;

  if (schematicName === CUSTOM_SCHEMATIC) {
    customName = args.positionals[1];
    name = args.positionals[2];
    if (customName === undefined || name === undefined) {
      deps.error(`Usage: ${PROGRAM_NAME} generate custom <schematic-name> <name>`);
      return EXIT_USAGE;
    }
  } else {
    const metadata = getSchematic(schematicName);
    if (metadata === undefined) {
      deps.error(`Unknown schematic: ${escapeName(schematicName)}`);
      printSchematics(await detectPlugins(deps.fs, dir), deps.log);
      return EXIT_USAGE;
    }

    name = args.positionals[1];
    if (name === undefined) {
      deps.error(`Usage: ${PROGRAM_NAME} generate ${escapeName(schematicName)} <name>`);
      return EXIT_USAGE;
    }

    schematic = metadata.factory;
    requiredPlugin = metadata.requiresPlugin;
  }

  const names = deriveNames(name);
  if (!isIdentifierSafe(names)) {
    // Schematics interpolate these forms into declarations, so a name that
    // cannot begin an identifier would emit source that does not parse.
    // Quoting the name back as typed, so through `escapeName`: a control
    // character here would forge a standalone line in the rendered message.
    deps.error(
      `Invalid name "${escapeName(name)}": ${IDENTIFIER_NAME_RULE}`,
    );
    return EXIT_USAGE;
  }

  const project = await detectProject(deps.fs, dir);
  if (project.kind === 'none') {
    deps.error(
      `${
        escapeName(dir)
      } holds no deno.json, deno.jsonc or package.json — run this inside a project, or pass --dir.`,
    );
    return EXIT_ERROR;
  }
  if (project.kind === 'workspace-root') {
    deps.error(
      `${escapeName(dir)} is a workspace root (${
        escapeName(project.marker)
      }); generate inside a member instead.`,
    );
    deps.error(`  Pass --dir apps/<member>.`);
    return EXIT_USAGE;
  }
  if (project.kind === 'unreadable') {
    deps.error(`Cannot read ${escapeName(project.path)}: ${escapeName(project.reason)}`);
    return EXIT_ERROR;
  }

  const installed = await detectPlugins(deps.fs, dir);

  // Resolve project-owned code and plugin gates only after the target has been
  // established as a readable project. Otherwise a missing plugin or custom
  // module can mask the more fundamental wrong-directory refusal.
  if (customName !== undefined) {
    try {
      schematic = await loadCustomSchematic(dir, customName, deps.load);
    } catch (cause) {
      deps.error(escapeName(cause instanceof Error ? cause.message : String(cause)));
      return EXIT_ERROR;
    }
  } else if (requiredPlugin !== undefined && !installed.has(requiredPlugin)) {
    deps.error(
      `The "${schematicName}" schematic requires @setu-ts/${requiredPlugin}, ` +
        `which is not installed in ${escapeName(dir)}.`,
    );
    deps.error(
      `Run \`${PROGRAM_NAME} add ${
        requiredPlugin.replace(/-plugin$/, '')
      }\`, then this command again.`,
    );
    return EXIT_ERROR;
  }

  if (schematic === undefined) {
    deps.error(`Could not resolve schematic: ${escapeName(schematicName)}`);
    return EXIT_ERROR;
  }
  // Detected from the project rather than defaulted, because the project already
  // knows: `setu new svc --runtime bun` records the choice once and nobody
  // repeats it on every `generate`. An explicit flag still wins, so a custom
  // schematic can be driven for another target deliberately.
  let runtime: TargetRuntime;
  try {
    runtime = runtimeFlag ?? await detectTargetRuntime(deps.fs, dir);
  } catch (cause) {
    if (!(cause instanceof RuntimeMarkerUnreadableError)) throw cause;
    deps.error(cause.message);
    return EXIT_ERROR;
  }

  // Read unconditionally, like `detectPlugins` above: the `module` schematic
  // needs it to render its aggregate barrel, and branching on the schematic name
  // here would put a second dispatch beside the registry.
  const moduleScan = await scanModules(deps.fs, dir);
  const modules = moduleScan.names;
  const legacyModules = moduleScan.skipped.map((skip) => skip.name);
  for (const skip of moduleScan.skipped) {
    deps.error(
      `Skipped ${escapeName(skip.path)}: it is missing ${
        escapeName(String(skip.missing))
      }, so it cannot be listed in ` +
        'the MODULES activation barrel used by migrated configs.',
    );
    deps.error(
      `  Add ${
        escapeName(String(skip.missing))
      } with @Module(...) or delete and regenerate the module.`,
    );
  }
  // Same reasoning as `modules`: the migration runner lists every migration in
  // order, and a schematic performs no I/O.
  const migrations = await readMigrationNames(deps.fs, dir);
  // Same reasoning, for the ten families that regenerate a seam barrel. One `readdir`
  // per family against paths that usually do not exist; a custom schematic reads it
  // too, so it cannot be gated on a built-in name.
  const scan = await scanArtifacts(deps.fs, dir, scanSeamSpecs(installed));

  // A candidate the scan rejected is reported, never silently dropped. This is the path
  // an artifact generated before its family gained a second export takes: the barrel
  // cannot name a symbol the file does not export, so the artifact is left out and the
  // developer is told to regenerate it — rather than getting a barrel that will not
  // compile, or one that quietly omits their work.
  for (const skip of scan.skipped) {
    deps.error(
      `Skipped ${escapeName(skip.path)}: it does not export ${
        escapeName(skip.missing.join(', '))
      }, ` +
        `so it cannot be listed in the generated barrel and nothing registers it.`,
    );
    // "Regenerate it" was the advice, and it could not be followed: the artifact
    // is not `managed`, so `setu generate` refuses to overwrite it and the
    // developer is told to run a command that then refuses — the M65 loop, found
    // by review after A2 made `health-indicator` mode-aware. An alpha.8 project
    // generated its indicator as a class; a functional project now expects a
    // value, so the file is dropped and its health check stops running.
    //
    // ADD comes first, and renaming is only offered as an alternative, because
    // M70d made rename a dead end for four of the five families it touched: the
    // missing symbol is now a FACTORY, and renaming a class to a factory's name
    // produces a barrel entry that is a class constructor where the option wants
    // an instance or a function — `TS2322`, so the project stops compiling
    // (probed). Leading with the route that works keeps this from being the M65
    // dead-end advice in a new disguise.
    deps.error(
      `  Add that export to the file — or rename an existing one — ` +
        `or delete the file and run this schematic again.`,
    );
  }

  // X4-4/F2: the barrel just claimed a file the CLI did not write. Reported once —
  // the next scan sees it in the barrel and stays quiet — because the alternative,
  // requiring a provenance marker in the artifact, would un-wire every artifact in
  // every project generated before this release.
  for (const claim of scan.adopted) {
    deps.error(
      `Adopted ${escapeName(claim.path)} into ${
        escapeName(claim.barrel)
      }: it matches this family's naming ` +
        `convention, so it is now registered by the generated barrel.`,
    );
    deps.error(`  Remove any manual registration of it, or rename the file.`);
  }

  // The half that breaks the boot: adopted AND already registered by hand is a
  // duplicate `METHOD path`, which the kernel has refused since M68. The developer's
  // own wiring wins and the barrel steps aside, rather than the command reporting
  // success and leaving the application unable to start.
  for (const wired of scan.manual) {
    deps.error(
      `Skipped ${escapeName(wired.path)}: ${
        escapeName(wired.symbol)
      } is already registered by hand in ` +
        `${
          escapeName(wired.wiredIn)
        }, so listing it in the generated barrel would register it twice.`,
    );
    deps.error(
      `  Remove the manual registration to let the barrel own it, or leave it as it is.`,
    );
  }

  // E8 merged `src/routes/` into `src/controllers/`, and a project that predates the
  // merge is invisible to every other check here: the scan above reads the NEW
  // directory, so a file in the old one is never scanned and never skipped, and
  // `setu.config.ts` still imports the old barrel because it is the developer's file.
  // Without this the generator reports `created` and leaves the artifact unreachable —
  // the M60 defect class, reintroduced for upgrading projects by the fix for it.
  for (const line of legacyLayoutNotice(await readLegacyHttpFiles(deps.fs, dir))) {
    deps.error(line);
  }

  // The registry parameter is optional so a pre-M84 config still COMPILES, which
  // is what keeps existing projects working — but it also means the compiler no
  // longer reports the gap, and a generated SSE controller throws at startup.
  for (const line of legacyRegistrarNotice(await readConfigModule(deps.fs, dir))) {
    deps.error(line);
  }

  // Refused BEFORE the schematic runs, and before `--dry-run` prints: a plan whose
  // output cannot work is not a plan worth printing. Both collisions this catches were
  // observed as real failures against a booted application — see `name-conflicts.ts`.
  const conflict = findNameConflict(
    schematicName,
    names.kebab,
    installed,
    scan.artifacts,
    modules,
  );
  if (conflict !== undefined) {
    deps.error(
      `Cannot generate ${escapeName(schematicName)} "${names.kebab}": ${
        escapeName(conflict.resource)
      } is already ` +
        `claimed by ${escapeName(conflict.claimedBy)}.`,
    );
    deps.error(`If both existed, ${escapeName(conflict.consequence)}.`);
    deps.error(`Choose a different name, or ${escapeName(conflict.remedy)}.`);
    return EXIT_ERROR;
  }

  const options: SchematicOptions = {
    runtime,
    plugins: installed,
    now: deps.now,
    modules,
    legacyModules,
    migrations,
    artifacts: scan.artifacts,
  };

  let generated: readonly GeneratedFile[];
  try {
    generated = schematic(names, options);
  } catch (cause) {
    deps.error(
      `Schematic "${escapeName(schematicName)}" failed: ${
        escapeName(cause instanceof Error ? cause.message : String(cause))
      }`,
    );
    return EXIT_ERROR;
  }

  // Root every path at the target directory before touching the filesystem, so
  // the overwrite check and the write agree on exactly the same paths.
  // Spread the file rather than rebuilding it from two known fields: dropping a
  // member here silently discards whatever the schematic declared about it, and
  // losing `managed` makes the aggregate module barrel refuse on every run after
  // the first.
  const files: readonly GeneratedFile[] = generated.map((file) => ({
    ...file,
    path: joinPath(dir, file.path),
  }));

  if (files.length === 0) {
    deps.error(`Schematic "${escapeName(schematicName)}" produced no files.`);
    return EXIT_ERROR;
  }

  // The name guard bounds the kebab, but a schematic APPENDS to it
  // (`<kebab>.controller.ts`), so a name within the bound can still plan a file
  // name the filesystem refuses — an uncaught `File name too long` from the
  // overwrite probe below. Checked against the schematic's own relative paths,
  // so a long `--dir` is not mistaken for the name, and before `--dry-run`, so
  // the dry run never prints a plan the real run could not carry out.
  const overlong = overlongComponent(generated.map((file) => file.path));
  if (overlong !== undefined) {
    deps.error(
      `Cannot generate "${escapeName(name)}": the file name ${overlong} is over 255 bytes, ` +
        `the limit for one path component. Use a shorter name.`,
    );
    return EXIT_USAGE;
  }

  if (args.flags['dry-run'] === true) {
    for (const file of files) deps.log(`would create ${escapeName(file.path)}`);
    return EXIT_OK;
  }

  const existing = await findExisting(deps.fs, files);
  if (existing.length > 0) {
    deps.error('Refusing to overwrite existing files:');
    for (const path of existing) deps.error(`  ${escapeName(path)}`);
    return EXIT_ERROR;
  }

  try {
    const outcomes = await writeFiles(
      deps.fs,
      files,
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
      `Failed to write: ${escapeName(cause instanceof Error ? cause.message : String(cause))}`,
    );
    return EXIT_ERROR;
  }

  return EXIT_OK;
}
