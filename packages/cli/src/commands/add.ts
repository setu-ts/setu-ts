/**
 * `setu add <plugin>` — installing a framework package into a project.
 *
 * D3: `setu generate --help` printed
 * `guard  (unavailable — install @setu-ts/auth-plugin)` and offered no command
 * to do it, so unlocking a gated schematic meant hand-editing `deno.json` and
 * re-running `deno install`. Every gate the CLI ships pointed at a step the CLI
 * would not take.
 *
 * Dispatched before the schematic registry, exactly as `custom` and the `app`
 * verb are, and deliberately NOT a registry entry: a `Schematic` is a pure
 * `(names, options) => GeneratedFile[]` that performs no I/O, while this reads
 * the target's manifest and rewrites it.
 *
 * @module
 */

import type { IFileSystem } from '@setu-ts/common';
import { escapeName } from '../utils/names.ts';
import type { ParsedArgs } from '../args.ts';
import { EXIT_ERROR, EXIT_OK, EXIT_USAGE, PROGRAM_NAME, VERSION } from '../constants.ts';
import { joinPath, resolveDir } from '../utils/file-writer.ts';
import { stringFlag } from '../args.ts';

/** What `runAddCommand` reaches the outside world through. */
export interface AddCommandDependencies {
  /** The filesystem all reads and writes go through. */
  readonly fs: IFileSystem;
  /** The working directory a relative `--dir` resolves against (absolute). */
  readonly cwd: string;
  /** Writes a line of normal output. */
  readonly log: (message: string) => void;
  /** Writes a line of error output. */
  readonly error: (message: string) => void;
}

/**
 * The framework packages this command will install.
 *
 * An explicit allow-list rather than "anything under `@setu-ts/`", because the
 * range this writes is the CLI's OWN version — which is only correct for
 * packages released as one version with it. A typo therefore has to be refused
 * rather than pinned to a version that does not exist.
 *
 * Short names are what a developer types; the full specifier is what the
 * manifest carries. Both resolve, so `setu add auth` and
 * `setu add @setu-ts/auth-plugin` are the same command.
 */
const ADDABLE: ReadonlyMap<string, string> = new Map([
  ['audit', 'audit-plugin'],
  ['auth', 'auth-plugin'],
  ['cache', 'cache-plugin'],
  ['cloudflare', 'cloudflare-plugin'],
  ['config', 'config-plugin'],
  ['cqrs', 'cqrs-plugin'],
  ['database', 'database-plugin'],
  ['decorator', 'decorator-plugin'],
  ['di', 'di-plugin'],
  ['events', 'events-plugin'],
  ['feature-flags', 'feature-flags-plugin'],
  ['graphql', 'graphql-plugin'],
  ['grpc', 'grpc-plugin'],
  ['health', 'health-plugin'],
  ['http-security', 'http-security-plugin'],
  ['logger', 'logger-plugin'],
  ['mail', 'mail-plugin'],
  ['messaging', 'messaging-plugin'],
  ['metrics', 'metrics-plugin'],
  ['multi-tenancy', 'multi-tenancy-plugin'],
  ['notification', 'notification-plugin'],
  ['openapi', 'openapi-plugin'],
  ['queue', 'queue-plugin'],
  ['react-router', 'react-router-plugin'],
  ['realtime-backplane', 'realtime-backplane-plugin'],
  ['resilience', 'resilience-plugin'],
  ['scheduler', 'scheduler-plugin'],
  ['secrets', 'secrets-plugin'],
  ['sdk', 'sdk'],
  ['service-discovery', 'service-discovery-plugin'],
  ['session', 'session-plugin'],
  ['sse', 'sse-plugin'],
  ['static', 'static-plugin'],
  ['storage', 'storage-plugin'],
  ['telemetry', 'telemetry-plugin'],
  ['validation', 'validation-plugin'],
  ['websocket', 'websocket-plugin'],
  ['worker-pool', 'worker-pool-plugin'],
]);

/** One provider a decorated ingress class can resolve from the application. */
interface IngressProviderWiring {
  /** Factory exported by the provider package. */
  readonly symbol: string;
}

/**
 * Provider plugins that a class-based ingress config can activate safely.
 *
 * Every factory here has an in-memory, zero-configuration default. That makes
 * adding it to the CLI-generated class-based config a coherent development
 * composition; providers that need credentials or a user-owned choice remain
 * manifest-only like every other `setu add` package.
 */
