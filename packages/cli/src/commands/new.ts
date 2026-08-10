/**
 * The `setu new` command — project and workspace scaffolding.
 *
 * The rendering lives in `templates/project-files.ts` and
 * `workspace/root-files.ts`; this module owns flag parsing, the refusals, and
 * the check-everything-then-write-everything pipeline.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';
import type { ParsedArgs } from '../args.ts';
import { stringFlag } from '../args.ts';
import {
  APP_VERB,
  EXIT_ERROR,
  EXIT_OK,
  EXIT_USAGE,
  isTargetRuntime,
  PROGRAM_NAME,
  TARGET_RUNTIMES,
  type TargetRuntime,
  TEMPLATES,
} from '../constants.ts';
import { listTemplates } from '../templates/registry.ts';
import { resolveTemplateChoice } from '../templates/choice.ts';
import { MINIMAL_HOST } from '../templates/minimal.ts';
import { projectFiles, resolveHost } from '../templates/project-files.ts';
import { DEFAULT_BASE_PORT } from '../workspace/manifest.ts';
import { workspaceRootFiles } from '../workspace/root-files.ts';
import { deriveNames } from '../utils/names.ts';
import {
  findExisting,
  firstDuplicatePath,
  type GeneratedFile,
  joinPath,
  resolveDir,
  writeFiles,
} from '../utils/file-writer.ts';

/**
 * Everything `runNewCommand` reaches the outside world through.
 */
export interface NewDependencies {
  /** The filesystem to write the project through. */
  readonly fs: IFileSystem;
  /** The directory new projects are created under (absolute). */
  readonly cwd: string;
  /** Writes a line of normal output. */
  readonly log: (message: string) => void;
  /** Writes a line of error output. */
  readonly error: (message: string) => void;
}

/** The highest port number a `--port` value may name. */
const MAX_PORT = 65535;

/**
 * Reads and validates `--port`.
 *
 * @param args - The parsed arguments
 * @returns The base port, `undefined` when the flag is absent, or the refusal
 */
function readBasePort(
  args: ParsedArgs,
): { readonly ok: true; readonly port?: number } | {
  readonly ok: false;
  readonly message: string;
} {
  const raw = stringFlag(args.flags, 'port');
  if (raw === undefined) return { ok: true };

  const port = Number(raw);
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    return {
      ok: false,
      message: `Invalid --port "${raw}": expected an integer between 1 and ${MAX_PORT}.`,
    };
  }
  return { ok: true, port };
}

/**
 * Plans a workspace root, refusing the flags a root cannot honor.
 *
 * `--template` and a non-Deno `--runtime` are refused rather than ignored: a
 * root registers no plugins and starts no server, so a template applied to it
 * has nothing to configure, and a Setu workspace is a Deno workspace. Silently
 * swallowing a flag is how `setu generate` once accepted an invalid `--runtime`
 * that `new` rejected.
 *
 * @param name - The workspace directory name
 * @param runtimeFlag - The raw `--runtime` value, when given
 * @param args - The parsed arguments, read for `--template` and `--port`
 * @returns The planned files, or the refusal to print
 */
function planWorkspace(
  name: string,
  runtime: TargetRuntime,
  args: ParsedArgs,
): { readonly ok: true; readonly files: readonly GeneratedFile[] } | {
  readonly ok: false;
  readonly message: string;
} {
  if (runtime !== 'deno') {
    return {
      ok: false,
      message: `A Setu workspace is a Deno workspace, so --runtime ${runtime} cannot apply. ` +
        `Scaffold a standalone project instead: ` +
        `\`${PROGRAM_NAME} new ${name} --runtime ${runtime}\`.`,
    };
  }

  const templateFlag = stringFlag(args.flags, 'template');
  if (templateFlag !== undefined) {
    return {
      ok: false,
      message: `A workspace root registers no plugins, so --template ${templateFlag} has ` +
        `nothing to configure. Create the workspace, then add a service with ` +
        `\`${PROGRAM_NAME} generate ${APP_VERB} <name> --template ${templateFlag}\`.`,
    };
  }

  const basePort = readBasePort(args);
  if (!basePort.ok) return { ok: false, message: basePort.message };

  return { ok: true, files: workspaceRootFiles(name, basePort.port ?? DEFAULT_BASE_PORT) };
}

/**
 * Plans an ordinary project.
 *
 * @param name - The project directory name
 * @param runtime - The selected runtime target
 * @param args - The parsed arguments, read for `--template`, `--di` and `--port`
 * @returns The planned files, or the refusal to print
 */
