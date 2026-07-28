/**
 * The `honoe generate` command — plugin-aware code generation.
 *
 * @module
 */

import type { IFileSystem } from '@hono-enterprise/common';
import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import {
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  isTargetRuntime,
  PROGRAM_NAME,
  TARGET_RUNTIMES,
  type TargetRuntime,
} from '../constants.ts';
import { deriveNames, isIdentifierSafe } from '../utils/names.ts';
import { detectPlugins } from '../utils/plugin-detector.ts';
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
}

/**
 * Prints the schematics available in the target project.
 *
 * Gated schematics whose plugin is absent are listed as unavailable, naming the
 * package to install.
 *
 * @param installed - The `@hono-enterprise` packages detected in the project
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
      log(`  ${name}  (unavailable — install @hono-enterprise/${requiresPlugin})`);
    }
  }
  log(`  ${CUSTOM_SCHEMATIC} <schematic-name>  (from .hono-enterprise/schematics/)`);
  log('');
  log('Options:');
  log('  --dry-run          Print what would be created, write nothing');
  log('  --dir <path>       Generate into this directory instead of the CWD');
}

/**
 * Runs `honoe generate`.
 *
 * Resolves the schematic (built-in or custom), refuses a gated schematic whose
 * plugin is not installed, checks every planned path for an existing file
 * BEFORE the first write, and writes nothing at all under `--dry-run`.
 *
 * @param args - Arguments after the `generate` verb, already parsed
 * @param deps - Filesystem, clock, and output sinks
 * @returns `0` on success, `1` on a runtime error, `2` on a usage error
 */
export async function runGenerateCommand(
  args: ParsedArgs,
  deps: GenerateDependencies,
): Promise<number> {
  const dir = resolveDir(deps.cwd, stringFlag(args.flags, 'dir'));
  const installed = await detectPlugins(deps.fs, dir);

  // `--help` is never an error, with or without a schematic named.
  if (args.flags['help'] === true || args.flags['h'] === true) {
    printSchematics(installed, deps.log);
    return EXIT_OK;
  }

  const schematicName = args.positionals[0];
  if (schematicName === undefined) {
    printSchematics(installed, deps.log);
    return EXIT_USAGE;
  }

  const runtimeFlag = stringFlag(args.flags, 'runtime');
  if (runtimeFlag !== undefined && !isTargetRuntime(runtimeFlag)) {
    // Rejected rather than defaulted: a custom schematic branches on
    // `options.runtime`, so silently swallowing a typo would change the
    // generated output with no diagnostic. `new` rejects it the same way.
    deps.error(
      `Unknown runtime "${runtimeFlag}". Expected one of: ${TARGET_RUNTIMES.join(', ')}.`,
    );
    return EXIT_USAGE;
  }
  const runtime: TargetRuntime = runtimeFlag ?? 'deno';

  let schematic: Schematic;
  let name: string | undefined;

  if (schematicName === CUSTOM_SCHEMATIC) {
    const customName = args.positionals[1];
    name = args.positionals[2];
    if (customName === undefined || name === undefined) {
      deps.error(`Usage: ${PROGRAM_NAME} generate custom <schematic-name> <name>`);
      return EXIT_USAGE;
    }
    try {
      schematic = await loadCustomSchematic(dir, customName, deps.load);
    } catch (cause) {
      deps.error(cause instanceof Error ? cause.message : String(cause));
      return EXIT_ERROR;
    }
  } else {
    const metadata = getSchematic(schematicName);
    if (metadata === undefined) {
      deps.error(`Unknown schematic: ${schematicName}`);
      printSchematics(installed, deps.log);
      return EXIT_USAGE;
    }

    name = args.positionals[1];
    if (name === undefined) {
      deps.error(`Usage: ${PROGRAM_NAME} generate ${schematicName} <name>`);
      return EXIT_USAGE;
    }

    if (metadata.requiresPlugin !== undefined && !installed.has(metadata.requiresPlugin)) {
      deps.error(
        `The "${schematicName}" schematic requires @hono-enterprise/${metadata.requiresPlugin}, ` +
          `which is not installed in ${dir}.`,
      );
      deps.error(`Install it, then run this command again.`);
      return EXIT_ERROR;
    }

    schematic = metadata.factory;
  }

  const names = deriveNames(name);
  if (!isIdentifierSafe(names)) {
    // Schematics interpolate these forms into declarations, so a name that
    // cannot begin an identifier would emit source that does not parse.
    deps.error(
      `Invalid name "${name}": it must contain a letter and must not start with a digit.`,
    );
    return EXIT_USAGE;
  }

  const options: SchematicOptions = { runtime, plugins: installed, now: deps.now };

  let generated: readonly GeneratedFile[];
  try {
    generated = schematic(names, options);
  } catch (cause) {
    deps.error(
      `Schematic "${schematicName}" failed: ${
        cause instanceof Error ? cause.message : String(cause)
      }`,
    );
    return EXIT_ERROR;
  }

  // Root every path at the target directory before touching the filesystem, so
  // the overwrite check and the write agree on exactly the same paths.
  const files: readonly GeneratedFile[] = generated.map((file) => ({
    path: joinPath(dir, file.path),
    contents: file.contents,
  }));

  if (files.length === 0) {
    deps.error(`Schematic "${schematicName}" produced no files.`);
    return EXIT_ERROR;
  }

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
  return EXIT_OK;
}