const INGRESS_PROVIDER_WIRINGS: ReadonlyMap<string, IngressProviderWiring> = new Map([
  ['cqrs-plugin', { symbol: 'CqrsPlugin' }],
  ['events-plugin', { symbol: 'EventsPlugin' }],
  ['messaging-plugin', { symbol: 'MessagingPlugin' }],
  ['queue-plugin', { symbol: 'QueuePlugin' }],
  ['scheduler-plugin', { symbol: 'SchedulerPlugin' }],
  ['websocket-plugin', { symbol: 'WebSocketPlugin' }],
]);

/**
 * Resolves what the user typed to a bare package name.
 *
 * @param input - The `<plugin>` argument
 * @returns The bare package name, or `undefined` when it names nothing
 */
export function resolveAddablePackage(input: string): string | undefined {
  const bare = input.startsWith('@setu-ts/') ? input.slice('@setu-ts/'.length) : input;
  if ([...ADDABLE.values()].includes(bare)) return bare;
  return ADDABLE.get(bare);
}

/** Every short name this command accepts, sorted, for a refusal to list. */
export function addableNames(): readonly string[] {
  return [...ADDABLE.keys()].sort();
}

/**
 * Inserts a dependency into a manifest's map, preserving key order.
 *
 * Rewritten from the parsed object rather than by text surgery: the manifests
 * this touches are the CLI's own output, and a regex insert would have to
 * reproduce their formatting exactly. Re-serializing at two-space indent
 * matches what every other emitter here writes, so the file stays byte-stable
 * under the project's own `deno fmt`.
 *
 * @param source - The manifest's current contents
 * @param section - The top-level key holding the dependency map
 * @param specifier - The import specifier to add
 * @param range - The value to record
 * @returns The rewritten manifest, or `undefined` when the entry is already
 * present with the same value
 */
export function withDependency(
  source: string,
  section: string,
  specifier: string,
  range: string,
): string | undefined {
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const existing = parsed[section];
  const map = existing !== null && typeof existing === 'object'
    ? { ...existing as Record<string, string> }
    : {};

  if (map[specifier] === range) return undefined;

  map[specifier] = range;
  // Sorted, because the emitters this has to agree with sort their maps and an
  // appended key would make a later regeneration reorder the file.
  const sorted = Object.fromEntries(
    Object.entries(map).sort(([left], [right]) => (left < right ? -1 : 1)),
  );
  return `${JSON.stringify({ ...parsed, [section]: sorted }, null, 2)}\n`;
}

/**
 * Finds the local name for one named provider import in the generated config shape.
 *
 * The config owns its import style, so this deliberately accepts only the
 * one-line named import form the CLI writes. It still understands aliases: a
 * hand-added `EventsPlugin as AppEvents` has to be invoked as `AppEvents`, not
 * reintroduced under a second local binding.
 */
function providerBinding(source: string, bare: string, symbol: string): string | undefined {
  const importStart = 'import {';
  const importEnd = `} from '@setu-ts/${bare}';`;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(importStart) || !trimmed.endsWith(importEnd)) continue;
    const specifiers = trimmed.slice(importStart.length, -importEnd.length).split(',');
    for (const specifier of specifiers) {
      const parts = specifier.trim().split(/\s+as\s+/);
      if (parts[0] === symbol) return parts[1] ?? symbol;
    }
  }
  return undefined;
}

/**
 * Adds a zero-config ingress provider to the CLI-generated class-based config.
 *
 * The generated config is deliberately identified by its explicit ingress
 * option, not merely by an import of `DecoratorPlugin`: a developer-owned
 * decorator composition may have a different registration site and must not
 * be rewritten by an installer. Likewise, a config that already constructs
 * the provider is left byte-identical.
 *
 * @param source - Existing `setu.config.ts` contents
 * @param bare - Bare package name being added
 * @returns The updated config, or `undefined` when it is not an eligible
 * generated config or needs no change
 */
