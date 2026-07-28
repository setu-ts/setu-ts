/**
 * Discovery and dispatch of plugin-contributed CLI commands.
 *
 * Plugins publish commands through the committed `ICliApi`; the kernel stores
 * each as `{ name, handler }` under `CAPABILITIES.CLI_COMMAND` with
 * `{ multi: true }`. Reading them means booting the user's application, so
 * every path here loads the config module, starts WITHOUT a port, and tears
 * down in a `finally`.
 *
 * @module
 */

import type { CliCommandHandler, IFileSystem } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import {
  CONFIG_EXPORT,
  CONFIG_MODULE,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  PROGRAM_NAME,
} from '../constants.ts';
import { resolveDir } from '../utils/file-writer.ts';
import { type AppLoader, configModuleExists, configModulePath, loadApp } from '../app-loader.ts';

/**
 * The registration shape the kernel stores under `CAPABILITIES.CLI_COMMAND`.
 *
 * Re-declared structurally at the consumption site, matching the
 * decorator-plugin precedent — `common` exports no shared registration type.
 */
interface RegisteredCommand {
  /** The command name, by convention `plugin:command`. */
  readonly name: string;
  /** The implementation. */
  readonly handler: CliCommandHandler;
}

/**
 * Everything the plugin-command paths reach the outside world through.
 */
export interface PluginCommandDependencies {
  /** The filesystem used to test for the config module. */
  readonly fs: IFileSystem;
  /** The CLI's working directory (absolute). */
  readonly cwd: string;
  /** Writes a line of normal output. */
  readonly log: (message: string) => void;
  /** Writes a line of error output. */
  readonly error: (message: string) => void;
  /** Loads the config module; defaults to a real dynamic `import()`. */
  readonly loadApp?: AppLoader;
}

/**
 * Boots the project's application, hands its commands to `use`, and always
 * tears down.
 *
 * `start()` is called with NO port: the kernel skips `listen` when none is
 * given, so discovery binds no socket. It does still run every plugin's init
 * and bootstrap hooks — a database plugin WILL connect — which is why the
 * teardown is unconditional.
 *
 * @param deps - Filesystem, working directory, and the loader seam
 * @param dir - The project root (absolute)
 * @param config - The `--config` override, when supplied
 * @param use - Receives the discovered commands
 * @returns Whatever `use` returns
 */
