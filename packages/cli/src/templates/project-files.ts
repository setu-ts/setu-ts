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
import { withDiPlugin } from './di.ts';
import type {
  AppFactoryWiring,
  LocalImport,
  MiddlewareWiring,
  PackageImport,
  RuntimeSwap,
  TemplateFeatures,
  TemplateHost,
  TemplateManifest,
  Wiring,
  WorkerExport,
  WorkerExportRoute,
} from './registry.ts';
import { packagesOf } from './registry.ts';

/** Semver range the scaffolded project pins framework packages to. */
const RANGE = `^${VERSION}`;

/**
 * Where the entry module gets the port it binds, when it is not a literal.
 *
 * A standalone project binds `3000`, which is what every scaffolded project did
 * before workspaces existed. A workspace member binds a port allocated by the
 * CLI, and that port has to be the SAME datum its siblings dial — so the entry
 * imports it from the generated discovery module rather than carrying a literal
 * that could drift from the map.
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
  readonly appFactory?: AppFactoryWiring | undefined;
  readonly manifest?: TemplateManifest | undefined;
}

/**
 * Fills in a host's optional members and applies the project's feature choices.
 *
 * `--di` is applied HERE, once, so it cannot be honored by the renderer and
 * missed by the manifest writer — the generated `setu.config.ts` would then
 * import a package the project does not declare.
 *
 * Every host in the registry happens to declare `localImports` and `files`, so
 * those two fallbacks are unreachable through `runNewCommand` today; they are
 * not dead, because {@linkcode TemplateHost} declares both optional and a
 * future host may omit either.
 *
 * @param host - The selected template, or the no-template host
 * @param features - The per-project choices parsed from the flags
 * @returns The host with every member present
 */
