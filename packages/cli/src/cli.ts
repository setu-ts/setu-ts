/**
 * CLI dispatcher — routes commands to their handlers and handles --help/--version.
 *
 * @module
 */

import { EXIT_OK, EXIT_USAGE, PROGRAM_NAME } from './constants.ts';
import { runNewCommand } from './commands/new.ts';
import { runGenerateCommand } from './commands/generate.ts';
import { parseArgs } from './args.ts';

/**
 * Dependencies injected into runCli for testing.
 */
export interface CliDependencies {
  readVersion: () => Promise<string>;
  parseArgs: typeof parseArgs;
  runNewCommand?: typeof runNewCommand;
  runGenerateCommand?: typeof runGenerateCommand;
}

/**
 * Handles CLI commands and dispatches to appropriate handlers.
 *
 * @param argv - Command-line arguments (typically Deno.args)
 * @param deps - Optional dependencies (for testing)
 * @returns Exit code (0 for success, 1 for runtime error, 2 for usage error)
 */
export async function runCli(
  argv: readonly string[],
  deps: CliDependencies = {
    readVersion: () => Promise.resolve('0.1.0-alpha.1'),
    parseArgs,
  },
): Promise<number> {
  const args = deps.parseArgs(argv);

  // Check for version/help flags BEFORE checking for empty positionals
  if (args.flags['v'] || args.flags['version']) {
    const version = await deps.readVersion();
    console.log(`${PROGRAM_NAME} ${version}`);
    return EXIT_OK;
  }

  if (args.flags['h'] || args.flags['help'] || args.positionals.length === 0) {
    printHelp();
    return EXIT_OK;
  }

  const command = args.positionals[0];

  switch (command) {
    case 'new':
    case 'n': {
      const opt: {
        dryRun: boolean;
        dir?: string;
        runtime?: 'deno' | 'node' | 'bun' | 'cloudflare-workers';
      } = {
        dryRun: !!args.flags['dry-run'] || !!args.flags['d'],
      };
      if (typeof args.flags['dir'] === 'string') opt.dir = args.flags['dir'];
      const runtimeFlag = args.flags['runtime'] as string | undefined;
      if (runtimeFlag) {
        opt.runtime = runtimeFlag as 'deno' | 'node' | 'bun' | 'cloudflare-workers';
      }
      const runNew = deps.runNewCommand ?? runNewCommand;
      return runNew(args.positionals.slice(1), opt);
    }

    case 'generate':
    case 'g': {
      const opt: { dryRun: boolean; dir?: string } = {
        dryRun: !!args.flags['dry-run'] || !!args.flags['d'],
      };
      if (typeof args.flags['dir'] === 'string') opt.dir = args.flags['dir'];
      const runGenerate = deps.runGenerateCommand ?? runGenerateCommand;
      return await runGenerate(args.positionals.slice(1), opt);
    }

    default:
      console.error(`Unknown command: ${command}`);
      printHelp();
      return EXIT_USAGE;
  }
}

/**
 * Prints the CLI help message.
 */
function printHelp(): void {
  console.log(`Usage: ${PROGRAM_NAME} [command] [options]`);
  console.log('');
  console.log('Commands:');
  console.log('  new, n      Create a new Hono Enterprise project');
  console.log('  generate, g <schematic> <name> Generate code using a schematic');
  console.log('');
  console.log('Options:');
  console.log('  -h, --help      Print this help message');
  console.log('  -v, --version   Print the version');
  console.log('');
  console.log('Schematics (for generate):');
  console.log('  plugin, controller, service, route, middleware,');
  console.log('  guard (gated on auth-plugin), health-indicator (gated on health-plugin),');
  console.log('  metric (gated on metrics-plugin), command-handler (gated on cqrs-plugin),');
  console.log('  query-handler (gated on cqrs-plugin), event-handler (gated on events-plugin),');
  console.log('  job, migration (gated on database-plugin), custom');
}
