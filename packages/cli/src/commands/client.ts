/** Generates a typed client or checks its drift without writing. @module */
import { isAbsolute } from 'node:path';
import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import { EXIT_ERROR, EXIT_INTERRUPTED, EXIT_OK, EXIT_USAGE } from '../constants.ts';
import { readClientDocument, type IClientDocumentDependencies } from '../client/document-source.ts';
import { CLIENT_MARKER, generateClientFile, type ClientPackageLoader } from '../client/generate.ts';
import { detectProject } from '../utils/project-detector.ts';
import { detectTargetRuntime } from '../utils/runtime-detector.ts';
import {
  assertInsideProject,
  readExistingText,
  reportDryRunPlan,
  resolveDir,
  withFileTransaction,
  writeFiles,
} from '../utils/file-writer.ts';
import { interruptionMessage, throwIfInterrupted } from '../utils/interruption.ts';
import { escapeName } from '../utils/names.ts';

/** External effects and the installed-package loading seam. */
export interface IClientCommandDependencies extends IClientDocumentDependencies {
  readonly importFromProject?: ClientPackageLoader;
}

/**
 * Runs setu client with the same generation path for writes and read-only checks.
 * @param args - Parsed arguments after the verb
 * @param deps - Filesystem, project loaders and output sinks
 * @returns 0 for success, 1 for drift or failure, 2 for usage, 130 for interruption
 */
export async function runClientCommand(
  args: ParsedArgs,
  deps: IClientCommandDependencies,
): Promise<number> {
  if (args.flags.help === true || args.flags.h === true) {
    deps.log(
      'Usage: setu client [--output <path>] [--input <file|url>] [--factory <name>] [--type-name <name>] [--dir <path>] [--config <path>] [--dry-run] [--check]',
    );
    deps.log('  --output <path>    Write inside the project (default src/clientsdk/api.ts)');
    deps.log('  --input <file|url> Read JSON instead of booting the app');
    deps.log('  --factory <name>   Factory name (default createApi)');
    deps.log('  --type-name <name> Client interface name (default Api)');
    deps.log('  --dir <path>       Target project instead of the CWD');
    deps.log('  --config <path>    Application module instead of setu.config.ts');
    deps.log('  --dry-run          Print the write plan, write nothing');
    deps.log('  --check            Check drift, write nothing');
    return EXIT_OK;
  }
  for (const name of ['output', 'input', 'factory', 'type-name', 'dir', 'config']) {
    if (
      args.flags[name] !== undefined &&
      (typeof args.flags[name] !== 'string' || args.flags[name] === '')
    ) {
      deps.error(`Option --${name} requires a value.`);
      return EXIT_USAGE;
    }
  }
  if (args.flags['dry-run'] === true && args.flags.check === true) {
    deps.error('--dry-run and --check cannot be used together.');
    return EXIT_USAGE;
  }
  for (const name of ['factory', 'type-name']) {
    const value = stringFlag(args.flags, name);
    if (value !== undefined && !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(value)) {
      deps.error(`Option --${name} must be a TypeScript identifier.`);
      return EXIT_USAGE;
    }
  }
  const input = stringFlag(args.flags, 'input');
  const config = stringFlag(args.flags, 'config');
  if (input !== undefined && config !== undefined) {
    deps.error('--config cannot be used with --input.');
    return EXIT_USAGE;
  }
  if (
    input !== undefined &&
    /^[A-Za-z][A-Za-z0-9+.-]*:/.test(input) &&
    !/^https?:\/\//.test(input)
  ) {
    deps.error('--input accepts HTTP(S) URLs or JSON files; other URL schemes are not supported.');
    return EXIT_USAGE;
  }
  const dir = resolveDir(deps.cwd, stringFlag(args.flags, 'dir'));
  const output = stringFlag(args.flags, 'output') ?? 'src/clientsdk/api.ts';
  if (isAbsolute(output) || /^[A-Za-z]:/.test(output) || !output.endsWith('.ts')) {
    deps.error('--output must be a relative .ts path inside the project.');
    return EXIT_USAGE;
  }
  const path = resolveDir(dir, output);
  try {
    await assertInsideProject(deps.fs, dir, path);
  } catch (cause) {
    deps.error(cause instanceof Error ? cause.message : String(cause));
    return EXIT_USAGE;
  }
  try {
    throwIfInterrupted(deps.interrupt);
    const project = await detectProject(deps.fs, dir);
    if (project.kind === 'none') {
      deps.error(
        `${escapeName(dir)} holds no deno.json, deno.jsonc or package.json — run this inside a project, or pass --dir.`,
      );
      return EXIT_ERROR;
    }
    if (project.kind === 'unreadable') {
      deps.error(`Cannot read ${escapeName(project.path)}: ${escapeName(project.reason)}`);
      return EXIT_ERROR;
    }
    if (project.kind === 'workspace-root') {
      deps.error('Run `setu client` in a member, or pass `--dir <member>`.');
      return EXIT_ERROR;
    }
    if (args.flags.check !== true) {
      const existing = await readExistingText(deps.fs, path);
      if (existing !== undefined && existing.split(/\r\n?|\n/)[0] !== CLIENT_MARKER) {
        deps.error(
          `${escapeName(output)} was not written by \`setu client\`; move it or choose another \`--output\`.`,
        );
        return EXIT_ERROR;
      }
    }
    const document = await readClientDocument(deps, dir, config, input);
    const factoryName = stringFlag(args.flags, 'factory');
    const apiTypeName = stringFlag(args.flags, 'type-name');
    const file = await generateClientFile(
      document,
      {
        ...(factoryName === undefined ? {} : { factoryName }),
        ...(apiTypeName === undefined ? {} : { apiTypeName }),
      },
      await detectTargetRuntime(deps.fs, dir),
      dir,
      path,
      deps.error,
      deps.importFromProject,
    );
    throwIfInterrupted(deps.interrupt);
    if (args.flags.check === true) {
      const existing = await readExistingText(deps.fs, path);
      if (existing === undefined) {
        deps.error(`${escapeName(output)} does not exist; run \`setu client\`.`);
        return EXIT_ERROR;
      }
      if (existing !== file.contents) {
        // Retain terminators so an EOL-only change still differs on its own line.
        const before = existing.split(/(?<=\n)|(?<=\r)(?!\n)/);
        const after = file.contents.split(/(?<=\n)|(?<=\r)(?!\n)/);
        let line = 0;
        while (before[line] === after[line]) line++;
        deps.error(
          `${escapeName(output)} is out of date; run \`setu client\` (first differing line ${line + 1}).`,
        );
        return EXIT_ERROR;
      }
      deps.log(`${escapeName(output)} is up to date`);
      return EXIT_OK;
    }
    if (args.flags['dry-run'] === true) return reportDryRunPlan(deps, [file]);
    const outcomes = await withFileTransaction(
      deps.fs,
      (fs) =>
        writeFiles(fs, [file], {
          root: dir,
          ...(deps.interrupt === undefined ? {} : { signal: deps.interrupt }),
        }),
      deps.interrupt,
    );
    for (const outcome of outcomes) deps.log(`${outcome.outcome} ${escapeName(outcome.path)}`);
    return EXIT_OK;
  } catch (cause) {
    const interrupted = interruptionMessage(cause);
    deps.error(interrupted ?? (cause instanceof Error ? cause.message : String(cause)));
    return interrupted === undefined ? EXIT_ERROR : EXIT_INTERRUPTED;
  }
}
