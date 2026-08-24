/**
 * The project renderer — every file a scaffolded project is made of.
 *
 * Extracted from `commands/new.ts` because a workspace MEMBER is a scaffolded
 * project too: `setu new` and `setu generate app` both render one, and a second
 * copy of this file would be ~700 lines of duplicated logic (AI_GUIDELINES
 * §11.1). The command layer keeps flag parsing, the refusals, and the write
 * pipeline; everything that turns a {@linkcode TemplateHost} into files lives
 * here.
 *
 * @module
 */

import {
  CONFIG_EXPORT,
  CONFIG_MODULE,
  PROGRAM_NAME,
  type TargetRuntime,
  VERSION,
} from '../constants.ts';
import type { GeneratedFile } from '../utils/file-writer.ts';
import type {
  AppFactoryRenderContext,
  AppFactoryWiring,
  EnvVariable,
  LocalImport,
  MiddlewareWiring,
  PackageImport,
  RuntimeSwap,
  TemplateHost,
  TemplateManifest,
  Wiring,
  WorkerExport,
  WorkerExportRoute,
} from './registry.ts';
import { packagesOf } from './registry.ts';
import { renderConfigOptions } from './env-file.ts';
import { GENERATED_LINE_WIDTH, rootManifestSettings } from './root-settings.ts';

/** Semver range the scaffolded project pins framework packages to. */
const RANGE = `^${VERSION}`;

/**
 * Where the entry module gets the port it binds, when it does not read `PORT`.
 *
 * A standalone project reads `PORT` from the environment, defaulting to `3000`,
 * set by whatever starts the process (X4-10). NOT from the emitted `.env`:
 * `ConfigPlugin({ envFilePath })` loads that into its own store, never into
 * `runtime.env`, and this expression is evaluated before any plugin registers.
 * Bun happens to auto-load `.env` into `process.env`; Deno and Node do not, so
 * the portable answer is the process environment. A workspace member does
 * NOT: its port is allocated by the CLI and has to be the SAME datum its
 * siblings dial, so the entry imports it from the generated discovery module
 * rather than taking an environment override that could drift from the map.
 */
export interface EntryPort {
  /** The identifier the entry imports, e.g. `SERVICE_PORT`. */
  readonly symbol: string;
  /** The module specifier to import it from, e.g. `./src/discovery/services.ts`. */
  readonly from: string;
}

/**
 * Renders a middleware wiring's `add()` options as source, including the
 * leading comma.
 *
 * Always emits both fields: a middleware's pipeline position is never
 * incidental, and `MiddlewareWiring.addOptions` is required precisely so this
 * cannot degrade to a bare `add()` at the default priority of 500.
 *
 * @param options - The wiring's declared position and name
 * @returns Source for the second argument to `app.middleware.add(...)`
 */
function renderAddOptions(options: MiddlewareWiring['addOptions']): string {
  return `, { priority: ${options.priority}, name: '${options.name}' }`;
}

/**
 * A {@linkcode TemplateHost} with every optional member filled in and the
 * project's feature choices already applied.
 *
 * One normalization site rather than a `?? []` at each of nine read sites: the
 * renderer and the manifest writer must agree about what the project contains,
 * and a default applied in one of them and forgotten in the other is invisible
 * until a generated project fails to compile.
 */
export interface ResolvedHost {
  readonly plugins: readonly Wiring[];
  /** Module exports the Workers entry declares beside `fetch`. */
  readonly workerExports: readonly WorkerExport[];
  /** Lines appended verbatim to the Workers entry, for a re-exported DO class. */
  readonly entryReExports: readonly string[];
  /** TOML appended to the generated `wrangler.toml`. */
  readonly wranglerToml: string;
  readonly middleware: readonly MiddlewareWiring[];
  readonly localImports: readonly LocalImport[];
  readonly packageImports: readonly PackageImport[];
  readonly files: readonly GeneratedFile[];
  readonly pluginSpreads: readonly string[];
  readonly setupCalls: readonly string[];
  /**
   * Tasks merged into the generated `deno.json` beyond `start`.
   *
   * A workspace transport contributes these — the gRPC arm needs a `proto:gen`
   * task, because the descriptors `grpc.addService` takes come from a compiler
   * rather than from the CLI.
   */
  readonly extraTasks: Readonly<Record<string, string>>;
  /**
   * Import-map entries merged into the generated `deno.json` beyond the framework
   * pins — what a transport-contributed file needs in order to compile.
   */
  readonly extraImports: Readonly<Record<string, string>>;
  readonly appFactory?: AppFactoryWiring | undefined;
  readonly appFactoryContext: Omit<AppFactoryRenderContext, 'runtime'>;
  readonly manifest?: TemplateManifest | undefined;
}

/**
 * Fills in a host's optional members and applies its runtime swap.
 *
 * Every host in the registry happens to declare `localImports` and `files`, so
 * those two fallbacks are unreachable through `runNewCommand` today; they are
 * not dead, because {@linkcode TemplateHost} declares both optional and a
 * future host may omit either.
 *
 * @param host - The selected template, or the no-template host
 * @returns The host with every member present
 */
export function resolveHost(
  host: TemplateHost,
  runtime: TargetRuntime,
): ResolvedHost {
  const swap = host.runtimeSwaps?.[runtime];
  const swapped = swap === undefined ? host.plugins : applyRuntimeSwap(host.plugins, swap);
  // Workers receive configuration exclusively through their request bindings.
  // Leaving an env-file path in the manifest would make ConfigPlugin require a
  // filesystem that the Workers runtime deliberately does not provide.
  const manifest = runtime === 'cloudflare-workers' && host.manifest?.envFilePath !== undefined
    ? withoutEnvFilePath(host.manifest)
    : host.manifest;

  return {
    plugins: swapped,
    workerExports: swap?.workerExports ?? [],
    entryReExports: swap?.entryReExports ?? [],
    wranglerToml: swap?.wranglerToml ?? '',
    middleware: host.middleware,
    localImports: host.localImports ?? [],
    packageImports: host.packageImports ?? [],
    files: [...(host.files ?? []), ...(swap?.files ?? [])],
    pluginSpreads: host.pluginSpreads ?? [],
    setupCalls: host.setupCalls ?? [],
    extraTasks: { ...host.extraTasks },
    extraImports: {},
    appFactory: host.appFactory,
    appFactoryContext: {
      ...(manifest?.envFilePath === undefined ? {} : { envFilePath: manifest.envFilePath }),
      ...host.appFactoryContext,
    },
    manifest,
  };
}

/**
 * Renders the gitignored dotenv file a generated project starts with.
 *
 * Each declared variable is written with its development value, so a template
 * whose own source calls `config.getOrThrow(...)` boots immediately after
 * `setu new`. The values are placeholders, never secrets — the file is
 * gitignored precisely so a real one can replace them in place.
 *
 * @param variables - The variables this template's generated source reads
 * @returns The dotenv file contents
 */