function planProject(
  name: string,
  runtime: TargetRuntime,
  args: ParsedArgs,
): { readonly ok: true; readonly files: readonly GeneratedFile[] } | {
  readonly ok: false;
  readonly message: string;
} {
  // `--port` sets a workspace's base port and means nothing to a standalone
  // project, whose entry binds 3000. Accepting it silently would report success
  // for a project that ignores the number the user chose.
  if (stringFlag(args.flags, 'port') !== undefined) {
    return {
      ok: false,
      message: `--port applies to \`${PROGRAM_NAME} new <name> --workspace\`, which allocates ` +
        `member ports from it. A standalone project binds the port its \`main.ts\` names.`,
    };
  }

  const choice = resolveTemplateChoice(args, runtime);
  if (!choice.ok) return { ok: false, message: choice.message };

  // The no-template path is a HOST like any other — that is what gives a bare
  // project the seams needing no plugin, so `setu generate route` lands wired.
  const host = resolveHost(choice.template ?? MINIMAL_HOST, choice.features);
  return { ok: true, files: projectFiles(name, runtime, host, choice.features) };
}

/**
 * Runs `setu new`.
 *
 * Creates the project (or the workspace root) under `<dir>/<name>`, checking
 * every planned path for an existing file BEFORE the first write, and writing
 * nothing at all under `--dry-run`.
 *
 * @param args - Arguments after the `new` verb, already parsed
 * @param deps - Filesystem and output sinks
 * @returns `0` on success, `1` on a runtime error, `2` on a usage error
 */
export async function runNewCommand(
  args: ParsedArgs,
  deps: NewDependencies,
): Promise<number> {
  const usage = `Usage: ${PROGRAM_NAME} new <project-name> [--template <name>] ` +
    `[--runtime <target>] [--di] [--workspace] [--dir <path>]`;

  // `--help` is never an error.
  if (args.flags['help'] === true || args.flags['h'] === true) {
    deps.log(usage);
    deps.log('');
    deps.log('Templates:');
    deps.log('  (none)              Minimal — the runtime plugin alone');
    for (const template of listTemplates()) {
      deps.log(`  ${template.name.padEnd(18)}${template.description}`);
    }
    deps.log('');
    deps.log('Options:');
    deps.log(`  --template <name>   ${TEMPLATES.join(' | ')}`);
    deps.log(`  --runtime <target>  ${TARGET_RUNTIMES.join(' | ')} (default deno)`);
    deps.log('  --di                Register DiPlugin, so @Injectable classes get a container');
    deps.log(
      `  --workspace         Create a monorepo root; add services with ` +
        `\`${PROGRAM_NAME} generate ${APP_VERB} <name>\``,
    );
    deps.log(
      `  --port <n>          Base port for workspace members (default ${DEFAULT_BASE_PORT})`,
    );
    deps.log('  --dir <path>        Create the project under this directory');
    deps.log('  --dry-run           Print what would be created, write nothing');
    return EXIT_OK;
  }

  const rawName = args.positionals[0];
  if (rawName === undefined) {
    deps.error(usage);
    return EXIT_USAGE;
  }

  const workspace = args.flags['workspace'] === true;
  const runtimeFlag = stringFlag(args.flags, 'runtime');
  if (runtimeFlag !== undefined && !isTargetRuntime(runtimeFlag)) {
    deps.error(
      `Unknown runtime "${runtimeFlag}". Expected one of: ${TARGET_RUNTIMES.join(', ')}.`,
    );
    return EXIT_USAGE;
  }
  const runtime: TargetRuntime = runtimeFlag ?? 'deno';

  const projectName = deriveNames(rawName).kebab;
  if (projectName === '') {
    deps.error(`Invalid project name: "${rawName}".`);
    return EXIT_USAGE;
  }

  const plan = workspace
    ? planWorkspace(projectName, runtime, args)
    : planProject(projectName, runtime, args);
  if (!plan.ok) {
    deps.error(plan.message);
    return EXIT_USAGE;
  }

  const root = joinPath(resolveDir(deps.cwd, stringFlag(args.flags, 'dir')), projectName);

  // A template file whose path collides with the fixed set would otherwise be
  // written twice, last one winning, with nothing reported — the overwrite
  // check probes the filesystem and cannot see a duplicate inside one plan.
  const duplicate = firstDuplicatePath(plan.files);
  if (duplicate !== undefined) {
    deps.error(
      `Template "${stringFlag(args.flags, 'template') ?? 'none'}" emits ${duplicate} twice; ` +
        `it collides with the generated project file of the same name.`,
    );
    return EXIT_ERROR;
  }

  const files = plan.files.map((file) => ({
    path: joinPath(root, file.path),
    contents: file.contents,
  }));

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
  deps.log('');

  if (workspace) {
    deps.log(`Created workspace ${projectName}. Next:`);
    deps.log(`  cd ${projectName}`);
    deps.log(`  ${PROGRAM_NAME} generate ${APP_VERB} orders --template microservice`);
    return EXIT_OK;
  }

  deps.log(`Created ${projectName} (${runtime}). Next:`);
  deps.log(`  cd ${projectName}`);
  deps.log(
    runtime === 'deno'
      ? '  deno task start'
      : runtime === 'cloudflare-workers'
      ? '  npm install && npx wrangler dev'
      : runtime === 'bun'
      ? '  bun install && bun run start'
      : '  npm install && npm start',
  );
  return EXIT_OK;
}
