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

import { planViewSetup, VIEWS_CONTROLLER } from './add-view.ts';
import { diagnoseProject } from '../diagnostics/diagnose.ts';
import {
  CONTROLLERS_SEAM,
  FUNCTIONAL_CONTROLLERS_SEAM,
  HTTP_SEAM_DIR,
  withControllerArtifact,
} from '../seams/http.ts';
import { renderModuleIndex } from '../seams/modules.ts';
import { formatForTarget } from '../utils/prettier-format.ts';
import { afterLastImport } from '../utils/import-placement.ts';
import type { IFileSystem } from '@setu-ts/common';
import { deriveNames, escapeName, isKebabIdentifier } from '../utils/names.ts';
import type { ParsedArgs } from '../args.ts';
import {
  EXIT_ERROR,
  EXIT_INTERRUPTED,
  EXIT_OK,
  EXIT_USAGE,
  PROGRAM_NAME,
  type TargetRuntime,
} from '../constants.ts';
import {
  type GeneratedFile,
  findExisting,
  joinPath,
  readExistingText,
  resolveDir,
  writeFiles,
} from '../utils/file-writer.ts';
import { frameworkSpecifier } from '../templates/framework-specifier.ts';
import { BROKER_COMPOSE_FILE, cliInvocation, resolveHost } from '../templates/project-files.ts';
import { MINIMAL_HOST } from '../templates/minimal.ts';
import {
  brokerComposeFiles,
  missingComposeServices,
  readArmFlag,
  redisClientRefusal,
  standaloneOverlayRefusal,
  starterOptionLiteral,
} from '../templates/broker.ts';
import {
  starterOptionValue,
  withStarterOption,
  withStarterArmEntry,
  starterLiteralEntries,
} from './starter-options.ts';
import { stringFlag } from '../args.ts';
import { BRIEF_BEGIN } from '../agents/brief-file.ts';
import { detectTargetRuntime, RuntimeMarkerUnreadableError } from '../utils/runtime-detector.ts';
import { findWorkspaceMarker } from '../utils/project-detector.ts';
import { readJsonManifest } from '../utils/manifest-reader.ts';
import { interruptionMessage } from '../utils/interruption.ts';
import { detectPlugins } from '../utils/plugin-detector.ts';
import { composingStarter } from '../utils/starter-arms.ts';
import { repositoryFileUrl } from '../utils/repository-links.ts';
import { hostSeamSpecs } from '../seams/registry.ts';
import {
  seamFiles,
  seamLocalImports,
  withPluginOptionSeams,
  STARTER_SEAMS,
  starterSeamLiteral,
} from '../templates/seam.ts';
import { renderPluginCall } from '../utils/render-call.ts';
import { installSearchDirs, unknownWorkspaceRedisClient } from '../app-loader.ts';
import { MEMBERS_DIR, readWorkspaceManifest, type WorkspaceMember } from '../workspace/manifest.ts';
import { transportSpec, renderConnection, type TransportSpec } from '../workspace/transport.ts';
import { workspaceProfile } from '../workspace/runtime-profile.ts';
import { CLIENT_RANGES } from '../templates/client-dependencies.ts';
import {
  NODE_REDIS_FACTORY,
  NODE_REDIS_IMPORT,
  NODE_REDIS_IMPORT_LINE,
  NODE_REDIS_MODULE_PATH,
  nodeRedisModuleFile,
} from '../templates/node-redis.ts';
import {
  callArguments,
  callsIdentifier,
  DEVTOOL_SOURCES_MODULE,
  factoryScope,
  frameworkImportsRetargeted,
  maskComments,
  maskImportDeclarations,
  maskSourceCode,
  packageSpecifierCount,
  parseImportItem,
  readDevtoolSourceNames,
  referencesIdentifier,
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
  /**
   * Optional peer packages a package manager will not install for the
   * consumer. Written on the runtimes listed here, at their
   * {@linkcode CLIENT_RANGES} range: into `package.json` `dependencies`, or
   * into a `deno.json`/`deno.jsonc` import map as `npm:<name>@<range>`.
   */
  readonly peers?: {
    readonly runtimes: readonly TargetRuntime[];
    readonly packages: readonly string[];
  };
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
export const ADDABLE: ReadonlyMap<string, IAddablePackage> = new Map([
  ['audit', { pkg: 'audit-plugin' }],
  ['auth', { pkg: 'auth-plugin' }],
  ['cache', { pkg: 'cache-plugin' }],
  ['cloudflare', { pkg: 'cloudflare-plugin' }],
  ['common', { pkg: 'common' }],
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
  ['idempotency', { pkg: 'idempotency-plugin' }],
  ['localization', { pkg: 'localization-plugin' }],
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
  [
    'telemetry',
    {
      pkg: 'telemetry-plugin',
      peers: {
        runtimes: ['node', 'bun', 'deno'],
        packages: [
          '@opentelemetry/api',
          '@opentelemetry/sdk-trace-base',
          '@opentelemetry/resources',
          '@opentelemetry/context-async-hooks',
        ],
      },
    },
  ],
  [
    'validation',
    {
      pkg: 'validation-plugin',
      peers: { runtimes: ['deno', 'node', 'bun', 'cloudflare-workers'], packages: ['zod'] },
    },
  ],
  [
    'view',
    {
      pkg: 'view-plugin',
      peers: { runtimes: ['node', 'bun', 'deno', 'cloudflare-workers'], packages: ['hono'] },
    },
  ],
  ['websocket', { pkg: 'websocket-plugin', peers: { runtimes: ['node'], packages: ['ws'] } }],
  ['worker-pool', { pkg: 'worker-pool-plugin' }],
]);

export const RUNTIME_RESTRICTIONS: ReadonlyMap<
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
  ['worker-pool-plugin', { symbol: 'WorkerPoolPlugin' }],
  ['secrets-plugin', { symbol: 'SecretsPlugin' }],
  ['storage-plugin', { symbol: 'StoragePlugin' }],
  ['audit-plugin', { symbol: 'AuditPlugin' }],
  ['mail-plugin', { symbol: 'MailPlugin' }],
  ['resilience-plugin', { symbol: 'ResiliencePlugin' }],
  ['view-plugin', { symbol: 'ViewPlugin' }],
  ['idempotency-plugin', { symbol: 'IdempotencyPlugin' }],
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

/**
 * The generated-artifact seam a zero-config provider consumes through its options.
 *
 * `setu new` wires each seam into `setu.config.ts` at scaffold time (for example
 * `EventsPlugin({ handlers: EVENT_HANDLERS })` on `microservice`). `setu add` used to
 * insert the bare call instead, so every handler a later `setu generate` wrote into
 * the seam barrel was registered by nothing — the M60 defect class. This carries the
 * same wiring `setu new` emits, derived from the same seam registry.
 */
export interface AddSeam {
  /** Options argument for the provider call, e.g. `{ handlers: EVENT_HANDLERS }`. */
  readonly args: string;
  /** Config imports that bring the barrel symbols into scope. */
  readonly imports: readonly { readonly symbols: readonly string[]; readonly from: string }[];
  /** The seam barrels, rendered empty, for a project that has none yet. */
  readonly files: readonly GeneratedFile[];
}

/**
 * The members of a CLI-authored object literal, without its braces, edge
 * whitespace or trailing comma — so two of them join with one `, `.
 *
 * @param literal - An object literal such as `{ adapter: 'redis' }`
 * @returns Its members, e.g. `adapter: 'redis'`
 */
function objectBody(literal: string): string {
  return literal.trim().slice(1, -1).trim().replace(/,$/, '').trim();
}

/**
 * Resolves the seam a provider consumes in a project with the given packages.
 *
 * Class-based projects receive handlers through `DecoratorPlugin`'s ingress barrel,
 * so `hostSeamSpecs` omits the functional event and CQRS seams there and this
 * returns `undefined` — the bare call stays correct.
 *
 * @param bare - Bare package name being added
 * @param installed - Bare package names installed after this add
 * @returns The seam wiring, or `undefined` when the provider consumes none
 */
export function addSeam(bare: string, installed: ReadonlySet<string>): AddSeam | undefined {
  const provider = ZERO_CONFIG_WIRINGS.get(bare);
  if (provider === undefined) return undefined;
  const specs = hostSeamSpecs(installed).filter((spec) => spec.requiresPlugin === bare);
  if (specs.length === 0) return undefined;
  const args = withPluginOptionSeams([{ pkg: bare, symbol: provider.symbol }], specs)[0]?.args;
  if (args === undefined) return undefined;
  return { args, imports: seamLocalImports(specs), files: seamFiles(specs) };
}

/** The concrete registration to show when configuration belongs to the application. */
function registrationLine(bare: string): string | undefined {
  const zero = ZERO_CONFIG_WIRINGS.get(bare);
  if (zero !== undefined) return `${zero.symbol}()`;
  // `rbac` is what registers the authorization service a generated guard asks;
  // without it every permission check answers 501.
  if (bare === 'auth-plugin') {
    return "AuthPlugin({ jwt: { secret: '<your-secret>' }, rbac: { roles: {} } })";
  }
  if (bare === 'session-plugin') return "SessionPlugin({ secret: '<your-secret>' })";
  if (bare === 'telemetry-plugin') {
    return "TelemetryPlugin({ serviceName: '<service-name>', exporter: 'console' })";
  }
  if (bare === 'localization-plugin') {
    return "LocalizationPlugin({ supportedLocales: ['en'], catalogues: { en: {} } })";
  }
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
  if (bare === 'cloudflare-plugin') {
    // M113d §3.8: `setu add cloudflare` is accepted only on cloudflare-workers,
    // whose generated factory takes the platform sink as its second parameter.
    // The spread is required under `exactOptionalPropertyTypes`: `setu commands`
    // calls the factory with no `waitUntil`.
    return 'CloudflarePlugin({ env, ...(waitUntil ? { waitUntil } : {}) })';
  }
  return undefined;
}

/**
 * Whether an existing option or call argument already carries exactly these options.
 *
 * Compared with whitespace and trailing commas removed, because Prettier rewraps the
 * literal an npm-target project was written with, and on the literal's properties rather
 * than its braces, because a generated call may carry a seam property first
 * (`processors: [...QUEUE_PROCESSORS]`). Callers pass the one option or call they read, never
 * the whole file, so an unrelated object cannot match (PR #519 review).
 *
 * @param existing - The existing option value or call arguments
 * @param literal - The options this command would write
 * @returns `true` when the same options are present
 */
function sameOptions(existing: string, literal: string): boolean {
  const normalize = (text: string): string => text.replace(/\s+/g, '').replace(/,([}\])])/g, '$1');
  const body = normalize(literal).replace(/^\{|\}$/g, '');
  return body !== '' && normalize(existing).includes(body);
}