function envFileContents(variables: readonly EnvVariable[]): string {
  const header = '# Local configuration. This file is ignored by Git.\n';
  if (variables.length === 0) return header;
  return `${header}# The values below are development placeholders. Replace them before deploying.\n${
    variables.map((variable) => `\n# ${variable.description}\n${variable.name}=${variable.develop}`)
      .join('\n')
  }\n`;
}

/**
 * Renders the tracked dotenv example.
 *
 * It names every variable with an EMPTY value: this file is committed, so a
 * development placeholder here would be a value someone deploys by accident.
 *
 * @param envFilePath - The path this example is copied to
 * @param variables - The variables this template's generated source reads
 * @returns The example file contents
 */
function envExampleContents(
  envFilePath: string,
  variables: readonly EnvVariable[],
): string {
  const header = `# Copy this file to \`${envFilePath}\` and fill in local values.\n` +
    `# \`${envFilePath}\` is ignored by Git; this example is committed.\n`;
  if (variables.length === 0) return header;
  return `${header}${
    variables.map((variable) => `\n# ${variable.description}\n${variable.name}=`).join('')
  }\n`;
}

/**
 * Removes the filesystem-only dotenv setting for a Workers project.
 *
 * @param manifest - The template manifest that may declare a dotenv path
 * @returns The manifest without its dotenv path
 */
function withoutEnvFilePath(manifest: TemplateManifest): TemplateManifest {
  const { envFilePath: _envFilePath, ...without } = manifest;
  return without;
}

/**
 * Replaces the dotenv path for a host that registers ConfigPlugin.
 *
 * @returns The adjusted host, or undefined when its composition has no config arm.
 */
export function withEnvFile(host: ResolvedHost, envFilePath: string): ResolvedHost | undefined {
  if (host.manifest?.envFilePath === undefined) return undefined;
  return {
    ...host,
    manifest: { ...host.manifest, envFilePath },
    appFactoryContext: { ...host.appFactoryContext, envFilePath },
  };
}

/**
 * Replaces the packages a runtime cannot serve with the ones it can.
 *
 * @param plugins - The template's plugin list
 * @param swap - What this runtime replaces
 * @returns The plugin list for this runtime
 * @throws {Error} When `removePackages` names a package the template does not
 * register — a defect in this repository's own template data, not something a
 * user can reach, and silently dropping it would leave a swap that no longer
 * removes what its author believed it did
 */
function applyRuntimeSwap(
  plugins: readonly Wiring[],
  swap: RuntimeSwap,
): readonly Wiring[] {
  const present = new Set(plugins.map((wiring) => wiring.pkg));
  const absent = swap.removePackages.filter((pkg) => !present.has(pkg));
  if (absent.length > 0) {
    throw new Error(
      `Runtime swap removes ${absent.join(', ')}, which this template does not register.`,
    );
  }

  const removed = new Set(swap.removePackages);
  return [...plugins.filter((wiring) => !removed.has(wiring.pkg)), ...swap.addPlugins];
}

/**
 * Renders the project's `setu.config.ts` — the single place its plugin list
 * lives.
 *
 * The factory deliberately does NOT start the application: `main.ts` owns that,
 * and `setu` imports this module to discover plugin-contributed commands, so
 * importing it must never bind a socket.
 *
 * @param runtime - The selected runtime target
 * @param host - The resolved template host
 * @returns The `setu.config.ts` contents
 */
function configModule(
  runtime: TargetRuntime,
  host: ResolvedHost,
): string {
  const {
    plugins,
    middleware,
    localImports,
    packageImports,
    appFactory,
    pluginSpreads,
    setupCalls,
  } = host;
  const pluginArgs = (wiring: Wiring): string =>
    wiring.pkg !== 'config-plugin'
      ? wiring.args ?? ''
      : runtime === 'cloudflare-workers'
      ? ''
      : host.manifest?.envFilePath === undefined
      ? wiring.args ?? ''
      : renderConfigOptions(host.manifest.envFilePath);
  // `common` is always imported for the return type, so a template naming more
  // symbols from it merges into that one statement rather than emitting a
  // second import of the same module.
  const extraCommonSymbols = packageImports
    .filter((p) => p.pkg === 'common')
    .flatMap((p) => p.symbols ?? []);
  // With no extra symbols the statement is the type-only import every template
  // emitted before this merge existed, so their output is unchanged.
  const commonImport = extraCommonSymbols.length === 0
    ? `import type { IApplication } from '@setu-ts/common';`
    : renderImport([...extraCommonSymbols, 'type IApplication'], '@setu-ts/common');

  const imports = [
    // A starter factory returns the application, so the kernel is not imported
    // at all on that path — the generated file names only what it uses.
    ...(appFactory === undefined
      ? [renderImport(['createApplication'], '@setu-ts/kernel')]
      : [renderImport([appFactory.symbol], `@setu-ts/${appFactory.pkg}`)]),
    commonImport,
    ...plugins.map((p) => renderImport([p.symbol], `@setu-ts/${p.pkg}`)),
    ...middleware.map((m) => renderImport([m.symbol], `@setu-ts/${m.pkg}`)),
    ...packageImports
      .filter((p) => p.pkg !== 'common' && p.symbols !== undefined && p.symbols.length > 0)
      .map((p) => renderImport(p.symbols ?? [], `@setu-ts/${p.pkg}`)),
    // Project-local last, so the generated file reads package imports first.
    ...localImports.map((l) => renderImport(l.symbols, l.from)),
  ].join('\n');

  const middlewareLines = middleware.length === 0 ? '' : `\n${
    middleware
      .map((m) =>
        `  app.middleware.add(${m.symbol}(${m.args ?? ''})${renderAddOptions(m.addOptions)});`
      )
      .join('\n')
  }\n`;

  // Placed after the middleware block and before the hello-world route: the app must
  // exist, and a generated route should be registered before the template's own `/`
  // handler so route precedence reads top-to-bottom in the emitted file. Pipeline
  // position is NOT affected by where a middleware is added — the kernel orders by
  // priority — which is why the generated middleware loop passes one explicitly.
  const setupLines = setupCalls.length === 0
    ? ''
    : `\n${setupCalls.map((line) => `  ${line}`).join('\n')}\n`;

  if (appFactory !== undefined) {
    // No hello-world route here: this application's routes come from its own
    // route module, and an exact '/' handler would take precedence over the
    // SSR catch-all and shadow the app's index route.
    return `${imports}

/**
 * Builds the application.
 *
 * \`setu\` imports this factory to discover plugin-contributed CLI commands, so
 * it must NOT start the server — \`main.ts\` owns that.
 *
 * @returns The configured, unstarted application
 */