export function withIngressProviderWiring(source: string, bare: string): string | undefined {
  const provider = INGRESS_PROVIDER_WIRINGS.get(bare);
  if (provider === undefined) return undefined;

  const decoratorImport = "import { DecoratorPlugin } from '@setu-ts/decorator-plugin';";
  const ingressImport = "import { INGRESS_HANDLERS } from './src/ingress/index.ts';";
  const ingressOption = 'ingress: [...INGRESS_HANDLERS],';
  const pluginList = 'plugins: [';
  const providerImport = `import { ${provider.symbol} } from '@setu-ts/${bare}';`;
  const importedBinding = providerBinding(source, bare, provider.symbol);
  const factory = importedBinding ?? provider.symbol;
  if (
    !source.includes(decoratorImport) ||
    !source.includes(ingressImport) ||
    !source.includes('DecoratorPlugin({') ||
    !source.includes(ingressOption) ||
    !source.includes(pluginList) ||
    source.includes(`${factory}(`) ||
    source.includes(`${factory} (`)
  ) {
    return undefined;
  }

  const withImport = importedBinding === undefined
    ? source.replace(decoratorImport, `${decoratorImport}\n${providerImport}`)
    : source;
  const insertion = withImport.indexOf(pluginList) + pluginList.length;
  const lineStart = withImport.lastIndexOf('\n', insertion - 1) + 1;
  const indentation = withImport.slice(lineStart, insertion - pluginList.length);
  return `${withImport.slice(0, insertion)}\n${indentation}  ${factory}(),${
    withImport.slice(insertion)
  }`;
}

/**
 * Adds a framework package to the project's manifest. For the six ingress
 * providers, it also activates the provider in an unmodified class-based
 * scaffold, whose `DecoratorPlugin` already receives the ingress barrel.
 *
 * Reports the install command rather than spawning it. That is deliberate: on
 * the day of a release `deno install` hits the 24-hour minimum-dependency-age
 * policy (D1), so the developer needs to SEE the command and its flags rather
 * than watch an opaque subprocess fail. It also keeps this command free of the
 * `run` permission.
 *
 * @param args - The parsed arguments after the verb
 * @param deps - Filesystem, working directory, and output sinks
 * @returns `0` on success, `1` on a runtime error, `2` on a usage error
 */
export async function runAddCommand(
  args: ParsedArgs,
  deps: AddCommandDependencies,
): Promise<number> {
  if (args.flags['help'] === true || args.flags['h'] === true) {
    printAddHelp(deps.log);
    return EXIT_OK;
  }

  const requested = args.positionals[0];
  if (requested === undefined || requested === '') {
    deps.error(`Usage: ${PROGRAM_NAME} add <plugin> [--dir <path>]`);
    deps.error(`Run \`${PROGRAM_NAME} add --help\` for the list.`);
    return EXIT_USAGE;
  }

  // X18-1: the contract is singular, and exceeding it used to be silent —
  // five requested packages reported `updated deno.json` and exited 0 with one
  // added. Refused by name, like every other misapplied input to this CLI.
  if (args.positionals.length > 1) {
    deps.error(
      `${PROGRAM_NAME} add takes one package; got ${args.positionals.length}. Run it once per package.`,
    );
    return EXIT_USAGE;
  }

  const bare = resolveAddablePackage(requested);
  if (bare === undefined) {
    deps.error(`"${escapeName(requested)}" is not a Setu-TS package this command can add.`);
    deps.error(`  Available: ${addableNames().join(', ')}`);
    return EXIT_USAGE;
  }

  const dir = resolveDir(deps.cwd, stringFlag(args.flags, 'dir'));
  const specifier = `@setu-ts/${bare}`;

  // Both manifests are updated when both exist, because a Workers or Node
  // project carries a `package.json` for its toolchain AND a `deno.json` that
  // `setu generate` reads for plugin gating — writing only one would leave the
  // gate and the build disagreeing about what is installed.
  const targets: readonly {
    readonly file: string;
    readonly section: string;
    readonly range: string;
  }[] = [
    { file: 'deno.json', section: 'imports', range: `jsr:${specifier}@^${VERSION}` },
    {
      file: 'package.json',
      section: 'dependencies',
      range: `npm:@jsr/setu-ts__${bare}@^${VERSION}`,
    },
  ];

  const edits: { readonly path: string; readonly contents: string }[] = [];
  let found = false;
  let alreadyPresent = false;

  for (const target of targets) {
    const path = joinPath(dir, target.file);
    let source: string;
    try {
      source = new TextDecoder().decode(await deps.fs.readFile(path));
    } catch {
      continue;
    }
    found = true;

    let updated: string | undefined;
    try {
      updated = withDependency(source, target.section, specifier, target.range);
    } catch {
      deps.error(`Cannot read ${path} as JSON; fix it and run this again.`);
      return EXIT_ERROR;
    }

    if (updated === undefined) {
      alreadyPresent = true;
      continue;
    }
    edits.push({ path, contents: updated });
  }

  // The ingress barrel is already part of a class-based scaffold from project
  // creation. Installing a provider only in the manifest would make a later
  // decorated ingress class fail at startup because the capability was never
  // registered. Activate only the known generated shape; an application-owned
  // config can have arbitrary composition and is not ours to rewrite.
  const configPath = joinPath(dir, 'setu.config.ts');
  try {
    const config = new TextDecoder().decode(await deps.fs.readFile(configPath));
    const wired = withIngressProviderWiring(config, bare);
    if (wired !== undefined) edits.push({ path: configPath, contents: wired });
  } catch {
    // `setu add` remains useful for non-scaffolded projects. A missing config
    // simply has no generated ingress composition to activate.
  }

  if (!found) {
    deps.error(`No deno.json or package.json in ${dir} — this is not a Setu-TS project.`);
    return EXIT_ERROR;
  }

  if (edits.length === 0 && alreadyPresent) {
    deps.log(`${specifier} is already installed in ${dir}.`);
    return EXIT_OK;
  }

  if (args.flags['dry-run'] === true) {
    for (const edit of edits) deps.log(`would update ${edit.path}`);
    return EXIT_OK;
  }

  for (const edit of edits) {
    await deps.fs.writeFile(edit.path, new TextEncoder().encode(edit.contents));
    deps.log(`updated ${edit.path}`);
  }

  deps.log('');
  deps.log('Next:');
  // `--min-dep-age 0` for the same reason the generated manifest carries
  // `minimumDependencyAge` (D1): this pin is the CLI's own version, which on
  // release day is younger than the policy allows.
  deps.log(`  deno install --min-dep-age 0`);
  printPermissionNote(specifier, deps.log);
  return EXIT_OK;
}