/**
 * The source text of each call's arguments to a provider inside the app factory.
 *
 * Calls are found on masked code, so a mention in a comment or string is not a call, and
 * read back from the source at the same offsets, so string values can be compared.
 *
 * @param source - The config source
 * @param bare - Bare package name of the provider
 * @param symbol - The provider's factory export
 * @returns Each call's argument text; empty when the factory is not classified
 */
function providerCallArguments(source: string, bare: string, symbol: string): readonly string[] {
  const binding = providerBinding(source, bare, symbol);
  const scope = factoryScope(source);
  if (binding === undefined || scope === undefined) return [];
  const found: string[] = [];
  const call = new RegExp(`(?<![\\w$.])${binding}\\s*\\(`, 'g');
  for (const match of scope.code.slice(scope.start, scope.end).matchAll(call)) {
    const open = scope.start + match.index + match[0].length - 1;
    let depth = 0;
    for (let at = open; at < scope.end; at++) {
      const c = scope.code[at];
      if (c === '(' || c === '{' || c === '[') depth++;
      else if ((c === ')' || c === '}' || c === ']') && --depth === 0) {
        found.push(source.slice(open + 1, at));
        break;
      }
    }
  }
  return found;
}

/**
 * Whether a configuration imports the node-redis helper, in either quote style;
 * comments are masked so a commented-out import does not count.
 *
 * @param source - The configuration source
 * @returns `true` when the helper is imported
 */
function importsNodeRedisHelper(source: string): boolean {
  const visible = maskComments(source) ?? source;
  return (
    visible.includes(`from '${NODE_REDIS_IMPORT.from}'`) ||
    visible.includes(`from "${NODE_REDIS_IMPORT.from}"`)
  );
}

/**
 * Names the node-redis helper's import when the configuration does not have it.
 *
 * Every guidance line for the node-redis arm calls `nodeRedisClient(...)`; a
 * configuration this run did not wire has no import of it, and without this line
 * the printed call would not compile.
 *
 * @param source - The configuration, if readable
 * @param clients - The client packages the selected transport installs
 * @param log - Where guidance goes
 */
function printNodeRedisImportNote(
  source: string | undefined,
  clients: readonly string[],
  log: (line: string) => void,
): void {
  if (!clients.includes('redis')) return;
  if (source !== undefined && importsNodeRedisHelper(source)) return;
  log(`  Import ${NODE_REDIS_FACTORY} from '${NODE_REDIS_IMPORT.from}' for it.`);
}

/** Explains the registration site without rewriting starter-owned composition. */
function printWiringNote(
  source: string | undefined,
  bare: string,
  log: (line: string) => void,
  seam?: AddSeam,
  transportArgs?: string,
): void {
  const starter = source === undefined ? undefined : composingStarter(source);
  if (starter !== undefined) {
    const arm = starter.arms.get(bare);
    if (arm !== undefined) {
      if (bare === 'messaging-plugin' || bare === 'queue-plugin') {
        const key = bare === 'messaging-plugin' ? 'messaging' : 'queue';
        const flag = key === 'messaging' ? 'broker' : 'queue';
        // The factory's own option, read with the same analysis withStarterOption edits
        // through; undefined for a hand-written starter config the CLI does not classify.
        const existing = source === undefined ? undefined : starterOptionValue(source, key);
        if (transportArgs === undefined) {
          log(
            existing === undefined
              ? `  ${starter.symbol} already registers ${key} in memory by default; select a backend with setu add ${key} --${flag} <name> (standalone), or configure its ${key} property.`
              : `  setu.config.ts already sets its own ${key} option; it was left as it is.`,
          );
        } else if (existing !== undefined && sameOptions(existing, transportArgs)) {
          log(`  setu.config.ts already sets these ${key} options.`);
        } else if (existing !== undefined) {
          log(`  The existing ${key} option was preserved; to use this transport, set:`);
          log(`  ${key}: ${transportArgs},`);
        } else {
          log(`  In setu.config.ts: ${key}: ${transportArgs},`);
        }
        return;
      }
      log(`  ${starter.symbol} owns this plugin; configure its ${arm} arm in setu.config.ts.`);
      // The barrel exists by now; without this line nothing would ever pass it to
      // the arm, so every handler generated into it would register nowhere.
      if (seam !== undefined) {
        log(`  Pass the generated artifacts through it: ${arm}: ${seam.args}`);
        for (const item of seam.imports) {
          log(`  Import ${item.symbols.join(', ')} from '${item.from}' for it.`);
        }
      }
      log(`  See ${repositoryFileUrl(`packages/starters/${starter.pkg}/README.md`)}`);
      log(
        '  Once that arm is configured, registering a second instance with app.register fails' +
          ' with a duplicate plugin name.',
      );
      return;
    }
  }
  const registration = registrationLine(bare);
  const factory = registration?.slice(0, registration.indexOf('('));
  // Guidance is suppressed only by a real call in code. Inserting refuses on any
  // possible use (fail closed); guidance must not ALSO go quiet then, or a mention
  // in a string would leave the plugin unregistered with nothing said (audit 4).
  // Only a call inside the createApp body counts: a same-named method or
  // signature elsewhere registers nothing (audit round 6, G-R6). A plugin built at
  // module scope therefore still gets the line — guidance fails open.
  if (
    source !== undefined &&
    factory !== undefined &&
    factoryCallsProvider(source, bare, factory)
  ) {
    if (transportArgs !== undefined)
      log(
        providerCallArguments(source, bare, factory).some((args) =>
          sameOptions(args, transportArgs),
        )
          ? `  setu.config.ts already passes these options to ${factory}.`
          : `  Set ${factory}(${transportArgs}) in setu.config.ts; the existing call was preserved.`,
      );
    for (const line of seamGapLines(source, bare, seam)) log(line);
    return;
  }
  // No raw-text check here: a string or comment containing the registration's
  // text silenced the guidance for a plugin nothing registers (audit round 5).
  // Only a real call in classified code, checked above, suppresses it.
  if (registration !== undefined) {
    const call =
      transportArgs !== undefined
        ? `${factory}(${transportArgs})`
        : seam === undefined
          ? registration
          : `${factory}(${seam.args})`;
    log(
      starter === undefined
        ? `  Register ${call} in setu.config.ts.`
        : `  Register it after the factory returns: app.register(${call});`,
    );
    for (const item of seam?.imports ?? []) {
      log(`  Import ${item.symbols.join(', ')} from '${item.from}' for it.`);
    }
  }
}

