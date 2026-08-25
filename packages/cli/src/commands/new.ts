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
import type { Prompter } from '../prompt.ts';
import { resolveNewChoices } from './new-interactive.ts';
import {
  brokerComposeFiles,
  brokerEnvVariables,
  standaloneOverlayRefusal,
  withBrokerArgs,
  withQueueArgs,
} from '../templates/broker.ts';
import type { ResolvedHost } from '../templates/project-files.ts';
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
import { projectFiles, resolveHost, withEnvFile } from '../templates/project-files.ts';
import { readEnvFilePath } from '../templates/env-file.ts';
import { DEFAULT_BASE_PORT, readPortFlag } from '../workspace/manifest.ts';
import {
  DEFAULT_TRANSPORT,
  getTransport,
  listBrokers,
  listQueues,
  listTransports,
  TRANSPORT_ALIASES,
  TRANSPORTS,
  type TransportSpec,
} from '../workspace/transport.ts';
import {
  isWorkspaceRuntime,
  WORKSPACE_RUNTIMES,
  workspaceProfile,
} from '../workspace/runtime-profile.ts';
import { workspaceRootFiles } from '../workspace/root-files.ts';
import type { PortProbe } from '../workspace/port-probe.ts';
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
  /** Checks whether a workspace base port is currently bindable. */
  readonly portAvailable?: PortProbe;
  /**
   * Asks the questions `setu new` already accepts as flags.
   *
   * OPTIONAL, and that optionality is the primary non-interactive guarantee:
   * when it is absent — every gate in this repository reaches the CLI through
   * an in-process `runCli` that passes none — no prompt is ever attempted and
   * each absent flag takes its documented default. The terminal implementation
   * is supplied by `src/main.ts` only behind `Deno.stdin.isTerminal()`.
   */
  readonly ask?: Prompter;
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
  // Deno, Node and Bun all host a workspace; Cloudflare Workers does not, and
  // that is a topology difference rather than a missing profile — each Worker is
  // its own deploy unit with its own `wrangler.toml`, so several in one repository
  // are several deployments, not members sharing a root manifest and a lockfile.
  if (!isWorkspaceRuntime(runtime)) {
    return {
      ok: false,
      message: `--runtime ${runtime} cannot host a workspace: each Worker is its own deploy ` +
        `unit with its own wrangler.toml, so several of them are several deployments rather ` +
        `than members of one. Workspaces target ${WORKSPACE_RUNTIMES.join(', ')}; scaffold a ` +
        `standalone project instead with \`${PROGRAM_NAME} new ${name} --runtime ${runtime}\`.`,
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

  // The independent DI flag is no longer a valid composition choice. Refuse it
  // here too because a workspace root never reaches template resolution.
  if (args.flags['di'] === true) {
    return {
      ok: false,
      message:
        '`--di` is no longer supported. Use `--template class-based` for decorators and DI together.',
    };
  }

  if (args.flags['env-file'] !== undefined) {
    return {
      ok: false,
      message: '--env-file applies to a generated application, not a workspace root.',
    };
  }

  if (args.flags['depends-on'] !== undefined) {
    return { ok: false, message: dependsOnRefusal() };
  }

  // The broker flags are a STANDALONE project's own composition choice; the
  // workspace-wide equivalent is --transport, chosen once at creation.
  for (const flag of ['broker', 'queue'] as const) {
    if (args.flags[flag] !== undefined) {
      return {
        ok: false,
        message: `--${flag} selects one standalone project's own transport backend; a ` +
          `workspace's members share one instead. Create the workspace with ` +
          `--transport <name> — its value covers the message brokers too.`,
      };
    }
  }

  const basePort = readPortFlag(args.flags);
  if (!basePort.ok) return { ok: false, message: basePort.message };

  const transport = readTransport(args);
  if (!transport.ok) return { ok: false, message: transport.message };

  return {
    ok: true,
    files: workspaceRootFiles(
      name,
      basePort.port ?? DEFAULT_BASE_PORT,
      transport.spec,
      workspaceProfile(runtime),
      // Omitted rather than passed as `undefined`: exactOptionalPropertyTypes.
      ...(transport.url === undefined ? [] : [transport.url]),
    ),
  };
}

/**
 * Reads and validates `--transport` and `--transport-url`.
 *
 * `tcp` is refused by name rather than accepted as a synonym for `http`: this
 * framework has no raw-TCP transport, every inter-service path is HTTP over TCP
 * or a broker client over TCP, and quietly handing back HTTP under another name
 * would leave the user believing they chose something.
 *
 * @param args - The parsed arguments
 * @returns The transport spec and endpoint, or the refusal to print
 */
function readTransport(
  args: ParsedArgs,
): { readonly ok: true; readonly spec: TransportSpec; readonly url?: string } | {
  readonly ok: false;
  readonly message: string;
} {
  const raw = args.flags['transport'];
  const named = raw === undefined ? DEFAULT_TRANSPORT : raw;
  if (typeof named !== 'string') {
    return {
      ok: false,
      message: `--transport needs a value: ${TRANSPORTS.join(' | ')}.`,
    };
  }

  const spec = getTransport(named);
  if (spec === undefined) {
    const alias = TRANSPORT_ALIASES[named];
    return {
      ok: false,
      message: alias === undefined
        ? `Unknown transport "${named}". Expected one of: ${TRANSPORTS.join(', ')}.`
        : `There is no raw ${named} transport: every inter-service path here is HTTP over ` +
          `${named} or a broker client over ${named}. Use --transport ${alias} for direct calls ` +
          `through the discovery map, or a broker (${
            TRANSPORTS.filter((t) => t !== 'http' && t !== 'grpc').join(', ')
          }).`,
    };
  }

  const rawUrl = args.flags['transport-url'];
  if (rawUrl === undefined) return { ok: true, spec };
  if (typeof rawUrl !== 'string') {
    return { ok: false, message: `--transport-url needs a value.` };
  }
  // Refused rather than stored, for two different reasons — and they are told
  // apart, because "this transport has no broker" is wrong advice for a cloud arm
  // that plainly does.
  if (spec.connection?.urlOverridable !== true) {
    const applies = listTransports()
      .filter((t) => t.connection?.urlOverridable === true)
      .map((t) => t.name)
      .join(', ');

    if (spec.connection !== undefined) {
      return {
        ok: false,
        message: `--transport ${spec.name} is not configured by URL: its connection value is ` +
          `read from ${spec.connection.variable} at run time, because it is a project id or a ` +
          `secret and a generated file is the wrong place for either. Leave it unset to use the ` +
          `local emulator. --transport-url applies to ${applies}.`,
      };
    }

    return {
      ok: false,
      message: `--transport ${spec.name} has no broker, so --transport-url has nothing to ` +
        `address. It applies to ${applies}.`,
    };
  }
  return { ok: true, spec, url: rawUrl };
}

/**
 * Names where `--depends-on` is actually read.
 *
 * Shared by the workspace-root and standalone refusals, so both name the one
 * command that honours the flag rather than only rejecting it.
 *
 * @returns The refusal message
 */
function dependsOnRefusal(): string {
  return `--depends-on applies to \`${PROGRAM_NAME} generate ${APP_VERB} <name>\`: it names an ` +
    `existing workspace member this service waits for, and only a workspace has members.`;
}

/**
 * Reads and validates one standalone transport-backend flag.
 *
 * The accepted set is DERIVED from the registry (`listBrokers`/`listQueues`), so
 * help text, refusal text and validation cannot drift from the arms that exist.
 * `memory` is always accepted: it states the default the plugin already takes
 * and rewrites nothing.
 *
 * @param args - The parsed arguments
 * @param flag - Which flag is being read
 * @returns The selected spec (undefined when the flag is absent), or the refusal
 */
function readArmFlag(
  args: ParsedArgs,
  flag: 'broker' | 'queue',
): { readonly ok: true; readonly spec?: TransportSpec } | {
  readonly ok: false;
  readonly message: string;
} {
  const raw = args.flags[flag];
  if (raw === undefined) return { ok: true };

  const accepted = flag === 'broker' ? listBrokers() : listQueues();
  if (typeof raw !== 'string') {
    return { ok: false, message: `--${flag} needs a value: ${accepted.join(' | ')}.` };
  }

  const spec = getTransport(raw);
  const hasArm = spec !== undefined &&
    (flag === 'broker' ? spec.messagingArgs !== undefined : spec.queueArgs !== undefined);
  if (spec === undefined || (raw !== 'memory' && !hasArm)) {
    // The two failures are told apart, because "no such transport" and "this
    // transport has no arm for this flag" are different mistakes.
    const prefix = spec === undefined
      ? `Unknown ${flag} "${raw}".`
      : flag === 'broker'
      ? `"${raw}" declares no message-broker wiring.`
      : `"${raw}" declares no queue wiring.`;
    return {
      ok: false,
      message: `${prefix} --${flag} accepts: ${accepted.join(', ')}.`,
    };
  }
  return { ok: true, spec };
}

/**
 * Applies the standalone broker overlay to a resolved host.
 *
 * Composes the SAME wiring rewrites the workspace transport uses with the two
 * things only the standalone path needs — the connection variable in the
 * generated dotenv pair, and the Compose file starting what was selected. With
 * neither flag selected this is the identity, so a default scaffold's output is
 * byte-identical to before the flags existed.
 *
 * @param host - The resolved host, after its env-file adjustment
 * @param selection - The selected transports, each undefined when its flag is absent
 * @param profile - How the target runtime reads the environment
 * @returns The overlaid host
 */
function applyBrokerOverlay(
  host: ResolvedHost,
  selection: { readonly broker?: TransportSpec; readonly queue?: TransportSpec },
  profile: ReturnType<typeof workspaceProfile>,
): ResolvedHost {
  let next = host;
  const specs: TransportSpec[] = [];
  if (selection.broker !== undefined) {
    next = withBrokerArgs(next, selection.broker, profile);
    specs.push(selection.broker);
  }
  if (selection.queue !== undefined) {
    next = withQueueArgs(next, selection.queue, profile);
    if (!specs.includes(selection.queue)) specs.push(selection.queue);
  }
  if (specs.length === 0) return next;

  // One arm can serve both flags; its variable must appear once in the dotenv
  // pair, deduplicated by name across the selection.
  const seen = new Set<string>();
  const variables = specs.flatMap(brokerEnvVariables).filter((variable) => {
    if (seen.has(variable.name)) return false;
    seen.add(variable.name);
    return true;
  });

  const manifest = next.manifest;
  if (manifest !== undefined && variables.length > 0) {
    next = {
      ...next,
      manifest: {
        ...manifest,
        envVariables: [...(manifest.envVariables ?? []), ...variables],
      },
    };
  }
  return { ...next, files: [...next.files, ...brokerComposeFiles(specs)] };
}

/**
 * Plans an ordinary project.
 *
 * @param name - The project directory name
 * @param runtime - The selected runtime target
 * @param args - The parsed arguments, read for `--template` and `--port`
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
  if (args.flags['port'] !== undefined) {
    return {
      ok: false,
      message: `--port applies to \`${PROGRAM_NAME} new <name> --workspace\`, which allocates ` +
        `member ports from it. A standalone project binds the port its \`main.ts\` names.`,
    };
  }

  // Same class again: a startup dependency names a sibling, and a standalone
  // project has no siblings. Nothing reads the flag here, so accepting it would
  // report success for a project with no ordering of any kind.
  if (args.flags['depends-on'] !== undefined) {
    return { ok: false, message: dependsOnRefusal() };
  }

  // Same class: a transport describes how the members of a workspace reach each
  // other, and a standalone project has no members. Accepting it would report
  // success for a project that registers nothing of the kind.
  for (const flag of ['transport', 'transport-url']) {
    if (args.flags[flag] !== undefined) {
      return {
        ok: false,
        message: `--${flag} applies to \`${PROGRAM_NAME} new <name> --workspace\`: it decides ` +
          `how a workspace's services talk to each other, and a standalone project has none. ` +
          `To configure THIS project's own backends, use --broker <name> and --queue <name>.`,
      };
    }
  }

  const broker = readArmFlag(args, 'broker');
  if (!broker.ok) return { ok: false, message: broker.message };
  const queue = readArmFlag(args, 'queue');
  if (!queue.ok) return { ok: false, message: queue.message };

  const choice = resolveTemplateChoice(args);
  if (!choice.ok) return { ok: false, message: choice.message };

  const envFile = readEnvFilePath(args.flags);
  if (!envFile.ok) return { ok: false, message: envFile.message };

  // The no-template path is a HOST like any other — that is what gives a bare
  // project the seams needing no plugin, so `setu generate route` lands wired.
  // The runtime swap runs INSIDE resolveHost, before any overlay: on Workers it
  // has already removed the messaging and queue wirings, which is exactly why a
  // broker flag is refused there rather than silently rewriting nothing.
  const host = resolveHost(choice.template ?? MINIMAL_HOST, runtime);
  const configured = envFile.path === undefined ? host : withEnvFile(host, envFile.path);
  if (configured === undefined) {
    return {
      ok: false,
      message: runtime === 'cloudflare-workers'
        ? '--env-file is unavailable on Cloudflare Workers; use Worker bindings for configuration.'
        : '--env-file requires a template that registers ConfigPlugin (rest, microservice, class-based, or full-stack).',
    };
  }

  // Refused wherever the flag would be a silent no-op — Workers, a
  // starter-composed template, or a template registering no matching wiring.
  // `memory` passes these checks everywhere the flag itself is accepted and
  // rewrites nothing below.
  for (const [flag, selected] of [['broker', broker.spec], ['queue', queue.spec]] as const) {
    if (selected === undefined) continue;
    const refusal = standaloneOverlayRefusal(flag, runtime, configured);
    if (refusal !== undefined) return { ok: false, message: refusal };
  }

  const overlaid = applyBrokerOverlay(
    configured,
    {
      ...(broker.spec === undefined ? {} : { broker: broker.spec }),
      ...(queue.spec === undefined ? {} : { queue: queue.spec }),
    },
    workspaceProfile(runtime),
  );
  return { ok: true, files: projectFiles(name, runtime, overlaid) };
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
    `[--runtime <target>] [--env-file <path>] [--workspace] [--dir <path>]`;

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
    deps.log('  --env-file <path>   Dotenv path for a ConfigPlugin-backed template (default .env)');
    deps.log(`  --runtime <target>  ${TARGET_RUNTIMES.join(' | ')} (default deno)`);
    deps.log(
      `  --workspace         Create a monorepo root; add services with ` +
        `\`${PROGRAM_NAME} generate ${APP_VERB} <name>\``,
    );
    deps.log(
      `  --port <n>          Base port for workspace members (default ${DEFAULT_BASE_PORT})`,
    );
    deps.log(
      `  --transport <name>  How a workspace's services talk: ${TRANSPORTS.join(' | ')} ` +
        `(default ${DEFAULT_TRANSPORT})`,
    );
    deps.log('  --transport-url <url>  Broker endpoint, for the broker transports');
    deps.log(
      `  --broker <name>     Message broker for a standalone project: ` +
        `${listBrokers().join(' | ')} (default memory)`,
    );
    deps.log(
      `  --queue <name>      Job queue backend for a standalone project: ` +
        `${listQueues().join(' | ')} (default memory)`,
    );
    deps.log('  --yes, -y           Take every default and ask nothing');
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

  // `--yes` is the single escape hatch: take every default and ask nothing.
  // It is a no-op when no prompter is present (nothing would be asked anyway),
  // never an error.
  const yes = args.flags['yes'] === true || args.flags['y'] === true;
  const chosen = yes || deps.ask === undefined
    ? args
    : await resolveNewChoices(args, deps.ask, deps.log);

  const runtimeFlag = stringFlag(chosen.flags, 'runtime');
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
    ? planWorkspace(projectName, runtime, chosen)
    : planProject(projectName, runtime, chosen);
  if (!plan.ok) {
    deps.error(plan.message);
    return EXIT_USAGE;
  }

  if (workspace && deps.portAvailable !== undefined) {
    const requested = readPortFlag(args.flags);
    if (!requested.ok) {
      deps.error(requested.message);
      return EXIT_USAGE;
    }
    const basePort = requested.port ?? DEFAULT_BASE_PORT;
    if (!(await deps.portAvailable(basePort))) {
      deps.error(`Port ${basePort} is already in use, so it cannot be this workspace's base port.`);
      deps.error('Choose another --port, or stop the process currently listening on it.');
      return EXIT_ERROR;
    }
  }

  const root = joinPath(resolveDir(deps.cwd, stringFlag(chosen.flags, 'dir')), projectName);

  // A template file whose path collides with the fixed set would otherwise be
  // written twice, last one winning, with nothing reported — the overwrite
  // check probes the filesystem and cannot see a duplicate inside one plan.
  const duplicate = firstDuplicatePath(plan.files);
  if (duplicate !== undefined) {
    deps.error(
      `Template "${stringFlag(chosen.flags, 'template') ?? 'none'}" emits ${duplicate} twice; ` +
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