/**
 * Extra permissions a package needs that the generated `start` task does not
 * already request, keyed by specifier.
 *
 * A NOTE rather than an automatic edit to `denoPermissions`: `--allow-write` is
 * needed only by the storage plugin's `local` provider, and granting filesystem
 * write to every project that installs an S3-backed capability would be a
 * security regression traded for an ergonomics one. The generated task's
 * contract is that it stays least-privilege.
 */
const PERMISSION_NOTES: ReadonlyMap<string, readonly string[]> = new Map([[
  '@setu-ts/storage-plugin',
  [
    "  The 'local' provider writes files, so a Deno project needs --allow-write",
    '  in its start task. Cloud providers (s3/gcs/azure/b2) do not.',
  ],
]]);

/**
 * Prints the permission note for a package that needs one.
 *
 * X8-9: with `STORAGE_PROVIDER=local` an otherwise untouched scaffolded project
 * answered every upload with a parse failure and reported `storage: up`,
 * because the generated task requests `--allow-read` but not `--allow-write`.
 * The provider now refuses to connect with the flag named; this says so before
 * the developer ever runs it.
 *
 * @param specifier - The package that was added
 * @param log - Output sink
 */
function printPermissionNote(specifier: string, log: (message: string) => void): void {
  const note = PERMISSION_NOTES.get(specifier);
  if (note === undefined) {
    return;
  }
  log('');
  log('Note:');
  for (const line of note) {
    log(line);
  }
}

/**
 * Prints the `add` usage text.
 *
 * @param log - Output sink
 */
function printAddHelp(log: (message: string) => void): void {
  log(`Usage: ${PROGRAM_NAME} add <plugin> [--dir <path>] [--dry-run]`);
  log('');
  log('Adds a Setu-TS package to this project, pinned to the version of the CLI');
  log("that added it — so a project's framework packages stay on one version.");
  log('');
  log('Available:');
  for (const name of addableNames()) {
    log(`  ${name}`);
  }
  log('');
  log('The full specifier works too, so `add auth` and `add @setu-ts/auth-plugin`');
  log('are the same command. Run `deno install` afterwards; this writes the');
  log('manifest and does not install for you.');
}
