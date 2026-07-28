/**
 * The `honoe` dispatcher: argument parsing, command routing, and exit codes.
 *
 * @module
 */

import type { IFileSystem } from '@hono-enterprise/common';
import { parseArgs } from './args.ts';
import { EXIT_OK, EXIT_USAGE, PROGRAM_NAME, TARGET_RUNTIMES, VERSION } from './constants.ts';
import { runGenerateCommand } from './commands/generate.ts';
import { runNewCommand } from './commands/new.ts';
import { listSchematics } from './schematics/registry.ts';
import type { ModuleLoader } from './schematics/custom.ts';

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
  log(`${PROGRAM_NAME} — Hono Enterprise project scaffolding and code generation`);
  log('');
  log(`Usage: ${PROGRAM_NAME} <command> [options]`);
  log('');
  log('Commands:');
  log(`  new, n <project-name>          Scaffold a new project`);
  log(`  generate, g <schematic> <name> Generate code from a schematic`);
  log('');
  log('Options:');
  log('  -h, --help          Show this help');
  log('  -v, --version       Show the version');
  log('  --dry-run           Print what would be created, write nothing');
  log('  --dir <path>        Operate on this directory instead of the CWD');
  log(`  --runtime <target>  ${TARGET_RUNTIMES.join(' | ')} (new; default deno)`);
  log('');
  log('Schematics:');
  log(`  ${listSchematics().map((s) => s.name).join(', ')}, custom`);
  log('');
  log(`Run \`${PROGRAM_NAME} generate --help\` inside a project to see which are available.`);
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
    // A bare `honoe` with no command is a usage error; `honoe --help` is not.
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

    case 'help':
      printHelp(deps.log);
      return EXIT_OK;

    default:
      deps.error(`Unknown command: ${command}`);
      printHelp(deps.log);
      return EXIT_USAGE;
  }
}