export async function ${CONFIG_EXPORT}(
  env?: Readonly<Record<string, unknown>>,
): Promise<IApplication> {
  const app = await ${appFactory.symbol}(${
      appFactory.args?.({
        runtime,
        ...host.appFactoryContext,
      }) ?? ''
    });
${middlewareLines}${setupLines}
  return app;
}
`;
  }

  // On Workers a plugin that reads the environment must be handed it: there is
  // no ambient environment on the edge, so `env` arrives as an argument of the
  // `fetch` handler and is threaded through the factory.
  const onWorkers = runtime === 'cloudflare-workers';
  const pluginList = [
    ...plugins
      .map((p) =>
        `      ${p.symbol}(${onWorkers ? p.workersArgs ?? pluginArgs(p) : pluginArgs(p)}),`
      ),
    ...pluginSpreads.map((spread) => `      ${spread},`),
  ].join('\n');

  const wantsWaitUntil = onWorkers && consumesWaitUntil(plugins);
  // Wrapped one-per-line when there are two, which is what `deno fmt` produces
  // for a signature past the emitted line width — a generated project has to
  // pass its OWN `deno fmt --check` (M63/D6).
  const factoryParam = !onWorkers
    ? ''
    : wantsWaitUntil
    ? '\n  env: Readonly<Record<string, unknown>> = {},' +
      '\n  waitUntil?: (promise: Promise<unknown>) => void,\n'
    : 'env: Readonly<Record<string, unknown>> = {}';
  const envDoc = onWorkers
    ? `\n * @param env - The Worker's bindings and variables, from the \`fetch\` handler${
      wantsWaitUntil
        ? `\n * @param waitUntil - The platform's post-response sink, from \`src/index.ts\`.` +
          `\n * Only the Worker ENTRY can import it: \`setu\` loads this module under Deno,` +
          `\n * which cannot resolve \`cloudflare:workers\` at all.`
        : ''
    }`
    : '';

  return `${imports}

/**
 * Builds the application.
 *
 * \`setu\` imports this factory to discover plugin-contributed CLI commands, so
 * it must NOT start the server — \`main.ts\` owns that.
 *${envDoc}
 * @returns The configured, unstarted application
 */
export function ${CONFIG_EXPORT}(${factoryParam}): IApplication {
  const app = createApplication({
    plugins: [
${pluginList}
    ],
  });
${middlewareLines}${setupLines}
  app.router.get('/', (ctx) => ctx.response.json({ message: 'Hello, World!' }));

  return app;
}
`;
}

/**
 * Whether any wiring's Workers arguments consume the post-response sink.
 *
 * Read off the RENDERED argument string rather than a flag beside it, so the
 * parameter is emitted exactly when something references it — a flag could say
 * yes while the args said nothing, leaving the generated project with an unused
 * parameter, or say no while the args named it, leaving it undeclared.
 *
 * @param plugins - The host's resolved wirings
 * @returns Whether the factory must accept a `waitUntil` argument
 */
function consumesWaitUntil(plugins: readonly Wiring[]): boolean {
  return plugins.some((wiring) => wiring.workersArgs?.includes('waitUntil') === true);
}

/**
 * The application entry shared by the Deno, Node, and Bun targets.
 *
 * All three bind a socket through `app.start({ port })`, which delegates to the
 * runtime's Hono serve adapter (M23). The plugin list lives in
 * {@linkcode configModule}, not here.
 *
 * @param runtime - The selected runtime target. It no longer decides how the
 * shutdown signal is caught — all three socket targets emit one identical body —
 * and is threaded on only so `shutdownBlock` can assert the Workers case away
 * @param port - Where the bound port comes from, when it is not the literal
 * default. A workspace member imports it, so the port it binds and the port its
 * siblings dial are one datum rather than two that can drift.
 * @returns The `main.ts` contents
 */
function serveEntry(runtime: TargetRuntime, port?: EntryPort): string {
  const portImport = port === undefined ? '' : `import { ${port.symbol} } from '${port.from}';\n`;
  // A workspace member binds the port the CLI allocated it, imported from the
  // generated discovery module so the port it binds and the port its siblings
  // dial stay ONE datum (M62). A standalone project has no such map and used to
  // carry the literal `3000`, so the port could not be set without editing the
  // source (X4-10). It now reads `PORT` from the PROCESS environment, through
  // `IRuntimeServices` rather than `Deno.env`/`process.env`, so the entry stays
  // portable across all three socket runtimes.
  //
  // Deliberately not the emitted `.env`: `ConfigPlugin({ envFilePath })` loads
  // that into its own store, and this expression is evaluated before any plugin
  // registers — so a `PORT=` line there would be read by `config.get('PORT')`
  // and not by this.
  const portExpression = port === undefined ? "Number(runtime.env.PORT ?? '3000')" : port.symbol;

  return `import { ${CONFIG_EXPORT} } from './${CONFIG_MODULE}';
import { createRuntimeServices } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type { ILogger } from '@setu-ts/common';
${portImport}
// Built before the application, because the port is needed at start() and
// plugins do not register until then. Safe to hold alongside the application's
// own instance: runtime services are a stateless facade over platform globals.
const runtime = createRuntimeServices();

const app = await ${CONFIG_EXPORT}();

await app.start({ port: ${portExpression} });
${shutdownBlock(runtime)}`;
}

/**
 * The graceful-shutdown listener the generated entry installs.
 *
 * **Measured, not precautionary.** A scaffolded project without this dies from
 * the signal itself: `docker stop` (and every Kubernetes pod eviction) sends
 * `SIGTERM`, and the default action for it terminates the process immediately —
 * a project generated before this exited with **code 143 after 1 ms**, so
 * `app.stop()` never ran. Everything that makes a rolling deploy safe is in that
 * call: the in-flight drain, `onStopping` (where a service deregisters from
 * discovery — M50), and `onShutdown` (where a database and a broker
 * disconnect). `terminationGracePeriodSeconds` and `stop_grace_period` are
 * decorative without it.
 *
 * The framework still does not install this itself, though the seam it needs now
 * exists: M39 recorded an `IRuntimeServices` widening as out of scope, and this
 * milestone shipped it as `onSignal?` — which is exactly what the emitted body
 * calls. What is deliberate is that the KERNEL does not register the handler;
 * `app.start({ gracefulShutdown: true })` is the option that would, and it is
 * deferred to M40. Emitting the block here is what makes the documented pattern
 * the default rather than something a reader has to find in a deployment
 * guide.
 *
 * `SIGINT` is caught beside `SIGTERM` so a local `Ctrl+C` exercises the exact
 * path the container runtime will take.
 *
 * @param runtime - The selected runtime target
 * @returns The block appended to the entry, empty on Cloudflare Workers
 */
function shutdownBlock(runtime: TargetRuntime): string {
  // Workers never reaches here (it renders a `fetch` export, not a socket
  // entry), and has no process to signal: an isolate is evicted, not stopped.
  if (runtime === 'cloudflare-workers') return '';

  // ONE body for Deno, Node and Bun — byte-identical. Before M70h this
  // rendered two different bodies reaching for `Deno.addSignalListener` /
  // `Deno.exit` / `Deno.build.os` and `process.on` / `process.exit`, which put
  // runtime APIs in application code (AI_GUIDELINES §4.2) and meant moving a
  // project between runtimes required rewriting its entry point by hand.
  //
  // All four touches now go through capabilities that already exist:
  //   - the signal listener  → `IRuntimeServices.onSignal` (M70h)
  //   - the OS guard         → gone; the Deno adapter omits `onSignal` on
  //                            Windows, where `addSignalListener` throws
  //   - `Deno.exit`/`process.exit` → `IRuntimeServices.exit`
  //   - `console.error`      → the resolved `ILogger`
  //
  // `onSignal` is called optionally because it is genuinely absent on Windows
  // and on Workers; `?.` is the honest read, not defensive noise.
  return `