/**
 * Guidance for a provider the factory already calls WITHOUT the seam it consumes.
 *
 * A config that registers a bare `EventsPlugin()` — the shape `setu add` emitted
 * before it learned the seam, and the shape a hand-written config may carry —
 * leaves every handler generated into `src/events/index.ts` registered nowhere.
 * Neither the insert nor the "Register …" guidance fires for it, since the call
 * exists, so this is the one place that says what the call is missing.
 *
 * @param source - The config source, if readable
 * @param bare - Bare package name being added
 * @param seam - The seam the provider consumes, if any
 * @returns The lines to print; empty when there is nothing to say
 */
function seamGapLines(
  source: string | undefined,
  bare: string,
  seam: AddSeam | undefined,
): readonly string[] {
  if (seam === undefined || source === undefined) return [];
  // A starter that owns the plugin has its own arm guidance; one that does not
  // (a REST starter has no `events` arm) leaves the call ours to check.
  if (composingStarter(source)?.arms.has(bare) === true) return [];
  const provider = ZERO_CONFIG_WIRINGS.get(bare);
  if (provider === undefined) return [];
  const binding = providerBinding(source, bare, provider.symbol);
  const scope = factoryScope(source);
  if (binding === undefined || scope === undefined) return [];
  const calls = callArguments(scope.code.slice(scope.start, scope.end), binding);
  if (calls.length === 0) return [];
  // The CALL's own arguments decide, not a reference anywhere in the factory: a
  // body that reads the barrel elsewhere and calls the provider bare still
  // registers nothing. Fails open — options built elsewhere and passed by name
  // draw the line, which says too much rather than nothing.
  const symbols = seam.imports.flatMap((item) => item.symbols);
  const wired = calls.some((args) => symbols.every((symbol) => referencesIdentifier(args, symbol)));
  if (wired) return [];
  return [
    `  The existing ${binding}(…) call does not pass the generated artifacts; give it ${seam.args}.`,
    ...seam.imports
      .filter((item) => !source.includes(`'${item.from}'`) && !source.includes(`"${item.from}"`))
      .map((item) => `  Import ${item.symbols.join(', ')} from '${item.from}' for it.`),
  ];
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
 * Reports a `package.json` that already pins the package, at this range, in the
 * npm section this command would NOT write. A scaffold may list a package under
 * `dependencies` that `setu add` places under `devDependencies` (or the reverse);
 * adding it to the second section would pin it twice. Malformed JSON answers
 * `false` so the caller's own parse reports it.
 *
 * @param source - The manifest's current contents
 * @param file - The manifest's file name
 * @param section - The section this command would write
 * @param specifier - The package specifier
 * @param range - The range this command would record
 * @returns Whether the other npm section already holds the identical pin
 */
export function pinnedInOtherNpmSection(
  source: string,
  file: string,
  section: string,
  specifier: string,
  range: string,
): boolean {
  if (file !== 'package.json') return false;
  const other = section === 'devDependencies' ? 'dependencies' : 'devDependencies';
  try {
    const parsed = JSON.parse(source) as Record<string, unknown>;
    const map = parsed[other];
    return (
      map !== null &&
      typeof map === 'object' &&
      (map as Record<string, unknown>)[specifier] === range
    );
  } catch {
    return false;
  }
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
  const map =
    existing !== null && typeof existing === 'object'
      ? { ...(existing as Record<string, string>) }
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
    ? sortedIndex < 0
      ? entries.length
      : sortedIndex
    : afterScope < 0
      ? entries.length
      : afterScope + 1;
  entries.splice(insertion, 0, [specifier, range]);
  return `${JSON.stringify({ ...parsed, [section]: Object.fromEntries(entries) }, null, 2)}\n`;
}

/**
 * The optional peer packages a package needs installed on a given runtime.
 *
 * @param bare - Bare package name being added
 * @param runtime - The detected target runtime
 * @returns Each peer and the range to record for it; empty when the package
 * declares none or the runtime is not listed
 */
function peerPackagesFor(
  bare: string,
  runtime: TargetRuntime,
): readonly { readonly name: string; readonly range: string }[] {
  const peers = [...ADDABLE.values()].find((entry) => entry.pkg === bare)?.peers;
  if (peers === undefined || !peers.runtimes.includes(runtime)) return [];
  return peers.packages.map((name) => {
    const range = CLIENT_RANGES[name];
    if (range === undefined) {
      throw new Error(`No client range for peer ${name}; add it to CLIENT_RANGES.`);
    }
    return { name, range };
  });
}

/** One root override that pins a package itself. */
interface IRootOverride {
  /** The spec the override names (a string value, or an object's `"."` entry). */
  readonly spec: string;
  /**
   * Whether the override is conditional: its key carried a version selector
   * (`ioredis@5`), or the package has more than one rule. It then applies only
   * to matching versions, which this command cannot evaluate.
   */
  readonly selector: boolean;
}

/**
 * The root overrides in a manifest's npm `overrides` that pin packages
 * THEMSELVES, at its top level, keyed by package name with any `@<range>`
 * selector on a key removed (`ioredis@5` → `ioredis`). A string value is the
 * spec; an object value pins the package only through its `"."` entry — an
 * object without one overrides the package's children, not the package, so it
 * is not returned.
 *
 * @param source - The root `package.json` text
 * @returns Each pinned package's override
 * @throws {SyntaxError} When the text is not JSON
 */
function rootOverrides(source: string): ReadonlyMap<string, IRootOverride> {
  const overrides = (JSON.parse(source) as { overrides?: unknown }).overrides;
  const pinned = new Map<string, IRootOverride>();
  if (overrides === null || typeof overrides !== 'object' || Array.isArray(overrides))
    return pinned;
  for (const [key, value] of Object.entries(overrides as Record<string, unknown>)) {
    const spec =
      typeof value === 'string'
        ? value
        : value !== null && typeof value === 'object' && Object.hasOwn(value, '.')
          ? (value as Record<string, unknown>)['.']
          : undefined;
    if (typeof spec !== 'string') continue;
    const at = key.indexOf('@', key.startsWith('@') ? 1 : 0);
    const name = at === -1 ? key : key.slice(0, at);
    // npm applies the first rule that matches the chosen version, so several
    // rules for one package (`x@1` and `x@2`, or `x` beside `x@2`) cannot be
    // reduced to one spec here: the name is treated as conditional.
    pinned.set(name, { spec, selector: at !== -1 || pinned.has(name) });
  }
  return pinned;
}

/**
 * The npm sections a production install keeps (`npm install --omit=dev` drops
 * `devDependencies`, not these), any of which means a peer is already declared.
 * `peerDependencies` is one: measured with npm 11 and Bun 1.4, both install a
 * project's own peer entry, so a second entry beside it would replace its pin.
 */
const PRODUCTION_SECTIONS = ['dependencies', 'optionalDependencies', 'peerDependencies'] as const;

/**
 * The names a `package.json` already declares in a section a production install
 * keeps. Measured with npm 11: a root listing a package in `devDependencies` at
 * one version and in `dependencies` at another installs the `devDependencies`
 * version, so a second entry beside an existing one changes nothing; a peer
 * declared only in `devDependencies` is instead MOVED to `dependencies` by
 * {@linkcode withPeerDependencies}, because `--omit=dev` would drop it.
 *
 * @param parsed - The parsed manifest
 * @returns The declared names
 */
function declaredNames(parsed: Record<string, unknown>): ReadonlySet<string> {
  const names = new Set<string>();
  const optional = optionalPeerPins(parsed);
  for (const section of PRODUCTION_SECTIONS) {
    const entries = parsed[section];
    if (entries !== null && typeof entries === 'object' && !Array.isArray(entries)) {
      for (const name of Object.keys(entries)) {
        // An optional peer installs nothing (measured: npm 11 and Bun 1.4), so
        // it is not a declaration of an installed package.
        if (section === 'peerDependencies' && optional.has(name)) continue;
        names.add(name);
      }
    }
  }
  return names;
}

/**
 * The `peerDependencies` entries `peerDependenciesMeta` marks optional, with
 * their specs. Measured with npm 11 and Bun 1.4: neither installs such a peer,
 * so a runtime peer declared only this way is added to `dependencies` at the
 * declared spec, leaving the peer declaration as it is.
 *
 * @param parsed - The parsed manifest
 * @returns Each optional peer and its declared spec
 */
function optionalPeerPins(parsed: Record<string, unknown>): ReadonlyMap<string, string> {
  const peers = parsed['peerDependencies'];
  const meta = parsed['peerDependenciesMeta'];
  const pins = new Map<string, string>();
  if (peers === null || typeof peers !== 'object' || Array.isArray(peers)) return pins;
  if (meta === null || typeof meta !== 'object' || Array.isArray(meta)) return pins;
  for (const [name, spec] of Object.entries(peers as Record<string, unknown>)) {
    const entry = (meta as Record<string, unknown>)[name];
    const isOptional =
      entry !== null &&
      typeof entry === 'object' &&
      (entry as Record<string, unknown>)['optional'] === true;
    if (isOptional && typeof spec === 'string') pins.set(name, spec);
  }
  return pins;
}

/** Every npm section a workspace member can pin a package in. */
const PIN_SECTIONS = [...PRODUCTION_SECTIONS, 'devDependencies'] as const;

/** One existing pin of a package somewhere in the workspace. */
interface IWorkspacePin {
  /** The manifest that pins it. */
  readonly path: string;
  /** The spec it is pinned at. */
  readonly spec: string;
}

/**
 * The pins the workspace's members already hold for the given packages, in any
 * section, read before this command writes anything. A member whose manifest
 * cannot be read is skipped: it cannot conflict with what npm will not install.
 *
 * @param fs - The filesystem to read through
 * @param root - The workspace root
 * @param members - The workspace's members
 * @param names - The package names to look for
 * @returns Each package's existing pins
 */
async function workspacePins(
  fs: IFileSystem,
  root: string,
  members: readonly WorkspaceMember[],
  names: ReadonlySet<string>,
): Promise<ReadonlyMap<string, readonly IWorkspacePin[]>> {
  const pins = new Map<string, IWorkspacePin[]>();
  for (const member of members) {
    const path = joinPath(root, joinPath(MEMBERS_DIR, joinPath(member.name, 'package.json')));
    let parsed: Record<string, unknown>;
    try {
      const text = await readExistingText(fs, path);
      if (text === undefined) continue;
      parsed = JSON.parse(text.replace(/^\uFEFF/, '')) as Record<string, unknown>;
    } catch {
      continue;
    }
    for (const section of PIN_SECTIONS) {
      const entries = parsed[section];
      if (entries === null || typeof entries !== 'object' || Array.isArray(entries)) continue;
      for (const [name, spec] of Object.entries(entries as Record<string, unknown>)) {
        if (!names.has(name) || typeof spec !== 'string') continue;
        pins.set(name, [...(pins.get(name) ?? []), { path, spec }]);
      }
    }
  }
  return pins;
}

/**
 * Adds optional peer packages to a manifest's `dependencies`, never replacing
 * an existing pin.
 *
 * `setu add websocket` on Node must install `ws` — an optional peer of
 * `@setu-ts/runtime` that a package manager will not install for the consumer —
 * or the first upgrade answers 500 with nothing in the log. A peer already
 * pinned at any range is left exactly as it is: a hand-pinned version may be
 * deliberate, and this command cannot know why.
 *
 * @param source - The manifest's current contents
 * @param peers - Each peer and the range to record for it
 * @returns The rewritten manifest and the peers actually added
 */
function withPeerDependencies(
  source: string,
  peers: readonly { readonly name: string; readonly range: string }[],
  section: 'dependencies' | 'imports',
): {
  readonly contents: string;
  readonly added: readonly string[];
  readonly moved: readonly string[];
} {
  if (peers.length === 0) return { contents: source, added: [], moved: [] };
  const parsed = JSON.parse(source) as Record<string, unknown>;
  const existing = parsed[section];
  const dependencies =
    existing !== null && typeof existing === 'object'
      ? { ...(existing as Record<string, string>) }
      : {};
  const declared = section === 'dependencies' ? declaredNames(parsed) : new Set<string>();
  const optionalPins = optionalPeerPins(parsed);
  const devSection = parsed['devDependencies'];
  const dev =
    section === 'dependencies' &&
    devSection !== null &&
    typeof devSection === 'object' &&
    !Array.isArray(devSection)
      ? { ...(devSection as Record<string, string>) }
      : undefined;
  const added: string[] = [];
  const moved: string[] = [];
  for (const peer of peers) {
    if (peer.name in dependencies || declared.has(peer.name)) continue;
    const optionalPin = section === 'dependencies' ? optionalPins.get(peer.name) : undefined;
    if (optionalPin !== undefined) {
      dependencies[peer.name] = optionalPin;
      added.push(peer.name);
      continue;
    }
    const devPin = dev?.[peer.name];
    if (dev !== undefined && typeof devPin === 'string') {
      // A runtime peer declared only for development: `--omit=dev` would drop
      // it, so its existing pin moves to `dependencies` unchanged.
      dependencies[peer.name] = devPin;
      delete dev[peer.name];
      moved.push(peer.name);
      continue;
    }
    dependencies[peer.name] = section === 'imports' ? `npm:${peer.name}@${peer.range}` : peer.range;
    added.push(peer.name);
  }
  if (added.length === 0 && moved.length === 0) return { contents: source, added: [], moved: [] };
  const rewritten: Record<string, unknown> = { ...parsed, [section]: dependencies };
  if (moved.length > 0) rewritten['devDependencies'] = dev;
  return { contents: `${JSON.stringify(rewritten, null, 2)}\n`, added, moved };
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
      const item = parseImportItem(specifier);
      if (item?.symbol === symbol && /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(item.local)) {
        return item.local;
      }
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
 * @param seam - The generated-artifact seam the provider consumes, if any: the
 * call then carries its options and the barrel imports are added
 * @param args - Explicit options for a classified insertion (including StaticPlugin); takes precedence over seam args
 * @returns The updated config, or `undefined` when it is not an eligible
 * generated config or needs no change
 */
export function withPluginWiring(
  source: string,
  bare: string,
  seam?: AddSeam,
  args?: string,
): string | undefined {
  const provider =
    ZERO_CONFIG_WIRINGS.get(bare) ??
    (bare === 'static-plugin' && args !== undefined ? { symbol: 'StaticPlugin' } : undefined);
  if (provider === undefined) return undefined;

  const anchor = '...(devtool?.plugins ?? [])';
  const scope = factoryScope(source);
  const code = scope?.code.slice(scope.start, scope.end);
  // The spread as an ARRAY ELEMENT: followed by `,` or `]`, on its own line (the
  // CLI's Deno rendering) or inline (Prettier's rendering of a short array, which
  // is what an npm-target scaffold carries). Exactly one, so the insertion point
  // is never a guess.
  const anchors =
    code === undefined
      ? []
      : [...code.matchAll(/\.\.\.\(devtool\?\.plugins \?\? \[\]\)(?=[ \t]*(?:,|\]))/g)];
  const anchorMatch = anchors.length === 1 ? anchors[0]! : null;
  if (code === undefined || anchorMatch === null || code.split(anchor).length !== 2) {
    return undefined;
  }
  const providerImport = `import { ${provider.symbol} } from '@setu-ts/${bare}';`;
  const importedBinding = providerBinding(source, bare, provider.symbol);
  // Exactly the one recognized import, or none: any other import form (`* as ns`,
  // double quotes, a second declaration) can use the package without the binding
  // checked below ever appearing.
  const visible = maskComments(source)!;
  if (packageSpecifierCount(visible, bare) !== (importedBinding === undefined ? 0 : 1)) {
    return undefined;
  }
  // A starter registers plugins this file never names (audit round 6).
  if (composingStarter(source) !== undefined) return undefined;
  const factory = importedBinding ?? provider.symbol;
  // Any reference anywhere in the file, not only a call in the factory body: a
  // plugin built at module scope, through an alias, an optional call or `.call`, and
  // listed by name is already registered, and inserting a second call makes the
  // kernel refuse a duplicate plugin name. When the factory is imported, its own
  // import is not a use; when it is NOT imported, any binding of that name (from
  // another module, say) also blocks the insert, since adding the import would then
  // declare the identifier twice. A plugin constructed in a DIFFERENT module is not
  // visible from here — that boundary is stated in plan §10.
  //
  // Read with only comments masked, so a use inside a string or a template
  // substitution (`${list.push(CachePlugin())}`) is seen too (audit round 3).
  const uses = importedBinding === undefined ? visible : maskImportDeclarations(visible);
  if (!source.includes(anchor) || referencesIdentifier(uses, factory)) {
    return undefined;
  }
  // A barrel symbol already bound, or the barrel already imported, means the file
  // carries wiring this edit cannot see the whole of: fail closed to guidance
  // rather than declare an identifier twice.
  if (barrelImportPlan(source, seam?.imports ?? [], false) === undefined) return undefined;

  const prefix =
    (importedBinding === undefined ? `${providerImport}\n` : '') +
    (seam?.imports ?? [])
      .map((item) => `import { ${item.symbols.join(', ')} } from '${item.from}';\n`)
      .join('');
  const withImport = `${prefix}${source}`;
  const insertion = anchorMatch.index + scope!.start + prefix.length;
  const lineStart = withImport.lastIndexOf('\n', insertion - 1) + 1;
  const before = withImport.slice(lineStart, insertion);
  // On its own line the new call takes a line of its own at the same indentation,
  // laid out for the width the project formats at (Deno has no formatter in the
  // CLI; an npm target's Prettier pass agrees); inline it joins the array where it
  // stands.
  const ownLine = before.trim() === '';
  const callArgs = args ?? seam?.args ?? '';
  const call = ownLine
    ? renderPluginCall(factory, callArgs, before.length)
    : `${factory}(${callArgs})`;
  return `${withImport.slice(0, insertion)}${call},${ownLine ? `\n${before}` : ' '}${withImport.slice(insertion)}`;
}

/** Shared fail-closed barrel admission for inline and starter composition. */
function barrelImportPlan(
  source: string,
  imports: AddSeam['imports'],
  reuse: boolean,
): { text: string; at: number } | undefined {
  const visible = maskComments(source);
  if (visible === undefined) return undefined;
  const missing: string[] = [];
  for (const item of imports) {
    const mentioned = visible.includes(`'${item.from}'`) || visible.includes(`"${item.from}"`);
    if (mentioned) {
      if (!reuse) return undefined;
      const declarations = [
        ...visible.matchAll(/\bimport\s*\{([^}]+)\}\s*from\s*(['"])([^'"]+)\2\s*;?/g),
      ].filter((match) => match[3] === item.from);
      if (
        declarations.length !== 1 ||
        !item.symbols.every((symbol) =>
          declarations[0]![1]!
            .split(',')
            .map((name) => name.trim())
            .includes(symbol),
        )
      )
        return undefined;
    } else {
      if (item.symbols.some((symbol) => referencesIdentifier(visible, symbol))) return undefined;
      missing.push(`import { ${item.symbols.join(', ')} } from '${item.from}';`);
    }
  }
  const at = afterLastImport(source, visible);
  if (at === undefined) return undefined;
  return { text: missing.length === 0 ? '' : `\n${missing.join('\n')}`, at };
}

/** Existing top-level keys must bind the same expressions; nested mentions do not count. */
function carriesStarterOptions(existing: string, literal: string): boolean {
  const actual = starterLiteralEntries(existing);
  const expected = starterLiteralEntries(literal);
  const normalize = (value: string): string =>
    value.replace(/\s+/g, '').replace(/,([}\])])/g, '$1');
  return (
    actual !== undefined &&
    expected !== undefined &&
    expected.every(([key, value]) => {
      const entry = actual.find(([name]) => name === key);
      return entry !== undefined && normalize(entry[1]) === normalize(value);
    })
  );
}