async function withPluginCommands(
  deps: PluginCommandDependencies,
  dir: string,
  config: string | undefined,
  use: (commands: readonly RegisteredCommand[]) => Promise<number> | number,
): Promise<number> {
  const app = await loadApp(dir, config, deps.loadApp);
  try {
    await app.start();
    const commands = app.services.getAll<RegisteredCommand>(CAPABILITIES.CLI_COMMAND);

    // Detected here rather than in each caller: both refuse identically, and
    // neither should have to remember to.
    const duplicates = duplicateCounts(commands);
    if (duplicates.size > 0) {
      reportDuplicates(duplicates, deps.error);
      return EXIT_ERROR;
    }

    return await use(commands);
  } finally {
    // Teardown is attempted on every path: stop() no-ops when start() never
    // completed, and is idempotent. Without it, a bootstrap hook's timer or
    // pool keeps the process alive after the command finishes.
    //
    // A FAILING teardown is reported but must NOT change the outcome: masking
    // a successful `db:migrate` as exit 1 would invite the user to re-run a
    // non-idempotent command. When the body already threw, that error wins and
    // this one is reported alongside it.
    try {
      await app.stop();
    } catch (cause) {
      deps.error(
        `Warning: the application did not shut down cleanly: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      );
    }
  }
}

/**
 * Counts how many times each command name was registered, keeping only the
 * names registered more than once.
 *
 * @param commands - The discovered commands
 * @returns Duplicated name → registration count
 */
function duplicateCounts(commands: readonly RegisteredCommand[]): ReadonlyMap<string, number> {
  const counts = new Map<string, number>();
  for (const command of commands) {
    counts.set(command.name, (counts.get(command.name) ?? 0) + 1);
  }
  for (const [name, count] of counts) {
    if (count < 2) counts.delete(name);
  }
  return counts;
}

/**
 * Reports a duplicate registration and refuses to run anything.
 *
 * The kernel registers CLI commands with `{ multi: true }`, so it accepts
 * duplicates silently and `getAll` returns both. Running the first would make
 * the winner depend on dependency-resolution order — unpredictable, so this is
 * a refusal rather than a race.
 *
 * @param duplicates - Duplicated name → registration count
 * @param error - Error sink
 */
function reportDuplicates(
  duplicates: ReadonlyMap<string, number>,
  error: (message: string) => void,
): void {
  for (const [name, count] of duplicates) {
    error(`Command "${name}" is registered ${count} times by different plugins.`);
  }
  error('Refusing to run: which registration wins would depend on plugin load order.');
}

/**
 * Explains that the project has no config module, and how to get one.
 *
 * @param dir - The project root
 * @param config - The `--config` override, when supplied
 * @param error - Error sink
 */
function reportMissingConfig(
  dir: string,
  config: string | undefined,
  error: (message: string) => void,
): void {
  error(`No ${CONFIG_MODULE} found at ${configModulePath(dir, config)}.`);
  error(
    `Plugin commands are read from your application, which \`${PROGRAM_NAME}\` loads through a ` +
      `${CONFIG_MODULE} exporting \`${CONFIG_EXPORT}()\`. Scaffold one with \`${PROGRAM_NAME} new\`, ` +
      `or point at an existing module with --config <path>.`,
  );
}

/**
 * Runs `honoe commands` — boots the project and lists what its plugins provide.
 *
 * @param args - Arguments after the `commands` verb, already parsed
 * @param deps - Filesystem, working directory, and output sinks
 * @returns `0` on success (including an empty list), `1` on a boot failure or
 * a duplicate registration, `2` when no config module exists
 */
export async function runCommandsListing(
  args: ParsedArgs,
  deps: PluginCommandDependencies,
): Promise<number> {
  const dir = resolveDir(deps.cwd, stringFlag(args.flags, 'dir'));
  const config = stringFlag(args.flags, 'config');

  if (!await configModuleExists(deps.fs, dir, config)) {
    reportMissingConfig(dir, config, deps.error);
    return EXIT_USAGE;
  }

  try {
    return await withPluginCommands(deps, dir, config, (commands) => {
      if (commands.length === 0) {
        deps.log('No plugin commands are registered by this application.');
        deps.log(
          `Plugins publish them with \`ctx.cli.register('plugin:command', handler)\`.`,
        );
        return EXIT_OK;
      }

      deps.log(`Commands provided by this application's plugins:`);
      for (const command of [...commands].sort((a, b) => a.name.localeCompare(b.name))) {
        deps.log(`  ${PROGRAM_NAME} ${command.name}`);
      }
      return EXIT_OK;
    });
  } catch (cause) {
    deps.error(cause instanceof Error ? cause.message : String(cause));
    return EXIT_ERROR;
  }
}

/**
 * Dispatches a first positional that matched no built-in verb.
 *
 * Built-ins are matched by the caller BEFORE this runs, so a plugin can never
 * shadow `new` or `generate`, and the common path never boots the application.
 *
 * @param name - The command name the user typed
 * @param args - Arguments after the command name, already parsed
 * @param deps - Filesystem, working directory, and output sinks
 * @returns `0` when the handler returns, `1` when it throws or the app fails to
 * boot, `2` when no config module exists or no such command is registered
 */
export async function dispatchPluginCommand(
  name: string,
  args: ParsedArgs,
  deps: PluginCommandDependencies,
): Promise<number> {
  const dir = resolveDir(deps.cwd, stringFlag(args.flags, 'dir'));
  const config = stringFlag(args.flags, 'config');

  if (!await configModuleExists(deps.fs, dir, config)) {
    deps.error(`Unknown command: ${name}`);
    reportMissingConfig(dir, config, deps.error);
    return EXIT_USAGE;
  }

  try {
    return await withPluginCommands(deps, dir, config, async (commands) => {
      const match = commands.find((command) => command.name === name);
      if (match === undefined) {
        deps.error(`Unknown command: ${name}`);
        if (commands.length === 0) {
          deps.error('This application registers no plugin commands.');
        } else {
          deps.error('Available plugin commands:');
          for (const command of commands) deps.error(`  ${command.name}`);
        }
        return EXIT_USAGE;
      }

      await match.handler(args.positionals);
      return EXIT_OK;
    });
  } catch (cause) {
    deps.error(cause instanceof Error ? cause.message : String(cause));
    return EXIT_ERROR;
  }
}