// Graceful shutdown. Without this the process dies from the signal itself and
// \`app.stop()\` never runs, so in-flight requests are cut, the service never
// deregisters from discovery, and no database or broker disconnects.
//
// Portable across every runtime: no \`Deno\`, no \`process\`, no OS check. On
// Windows \`onSignal\` is absent and this registers nothing, which is correct —
// Windows has no SIGTERM to catch.
//
// The logger is resolved only if one is registered: a project scaffolded
// without LoggerPlugin still shuts down cleanly, it just reports nothing.
const logger = app.services.has(CAPABILITIES.LOGGER)
  ? app.services.get<ILogger>(CAPABILITIES.LOGGER)
  : undefined;

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  runtime.onSignal?.(signal, () => {
    // The .catch is not optional: a rejecting onShutdown hook makes stop()
    // reject, and an unhandled rejection replaces the reason with a trace.
    void app.stop()
      .then(() => runtime.exit(0))
      .catch((error: unknown) => {
        logger?.error('Graceful shutdown failed', { error });
        runtime.exit(1);
      });
  });
}
`;
}

/**
 * The Cloudflare Workers entry: a `fetch` export, never a `listen`.
 *
 * Startup is deferred to the first request and memoized, rather than kicked off
 * at module scope. A module-scope `start()` whose promise is only awaited later
 * leaves a window in which a rejection has no handler attached.
 *
 * @returns The `src/index.ts` contents
 */
/**
 * Renders the value imports one worker export's routes need.
 *
 * Grouped by package and deduplicated: two routes from one package must not emit
 * the same import twice, which would not compile.
 *
 * @param routes - The export's routes
 * @returns One import line per contributing package
 */
function renderRouteImports(routes: readonly WorkerExportRoute[]): string {
  const byPackage = new Map<string, Set<string>>();
  for (const route of routes) {
    const symbols = byPackage.get(route.pkg) ?? new Set<string>();
    symbols.add(route.symbol);
    byPackage.set(route.pkg, symbols);
  }
  return [...byPackage]
    .map(([pkg, symbols]) => `import { ${[...symbols].sort().join(', ')} } from '@setu-ts/${pkg}';`)
    .join('\n');
}

/**
 * Renders the body that dispatches one delivered payload to its handler.
 *
 * A single route needs no branch. Several need one on `payload.queue`, because
 * Cloudflare invokes ONE `queue` export for every queue a Worker consumes: a
 * Worker that fed both queues to one handler would hand the messaging broker
 * its job batches, which it cannot read and therefore retries until the queue
 * dead-letters them.
 *
 * An unlisted queue throws rather than falling through to the first route, so a
 * queue added to `wrangler.toml` without a handler fails loudly instead of
 * having its work quietly discarded.
 *
 * @param entry - The worker export to render
 * @returns The indented statement block
 */
function renderRoutes(entry: WorkerExport): string {
  const only = entry.routes[0];
  if (entry.routes.length === 1 && only !== undefined) {
    return `    await ${only.symbol}(app)(payload);`;
  }

  const cases = entry.routes
    .map((route) =>
      `      case '${route.queueName}':\n` +
      `        return await ${route.symbol}(app)(payload);`
    )
    .join('\n');

  return `    // Cloudflare invokes ONE '${entry.name}' export for every queue this Worker
    // consumes, distinguished only by the queue NAME from wrangler.toml.
    switch (payload.queue) {
${cases}
      default:
        throw new Error(\`No handler is registered for queue '\${payload.queue}'.\`);
    }`;
}

function workersEntry(
  workerExports: readonly WorkerExport[],
  entryReExports: readonly string[],
  wantsWaitUntil: boolean,
): string {
  // `env` is threaded in on BOTH paths. On Workers the environment is not
  // process-wide — bindings and variables arrive as the `env` argument below —
  // so a factory-composed app would otherwise resolve its configuration from
  // nothing, and a plugin-list app would register a RuntimePlugin whose
  // `runtime.env` is empty. A failed boot is NOT permanent (M70l X9-8): only a
  // SUCCESSFUL boot is memoised, so a transient failure is retried on the next
  // request instead of being cached for the isolate's life.
  // THE import lives here and nowhere else. `setu commands` loads
  // `setu.config.ts` under Deno to discover plugin-contributed verbs, and Deno
  // cannot resolve `cloudflare:workers` at all — putting it there, which is what
  // the plugin README's only usage example shows, breaks the CLI outright with
  // `Unsupported scheme "cloudflare"`. This entry module is never loaded by
  // `setu`, so it is the one place the specifier is safe.
  const waitUntilImport = wantsWaitUntil ? "import { waitUntil } from 'cloudflare:workers';\n" : '';
  const bootSignature =
    'async function boot(env: Record<string, unknown>): Promise<IApplication> {';
  const bootCall = `${CONFIG_EXPORT}(env${wantsWaitUntil ? ', waitUntil' : ''})`;
  const fetchSignature =
    'async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {';

  // The memoisation seam every entry shares. `??= boot(env)` cached the raw
  // promise, so ONE failed boot — a mistyped binding, a broker briefly down at
  // cold start — was permanent for the isolate's life; the catch clears the
  // slot before rethrowing so the next request re-attempts. Synchronous on
  // purpose: an `async` wrapper with no await fails the generated project's
  // own `deno lint` (require-await).
  const ensureBootedFn =
    `function ensureBooted(env: Record<string, unknown>): Promise<IApplication> {
  if (booted === undefined) {
    booted = boot(env).catch((error: unknown) => {
      booted = undefined;
      throw error;
    });
  }
  return booted;
}`;

  // One import line per contributing package, and one export per contribution.
  // Each reuses `booted`, never a second `boot(env)`: two applications would
  // mean two brokers with two dispatch tables, and a subscription registered on
  // one would be invisible to the other.
  const exportImports = workerExports
    .map((entry) =>
      `import type { ${entry.payloadType} } from '@setu-ts/${entry.payloadPkg}';\n` +
      renderRouteImports(entry.routes)
    )
    .join('\n');
  const exportBlock = workerExports
    .map((entry) =>
      `\n  async ${entry.name}(
    payload: ${entry.payloadType},
    env: Record<string, unknown>,
  ): Promise<void> {
    const app = await ensureBooted(env);
${renderRoutes(entry)}
  },`
    )
    .join('');
  const reExportBlock = entryReExports.length === 0 ? '' : `\n${entryReExports.join('\n')}\n`;

  return `import type { IApplication } from '@setu-ts/common';
import { ${CONFIG_EXPORT} } from '../${CONFIG_MODULE}';
${waitUntilImport}${exportImports === '' ? '' : `${exportImports}\n`}
let booted: Promise<IApplication> | undefined;

/**
 * Builds and starts the application once, on the first request.
 *
 * Workers have no socket to bind, so start() takes no port: it registers the
 * plugins and the platform drives the app through fetch().
 */
${bootSignature}
  const app = await ${bootCall};
  await app.start();
  return app;
}

${ensureBootedFn}

export default {
  ${fetchSignature}
    let app: IApplication;
    try {
      app = await ensureBooted(env);
    } catch (error) {
      // A failed boot must not leak the stack to the client (M70l X9-8): the
      // body is generic and the real error goes to the platform's logs. 503,
      // because the instance genuinely has no application to serve with.
      console.error('setu: application failed to start', error);
      return new Response('Service Unavailable', { status: 503 });
    }
    try {
      return await app.fetch(request);
    } catch (error) {
      // A REQUEST-time failure is a separate case, reported separately. Folding
      // it into the boot catch above logged 'failed to start' for a fault that
      // had nothing to do with startup, and answered 503 — which tells a load
      // balancer to drain the instance — for what is a single bad request.
      // app.fetch() does throw: the kernel rejects when no HTTP adapter is
      // registered, and an adapter may reject on a malformed request.
      console.error('setu: request failed', error);
      return new Response('Internal Server Error', { status: 500 });
    }
  },${exportBlock}
};
${reExportBlock}`;
}

/**
 * Every framework package a generated project depends on.
 *
 * Always includes `kernel` and `common` (the config module imports both) plus
 * one entry per wiring, so the manifest can never omit a package the generated
 * source references.
 *
 * @param host - The resolved template host
 * @returns Bare package names, deduplicated
 */
function frameworkPackages(host: ResolvedHost, runtime: TargetRuntime): readonly string[] {
  // `common` is unconditional: the config module imports IApplication whichever
  // way it builds the app. `kernel` is not — a starter factory returns the
  // application, so `createApplication` is never imported on that path and
  // declaring the dependency would be a package the project never references.
  const packages = new Set<string>(['common']);
  // Every socket target's `main.ts` imports `createRuntimeServices` to read the
  // port and register its shutdown signals (M70h/B1). It is declared here
  // rather than left to the plugin scan because a starter-composed host
  // (`full-stack`) has an EMPTY plugin list — its RuntimePlugin comes from the
  // starter — so the scan alone would leave `main.ts` importing a package the
  // project never declared. Workers renders a `fetch` export instead and needs
  // no entry of its own.
  if (runtime !== 'cloudflare-workers') {
    packages.add('runtime');
  }
  if (host.appFactory === undefined) {
    packages.add('kernel');
  } else {
    packages.add(host.appFactory.pkg);
  }
  for (const entry of host.packageImports) packages.add(entry.pkg);
  // Reads the SAME resolved plugin list the renderer emits, so a project never
  // imports a framework package without declaring it.
  for (const pkg of packagesOf(host.plugins, host.middleware)) packages.add(pkg);
  return [...packages];
}

/**
 * Builds the Deno `imports` map for a generated project.
 *
 * @param host - The resolved template host
 * @returns Specifier → `jsr:` URL
 */
function jsrImports(host: ResolvedHost, runtime: TargetRuntime): Record<string, string> {
  const imports: Record<string, string> = {};
  for (const pkg of frameworkPackages(host, runtime)) {
    imports[`@setu-ts/${pkg}`] = `jsr:@setu-ts/${pkg}@${RANGE}`;
  }
  // Template aliases last: an alias like `~/` is not a framework package and
  // must not be able to displace one.
  return { ...imports, ...host.extraImports, ...host.manifest?.denoImports };
}

/**
 * Builds the npm `dependencies` map for a generated project, using JSR's npm
 * compatibility names.
 *
 * @param host - The resolved template host
 * @returns Specifier → `npm:@jsr/…` range
 */
function npmDependencies(host: ResolvedHost, runtime: TargetRuntime): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const pkg of frameworkPackages(host, runtime)) {
    deps[`@setu-ts/${pkg}`] = `npm:@jsr/setu-ts__${pkg}@${RANGE}`;
  }
  return { ...deps, ...host.manifest?.npmDependencies };
}