/** Merges seam options and selected transport atomically; uncertain edits retain guidance. */
function withStarterWiring(
  source: string,
  bare: string,
  seam: AddSeam | undefined,
  transportArgs: string | undefined,
): string | undefined {
  const starter = composingStarter(source);
  const arm = starter?.arms.get(bare);
  if (arm === undefined) return undefined;
  const shape = STARTER_SEAMS.find((entry) => entry.plugin === bare);
  const key = shape?.arm ?? (bare === 'messaging-plugin' ? 'messaging' : undefined);
  if (key === undefined) return undefined;
  const plan = barrelImportPlan(source, seam?.imports ?? [], true);
  if (plan === undefined) return undefined;
  let result = source;
  if (seam !== undefined && shape !== undefined) {
    const existing = starterOptionValue(result, key);
    if (existing === undefined) {
      const edited = withStarterOption(result, key, starterSeamLiteral(shape));
      if (edited === undefined) return undefined;
      result = edited;
    } else if (!carriesStarterOptions(existing, seam.args)) {
      for (const [property, value] of shape.entries) {
        const edited = withStarterArmEntry(result, key, property, value);
        if (edited === undefined) return undefined;
        result = edited;
      }
    }
  }
  if (transportArgs !== undefined) {
    const existing = starterOptionValue(result, key);
    if (existing === undefined) {
      const edited = withStarterOption(result, key, transportArgs);
      if (edited === undefined) return undefined;
      result = edited;
    } else if (!carriesStarterOptions(existing, transportArgs)) {
      const entries = starterLiteralEntries(transportArgs);
      if (entries === undefined) return undefined;
      for (const [property, value] of entries) {
        const edited = withStarterArmEntry(result, key, property, value);
        if (edited === undefined) return undefined;
        result = edited;
      }
    }
  }
  if (result === source) return undefined;
  return `${result.slice(0, plan.at)}${plan.text}${result.slice(plan.at)}`;
}

