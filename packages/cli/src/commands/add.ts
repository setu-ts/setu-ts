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
import {
  EXIT_ERROR,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_USAGE,
  PROGRAM_NAME,
  type TargetRuntime,
  VERSION,
} from '../constants.ts';
import { joinPath, resolveDir, writeFiles } from '../utils/file-writer.ts';
import { stringFlag } from '../args.ts';
import { detectTargetRuntime, RuntimeMarkerUnreadableError } from '../utils/runtime-detector.ts';
import { findWorkspaceMarker } from '../utils/project-detector.ts';
import { readJsonManifest } from '../utils/manifest-reader.ts';
import { interruptionMessage } from '../utils/interruption.ts';
import { detectPlugins } from '../utils/plugin-detector.ts';
import {
  DEVTOOL_SOURCES_MODULE,
  factoryScope,
  maskSourceCode,
  readDevtoolSourceNames,
  renderDevtoolSources,
  withDevtoolSourceWiring,
} from '../devtool/sources.ts';

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
  /** Cooperative interruption signal checked at write boundaries. */
  readonly interrupt?: AbortSignal;
}

/** A package pin and the npm section that consumes it. */
interface IAddablePackage {
  /** Bare package name pinned at the CLI version. */
  readonly pkg: string;
  /** Packages used only while developing belong in npm devDependencies. */
  readonly section?: 'dev';
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
const ADDABLE: ReadonlyMap<string, IAddablePackage> = new Map([
  ['audit', { pkg: 'audit-plugin' }],
  ['auth', { pkg: 'auth-plugin' }],
  ['cache', { pkg: 'cache-plugin' }],
  ['cloudflare', { pkg: 'cloudflare-plugin' }],
  ['config', { pkg: 'config-plugin' }],
  ['cqrs', { pkg: 'cqrs-plugin' }],
  ['database', { pkg: 'database-plugin' }],
  ['decorator', { pkg: 'decorator-plugin' }],
  ['di', { pkg: 'di-plugin' }],
  ['events', { pkg: 'events-plugin' }],
  ['feature-flags', { pkg: 'feature-flags-plugin' }],
  ['graphql', { pkg: 'graphql-plugin' }],
  ['grpc', { pkg: 'grpc-plugin' }],
  ['health', { pkg: 'health-plugin' }],
  ['http-security', { pkg: 'http-security-plugin' }],
  ['logger', { pkg: 'logger-plugin' }],
  ['mail', { pkg: 'mail-plugin' }],
  ['messaging', { pkg: 'messaging-plugin' }],
  ['metrics', { pkg: 'metrics-plugin' }],
  ['multi-tenancy', { pkg: 'multi-tenancy-plugin' }],
  ['notification', { pkg: 'notification-plugin' }],
  ['openapi', { pkg: 'openapi-plugin' }],
  ['queue', { pkg: 'queue-plugin' }],
  ['react-router', { pkg: 'react-router-plugin' }],
  ['realtime-backplane', { pkg: 'realtime-backplane-plugin' }],
  ['resilience', { pkg: 'resilience-plugin' }],
  ['scheduler', { pkg: 'scheduler-plugin' }],
  ['secrets', { pkg: 'secrets-plugin' }],
  ['sdk', { pkg: 'sdk' }],
  ['service-discovery', { pkg: 'service-discovery-plugin' }],
  ['session', { pkg: 'session-plugin' }],
  ['sse', { pkg: 'sse-plugin' }],
  ['static', { pkg: 'static-plugin' }],
  ['storage', { pkg: 'storage-plugin' }],
  ['testing', { pkg: 'testing', section: 'dev' }],
  ['telemetry', { pkg: 'telemetry-plugin' }],
  ['validation', { pkg: 'validation-plugin' }],
  ['websocket', { pkg: 'websocket-plugin' }],
  ['worker-pool', { pkg: 'worker-pool-plugin' }],
]);

const RUNTIME_RESTRICTIONS: ReadonlyMap<
  string,
  { readonly runtimes: readonly TargetRuntime[]; readonly reason: string }
> = new Map([
  [
    'cloudflare-plugin',
    {
      runtimes: ['cloudflare-workers'],
      reason: 'it requires Cloudflare Workers environment bindings at registration',
    },
  ],
  [
    'scheduler-plugin',
    {
      runtimes: ['deno', 'node', 'bun'],
      reason: 'the scheduler is unavailable on Cloudflare Workers',
    },
  ],
]);

/** One provider a decorated ingress class can resolve from the application. */
interface IPluginWiring {
  /** Factory exported by the provider package. */
  readonly symbol: string;
}

/**
 * Provider plugins that an emitted application config can activate safely.
 *
 * Every factory here has an in-memory, zero-configuration default. That makes
 * adding it to the CLI-generated config a coherent development
 * composition; providers that need credentials or a user-owned choice remain
 * manifest-only like every other `setu add` package.
 */
const ZERO_CONFIG_WIRINGS: ReadonlyMap<string, IPluginWiring> = new Map([
  ['cqrs-plugin', { symbol: 'CqrsPlugin' }],
  ['events-plugin', { symbol: 'EventsPlugin' }],
  ['messaging-plugin', { symbol: 'MessagingPlugin' }],
  ['queue-plugin', { symbol: 'QueuePlugin' }],
  ['scheduler-plugin', { symbol: 'SchedulerPlugin' }],
  ['websocket-plugin', { symbol: 'WebSocketPlugin' }],
  ['cache-plugin', { symbol: 'CachePlugin' }],
  ['health-plugin', { symbol: 'HealthPlugin' }],
  ['metrics-plugin', { symbol: 'MetricsPlugin' }],
  ['openapi-plugin', { symbol: 'OpenApiPlugin' }],
  ['sse-plugin', { symbol: 'SsePlugin' }],
  ['realtime-backplane-plugin', { symbol: 'RealtimeBackplanePlugin' }],
]);

/** Starter-owned options, including optional arms that must first be configured. */
const REST_ARMS: ReadonlyMap<string, string> = new Map([
  ['config-plugin', 'config'],
  ['logger-plugin', 'logger'],
  ['validation-plugin', 'validation'],
  ['http-security-plugin', 'httpSecurity'],
  ['health-plugin', 'health'],
  ['metrics-plugin', 'metrics'],
  ['openapi-plugin', 'openapi'],
  ['decorator-plugin', 'decorators'],
  ['database-plugin', 'database'],
  ['auth-plugin', 'auth'],
  ['websocket-plugin', 'realtime.websocket'],
  ['sse-plugin', 'realtime.sse'],
  ['realtime-backplane-plugin', 'realtime.backplane'],
  ['session-plugin', 'session'],
  ['di-plugin', 'di'],
  ['graphql-plugin', 'graphql'],
  ['service-discovery-plugin', 'serviceDiscovery'],
]);
const MICROSERVICE_ARMS: ReadonlyMap<string, string> = new Map([
  ...REST_ARMS,
  ['messaging-plugin', 'messaging'],
  ['queue-plugin', 'queue'],
  ['resilience-plugin', 'resilience'],
  ['telemetry-plugin', 'telemetry'],
]);
const FULL_STACK_ARMS: ReadonlyMap<string, string> = new Map([
  ...MICROSERVICE_ARMS,
  ['cache-plugin', 'cache'],
  ['events-plugin', 'events'],
  ['cqrs-plugin', 'cqrs'],
  ['scheduler-plugin', 'scheduler'],
  ['audit-plugin', 'audit'],
  ['secrets-plugin', 'secrets'],
  ['storage-plugin', 'storage'],
  ['mail-plugin', 'mail'],
  ['feature-flags-plugin', 'featureFlags'],
  ['notification-plugin', 'notifications'],
  ['multi-tenancy-plugin', 'multiTenancy'],
  ['react-router-plugin', 'reactRouter'],
  ['static-plugin', 'static'],
]);
const STARTER_ARMS = [
  { symbol: 'createRestApp', pkg: 'rest-starter', arms: REST_ARMS },
  { symbol: 'createMicroserviceApp', pkg: 'microservice-starter', arms: MICROSERVICE_ARMS },
  { symbol: 'createFullStackAppFromConfig', pkg: 'full-stack-starter', arms: FULL_STACK_ARMS },
] as const;

/** The concrete registration to show when configuration belongs to the application. */
function registrationLine(bare: string): string | undefined {
  const zero = ZERO_CONFIG_WIRINGS.get(bare);
  if (zero !== undefined) return `${zero.symbol}()`;
  if (bare === 'auth-plugin') return "AuthPlugin({ jwt: { secret: '<your-secret>' } })";
  if (bare === 'session-plugin') return "SessionPlugin({ secret: '<your-secret>' })";
  if (bare === 'grpc-plugin') return 'GrpcPlugin({ services: [] })';
  if (bare === 'database-plugin') return "DatabasePlugin({ type: 'memory' })";
  if (bare === 'feature-flags-plugin') return "FeatureFlagsPlugin({ provider: 'memory' })";
  if (bare === 'notification-plugin') return 'NotificationPlugin({ channels: {} })';
  if (bare === 'graphql-plugin') {
    return "GraphqlPlugin({ typeDefs: '<your-schema>', resolvers: {} })";
  }
  if (bare === 'static-plugin') return "StaticPlugin({ root: '<public-directory>' })";
  if (bare === 'react-router-plugin') {
    return "ReactRouterPlugin({ serverBuildPath: '<server-build-module>' })";
  }
  if (bare === 'multi-tenancy-plugin') return "MultiTenancyPlugin({ resolver: 'header' })";
  if (bare === 'service-discovery-plugin') {
    return "ServiceDiscoveryPlugin({ provider: 'static', services: {} })";
  }
  if (bare === 'cloudflare-plugin') return 'CloudflarePlugin({ env })';
  return undefined;
}

/** Explains the registration site without rewriting starter-owned composition. */
function printWiringNote(
  source: string | undefined,
  bare: string,
  log: (line: string) => void,
): void {
  const starter = source?.includes('export async function createApp(')
    ? STARTER_ARMS.find(({ pkg, symbol }) => providerBinding(source, pkg, symbol) !== undefined)
    : undefined;
  if (starter !== undefined) {
    const arm = starter.arms.get(bare);
    if (arm !== undefined) {
      log(`  ${starter.symbol} owns this plugin; configure its ${arm} arm in setu.config.ts.`);
      log(
        `  See https://github.com/setu-ts/setu-ts/blob/develop/packages/starters/${starter.pkg}/README.md`,
      );
      log(
        '  Registering a second instance with app.register would fail with a duplicate plugin name.',
      );
      return;
    }
  }
  const registration = registrationLine(bare);
  const factory = registration?.slice(0, registration.indexOf('('));
  const binding = source === undefined || factory === undefined
    ? undefined
    : providerBinding(source, bare, factory);
  const code = source === undefined ? undefined : maskSourceCode(source);
  if (binding !== undefined && (code?.includes(`${binding}(`) || code?.includes(`${binding} (`))) {
    return;
  }
  if (registration !== undefined && (source === undefined || !source.includes(registration))) {
    log(
      starter === undefined
        ? `  Register ${registration} in setu.config.ts.`
        : `  Register it after the factory returns: app.register(${registration});`,
    );
  }
}

/**
 * Resolves what the user typed to a bare package name.
 *
 * @param input - The `<plugin>` argument
 * @returns The bare package name, or `undefined` when it names nothing
 */
export function resolveAddablePackage(input: string): string | undefined {
  const bare = input.startsWith('@setu-ts/') ? input.slice('@setu-ts/'.length) : input;
  if ([...ADDABLE.values()].some((entry) => entry.pkg === bare)) return bare;
  return ADDABLE.get(bare)?.pkg;
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

  const entries = Object.entries(map);
  const keys = Object.keys(map);
  if (specifier in map) {
    map[specifier] = range;
    return `${JSON.stringify({ ...parsed, [section]: map }, null, 2)}\n`;
  }
  // Preserve the emitter's insertion order; a hand-sorted map stays sorted.
  const sorted = keys.every((key, index) => index === 0 || keys[index - 1]! < key);
  const scope = specifier.startsWith('@') ? specifier.slice(0, specifier.indexOf('/') + 1) : '';
  const afterScope = scope === '' ? -1 : keys.findLastIndex((key) => key.startsWith(scope));
  const sortedIndex = keys.findIndex((key) => key > specifier);
  const insertion = sorted
    ? (sortedIndex < 0 ? entries.length : sortedIndex)
    : (afterScope < 0 ? entries.length : afterScope + 1);
  entries.splice(insertion, 0, [specifier, range]);
  return `${JSON.stringify({ ...parsed, [section]: Object.fromEntries(entries) }, null, 2)}\n`;
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
  const code = maskSourceCode(source);
  if (code === undefined) return undefined;
  let offset = 0;
  for (const line of source.split('\n')) {
    const trimmed = line.trim();
    const codeLine = code.slice(offset, offset + line.length).trim();
    offset += line.length + 1;
    if (!codeLine.startsWith('import {')) continue;
    if (!trimmed.startsWith(importStart) || !trimmed.endsWith(importEnd)) continue;
    const specifiers = trimmed.slice(importStart.length, -importEnd.length).split(',');
    for (const specifier of specifiers) {
      const parts = specifier.trim().split(/\s+as\s+/);
      const binding = parts[1] ?? symbol;
      if (parts[0] === symbol && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(binding)) return binding;
    }
  }
  return undefined;
}

/**
 * Adds a zero-config provider above the emitted development-plugin anchor.
 *
 * Both generator styles share this anchor. A configuration with another
 * registration site receives guidance. An existing call stays byte-identical.
 *
 * @param source - Existing `setu.config.ts` contents
 * @param bare - Bare package name being added
 * @returns The updated config, or `undefined` when it is not an eligible
 * generated config or needs no change
 */
export function withPluginWiring(source: string, bare: string): string | undefined {
  const provider = ZERO_CONFIG_WIRINGS.get(bare);
  if (provider === undefined) return undefined;

  const anchor = '...(devtool?.plugins ?? []),';
  const scope = factoryScope(source);
  const code = scope?.code.slice(scope.start, scope.end);
  const anchorMatch = code === undefined
    ? null
    : /^[ \t]*\.\.\.\(devtool\?\.plugins \?\? \[\]\),[ \t]*$/m.exec(code);
  if (code === undefined || anchorMatch === null) {
    return undefined;
  }
  const providerImport = `import { ${provider.symbol} } from '@setu-ts/${bare}';`;
  const importedBinding = providerBinding(source, bare, provider.symbol);
  if (importedBinding === undefined && source.includes(`'@setu-ts/${bare}'`)) return undefined;
  const factory = importedBinding ?? provider.symbol;
  if (
    !source.includes(anchor) ||
    code.includes(`${factory}(`) ||
    code.includes(`${factory} (`)
  ) {
    return undefined;
  }

  const withImport = importedBinding === undefined ? `${providerImport}\n${source}` : source;
  const insertion = anchorMatch.index + anchorMatch[0].indexOf(anchor) +
    scope!.start +
    (importedBinding === undefined ? providerImport.length + 1 : 0);
  const lineStart = withImport.lastIndexOf('\n', insertion - 1) + 1;
  const indentation = withImport.slice(lineStart, insertion);
  return `${withImport.slice(0, insertion)}${factory}(),\n${indentation}${
    withImport.slice(insertion)
  }`;
}

/**
 * Adds a framework package to the project's manifest. For zero-configuration
 * providers, it also activates the provider in a recognized emitted
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

  const workspaceMarker = await findWorkspaceMarker(deps.fs, dir);
  if (workspaceMarker !== undefined) {
    deps.error(
      `${escapeName(dir)} is a workspace root (${
        escapeName(workspaceMarker)
      }); framework packages are pinned in each ` +
        `member, because \`${PROGRAM_NAME} generate\` reads the member's manifest to decide what ` +
        `is installed.`,
    );
    deps.error(`  Run it against a member: ${PROGRAM_NAME} add ${bare} --dir <member directory>`);
    return EXIT_USAGE;
  }

  let runtime: TargetRuntime;
  try {
    runtime = await detectTargetRuntime(deps.fs, dir);
  } catch (cause) {
    if (!(cause instanceof RuntimeMarkerUnreadableError)) throw cause;
    deps.error(cause.message);
    return EXIT_ERROR;
  }
  const restriction = RUNTIME_RESTRICTIONS.get(bare);
  if (restriction !== undefined && !restriction.runtimes.includes(runtime)) {
    deps.error(`Cannot add ${specifier} to a ${runtime} project: ${restriction.reason}.`);
    return EXIT_USAGE;
  }

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
    { file: 'deno.jsonc', section: 'imports', range: `jsr:${specifier}@^${VERSION}` },
    {
      file: 'package.json',
      section: [...ADDABLE.values()].find((entry) => entry.pkg === bare)?.section === 'dev'
        ? 'devDependencies'
        : 'dependencies',
      range: `npm:@jsr/setu-ts__${bare}@^${VERSION}`,
    },
  ];

  const edits: { readonly path: string; readonly contents: string }[] = [];
  let found = false;
  let alreadyPresent = false;

  for (const target of targets) {
    if (runtime === 'deno' && target.file === 'package.json') continue;
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
      const read = await readJsonManifest(deps.fs, path);
      if (read.kind === 'ok' && read.format === 'jsonc') {
        deps.error(
          `${
            escapeName(path)
          } is JSONC (comments, trailing commas); rewriting it would discard them. ` +
            `Add this line under "${target.section}" yourself: ` +
            `"${specifier}": "${target.range}"`,
        );
      } else {
        deps.error(`Cannot read ${escapeName(path)} as JSON; fix it and run this again.`);
      }
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
  let configSource: string | undefined;
  try {
    const config = new TextDecoder().decode(await deps.fs.readFile(configPath));
    const wired = withPluginWiring(config, bare);
    if (wired !== undefined) edits.push({ path: configPath, contents: wired });
    configSource = wired ?? config;
  } catch {
    // `setu add` remains useful for non-scaffolded projects. A missing config
    // simply has no generated ingress composition to activate.
  }

  if (!found) {
    deps.error(
      `No deno.json or package.json in ${escapeName(dir)} — this is not a Setu-TS project.`,
    );
    return EXIT_ERROR;
  }

  let existingSources: string | undefined;
  try {
    existingSources = new TextDecoder().decode(
      await deps.fs.readFile(joinPath(dir, DEVTOOL_SOURCES_MODULE)),
    );
  } catch {
    // A project without this managed module has not opted into source wiring.
  }
  if (existingSources !== undefined) {
    const installed = new Set(await detectPlugins(deps.fs, dir));
    installed.add(bare);
    const names = await readDevtoolSourceNames(deps.fs, dir, installed, configSource ?? '');
    const sources = renderDevtoolSources(installed, names);
    const sourcesPath = joinPath(dir, sources.path);
    if (existingSources !== sources.contents) {
      edits.push({ path: sourcesPath, contents: sources.contents });
    }
    if (configSource !== undefined) {
      const wiring = withDevtoolSourceWiring(configSource, installed);
      for (const line of wiring.manual) {
        deps.log(`  Configure the development source: ${escapeName(line)}`);
      }
      if (wiring.source !== configSource) {
        const configEdit = edits.findIndex((edit) => edit.path === configPath);
        if (configEdit >= 0) edits.splice(configEdit, 1);
        edits.push({ path: configPath, contents: wiring.source });
        configSource = wiring.source;
      }
    }
  }

  if (edits.length === 0 && alreadyPresent) {
    deps.log(`${specifier} is already installed in ${escapeName(dir)}.`);
    return EXIT_OK;
  }

  if (args.flags['dry-run'] === true) {
    for (const edit of edits) deps.log(`would update ${escapeName(edit.path)}`);
    return EXIT_OK;
  }

  let outcomes: Awaited<ReturnType<typeof writeFiles>>;
  try {
    outcomes = await writeFiles(
      deps.fs,
      edits.map((edit) => ({ ...edit, managed: true })),
      deps.interrupt === undefined ? { root: dir } : { root: dir, signal: deps.interrupt },
    );
  } catch (cause) {
    const interrupted = interruptionMessage(cause);
    if (interrupted !== undefined) {
      deps.error(interrupted);
      return EXIT_INTERRUPTED;
    }
    deps.error(
      `Failed to update the manifest: ${
        escapeName(cause instanceof Error ? cause.message : String(cause))
      }`,
    );
    return EXIT_ERROR;
  }
  for (const outcome of outcomes) deps.log(`${outcome.outcome} ${escapeName(outcome.path)}`);
  deps.log('');
  deps.log('Next:');
  deps.log(`  ${installCommand(runtime)}`);
  printWiringNote(configSource, bare, deps.log);
  // Deno is excluded on measurement, not assumption: a Deno full-stack project
  // carries a `package.json` (its Vite build) and no `.npmrc`, and
  // `deno install` resolves the `npm:@jsr/…` entry there without one.
  if (runtime !== 'deno' && edits.some((edit) => edit.path === joinPath(dir, 'package.json'))) {
    await printJsrRegistryNote(deps.fs, dir, deps.log);
  }
  printPermissionNote(specifier, deps.log);
  return EXIT_OK;
}

/**
 * Reports why a directory is a workspace root, or `undefined` when it is not.
 *
 * `setu add` at a root used to write the pin into the root manifest and exit 0.
 * Nothing reads it there: plugin gating reads the MEMBER's manifest, so the
 * package looked installed while every member's `generate` still refused the
 * schematics it unlocks. Three markers, because a root is recognisable three
 * ways — the CLI's own workspace manifest, a Deno `workspace` key, and an npm
 * or Bun `workspaces` key — and a hand-built workspace may carry only one.
 *
 * @param fs - The filesystem to read through
 * @param dir - The target directory
 * @returns The marker found, for the refusal to name
 */
/**
 * The install command for a project's toolchain.
 *
 * It used to be `deno install` unconditionally, so a Node or Bun project was
 * told to run a command its toolchain does not use. The commands match what
 * `setu new` prints for each target. Workers installs through npm, because
 * `wrangler` bundles from `node_modules`; its `deno.json` exists only for
 * plugin gating.
 *
 * @param runtime - The detected target runtime
 * @returns The command to print
 */
function installCommand(runtime: TargetRuntime): string {
  switch (runtime) {
    case 'deno':
      // `--min-dep-age 0` for the same reason the generated manifest carries
      // `minimumDependencyAge` (D1): this pin is the CLI's own version, which on
      // release day is younger than the policy allows.
      return 'deno install --min-dep-age 0';
    case 'bun':
      return 'bun install';
    case 'node':
    case 'cloudflare-workers':
      return 'npm install';
  }
}

/** The registry line npm and Bun need to resolve an `npm:@jsr/…` entry. */
const JSR_REGISTRY_LINE = '@jsr:registry=https://npm.jsr.io';

/**
 * Warns when a `package.json` entry was written that the project cannot resolve.
 *
 * The entry is `npm:@jsr/setu-ts__<pkg>`, which npm and Bun look up on the npm
 * registry unless an `.npmrc` routes the `@jsr` scope to JSR. `setu new` emits
 * that file; a project assembled by hand may not have it, and the install would
 * then fail naming a package that does not exist on npm.
 *
 * @param fs - The filesystem to read through
 * @param dir - The project directory
 * @param log - Output sink
 */
async function printJsrRegistryNote(
  fs: IFileSystem,
  dir: string,
  log: (message: string) => void,
): Promise<void> {
  try {
    const npmrc = new TextDecoder().decode(await fs.readFile(joinPath(dir, '.npmrc')));
    if (npmrc.split('\n').some((line) => line.trim() === JSR_REGISTRY_LINE)) return;
  } catch {
    // Missing: fall through to the note.
  }
  log('');
  log('Note:');
  log(`  Add this line to ${escapeName(joinPath(dir, '.npmrc'))}, or the install cannot`);
  log('  find @jsr packages:');
  log(`    ${JSR_REGISTRY_LINE}`);
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
  log('are the same command. This writes the manifest and does not install for');
  log("you; it prints the project's install command (deno, npm or bun) to run.");
}