/**
 * The task block a generated Deno manifest carries.
 *
 * A template with a frontend build gets `install` and `build` beside `start`,
 * and `start` DEPENDS on `build` — which is the whole of X5-3. Before this the
 * Deno target emitted the build command into `package.json` alone, whose script
 * runner a Deno project never invokes, so `deno task start` failed with
 * `Failed to load React Router server build … Module not found`. The generated
 * README said `deno task start` and nothing else; there was no `build` task, no
 * `install` task, and no mention anywhere of how the server build got produced.
 *
 * These are the four pieces `apps/full-stack/deno.json` — described in its own
 * README as "the runnable counterpart to `setu new --template full-stack`" —
 * has carried all along.
 *
 * @param runtime - The selected runtime target
 * @param host - The resolved template host, for its extra tasks
 * @param manifest - The template's manifest contributions, when it declares them
 * @returns The `tasks` block, in a fixed order
 */
function denoTasks(
  runtime: TargetRuntime,
  host: ResolvedHost,
  manifest?: TemplateManifest,
): Record<string, string> {
  const entry = runtime === 'deno' ? 'main.ts' : 'src/index.ts';
  // Workers serves through a `fetch` export, so `deno run` binds nothing and
  // exits 0 — Deno's own warning names `deno serve` as the fix (X9-7).
  const start = runtime === 'cloudflare-workers'
    ? `deno serve ${denoPermissions(manifest)} ${entry}`
    : `deno run ${denoPermissions(manifest)} ${entry}`;

  // A3: every template emits a `test` task now. `setu generate module` writes a
  // `*.service.test.ts`, and NO template declared a task that runs it — so the
  // generated test sat beside the generated service, unreachable from
  // `deno check main.ts setu.config.ts`, and both stayed broken through a full
  // green run of every gate a developer had.
  const test = { test: 'deno test -A' };

  if (manifest?.npmBuild === undefined) {
    return { start, ...test, ...host.extraTasks };
  }

  return {
    // `--min-dep-age 0` for the same reason the root manifest carries
    // `minimumDependencyAge`: this project is pinned to the CLI's own version,
    // which on release day is younger than Deno's 24-hour policy allows (D1).
    // The manifest setting covers a bare `deno install`; this task passes its
    // own flags, so it needs the flag too.
    install: 'deno install --allow-scripts --min-dep-age 0',
    build: `deno task install && ${manifest.npmBuild.denoCommand}`,
    start: `deno task build && ${start}`,
    ...test,
    ...host.extraTasks,
  };
}

/**
 * The line width a generated project is formatted at.
 *
 * Matches the `fmt.lineWidth` the root manifest declares, so source this module
 * emits already satisfies the formatter that project ships with.
 */
// The budget the generated `fmt` config sets; see `root-settings.ts`.
const LINE_WIDTH = GENERATED_LINE_WIDTH;

/**
 * Renders one import statement, wrapped when it would overflow.
 *
 * A generated file has to be formatted the way the project's own
 * `deno fmt` would leave it, since the first thing many projects run is
 * `deno fmt --check`. A single-line import of four long symbols overflows
 * {@linkcode LINE_WIDTH}, and the formatter then rewrites a file the CLI just
 * wrote — which is what made a fresh scaffold fail its own format check.
 *
 * The multi-line form matches `deno fmt`'s output exactly: one symbol per line,
 * two-space indent, trailing comma.
 *
 * @param symbols - The imported bindings, in the order they should appear
 * @param from - The module specifier
 * @returns The statement, without a trailing newline
 */