/**
 * Whether the app factory body calls a provider through its recognized import.
 *
 * The same test {@linkcode printWiringNote} uses to stay quiet: a real call in
 * classified code, never a mention in a string or comment.
 *
 * @param source - The config source
 * @param bare - Bare package name of the provider
 * @param symbol - The provider's factory export
 * @returns `true` when the factory calls it
 */
function factoryCallsProvider(source: string, bare: string, symbol: string): boolean {
  const binding = providerBinding(source, bare, symbol);
  const scope = factoryScope(source);
  return (
    binding !== undefined &&
    scope !== undefined &&
    callsIdentifier(scope.code.slice(scope.start, scope.end), binding)
  );
}

/**
 * Imports the project-local node-redis helper into a configuration the node-redis
 * arm just wired (see `templates/node-redis.ts` for why it is not a `redis` import).
 *
 * @param original - The configuration before the wiring
 * @param wired - The configuration after the wiring
 * @returns The wired configuration importing the helper once, or `undefined` when
 *   `nodeRedisClient` is already bound some other way and declaring it again would
 *   collide (the caller then prints guidance instead of writing)
 */
function withNodeRedisImport(original: string, wired: string): string | undefined {
  if (importsNodeRedisHelper(original)) return wired;
  if (referencesIdentifier(maskComments(original) ?? original, NODE_REDIS_FACTORY)) {
    return undefined;
  }
  return `${NODE_REDIS_IMPORT_LINE}\n${wired}`;
}

/** Reads transport options only for a listed workspace member. */
async function workspaceAddArgs(
  deps: AddCommandDependencies,
  dirs: readonly string[],
  bare: string,
  runtime: TargetRuntime,
  starter: boolean,
): Promise<{ readonly args: string; readonly clients: readonly string[] } | undefined> {
  if (dirs.length === 1) return undefined;
  const read = await readWorkspaceManifest(deps.fs, dirs[dirs.length - 1]!);
  if (!read.ok) return undefined;
  const transport = transportSpec(read.manifest.transport, read.manifest.redisClient);
  return transportAddArgs(transport, bare, runtime, starter, read.manifest.transportUrl);
}

/** Shares arm selection and literal rendering between workspace and standalone adds. */
function transportAddArgs(
  transport: TransportSpec,
  bare: string,
  runtime: TargetRuntime,
  starter: boolean,
  override?: string,
): { readonly args: string; readonly clients: readonly string[] } | undefined {
  const builder =
    bare === 'cache-plugin'
      ? transport.cacheArgs
      : bare === 'scheduler-plugin'
        ? transport.schedulerArgs
        : bare === 'realtime-backplane-plugin'
          ? transport.backplaneArgs
          : bare === 'messaging-plugin'
            ? transport.messagingArgs
            : bare === 'queue-plugin'
              ? transport.queueArgs
              : undefined;
  if (builder === undefined || transport.connection === undefined) return undefined;
  return {
    args: starter
      ? starterOptionLiteral(builder, transport, override)
      : builder(renderConnection(transport.connection, workspaceProfile(runtime), override)),
    clients:
      bare === 'messaging-plugin'
        ? (transport.messagingClients ?? [])
        : bare === 'queue-plugin'
          ? (transport.queueClients ?? [])
          : [transport.redisClient === 'node-redis' ? 'redis' : 'ioredis'],
  };
}

/** Uses the same JSONC/JSON refusal for a member or workspace root. */
async function reportManifestRefusal(
  deps: AddCommandDependencies,
  path: string,
  section: string,
  specifier: string,
  range: string,
): Promise<void> {
  const read = await readJsonManifest(deps.fs, path);
  if (read.kind === 'ok' && read.format === 'jsonc') {
    deps.error(
      `${escapeName(path)} is JSONC (comments, trailing commas); rewriting it would discard them. ` +
        `Add this line under "${section}" yourself: "${specifier}": "${range}"`,
    );
  } else {
    deps.error(`Cannot read ${escapeName(path)} as JSON; fix it and run this again.`);
  }
}