export function resolveHost(
  host: TemplateHost,
  features: TemplateFeatures,
  runtime: TargetRuntime,
): ResolvedHost {
  const swap = host.runtimeSwaps?.[runtime];
  const swapped = swap === undefined ? host.plugins : applyRuntimeSwap(host.plugins, swap);

  return {
    // A starter-composed template owns its whole plugin set, so `--di` reaches
    // it through the factory's options instead (see `fullStackArgs`). Appending
    // here would be silently dropped by the renderer's factory branch.
    plugins: host.appFactory === undefined ? withDiPlugin(swapped, features) : swapped,
    workerExports: swap?.workerExports ?? [],
    entryReExports: swap?.entryReExports ?? [],
    wranglerToml: swap?.wranglerToml ?? '',
    middleware: host.middleware,
    localImports: host.localImports ?? [],
    packageImports: host.packageImports ?? [],
    files: [...(host.files ?? []), ...(swap?.files ?? [])],
    pluginSpreads: host.pluginSpreads ?? [],
    setupCalls: host.setupCalls ?? [],
    appFactory: host.appFactory,
    manifest: host.manifest,
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
 * @param features - The per-project choices, handed to a starter factory's args
 * @returns The `setu.config.ts` contents
 */
function configModule(
  runtime: TargetRuntime,
  host: ResolvedHost,
  features: TemplateFeatures,
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
    : `import { ${
      [...extraCommonSymbols, 'type IApplication'].join(', ')
    } } from '@setu-ts/common';`;

  const imports = [
    // A starter factory returns the application, so the kernel is not imported
    // at all on that path — the generated file names only what it uses.
    ...(appFactory === undefined
      ? [`import { createApplication } from '@setu-ts/kernel';`]
      : [`import { ${appFactory.symbol} } from '@setu-ts/${appFactory.pkg}';`]),
    commonImport,
    ...plugins.map((p) => `import { ${p.symbol} } from '@setu-ts/${p.pkg}';`),
    ...middleware.map((m) => `import { ${m.symbol} } from '@setu-ts/${m.pkg}';`),
    ...packageImports
      .filter((p) => p.pkg !== 'common' && p.symbols !== undefined && p.symbols.length > 0)
      .map((p) => `import { ${p.symbols?.join(', ')} } from '@setu-ts/${p.pkg}';`),
    // Project-local last, so the generated file reads package imports first.
    ...localImports.map((l) => `import { ${l.symbols.join(', ')} } from '${l.from}';`),
  ].join('\n');

  const middlewareLines = middleware.length === 0 ? '' : `\n${
    middleware
      .map((m) => `  app.middleware.add(${m.symbol}()${renderAddOptions(m.addOptions)});`)
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
  const app = await ${appFactory.symbol}(${appFactory.args?.(runtime, features) ?? ''});
${middlewareLines}
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
      .map((p) => `      ${p.symbol}(${(onWorkers ? p.workersArgs ?? p.args : p.args) ?? ''}),`),
    ...pluginSpreads.map((spread) => `      ${spread},`),
  ].join('\n');

  const factoryParam = onWorkers ? 'env: Readonly<Record<string, unknown>> = {}' : '';
  const envDoc = onWorkers
    ? `\n * @param env - The Worker's bindings and variables, from the \`fetch\` handler`
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
 * The application entry shared by the Deno, Node, and Bun targets.
 *
 * All three bind a socket through `app.start({ port })`, which delegates to the
 * runtime's Hono serve adapter (M23). The plugin list lives in
 * {@linkcode configModule}, not here.
 *
 * @param port - Where the bound port comes from, when it is not the literal
 * default. A workspace member imports it, so the port it binds and the port its
 * siblings dial are one datum rather than two that can drift.
 * @returns The `main.ts` contents
 */
function serveEntry(port?: EntryPort): string {
  const portImport = port === undefined ? '' : `import { ${port.symbol} } from '${port.from}';\n`;
  const portExpression = port === undefined ? '3000' : port.symbol;

  return `import { ${CONFIG_EXPORT} } from './${CONFIG_MODULE}';
${portImport}
const app = await ${CONFIG_EXPORT}();

await app.start({ port: ${portExpression} });
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
): string {
  // `env` is threaded in on BOTH paths. On Workers the environment is not
  // process-wide — bindings and variables arrive as the `env` argument below —
  // so a factory-composed app would otherwise resolve its configuration from
  // nothing, and a plugin-list app would register a RuntimePlugin whose
  // `runtime.env` is empty. Either failure is permanent, because `booted`
  // memoises the rejection.
  const bootSignature =
    'async function boot(env: Record<string, unknown>): Promise<IApplication> {';
  const bootCall = `${CONFIG_EXPORT}(env)`;
  const bootedInit = 'booted ??= boot(env);';
  const fetchSignature =
    'async fetch(request: Request, env: Record<string, unknown>): Promise<Response> {';

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
    ${bootedInit}
    const app = await booted;
${renderRoutes(entry)}
  },`
    )
    .join('');
  const reExportBlock = entryReExports.length === 0 ? '' : `\n${entryReExports.join('\n')}\n`;

  return `import type { IApplication } from '@setu-ts/common';
import { ${CONFIG_EXPORT} } from '../${CONFIG_MODULE}';
${exportImports === '' ? '' : `${exportImports}\n`}
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

export default {
  ${fetchSignature}
    ${bootedInit}
    const app = await booted;
    return await app.fetch(request);
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
function frameworkPackages(host: ResolvedHost): readonly string[] {
  // `common` is unconditional: the config module imports IApplication whichever
  // way it builds the app. `kernel` is not — a starter factory returns the
  // application, so `createApplication` is never imported on that path and
  // declaring the dependency would be a package the project never references.
  const packages = new Set<string>(['common']);
  if (host.appFactory === undefined) {
    packages.add('kernel');
  } else {
    packages.add(host.appFactory.pkg);
  }
  for (const entry of host.packageImports) packages.add(entry.pkg);
  // Reads the SAME resolved plugin list the renderer emits, so a `--di` project
  // can never import `@setu-ts/di-plugin` without declaring it.
  for (const pkg of packagesOf(host.plugins, host.middleware)) packages.add(pkg);
  return [...packages];
}

/**
 * Builds the Deno `imports` map for a generated project.
 *
 * @param host - The resolved template host
 * @returns Specifier → `jsr:` URL
 */
function jsrImports(host: ResolvedHost): Record<string, string> {
  const imports: Record<string, string> = {};
  for (const pkg of frameworkPackages(host)) {
    imports[`@setu-ts/${pkg}`] = `jsr:@setu-ts/${pkg}@${RANGE}`;
  }
  // Template aliases last: an alias like `~/` is not a framework package and
  // must not be able to displace one.
  return { ...imports, ...host.manifest?.denoImports };
}

/**
 * Builds the npm `dependencies` map for a generated project, using JSR's npm
 * compatibility names.
 *
 * @param host - The resolved template host
 * @returns Specifier → `npm:@jsr/…` range
 */
function npmDependencies(host: ResolvedHost): Record<string, string> {
  const deps: Record<string, string> = {};
  for (const pkg of frameworkPackages(host)) {
    deps[`@setu-ts/${pkg}`] = `npm:@jsr/setu-ts__${pkg}@${RANGE}`;
  }
  return { ...deps, ...host.manifest?.npmDependencies };
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
  return ['--allow-net', '--allow-env', ...manifest?.denoPermissions ?? []].join(' ');
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
  return manifest?.npmBuildScript === undefined
    ? { start }
    : { build: manifest.npmBuildScript, start };
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
 * `--template nest` never boots at all. `tsx` runs all of them, reading the
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
  // installed. Workers: `wrangler` is pinned rather than left to `npx`, which
  // would otherwise fetch whatever is latest at that moment.
  if (runtime === 'node') return { tsx: '^4.20.0' };
  if (runtime === 'cloudflare-workers') return { wrangler: '^4.0.0' };
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
  if (manifest?.npmBuildScript === undefined && !onWorkers) return [];

  const dependencies = {
    ...(onWorkers ? npmDependencies(host) : {}),
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
    ...(manifest?.npmBuildScript === undefined ? {} : { build: manifest.npmBuildScript }),
    ...(onWorkers ? { dev: 'wrangler dev', deploy: 'wrangler deploy' } : {}),
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
 * @param features - The per-project choices, threaded to the config renderer
 * @param port - Where the entry gets its port, when it is not the literal
 * default (a workspace member imports it)
 * @returns The files to create, relative to the project root
 */
export function projectFiles(
  projectName: string,
  runtime: TargetRuntime,
  host: ResolvedHost,
  features: TemplateFeatures,
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

  const gitignore = runtime === 'deno' ? 'coverage/\n' : 'node_modules/\ncoverage/\n.wrangler/\n';

  const files: GeneratedFile[] = [
    { path: 'README.md', contents: readme },
    { path: '.gitignore', contents: gitignore },
  ];

  if (runtime === 'deno' || runtime === 'cloudflare-workers') {
    const entry = runtime === 'deno' ? 'main.ts' : 'src/index.ts';
    files.push({
      path: 'deno.json',
      contents: `${
        JSON.stringify(
          {
            tasks: { start: `deno run ${denoPermissions(manifest)} ${entry}` },
            // The decorator and OpenAPI plugins ship legacy decorators, so a
            // generated @Controller class only type-checks with this enabled.
            compilerOptions: { experimentalDecorators: true },
            imports: jsrImports(host),
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
            dependencies: npmDependencies(host),
            // Runtime-level first, so a template that pins its own copy of the
            // same package wins — the template knows what its build needs.
            ...(() => {
              const dev = { ...runtimeDevDependencies(runtime), ...manifest?.npmDevDependencies };
              return Object.keys(dev).length === 0 ? {} : { devDependencies: dev };
            })(),
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
    contents: configModule(runtime, host, features),
  });

  if (runtime === 'cloudflare-workers') {
    files.push({
      path: 'src/index.ts',
      contents: workersEntry(host.workerExports, host.entryReExports),
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
# Register \`CloudflarePlugin\` from @setu-ts/cloudflare-plugin to serve
# the cache and storage capabilities from KV and R2.
#
# [[kv_namespaces]]
# binding = "CACHE_KV"
# id = "<your-kv-namespace-id>"
#
# [[r2_buckets]]
# binding = "UPLOADS"
# bucket_name = "<your-bucket-name>"
${host.wranglerToml}`,
    });
  } else {
    files.push({ path: 'main.ts', contents: serveEntry(port) });
  }

  // Template source files last. Any path colliding with the fixed set above is
  // reported by the caller's overwrite check rather than silently winning.
  for (const extra of host.files) {
    files.push({ path: extra.path, contents: extra.contents });
  }

  return files;
}