function renderImport(symbols: readonly string[], from: string): string {
  const sorted = sortSpecifiers(symbols);
  const oneLine = `import { ${sorted.join(', ')} } from '${from}';`;
  if (oneLine.length <= LINE_WIDTH) return oneLine;
  return `import {\n${sorted.map((s) => `  ${s},`).join('\n')}\n} from '${from}';`;
}

/**
 * Orders named import specifiers the way `deno fmt` does.
 *
 * The formatter sorts the bindings inside the braces case-insensitively by the
 * symbol name, ignoring a leading `type ` — so `ServerRouter, type EntryContext`
 * is rewritten to `type EntryContext, ServerRouter` even on a line short enough
 * to leave alone. Emitting them unsorted means the formatter rewrites a file the
 * CLI just wrote.
 *
 * The comparison is by CODE POINT on the lowercased name, never
 * `String.localeCompare`. Measured against `deno fmt`: it orders
 * `$dollar, _under, alpha` — `$` (36) before `_` (95) before the letters — while
 * `localeCompare` deprioritises punctuation and answers `_under, $dollar, alpha`.
 * No template emits a `$`- or `_`-prefixed import today, so the disagreement is
 * latent; it is pinned because a helper whose only job is matching the formatter
 * must not diverge from it silently.
 *
 * @param symbols - The bindings, as written
 * @returns The same bindings in the formatter's order
 */
function sortSpecifiers(symbols: readonly string[]): readonly string[] {
  const bareName = (s: string) => s.replace(/^type\s+/, '').toLowerCase();
  return [...symbols].sort((a, b) => {
    const left = bareName(a);
    const right = bareName(b);
    if (left === right) return 0;
    return left < right ? -1 : 1;
  });
}

/**
 * The permission flags the generated Deno `start` task runs with.
 *
 * Network and environment access are unconditional — every generated project
 * binds a socket and reads configuration. Anything further is the template's
 * to declare, so the default stays least-privilege.
 *
 * @param manifest - The template's manifest contributions, when it declares them
 * @returns The space-separated flags
 */
function denoPermissions(manifest?: TemplateManifest): string {
  return [
    ...new Set([
      '--allow-net',
      '--allow-env',
      ...(manifest?.envFilePath === undefined ? [] : ['--allow-read']),
      ...manifest?.denoPermissions ?? [],
    ]),
  ].join(' ');
}

/**
 * The `compilerOptions` a generated `tsconfig.json` carries.
 *
 * One function for both the Node/Bun manifest and the standalone one a Deno or
 * Workers project gets when its template needs an npm toolchain, so the two can
 * never disagree about how the emitted TypeScript is compiled.
 *
 * @param manifest - The template's manifest contributions, when it declares them
 * @returns The merged compiler options
 */
function tsconfigOptions(manifest?: TemplateManifest): Record<string, unknown> {
  return {
    target: 'ES2022',
    module: 'ESNext',
    moduleResolution: 'bundler',
    strict: true,
    // Required by the decorator and OpenAPI plugins.
    experimentalDecorators: true,
    verbatimModuleSyntax: true,
    skipLibCheck: true,
    ...manifest?.tsconfigCompilerOptions,
  };
}

/**
 * The `compilerOptions` a generated `deno.json` carries.
 *
 * Kept apart from {@linkcode tsconfigOptions} because the two files are read by
 * different toolchains: Vite and `tsc` read `tsconfig.json`, while `deno check`
 * and `deno task start` read this one. The options are entirely the template's
 * to declare — a template emitting decorated classes needs
 * `experimentalDecorators` and one emitting JSX needs `jsx`, and neither needs
 * either setting.
 * use for the other's.
 *
 * @param manifest - The template's manifest contributions, when it declares them
 * @returns The compiler options, or undefined when the template declares none,
 * so the key is omitted rather than emitted empty
 */
function denoCompilerOptions(
  manifest?: TemplateManifest,
): Readonly<Record<string, unknown>> | undefined {
  const options = manifest?.denoCompilerOptions;
  return options && Object.keys(options).length > 0 ? options : undefined;
}

/**
 * The `scripts` a generated `package.json` carries.
 *
 * A template with a frontend build gets a `build` script alongside `start`,
 * because its `start` cannot work until the build has produced the server
 * bundle the SSR plugin loads.
 *
 * @param runtime - The selected runtime target
 * @param manifest - The template's manifest contributions, when it declares them
 * @returns The scripts block
 */
function npmScripts(
  runtime: TargetRuntime,
  manifest?: TemplateManifest,
): Record<string, string> {
  const start = runtime === 'bun' ? 'bun run main.ts' : `${NODE_RUNNER} main.ts`;
  // A3 applies to every target, not just the Deno ones: `setu generate module`
  // emits a `*.service.test.ts` here too, and before this nothing could run it.
  // Each runtime's own runner, matching the harness the schematic emits — `bun
  // test` for `bun:test`, and `node --test` under the same loader `start` uses,
  // since the generated test is TypeScript.
  const test = runtime === 'bun' ? 'bun test' : `${NODE_RUNNER} --test`;
  return manifest?.npmBuild === undefined
    ? { start, test }
    : { build: manifest.npmBuild.script, start, test };
}

/**
 * The command a generated Node project runs its TypeScript entry with.
 *
 * NOT `node --experimental-strip-types`. Node's built-in TypeScript support
 * ERASES types without transforming code, so it cannot run the decorated half
 * of this framework: a legacy decorator is a bare
 * `SyntaxError: Invalid or unexpected token`, and the constructor parameter
 * property `setu generate module` emits is
 * `ERR_UNSUPPORTED_TYPESCRIPT_SYNTAX`. `--experimental-transform-types` does
 * not close it either — it handles the parameter property but still rejects the
 * decorator, because it does not enable `experimentalDecorators`.
 *
 * Measured on Node v24: with `--experimental-strip-types` a scaffolded Node
 * project boots until the first `setu generate service|controller|module`, and
 * the former class template never booted at all. `tsx` runs all of them, reading the
 * `experimentalDecorators` the generated `tsconfig.json` already sets.
 */
const NODE_RUNNER = 'tsx';

/**
 * npm packages a generated project needs because of its RUNTIME, not its
 * template.
 *
 * Kept apart from {@linkcode TemplateManifest.npmDevDependencies}, which is a
 * per-template concern, because this one is per-target: every Node project
 * needs it and no Bun, Deno or Workers project does. Bun compiles TypeScript
 * outright, and the Workers and Deno targets never invoke {@linkcode
 * NODE_RUNNER}.
 *
 * @param runtime - The selected runtime target
 * @returns devDependencies to merge, empty for every target but Node
 */