/**
 * Adds a framework package to the project's manifest. For zero-configuration
 * providers, it also activates the provider in a recognized emitted
 * scaffold, whose `DecoratorPlugin` already receives the ingress barrel.
 * Workspace members receive the selected transport's messaging, queue, cache,
 * scheduler lock and realtime backplane options and their optional clients.
 * Standalone messaging/queue flags select the same transport arms.
 * In npm/Bun Setu workspaces, optional peers are also recorded in the root's
 * dependencies so hoisted framework packages can load them (since 0.11.0).
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

  const diagnostics = requested === 'diagnostics' || requested === '@setu-ts/diagnostics-plugin';
  const bare = diagnostics ? 'diagnostics-plugin' : resolveAddablePackage(requested);
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
      `${escapeName(dir)} is a workspace root (${escapeName(
        workspaceMarker,
      )}); framework packages are pinned in each ` +
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
  if (diagnostics) {
    deps.error(
      `\`@setu-ts/diagnostics-plugin\` is installed and wired by \`${cliInvocation('deno')} devtool enable\`.`,
    );
    return EXIT_USAGE;
  }
  const moduleFlag = args.flags['module'];
  if (moduleFlag !== undefined && bare !== 'view-plugin') {
    deps.error('--module applies only to `setu add view`, which writes a controller.');
    return EXIT_USAGE;
  }
  if (
    moduleFlag !== undefined &&
    (typeof moduleFlag !== 'string' || !isKebabIdentifier(moduleFlag))
  ) {
    deps.error('Option --module requires a valid module name.');
    return EXIT_USAGE;
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
    { file: 'deno.json', section: 'imports', range: frameworkSpecifier(bare, 'deno') },
    { file: 'deno.jsonc', section: 'imports', range: frameworkSpecifier(bare, 'deno') },
    {
      file: 'package.json',
      section:
        [...ADDABLE.values()].find((entry) => entry.pkg === bare)?.section === 'dev'
          ? 'devDependencies'
          : 'dependencies',
      range: frameworkSpecifier(bare, 'npm'),
    },
  ];

  const edits: { readonly path: string; readonly contents: string }[] = [];
  const createOnlyPaths = new Set<string>();
  let found = false;
  let alreadyPresent = false;
  const unknownRedisClient = await unknownWorkspaceRedisClient(deps.fs, dir);
  if (unknownRedisClient !== undefined) {
    deps.error(
      `Workspace names unknown redisClient "${escapeName(unknownRedisClient)}". Expected node-redis, or omit it for ioredis.`,
    );
    return EXIT_ERROR;
  }
  const searchDirs = await installSearchDirs(deps.fs, dir);
  const configPath = joinPath(dir, 'setu.config.ts');
  let initialConfig: string | undefined;
  try {
    initialConfig = new TextDecoder().decode(await deps.fs.readFile(configPath));
  } catch {
    // A project may have no CLI-owned configuration.
  }
  if (
    bare === 'react-router-plugin' &&
    (initialConfig === undefined ||
      (composingStarter(initialConfig)?.symbol !== 'createFullStackAppFromConfig' &&
        !factoryCallsProvider(initialConfig, bare, 'ReactRouterPlugin')))
  ) {
    deps.error(
      `React Router requires a full-stack app. Run ${cliInvocation(runtime)} ` +
        (searchDirs.length > 1
          ? 'generate app <name> --template full-stack.'
          : 'new <name> --template full-stack.'),
    );
    return EXIT_ERROR;
  }
  let selected: TransportSpec | undefined;
  if (args.flags['redis-client'] !== undefined && searchDirs.length > 1) {
    deps.error(
      '--redis-client cannot apply inside a workspace member: members share the workspace --transport and redisClient.',
    );
    return EXIT_USAGE;
  }
  const redisRefusal = redisClientRefusal(
    args,
    runtime,
    args.flags['broker'] === 'redis' || args.flags['queue'] === 'redis',
  );
  if (redisRefusal !== undefined) {
    deps.error(redisRefusal);
    return EXIT_USAGE;
  }
  for (const flag of ['broker', 'queue'] as const) {
    if (args.flags[flag] === undefined) continue;
    const expected = flag === 'broker' ? 'messaging-plugin' : 'queue-plugin';
    if (bare !== expected) {
      deps.error(
        `--${flag} applies only to setu add ${flag === 'broker' ? 'messaging' : 'queue'}.`,
      );
      return EXIT_USAGE;
    }
    if (searchDirs.length > 1) {
      deps.error(
        `--${flag} cannot apply inside a workspace member: members share the workspace --transport.`,
      );
      return EXIT_USAGE;
    }
    if (runtime === 'cloudflare-workers') {
      deps.error(standaloneOverlayRefusal(flag, runtime, resolveHost(MINIMAL_HOST, runtime))!);
      return EXIT_USAGE;
    }
    const arm = readArmFlag(args, flag);
    if (!arm.ok) {
      deps.error(arm.message);
      return EXIT_USAGE;
    }
    selected = arm.spec;
  }
  const starter =
    initialConfig !== undefined &&
    composingStarter(initialConfig)?.symbol === 'createFullStackAppFromConfig';
  const transport =
    selected === undefined
      ? await workspaceAddArgs(deps, searchDirs, bare, runtime, starter)
      : transportAddArgs(selected, bare, runtime, starter);
  const transportArgs = transport?.args;
  const peerPackages = [
    ...peerPackagesFor(bare, runtime),
    ...(transport?.clients ?? []).map((name) => ({ name, range: CLIENT_RANGES[name]! })),
  ];
  const addedPeers: string[] = [];
  const movedPeers: { readonly name: string; readonly path: string }[] = [];

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
    if (pinnedInOtherNpmSection(source, target.file, target.section, specifier, target.range)) {
      alreadyPresent = true;
    } else {
      try {
        updated = withDependency(source, target.section, specifier, target.range);
      } catch {
        await reportManifestRefusal(deps, path, target.section, specifier, target.range);
        return EXIT_ERROR;
      }
      if (updated === undefined) alreadyPresent = true;
    }

    // Optional peers ride the SAME manifest rewrite — a second edit for one path
    // fails as a duplicate — and are applied even when the framework package is
    // already pinned, so re-running `setu add <name>` is how a project missing
    // a peer recovers (for example `ws` after `setu add websocket`, or `zod`
    // after `setu add validation`).
    {
      const merged = withPeerDependencies(
        updated ?? source,
        peerPackages,
        target.file === 'package.json' ? 'dependencies' : 'imports',
      );
      if (merged.added.length > 0 || merged.moved.length > 0) {
        updated = merged.contents;
        addedPeers.push(...merged.added);
        movedPeers.push(...merged.moved.map((name) => ({ name, path })));
      }
    }

    if (updated === undefined) continue;
    edits.push({ path, contents: updated });
  }

  let writeRoot = dir;
  if (found && peerPackages.length > 0 && searchDirs.length > 1) {
    const root = searchDirs[searchDirs.length - 1]!;
    const workspace = await readWorkspaceManifest(deps.fs, root);
    if (workspace.ok && workspaceProfile(workspace.manifest.runtime).manifestKind === 'npm') {
      const path = joinPath(root, 'package.json');
      try {
        // A leading BOM is valid to npm and Bun alike; JSON.parse refuses it.
        const source = (await readExistingText(deps.fs, path))?.replace(/^\uFEFF/, '');
        if (source !== undefined) {
          // npm refuses (EOVERRIDE) a direct dependency whose spec differs from
          // a root override of the same package, and an override alone installs
          // nothing. So a peer the root overrides is recorded at the override's
          // own spec; a `$name` reference is not a spec a dependency can carry,
          // so that peer is left to the override and the reason printed.
          const overridden = rootOverrides(source);
          const parsedRoot = JSON.parse(source) as Record<string, unknown>;
          const devRoot = parsedRoot['devDependencies'];
          // An existing pin in any section wins over the override logic: a
          // production one is kept, a development one is moved as it stands, and
          // an optional peer's spec is added to `dependencies` beside it.
          const declared = new Set([
            ...declaredNames(parsedRoot),
            ...(devRoot !== null && typeof devRoot === 'object' && !Array.isArray(devRoot)
              ? Object.keys(devRoot)
              : []),
            ...optionalPeerPins(parsedRoot).keys(),
          ]);
          const pinned = await workspacePins(
            deps.fs,
            root,
            workspace.manifest.members,
            new Set(peerPackages.map((peer) => peer.name)),
          );
          const rootPeers: { readonly name: string; readonly range: string }[] = [];
          for (const peer of peerPackages) {
            const override = overridden.get(peer.name);
            if (declared.has(peer.name)) {
              rootPeers.push(peer);
            } else if (override?.selector === true) {
              // Whether `name@<range>` applies depends on the version npm picks,
              // which this command cannot evaluate: either spec can be refused.
              deps.log(
                `left ${peer.name} out of ${escapeName(path)}: its "overrides" pins it only for ` +
                  `some versions; add it at the root yourself, at a spec that agrees with that override.`,
              );
            } else if (override?.spec.startsWith('$') === true) {
              deps.log(
                `left ${peer.name} out of ${escapeName(path)}: its "overrides" pins it by reference ` +
                  `(${escapeName(override.spec)}); add the referenced dependency at the root yourself.`,
              );
            } else if (override !== undefined) {
              rootPeers.push({ name: peer.name, range: override.spec });
            } else {
              // The root entry is what places a version inside the framework's
              // peer range where the hoisted framework package resolves it; without
              // one, placement is npm's choice, and V10-50's image (installed from a
              // lockfile recording the peer nested under a member) crashed on it. A
              // member pinned at another spec may then keep a second copy — measured
              // with npm 11: root 5.11.1 beside a nested 5.4.1 — so it is named.
              rootPeers.push(peer);
              const differing = (pinned.get(peer.name) ?? []).filter(
                (pin) => pin.spec !== peer.range,
              );
              if (differing.length > 0) {
                deps.log(
                  `note: ${differing
                    .map(
                      (pin) =>
                        `${escapeName(pin.path)} pins ${peer.name} at ${escapeName(pin.spec)}`,
                    )
                    .join('; ')}; the root entry keeps the hoisted framework package on ` +
                    `${escapeName(peer.range)}, and npm may install a second copy for that member — ` +
                    `align the pins if they should share one.`,
                );
              }
            }
          }
          const merged = withPeerDependencies(source, rootPeers, 'dependencies');
          if (merged.added.length > 0 || merged.moved.length > 0) {
            edits.push({ path, contents: merged.contents });
            addedPeers.push(...merged.added);
            movedPeers.push(...merged.moved.map((name) => ({ name, path })));
            writeRoot = root;
          }
        }
      } catch {
        const peer = peerPackages[0]!;
        await reportManifestRefusal(deps, path, 'dependencies', peer.name, peer.range);
        return EXIT_ERROR;
      }
    }
  }

  // The ingress barrel is already part of a class-based scaffold from project
  // creation. Installing a provider only in the manifest would make a later
  // decorated ingress class fail at startup because the capability was never
  // registered. Activate only the known generated shape; an application-owned
  // config can have arbitrary composition and is not ours to rewrite.
  const installedAfter = new Set(await detectPlugins(deps.fs, dir));
  installedAfter.add(bare);
  const artifactSeam = addSeam(bare, installedAfter);
  const seam =
    transportArgs === undefined
      ? artifactSeam
      : {
          args:
            artifactSeam === undefined
              ? transportArgs
              : `{ ${objectBody(artifactSeam.args)}, ${objectBody(transportArgs)} }`,
          imports: artifactSeam?.imports ?? [],
          files: artifactSeam?.files ?? [],
        };
  // Taken before the config is considered: a manifest edit means a real install.
  const installing = edits.length > 0;

  let configSource: string | undefined;
  let configRetargeted = false;
  try {
    const config = new TextDecoder().decode(await deps.fs.readFile(configPath));
    // An import map that points a framework name elsewhere makes the configuration's
    // imports mean something its text does not say: no automatic wiring then.
    configRetargeted = await frameworkImportsRetargeted(deps.fs, dir);
    const wired = configRetargeted
      ? undefined
      : composingStarter(config)?.arms.has(bare) === true
        ? withStarterWiring(config, bare, artifactSeam, transportArgs)
        : withPluginWiring(
            config,
            bare,
            seam,
            transportArgs === undefined ? undefined : seam?.args,
          );
    const imported =
      wired !== undefined && transport?.clients.includes('redis')
        ? withNodeRedisImport(config, wired)
        : wired;
    if (imported !== undefined) edits.push({ path: configPath, contents: imported });
    configSource = imported ?? config;
  } catch {
    // `setu add` remains useful for non-scaffolded projects. A missing config
    // simply has no generated ingress composition to activate.
  }

  // The barrels exist whether or not the config could be rewritten: the printed
  // guidance names them, and an import of a missing module would not compile.
  // Written on a real install, AND whenever the config was just wired to read
  // them — re-adding an installed package to a config with no provider call
  // still wires it, and that import must resolve. A re-add that edits nothing
  // writes nothing.
  const configWired = edits.some((edit) => edit.path === configPath);
  // The node-redis arm's call needs the project-local helper whether this run wired
  // it or prints it as guidance (as the barrels above are written for guidance that
  // names them); an existing file is the user's.
  if ((installing || configWired) && transport?.clients.includes('redis')) {
    const path = joinPath(dir, NODE_REDIS_MODULE_PATH);
    try {
      await deps.fs.readFile(path);
    } catch {
      const file = nodeRedisModuleFile();
      edits.push({ path, contents: file.contents });
    }
  }
  for (const file of installing || configWired ? (seam?.files ?? []) : []) {
    const path = joinPath(dir, file.path);
    try {
      await deps.fs.readFile(path);
    } catch {
      edits.push({ path, contents: file.contents });
    }
  }

  if (!found) {
    deps.error(
      `No deno.json or package.json in ${escapeName(dir)} — this is not a Setu-TS project.`,
    );
    return EXIT_ERROR;
  }

  if (selected?.connection !== undefined) {
    deps.log(
      `  ${selected.connection.variable}=${selected.connection.localDefault} (local default; .env files are unchanged).`,
    );
    const composePath = joinPath(dir, BROKER_COMPOSE_FILE);
    const existingCompose = await readExistingText(deps.fs, composePath);
    // Every file is create-only: an existing Compose file is never rewritten, so a
    // service it lacks is printed for the developer to add (PR #519 review).
    for (const file of brokerComposeFiles([selected])) {
      const path = joinPath(dir, file.path);
      if ((await findExisting(deps.fs, [{ ...file, path }])).length > 0) continue;
      createOnlyPaths.add(path);
      edits.push({ path, contents: file.contents });
    }
    const missing =
      existingCompose === undefined ? undefined : missingComposeServices(existingCompose, selected);
    if (missing !== undefined) {
      deps.log(
        `  ${BROKER_COMPOSE_FILE} exists and has no ${selected.name} service; add this under services: and keep the rest:`,
      );
      // Unprefixed: the block is printed at the file's own indentation, ready to paste.
      for (const line of missing.split('\n')) deps.log(line);
    }
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
    const installed = installedAfter;
    const names = await readDevtoolSourceNames(deps.fs, dir, installed, configSource ?? '');
    const sources = renderDevtoolSources(installed, names);
    const sourcesPath = joinPath(dir, sources.path);
    if (existingSources !== sources.contents) {
      edits.push({ path: sourcesPath, contents: sources.contents });
    }
    if (configSource !== undefined) {
      const wiring = withDevtoolSourceWiring(
        configSource,
        installed,
        names.customBackplane === true,
      );
      for (const line of wiring.setup) deps.log(`  In setu.config.ts: ${escapeName(line)}`);
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

  if (bare === 'view-plugin') {
    // The example page is a controller, so it follows the controller rule: a
    // flat project keeps it in src/controllers/, a modular one in a module.
    const diagnosis = await diagnoseProject(deps.fs, dir, await detectPlugins(deps.fs, dir));
    const module = typeof moduleFlag === 'string' ? moduleFlag : undefined;
    if (module !== undefined && diagnosis.modules.length === 0) {
      deps.error(
        `This project has no modules; drop --module, or run \`${cliInvocation(runtime)} g module ${escapeName(module)}\` first.`,
      );
      return EXIT_ERROR;
    }
    if (module === undefined && diagnosis.layout !== 'flat') {
      deps.error(
        `This project uses modules; pass --module <name> to place the views controller (existing: ${diagnosis.modules.map(escapeName).join(', ')}).`,
      );
      return EXIT_USAGE;
    }
    if (module !== undefined && !diagnosis.modules.includes(module)) {
      deps.error(
        `Unknown module "${escapeName(module)}". Admitted modules: ${diagnosis.modules.map(escapeName).join(', ')}.`,
      );
      return EXIT_ERROR;
    }
    const views = VIEWS_CONTROLLER.slice(0, -'.controller.ts'.length);
    const controllerDir = module === undefined ? HTTP_SEAM_DIR : `src/modules/${module}`;
    const registration =
      module === undefined
        ? {
            path: (diagnosis.mode === 'class-based'
              ? CONTROLLERS_SEAM
              : FUNCTIONAL_CONTROLLERS_SEAM
            ).barrel,
            contents: (diagnosis.mode === 'class-based'
              ? CONTROLLERS_SEAM
              : FUNCTIONAL_CONTROLLERS_SEAM
            ).renderBarrel(withControllerArtifact(diagnosis.artifacts, views, 'function')),
          }
        : {
            path: `${controllerDir}/index.ts`,
            contents: renderModuleIndex(
              diagnosis.mode,
              deriveNames(module),
              withControllerArtifact(diagnosis.moduleArtifacts.get(module), views, 'function'),
            ),
          };
    const existing = new Map<string, string>();
    for (const path of [
      'package.json',
      'deno.json',
      'deno.jsonc',
      'tsconfig.json',
      'setu.config.ts',
      '.gitignore',
      'src/views/styles.css',
      'src/views/layout.tsx',
      'src/views/home.tsx',
      `${controllerDir}/${VIEWS_CONTROLLER}`,
    ]) {
      const fullPath = joinPath(dir, path);
      const pending = edits.find((edit) => edit.path === fullPath);
      let text: string | undefined;
      try {
        text = pending?.contents ?? (await readExistingText(deps.fs, fullPath));
      } catch (cause) {
        // A linked or unreadable view file refuses the whole add, before any write.
        deps.error(
          `Failed to read the project for the view setup: ${escapeName(
            cause instanceof Error ? cause.message : String(cause),
          )}`,
        );
        return EXIT_ERROR;
      }
      if (text !== undefined) existing.set(path, text);
    }
    const plan = planViewSetup({
      runtime,
      existing,
      // An earlier `setu add view` (0.10.0 wired only the plugin) or a hand
      // registration counts too, so re-running the command wires the example route.
      viewPluginRegistered:
        configWired ||
        (!configRetargeted &&
          configSource !== undefined &&
          factoryCallsProvider(configSource, 'view-plugin', 'ViewPlugin')),
      wireStatic: (source, args) =>
        configRetargeted ? undefined : withPluginWiring(source, 'static-plugin', undefined, args),
      controllerDir,
      registration,
    });
    for (const file of plan.files) createOnlyPaths.add(joinPath(dir, file.path));
    for (const file of [...plan.files, ...plan.manifestEdits, ...plan.configEdits]) {
      const path = joinPath(dir, file.path);
      const previous = edits.findIndex((edit) => edit.path === path);
      if (previous >= 0) edits.splice(previous, 1);
      edits.push({ path, contents: file.contents });
      if (file.path === 'setu.config.ts') configSource = file.contents;
    }
    for (const line of plan.notes) deps.log(escapeName(line));
    // The page reaches the router only through the barrel or module index, so a
    // config that never calls its registrar leaves /ui unregistered.
    const registrar = module === undefined ? 'registerGeneratedRoutes' : 'registerModules';
    if (
      plan.files.some((file) => file.path.endsWith(VIEWS_CONTROLLER)) &&
      configSource !== undefined &&
      !callsIdentifier(maskSourceCode(configSource) ?? '', registrar)
    )
      deps.log(
        `setu.config.ts does not call ${registrar}; add ${registrar}(app.router, app.services); so /ui is registered.`,
      );
  }

  if (edits.length === 0 && alreadyPresent) {
    deps.log(`${specifier} is already installed in ${escapeName(dir)}.`);
    for (const line of seamGapLines(configSource, bare, seam)) deps.log(line);
    if (bare === 'messaging-plugin' || bare === 'queue-plugin') {
      printWiringNote(configSource, bare, deps.log, seam, transportArgs);
      printNodeRedisImportNote(configSource, transport?.clients ?? [], deps.log);
    }
    if (args.flags['dry-run'] !== true) await reportAgentsHint(deps, dir, runtime);
    return EXIT_OK;
  }

  if (args.flags['dry-run'] === true) {
    for (const edit of edits) deps.log(`would update ${escapeName(edit.path)}`);
    return EXIT_OK;
  }

  let outcomes: Awaited<ReturnType<typeof writeFiles>>;
  try {
    const planned = await formatForTarget(
      edits.map((edit) => ({ ...edit, managed: !createOnlyPaths.has(edit.path) })),
      runtime,
      dir,
      deps.error,
    );
    // New view files remain developer-owned, even if one appeared while formatting.
    const appeared = new Set(await findExisting(deps.fs, planned));
    for (const path of appeared)
      deps.log(`left ${escapeName(path)} unchanged: appeared after planning.`);
    outcomes = await writeFiles(
      deps.fs,
      planned.filter((file) => !appeared.has(file.path)),
      deps.interrupt === undefined
        ? { root: writeRoot }
        : { root: writeRoot, signal: deps.interrupt },
    );
  } catch (cause) {
    const interrupted = interruptionMessage(cause);
    if (interrupted !== undefined) {
      deps.error(interrupted);
      return EXIT_INTERRUPTED;
    }
    deps.error(
      `Failed to update the manifest: ${escapeName(
        cause instanceof Error ? cause.message : String(cause),
      )}`,
    );
    return EXIT_ERROR;
  }
  for (const outcome of outcomes) deps.log(`${outcome.outcome} ${escapeName(outcome.path)}`);
  for (const { name, path } of movedPeers) {
    deps.log(
      `moved ${name} from devDependencies to dependencies in ${escapeName(path)}: ` +
        `it is loaded at runtime, and an install with --omit=dev would drop it.`,
    );
  }
  if (addedPeers.includes('ws')) {
    deps.log('added ws (the Node WebSocket server, an optional peer of @setu-ts/runtime)');
  }
  deps.log('');
  deps.log('Next:');
  deps.log(`  ${installCommand(runtime)}`);
  // When this run wrote the transport into setu.config.ts, the guidance would ask
  // for the very option it just wrote (PR #519 review). Any other config edit —
  // a bare plugin insertion — still needs its note.
  const transportWritten =
    configWired &&
    transportArgs !== undefined &&
    (bare === 'messaging-plugin' || bare === 'queue-plugin');
  const wiredArm =
    configWired && configSource !== undefined
      ? composingStarter(configSource)?.arms.get(bare)
      : undefined;
  if (wiredArm !== undefined) deps.log(`wired ${wiredArm} in setu.config.ts`);
  if (!transportWritten && wiredArm === undefined)
    printWiringNote(configSource, bare, deps.log, seam, transportArgs);
  printNodeRedisImportNote(configSource, transport?.clients ?? [], deps.log);
  if (bare === 'cloudflare-plugin') {
    // M113d §3.8: the generated factory names its second parameter `_waitUntil`
    // while nothing reads it (a read-free parameter must be underscored to pass
    // the project's own lint), and a project scaffolded before 0.10.0 has no
    // such parameter at all. The printed registration reads `waitUntil`, so
    // both cases are named here rather than detected in the developer's file.
    deps.log("  In createApp (setu.config.ts), rename the '_waitUntil' parameter to 'waitUntil'.");
    deps.log('  No such parameter (a project scaffolded before 0.10.0)? Add it as the second');
    deps.log('  parameter, as docs/upgrading.md describes ("Workers projects: thread waitUntil").');
  }
  // Both notes concern a Deno start task's permission flags; on another target
  // they describe nothing the developer can act on.
  if (runtime === 'deno') printPermissionNote(specifier, deps.log);
  await reportAgentsHint(deps, dir, runtime);
  return EXIT_OK;
}

/** An add is successful even when its advisory brief reminder cannot be read. */
async function reportAgentsHint(
  deps: AddCommandDependencies,
  dir: string,
  runtime: TargetRuntime,
): Promise<void> {
  try {
    const brief = await readExistingText(deps.fs, joinPath(dir, 'AGENTS.md'));
    if (brief?.includes(BRIEF_BEGIN) === true)
      deps.log(`Run \`${cliInvocation(runtime)} agents\` to update AGENTS.md.`);
  } catch (cause) {
    deps.error(`Cannot inspect AGENTS.md: ${escapeName(String(cause))}`);
  }
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
const PERMISSION_NOTES: ReadonlyMap<string, readonly string[]> = new Map([
  [
    '@setu-ts/storage-plugin',
    [
      "  The 'local' provider writes files, so a Deno project needs --allow-write",
      '  in its start task. Cloud providers (s3/gcs/azure/b2) do not.',
    ],
  ],
  [
    // The built-in `self` indicator reads the host name. Measured on a bare Deno
    // scaffold: without the flag `/health` answers `down`, so `/ready` fails too.
    '@setu-ts/health-plugin',
    [
      "  The built-in 'self' check reads the host name, so a Deno project needs",
      '  --allow-sys in its start task, or /health reports down.',
    ],
  ],
]);

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
  log(`Usage: ${PROGRAM_NAME} add <plugin> [--dir <path>] [--dry-run] [--module <name>]`);
  log('');
  log('Adds a Setu-TS package to this project, pinned to the version of the CLI');
  log("that added it — so a project's framework packages stay on one version.");
  log('');
  log('Standalone: add messaging --broker <name> or add queue --queue <name>.');
  log('Redis arms: --redis-client <ioredis|node-redis> (default ioredis).');
  log('Workspace members use their workspace transport; existing configuration is preserved.');
  log('add view writes its page controller to src/controllers/, or with --module <name> into');
  log('that module; a project with modules requires --module.');
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
