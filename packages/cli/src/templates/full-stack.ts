/**
 * The `full-stack` template: a React Router 8 application served by the
 * framework.
 *
 * This is the one template that composes through a starter instead of inlining
 * its plugin list. The other three name nine to thirteen plugins, which reads
 * fine; the full-stack set is twenty-two, and a generated file a human is meant
 * to open and edit should not open with twenty-two imports of things they did
 * not choose. `createFullStackAppFromConfig` names that composition once, and
 * the generated file shows only what this project decides.
 *
 * @module
 */

import type { AppFactoryRenderContext, LocalImport, TemplateDefinition } from './registry.ts';
import {
  seamFiles,
  seamLocalImports,
  seamPluginRegistrations,
  seamSetupCalls,
  seamsFor,
} from './seam.ts';
import { renderConfigOptions } from './env-file.ts';
import { FULL_STACK_APP_FILES } from './full-stack-app-files.ts';
import { TEST_DEPENDENCY_MANIFEST } from './test-deps.ts';
import {
  buildFullStackBuildFiles,
  FULL_STACK_CHECK_TASK,
  FULL_STACK_DENO_COMPILER_OPTIONS,
  FULL_STACK_DENO_IMPORTS,
  FULL_STACK_NPM_DEPENDENCIES,
  FULL_STACK_NPM_DEV_DEPENDENCIES,
  FULL_STACK_TSCONFIG_OPTIONS,
} from './full-stack-build-files.ts';

/**
 * Framework packages the emitted `app/` tree imports.
 *
 * One list, read twice: the manifest pins them, and the server build treats
 * them as external. Declared here so those two cannot disagree — a package
 * bundled into the server build rather than externalised gets a second copy,
 * and context keys stop matching across it.
 */
export const FULL_STACK_APP_FRAMEWORK_PACKAGES = ['react-router-plugin', 'common'] as const;

/**
 * Renders the argument list for `createFullStackAppFromConfig`.
 *
 * Static assets and dotenv configuration are runtime-dependent in this template.
 * On Cloudflare Workers there is no filesystem, so the framework's asset
 * handler would answer 404 for every asset; omitting `assetsDir` registers no
 * asset route at all and leaves serving to the platform's own static-asset
 * binding, which is what a Workers deployment should use anyway. Everywhere
 * else the framework serves the client build directly. Workers also have no
 * filesystem, so their `ConfigPlugin` reads the request bindings rather than a
 * dotenv path.
 *
 * @param context - The selected runtime and any workspace-only factory inputs
 * @returns Source for the call's arguments, without the enclosing parentheses
 */
function fullStackArgs(context: AppFactoryRenderContext): string {
  const { runtime, serviceEndpoints, grpcBasePath } = context;
  const assets = runtime === 'cloudflare-workers'
    // Assets are served by the platform binding, not the framework.
    ? ''
    : `\n      assetsDir: './build/client/assets',`;

  // Indented to sit inside `const app = await …(` at two spaces, so the
  // generated file reads as hand-written source rather than as output.
  //
  // `{ env }` is passed on every target, not only Workers. Off Workers the
  // parameter is undefined and the factory reads the platform environment as
  // usual; on Workers it is the per-request bindings object, which is the only
  // place configuration exists there.
  const discovery = serviceEndpoints === undefined
    ? ''
    : `\n    serviceDiscovery: { provider: 'static', services: ${serviceEndpoints} },`;
  const config = runtime === 'cloudflare-workers'
    ? ''
    : `, config: ${renderConfigOptions(context.envFilePath ?? '.env')}`;
  const csrf = grpcBasePath === undefined
    ? '{}'
    : `{ exclude: [/^${grpcBasePath.replaceAll('/', '\\/')}(?:\\/|$)/] }`;

  // The RETURN TYPE annotation is X5-2's whole fix, and it is load-bearing
  // rather than decorative. TypeScript does NOT apply excess-property checking
  // to an object literal returned from a contextually-typed callback, so
  // `(config) => ({ … })` accepted a misspelled arm and an option that does not
  // exist — both type-checked, booted, and logged nothing, while a NESTED
  // mistake (`drizzleInstance` one level too high) became a startup crash whose
  // error named the adapter rather than the option. Probed against the real
  // type: with the annotation the same literal raises TS2561 naming the key and
  // its nearest match; without it, nothing at all.
  return `(config): FullStackStarterOptions => ({
    reactRouter: {
      // Absolute, deliberately: the plugin does \`await import(serverBuildPath)\`,
      // and a relative specifier there would resolve against the PLUGIN's
      // module rather than this project.
      serverBuildPath: new URL('./build/server/index.js', import.meta.url).href,${assets}
      populateLoadContext: (ctx, context) => {
        // The bridge between the kernel request context and a React Router
        // loader: getSession() needs the kernel context, which a loader never
        // sees. The keys come from contextKeyFor(), so the copy of
        // context-keys.server.ts inlined into the server build resolves to the
        // same key objects this module holds.
        context.set(sessionContext, getSession(ctx));
        context.set(csrfContext, getCsrfToken(ctx));
        context.set(loggerContext, ctx.services.get<ILogger>(CAPABILITIES.LOGGER));
        context.set(secretsContext, ctx.services.get<ISecretManager>(CAPABILITIES.SECRETS));
      },
    },
    session: {
      secret: config.getOrThrow<string>('SESSION_SECRET'),
      csrf: ${csrf},
    },${discovery}
  }), { env${config} }`;
}