function runtimeDevDependencies(runtime: TargetRuntime): Readonly<Record<string, string>> {
  // Node: see NODE_RUNNER — the start script invokes it, so it must be
  // installed. `@types/node` is what declares the `process` the entry's shutdown
  // listener registers on; without it a generated project's own `tsc` reports an
  // undeclared name while `tsx` runs the file regardless, so nothing but this
  // would catch it.
  if (runtime === 'node') return { '@types/node': '^24.0.0', tsx: '^4.20.0' };
  // Bun gets `@types/bun` rather than `@types/node`: it is the package Bun's own
  // documentation prescribes, and it supplies the `process` declarations by
  // depending on `@types/node` — so the entry's listener type-checks without the
  // project claiming to be a Node one.
  if (runtime === 'bun') return { '@types/bun': '^1.2.0' };
  // X9-4: a Workers project had NO type-checker. `wrangler` bundles with
  // esbuild, which strips types without checking them, and `deno check` resolves
  // `cloudflare:workers` to an untyped module — so `DurableObject` becomes `any`
  // and the README's own Durable Object snippet fails with TS2339/TS4112 under
  // the only checker present. `tsc` reads the `tsconfig.json` the scaffold
  // already emitted and nothing consumed.
  if (runtime === 'cloudflare-workers') {
    return {
      wrangler: '^4.0.0',
      typescript: '^5.7.0',
      '@cloudflare/workers-types': '^4.20250109.0',
    };
  }
  return {};
}

/**
 * The npm manifest files a Deno or Workers project needs.
 *
 * Two independent reasons, and the second is unconditional:
 *
 * - **A template with a frontend build.** Those targets carry a `deno.json` and
 *   no `package.json`, so an npm toolchain would otherwise have nowhere to be
 *   declared. Only one template needs this.
 * - **Cloudflare Workers, always.** `wrangler` bundles with esbuild, which
 *   resolves neither `jsr:` specifiers nor a Deno import map, so every Workers
 *   project needs its framework packages in a `package.json` regardless of
 *   template.
 *
 * Returns nothing for any other Deno project.
 *
 * @param projectName - The project directory and manifest name
 * @param runtime - The selected runtime target; Workers always gets a manifest
 * @param host - The resolved host, read for the framework packages Workers pins
 * @param manifest - The template's manifest contributions, when it declares them
 * @returns The files to add, or an empty list
 */
function standaloneNpmFiles(
  projectName: string,
  runtime: TargetRuntime,
  host: ResolvedHost,
  manifest?: TemplateManifest,
): readonly GeneratedFile[] {
  // Keyed on the BUILD SCRIPT, not on the presence of dev dependencies: a Deno or
  // Workers project needs an npm manifest only when it has an npm build to run.
  // A template that declares dev dependencies for another reason (the `@std`
  // packages the module schematic's emitted test imports, which reach Deno
  // through the import map instead) must not acquire a package.json — that
  // switches Deno to node_modules resolution.
  // Workers ALWAYS needs one: `wrangler` bundles `src/index.ts` with esbuild,
  // which resolves neither `jsr:` specifiers nor a Deno import map, so a project
  // declaring its framework packages only in `deno.json` fails `wrangler dev`
  // with one `Could not resolve "@setu-ts/…"` per package — while the CLI's own
  // next-step hint already said `npm install && npx wrangler dev`. There was
  // simply nothing to install. Deno is deliberately excluded: it resolves
  // through the import map, and a package.json switches it to node_modules.
  const onWorkers = runtime === 'cloudflare-workers';
  if (manifest?.npmBuild === undefined && !onWorkers) return [];

  const dependencies = {
    ...(onWorkers ? npmDependencies(host, runtime) : {}),
    ...manifest?.npmDependencies,
  };
  const devDependencies = {
    // Through the same helper the Node branch uses, so runtime-level
    // devDependencies have ONE home. Inlining Workers' here meant a package
    // added to that helper would be silently ignored on this path.
    ...runtimeDevDependencies(runtime),
    ...manifest?.npmDevDependencies,
  };
  const scripts = {
    ...(manifest?.npmBuild === undefined ? {} : { build: manifest.npmBuild.script }),
    ...(onWorkers ? { check: 'tsc --noEmit', dev: 'wrangler dev', deploy: 'wrangler deploy' } : {}),
  };

  return [
    {
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: projectName,
            version: '0.1.0',
            private: true,
            type: 'module',
            // Emitted unconditionally: this function returns early unless the
            // target is Workers or the template has an npm build, and both of
            // those always contribute a script, a dependency and a devDependency.
            // Guarding each one added three branches no combination can reach.
            scripts,
            dependencies,
            devDependencies,
          },
          null,
          2,
        )
      }\n`,
    },
    // JSR packages resolve from npm only when the @jsr scope is mapped.
    ...(onWorkers ? [{ path: '.npmrc', contents: '@jsr:registry=https://npm.jsr.io\n' }] : []),
    {
      path: 'tsconfig.json',
      contents: `${JSON.stringify({ compilerOptions: tsconfigOptions(manifest) }, null, 2)}\n`,
    },
  ];
}

/**
 * Builds the file set for one runtime target and host.
 *
 * @param projectName - The project directory and manifest name
 * @param runtime - The selected runtime target
 * @param host - The resolved template host: its plugins, middleware, imports,
 * extra source files, and manifest additions
 * @param port - Where the entry gets its port, when it is not the literal
 * default (a workspace member imports it)
 * @returns The files to create, relative to the project root
 */
export function projectFiles(
  projectName: string,
  runtime: TargetRuntime,
  host: ResolvedHost,
  port?: EntryPort,
): readonly GeneratedFile[] {
  const manifest = host.manifest;
  const readme = `# ${projectName}

