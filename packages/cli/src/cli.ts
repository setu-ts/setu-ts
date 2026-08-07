/**
 * The `setu` dispatcher: argument parsing, command routing, and exit codes.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';
import { parseArgs } from './args.ts';
import {
  CONFIG_MODULE,
  EXIT_OK,
  EXIT_USAGE,
  PROGRAM_NAME,
  TARGET_RUNTIMES,
  VERSION,
} from './constants.ts';
import { runGenerateCommand } from './commands/generate.ts';
import { runNewCommand } from './commands/new.ts';
import { listSchematics } from './schematics/registry.ts';
import type { ModuleLoader } from './schematics/custom.ts';
import type { AppLoader } from './app-loader.ts';
import {
  dispatchPluginCommand,
  type PluginCommandDependencies,
  runCommandsListing,
} from './commands/plugin-commands.ts';

/**
 * Everything the CLI reaches the outside world through.
 *
 * There is deliberately no default: the process-level values (`Deno.cwd()`,
 * `console.log`, the Deno filesystem) belong to `src/main.ts`, the one module
 * that owns the process boundary. A defaulted `fs` here would let a
 * misconfigured call silently degrade to "no filesystem" at runtime.
 */
export interface CliDependencies {
  /** The filesystem all reads and writes go through. */
  readonly fs: IFileSystem;
  /** The working directory commands resolve relative paths against (absolute). */
  readonly cwd: string;
  /** Wall-clock milliseconds, for timestamped output. */
  readonly now: () => number;
  /** Writes a line of normal output. */
  readonly log: (message: string) => void;
  /** Writes a line of error output. */
  readonly error: (message: string) => void;
  /** Loads a custom schematic module; defaults to a real dynamic `import()`. */
  readonly load?: ModuleLoader;
  /**
   * Loads the target project's `setu.config.ts`; defaults to a real dynamic
   * `import()`. Only the plugin-command paths use it.
   */
  readonly loadApp?: AppLoader;
}

/**
 * Prints the top-level usage text.
 *
 * The schematic list comes from the registry, so it can never drift from the
 * schematics that actually exist.
 *
 * @param log - Output sink
 */
function printHelp(log: (message: string) => void): void {
  log(`${PROGRAM_NAME} — Setu-TS project scaffolding and code generation`);
  log('');
  log(`Usage: ${PROGRAM_NAME} <command> [options]`);
  log('');
  log('Commands:');
  log(`  new, n <project-name>          Scaffold a new project`);
  log(`  generate, g <schematic> <name> Generate code from a schematic`);
  log(`  commands                       List commands this app's plugins provide`);
  log('');
  log('Options:');
  log('  -h, --help          Show this help');
  log('  -v, --version       Show the version');
  log('  --dry-run           Print what would be created, write nothing');
  log('  --dir <path>        Operate on this directory instead of the CWD');
  log(`  --config <path>     Load the app from this module instead of ./${CONFIG_MODULE}`);
  log(`  --runtime <target>  ${TARGET_RUNTIMES.join(' | ')} (new; default deno)`);
  log('');
  log('Schematics:');
  log(`  ${listSchematics().map((s) => s.name).join(', ')}, custom`);
  log('');
  log(`Run \`${PROGRAM_NAME} generate --help\` inside a project to see which are available.`);
  log(
    `Any other command is looked up among the plugin commands your ${CONFIG_MODULE} registers ` +
      `(\`${PROGRAM_NAME} commands\` lists them).`,
  );
}

/**
 * Parses `argv`, runs the requested command, and returns its exit code.
 *
 * Never terminates the process — `src/main.ts` owns the single `Deno.exit`, so
 * every path here is testable.
 *
 * @param argv - The raw arguments (e.g. `Deno.args`)
 * @param deps - Filesystem, working directory, clock, and output sinks
 * @returns `0` on success, `1` on a runtime error, `2` on a usage error
 */
export async function runCli(
  argv: readonly string[],
  deps: CliDependencies,
): Promise<number> {
  const args = parseArgs(argv);
  const command = args.positionals[0];

  if (args.flags['version'] === true || args.flags['v'] === true) {
    deps.log(`${PROGRAM_NAME} ${VERSION}`);
    return EXIT_OK;
  }

  if (command === undefined) {
    printHelp(deps.log);
    // A bare `setu` with no command is a usage error; `setu --help` is not.
    return args.flags['help'] === true || args.flags['h'] === true ? EXIT_OK : EXIT_USAGE;
  }

  const rest = {
    positionals: args.positionals.slice(1),
    flags: args.flags,
  };

  switch (command) {
    case 'new':
    case 'n':
      return await runNewCommand(rest, {
        fs: deps.fs,
        cwd: deps.cwd,
        log: deps.log,
        error: deps.error,
      });

    case 'generate':
    case 'g':
      return await runGenerateCommand(rest, {
        fs: deps.fs,
        cwd: deps.cwd,
        now: deps.now,
        log: deps.log,
        error: deps.error,
        ...(deps.load === undefined ? {} : { load: deps.load }),
      });

    case 'commands':
      return await runCommandsListing(rest, pluginCommandDeps(deps));

    case 'help':
      printHelp(deps.log);
      return EXIT_OK;

    default:
      // Not a built-in: the only remaining possibility is a command one of the
      // application's plugins registered. Built-ins are matched first and
      // always win, so a plugin can never shadow `new` or `generate`, and the
      // common path never boots the user's application.
      return await dispatchPluginCommand(command, rest, pluginCommandDeps(deps));
  }
}

/**
 * Narrows the CLI dependency bundle to what the plugin-command paths need.
 *
 * @param deps - The full dependency bundle
 * @returns The subset those paths consume
 */
function pluginCommandDeps(deps: CliDependencies): PluginCommandDependencies {
  return {
    fs: deps.fs,
    cwd: deps.cwd,
    log: deps.log,
    error: deps.error,
    ...(deps.loadApp === undefined ? {} : { loadApp: deps.loadApp }),
  };
}