/**
 * The app-local modules the generated `setu.config.ts` imports.
 *
 * Named rather than inline because the seam barrels are appended to it — two
 * `localImports` keys in one object literal would leave the later one silently
 * winning.
 */
const FULL_STACK_LOCAL_IMPORTS: readonly LocalImport[] = [
  {
    symbols: ['csrfContext', 'loggerContext', 'secretsContext', 'sessionContext'],
    from: './app/lib/context-keys.server.ts',
  },
];

/**
 * The seams a full-stack project hosts.
 *
 * X5-8: the generated README tells the developer to run `setu generate service`,
 * and doing so wrote into `src/` — a second service directory beside the
 * template's own `app/services/`, imported by nothing and type-checked by
 * neither of the project's check paths. `setu generate route` behaved the same
 * way and answered 404, while its barrel blamed an "old scaffold" for a line the
 * current template never emitted.
 *
 * The gated families are absent because this host installs no plugin of its own
 * — `seamsFor` filters them — so what remains is exactly the set a
 * starter-composed project can consume.
 */
const FULL_STACK_SEAMS = seamsFor(new Set<string>());

/**
 * The `full-stack` template definition.
 *
 * Registers no plugins of its own: `appFactory` supplies the whole set, and
 * the starter adds the error-handler middleware itself, so `middleware` is
 * empty rather than duplicating it.
 */
export const FULL_STACK_TEMPLATE: TemplateDefinition = {
  name: 'full-stack',
  description: 'React Router 8 SSR app — the full plugin set, composed from configuration',
  plugins: [],
  middleware: [],
  appFactory: {
    pkg: 'full-stack-starter',
    symbol: 'createFullStackAppFromConfig',
    args: fullStackArgs,
  },
  packageImports: [
    // The annotation that restores excess-property checking on the resolver
    // (X5-2). A type-only import, so it costs the generated project nothing at
    // runtime.
    { pkg: 'full-stack-starter', symbols: ['type FullStackStarterOptions'] },
    // The load-context bridge in the generated setu.config.ts.
    { pkg: 'session-plugin', symbols: ['getCsrfToken', 'getSession'] },
    // The capability tokens and service types the bridge resolves.
    { pkg: 'common', symbols: ['CAPABILITIES', 'type ILogger', 'type ISecretManager'] },
    // Imported by app/lib/context-keys.server.ts for contextKeyFor(), so the
    // manifest must carry it even though setu.config.ts names no symbol.
    { pkg: 'react-router-plugin' },
  ],
  files: [
    ...FULL_STACK_APP_FILES,
    ...buildFullStackBuildFiles(FULL_STACK_APP_FRAMEWORK_PACKAGES),
    ...seamFiles(FULL_STACK_SEAMS),
  ],
  localImports: [...FULL_STACK_LOCAL_IMPORTS, ...seamLocalImports(FULL_STACK_SEAMS)],
  // Statements rather than plugin-array entries: this host composes through a
  // starter, so `plugins` must stay empty and there is nothing to spread into.
  setupCalls: [
    ...seamSetupCalls(FULL_STACK_SEAMS),
    ...seamPluginRegistrations(FULL_STACK_SEAMS),
  ],
  extraTasks: FULL_STACK_CHECK_TASK,
  manifest: {
    envFilePath: '.env',
    // `fullStackArgs` emits `config.getOrThrow<string>('SESSION_SECRET')`, so
    // without this the template scaffolds a project that throws at startup.
    envVariables: [{
      name: 'SESSION_SECRET',
      description: 'Signs and encrypts session cookies. Use a long random value in production.',
      develop: 'dev-only-insecure-session-secret-change-me',
    }],
    // The one template with a real frontend build, and the only one that should
    // therefore carry an npm manifest on a Deno or Workers target.
    npmBuild: {
      script: 'react-router build',
      // The npm specifier, not the bin shim: a Deno task resolves the package,
      // while `package.json` resolves the shim from `node_modules`.
      denoCommand: 'deno run -A npm:@react-router/dev build',
      outputDir: 'build',
    },
    npmDependencies: FULL_STACK_NPM_DEPENDENCIES,
    // The test packages are merged in because `setu generate module` is ungated
    // since M65: this template can emit a `*.service.test.ts` too, and a host
    // that emits a test file must declare what that file imports.
    npmDevDependencies: {
      ...TEST_DEPENDENCY_MANIFEST.npmDevDependencies,
      ...FULL_STACK_NPM_DEV_DEPENDENCIES,
    },
    tsconfigCompilerOptions: FULL_STACK_TSCONFIG_OPTIONS,
    denoImports: { ...TEST_DEPENDENCY_MANIFEST.denoImports, ...FULL_STACK_DENO_IMPORTS },
    // Vite reads `tsconfig.json`; `deno check` reads `deno.json` and ignores it.
    // Without the same JSX settings in both, `vite build` succeeds while
    // `deno check` fails on every route with `TS2686 'React' refers to a UMD
    // global`. No decorator option appears here, and none is needed anywhere:
    // the decorator surface is TC39 standard decorators.
    denoCompilerOptions: FULL_STACK_DENO_COMPILER_OPTIONS,
    // The SSR plugin imports the compiled server build and reads client assets
    // through the runtime filesystem; without this the project starts and then
    // fails on its first request. `--allow-sys` is for `HealthPlugin`, which the
    // full-stack starter composes — its `self` indicator reads the hostname.
    denoPermissions: ['--allow-read', '--allow-sys'],
  },
  // Every runtime is supported: a missing filesystem makes the asset handler
  // answer 404 rather than throw, and this template omits the asset route
  // entirely on Workers, so nothing here needs refusing.
};