A [Setu-TS](https://github.com/setu-ts/setu-ts) project targeting \`${runtime}\`.

## Run

\`\`\`bash
${
    runtime === 'deno'
      ? 'deno task start'
      : runtime === 'cloudflare-workers'
      ? 'npx wrangler dev'
      : runtime === 'bun'
      ? 'bun run start'
      : 'npm start'
  }
\`\`\`

## Generate code

\`\`\`bash
${PROGRAM_NAME} generate service billing
${PROGRAM_NAME} generate --help
\`\`\`
`;

  // Deno projects get neither `node_modules/` nor `.wrangler/`: this file is
  // read by a human, and an ignore rule for a directory the target can never
  // produce is noise that invites copying it into projects that would need it.
  const gitignore = `${runtime === 'deno' ? '' : 'node_modules/\n'}coverage/\n${
    runtime === 'cloudflare-workers' ? '.wrangler/\n' : ''
  }${
    // A frontend build's output is generated, so it is ignored like any other
    // build artifact — the generated file used to list only `coverage/` and the
    // env file, which left a minified bundle tracked (D2).
    manifest?.npmBuild === undefined ? '' : `${manifest.npmBuild.outputDir}/\n`}${
    manifest?.envFilePath === undefined ? '' : `${manifest.envFilePath}\n`
  }`;

  const files: GeneratedFile[] = [
    { path: 'README.md', contents: readme },
    { path: '.gitignore', contents: gitignore },
  ];

  if (runtime === 'deno' || runtime === 'cloudflare-workers') {
    // A workspace member is the only caller that passes a port, and a member's
    // manifest must not carry the root-only settings below: the workspace root
    // already declares them for every member, and Deno refuses some of them
    // outright in a member (`nodeModulesDir` is the precedent).
    const isWorkspaceMember = port !== undefined;
    const compilerOptions = denoCompilerOptions(manifest);
    files.push({
      path: 'deno.json',
      contents: `${
        JSON.stringify(
          {
            tasks: denoTasks(runtime, host, manifest),
            ...(isWorkspaceMember ? {} : rootManifestSettings(manifest?.npmBuild?.outputDir)),
            // A `package.json` switches Deno to node_modules resolution, and the
            // full-stack template is the one that emits one on a Deno target. A
            // pristine scaffold then failed its OWN `check:app` on a cold
            // checkout — `Could not resolve "@react-router/fs-routes", but found
            // it in a package.json` — advising a task the project did not have
            // (X5-4). `apps/full-stack` calls this setting load-bearing and sets
            // it; the renderer never did.
            //
            // Refused in a workspace member, where the root declares it instead.
            ...(!isWorkspaceMember && manifest?.npmBuild !== undefined
              ? { nodeModulesDir: 'auto' }
              : {}),
            // Declared by the template rather than fixed here: `deno check` reads
            // this file, and what it needs depends on what the template emits —
            // decorated classes need `experimentalDecorators`, JSX needs `jsx`.
            ...(compilerOptions === undefined ? {} : { compilerOptions }),
            imports: jsrImports(host, runtime),
          },
          null,
          2,
        )
      }\n`,
    });

    // These targets have no npm manifest in the fixed set, so a template that
    // needs one — a frontend build — gets a standalone file rather than a
    // merge. Framework packages stay in the import map above; only the
    // template's own npm dependencies appear here.
    const npmFiles = standaloneNpmFiles(projectName, runtime, host, manifest);
    for (const file of npmFiles) files.push(file);
  } else {
    files.push({
      path: 'package.json',
      contents: `${
        JSON.stringify(
          {
            name: projectName,
            version: '0.1.0',
            type: 'module',
            scripts: npmScripts(runtime, manifest),
            dependencies: npmDependencies(host, runtime),
            // Runtime-level first, so a template that pins its own copy of the
            // same package wins — the template knows what its build needs.
            //
            // Emitted unconditionally: this branch serves Node and Bun, and both
            // now contribute a runtime devDependency of their own (the TypeScript
            // runner and the `process` declarations the entry's shutdown listener
            // needs). The empty-object guard that used to sit here covered the
            // Bun-with-no-template case and became unreachable, so it is gone
            // rather than left as a branch no input can take.
            devDependencies: {
              ...runtimeDevDependencies(runtime),
              ...manifest?.npmDevDependencies,
            },
          },
          null,
          2,
        )
      }\n`,
    });
    // JSR packages resolve from npm only when the @jsr scope is mapped.
    files.push({ path: '.npmrc', contents: '@jsr:registry=https://npm.jsr.io\n' });
    files.push({
      path: 'tsconfig.json',
      contents: `${JSON.stringify({ compilerOptions: tsconfigOptions(manifest) }, null, 2)}\n`,
    });
  }

  files.push({
    path: CONFIG_MODULE,
    contents: configModule(runtime, host),
  });

  if (manifest?.envFilePath !== undefined) {
    files.push({
      path: manifest.envFilePath,
      contents: envFileContents(manifest.envVariables ?? []),
    });
    files.push({
      path: `${manifest.envFilePath}.example`,
      contents: envExampleContents(manifest.envFilePath, manifest.envVariables ?? []),
    });
  }

  if (runtime === 'cloudflare-workers') {
    files.push({
      path: 'src/index.ts',
      contents: workersEntry(
        host.workerExports,
        host.entryReExports,
        consumesWaitUntil(host.plugins),
      ),
    });
    files.push({
      path: 'wrangler.toml',
      // The compatibility date has to postdate 2025-08-08, when Cloudflare
      // shipped `import { waitUntil } from 'cloudflare:workers'`. A project
      // scaffolded against an earlier date cannot import it, so
      // CloudflarePlugin's background-work seam would be unreachable.
      contents: `name = "${projectName}"
main = "src/index.ts"
compatibility_date = "2025-09-01"
compatibility_flags = ["nodejs_compat"]

# Platform bindings reach the application through the \`env\` argument of the
# \`fetch\` handler, which \`src/index.ts\` threads into \`${CONFIG_EXPORT}()\`.
# Register \`CloudflarePlugin\` from @setu-ts/cloudflare-plugin to serve the
# cache, storage, database, queue, messaging and realtime capabilities from the
# bindings below. Add a package with \`${PROGRAM_NAME} add cloudflare\`.
#
# The binding types most projects reach for are listed. Uncomment what you use — a
# binding declared here but absent from the plugin's options is inert, and one
# the plugin names but wrangler does not declare fails at startup with an error
# naming the binding and the ones that ARE present.
#
# KV — CloudflarePlugin({ cache: { binding: 'CACHE_KV' } })
# [[kv_namespaces]]
# binding = "CACHE_KV"
# id = "<your-kv-namespace-id>"
#
# R2 — CloudflarePlugin({ storage: { binding: 'UPLOADS' } })
# [[r2_buckets]]
# binding = "UPLOADS"
# bucket_name = "<your-bucket-name>"
#
# D1 — new D1Adapter(env.DB) handed to DatabasePlugin({ type: 'custom' })
# [[d1_databases]]
# binding = "DB"
# database_name = "<your-database-name>"
# database_id = "<your-database-id>"
#
# Queues, PRODUCER — CloudflarePlugin({ queue: { binding: 'JOBS' } })
# [[queues.producers]]
# binding = "JOBS"
# queue = "<your-queue-name>"
#
# Queues, CONSUMER — drives the \`queue\` export in src/index.ts.
# \`max_batch_timeout = 0\` is REQUIRED for brokered request/reply: the default
# of 5s alone exhausts the 5000ms default request budget.
# [[queues.consumers]]
# queue = "<your-queue-name>"
# max_batch_timeout = 0
#
# Durable Objects — the realtime backplane and the distributed lock. The class
# must be EXPORTED from your own src/index.ts; the plugin ships the core it
# delegates to, not the class itself.
# [[durable_objects.bindings]]
# name = "REPLY_INBOX"
# class_name = "RealtimeBackplaneObject"
#
# [[migrations]]
# tag = "v1"
# new_sqlite_classes = ["RealtimeBackplaneObject"]
#
# Cron Triggers — drives the \`scheduled\` export. SchedulerPlugin cannot honour
# runtime schedule() calls on Workers, so the schedule lives here.
# [triggers]
# crons = ["0 * * * *"]
${host.wranglerToml}`,
    });
  } else {
    files.push({ path: 'main.ts', contents: serveEntry(runtime, port) });
  }

  // Template source files last. Any path colliding with the fixed set above is
  // reported by the caller's overwrite check rather than silently winning.
  for (const extra of host.files) {
    files.push({ path: extra.path, contents: extra.contents });
  }

  return files;
}
