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
import { FULL_STACK_UI_FILES } from './full-stack-ui-files.ts';
import { FULL_STACK_APP_FILES, FULL_STACK_README_SECTION } from './full-stack-app-files.ts';
import { TEST_DEPENDENCY_MANIFEST } from './test-deps.ts';
import {
  buildFullStackBuildFiles,
  FULL_STACK_CHECK_TASK,
  FULL_STACK_DENO_COMPILER_OPTIONS,
  FULL_STACK_DENO_IMPORTS,
  FULL_STACK_DEV_ENTRY,
  FULL_STACK_NPM_DEPENDENCIES,
  FULL_STACK_NPM_DEV_DEPENDENCIES,
  FULL_STACK_TSCONFIG_OPTIONS,
} from './full-stack-build-files.ts';
import { SWAGGER_UI_DIST_VERSION } from './swagger-version.ts';
import { defaultLogger } from './logger.ts';

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

  // Indented to sit inside `const app = await …(` at two spaces, so the
  // generated file reads as hand-written source rather than as output.
  //
  // `{ env }` is passed on every target, not only Workers. Off Workers the
  // parameter is undefined and the factory reads the platform environment as
  // usual; on Workers it is the per-request bindings object, which is the only
  // place configuration exists there.
  const discovery =
    serviceEndpoints === undefined
      ? ''
      : `\n        serviceDiscovery: { provider: 'static', services: ${serviceEndpoints} },`;
  const config =
    runtime === 'cloudflare-workers'
      ? ''
      : `, config: ${renderConfigOptions(context.envFilePath ?? '.env')}`;
  // `new RegExp('…')` rather than a regex literal: a generated configuration must
  // stay inside the language the CLI's own config reader classifies (no regex
  // literal, no backslash), or `setu add` and `setu devtool enable` would treat
  // the CLI's own output as unfamiliar (audit round 5, C-R5). The base path is a
  // fixed literal path segment, so it needs no escaping inside the pattern.
  if (grpcBasePath !== undefined && !/^\/[A-Za-z0-9_-]+$/.test(grpcBasePath)) {
    throw new Error(`gRPC base path ${grpcBasePath} must be a single plain path segment.`);
  }
  const csrf =
    grpcBasePath === undefined ? '{}' : `{ exclude: [new RegExp('^${grpcBasePath}(?:/|$)')] }`;

  // The RETURN TYPE annotation is X5-2's whole fix, and it is load-bearing
  // rather than decorative. TypeScript does NOT apply excess-property checking
  // to an object literal returned from a contextually-typed callback, so
  // `(config) => ({ … })` accepted a misspelled arm and an option that does not
  // exist — both type-checked, booted, and logged nothing, while a NESTED
  // mistake (`drizzleInstance` one level too high) became a startup crash whose
  // error named the adapter rather than the option. Probed against the real
  // type: with the annotation the same literal raises TS2561 naming the key and
  // its nearest match; without it, nothing at all.
  // M113d §3.10: the arm is chosen at RUNTIME by the generated code, but the
  // assetsDir decision is made HERE — the generated config has no \`runtime\`
  // in scope, and assets are served by the platform binding on Workers.
  // The dev spread stays clean because \`ssr\` is a union: the module object
  // carries no dev fields and the dev object carries no \`serverBuild\`, so
  // neither spread can leak an optional property into the other arm under
  // exactOptionalPropertyTypes.
  const moduleArm = "ssr !== undefined && 'serverBuild' in ssr";
  const reactRouterArm =
    runtime === 'cloudflare-workers'
      ? `...(${moduleArm} ? { serverBuild: ssr.serverBuild } : {
            // Absolute, deliberately: the plugin does \`await import(serverBuildPath)\`,
            // and a relative specifier there would resolve against the PLUGIN's
            // module rather than this project.
            serverBuildPath: new URL('./build/server/index.js', import.meta.url).href,
          }),`
      : `...(${moduleArm} ? { serverBuild: ssr.serverBuild } : {
            // Absolute, deliberately: the plugin does \`await import(serverBuildPath)\`,
            // and a relative specifier there would resolve against the PLUGIN's
            // module rather than this project.
            serverBuildPath: new URL('./build/server/index.js', import.meta.url).href,
            ...(ssr === undefined ? { assetsDir: './build/client/assets' } : ssr),
          }),
          // The production entry passes the module, and the socket server then
          // serves the client bundle the page loads itself (M120).
          ...('serverBuild' in (ssr ?? {}) ? { assetsDir: './build/client/assets' } : {}),`;

  // The call wraps onto its own line and the body sits two spaces deeper than
  // the single-line form: this argument is long enough that Prettier wraps the
  // call, and a generated project must pass its OWN \`prettier --check\` (M63).
  return `
    (config): FullStackStarterOptions => {
      const trustedProxies = config.get<string>('TRUSTED_PROXIES', { default: '' })
        .split(',').map((entry) => entry.trim()).filter((entry) => entry.length > 0);
      return {
        reactRouter: {
          // Production entries pass the compiled server build as a MODULE so
          // bundling cannot relocate a path relative to import.meta.url.
          // Config callers without the entry (tests and setu commands) keep
          // the absolute path fallback; development supplies the Vite runtime.
          ${reactRouterArm}
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
        },
        // Opted in by the scaffold, with the probe and scrape paths excluded so a
        // kubelet does not write a log line per poll. The plugin's own default
        // (off) is unchanged.
        logger: {
          transport: '${context.logger ?? defaultLogger(runtime)}',
          requestLogging: true,
          excludePaths: ['/live', '/ready', '/health', '/metrics'],
        },${discovery}
        // Preserve Origin on native form posts; send no cross-origin referrer.
        httpSecurity: {
          headers: { referrerPolicy: 'same-origin' },
          ...(trustedProxies.length > 0
            ? { ipSecurity: { trustProxy: true, trustedProxies } }
            : {}),
        },${context.swaggerAssets === 'cdn' ? "\n        openapi: { swagger: { assets: 'cdn' } }," : ''}
      };
    },
    { env${config} },
  `;
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
 * empty rather than duplicating it. A non-empty TRUSTED_PROXIES CIDR list
 * enables forwarded identity and public-origin trust for TLS proxy deployments.
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
    // The REST starter underneath registers these unconditionally; listed here
    // because the factory hides them from the plugin list the README reads.
    composes: ['health-plugin', 'metrics-plugin', 'openapi-plugin', 'logger-plugin'],
    parameter: {
      name: 'ssr',
      type: "{ serverBuild: unknown } | Pick<ReactRouterPluginOptions, 'loadRequestHandler' | 'mode'>",
      doc: 'The Vite runtime start:dev supplies; production entries pass the compiled server build module.',
      readOn: ['deno', 'node', 'bun', 'cloudflare-workers'],
    },
  },
  routes: [
    { path: '/', purpose: 'the home page, server-rendered by React Router' },
    { path: '/products', purpose: 'a page behind sign-in; it redirects to `/login`' },
    { path: '/login', purpose: 'the sign-in form' },
  ],
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
    { pkg: 'react-router-plugin', symbols: ['type ReactRouterPluginOptions'] },
  ],
  files: [
    ...FULL_STACK_APP_FILES,
    ...FULL_STACK_UI_FILES,
    ...buildFullStackBuildFiles(FULL_STACK_APP_FRAMEWORK_PACKAGES),
    ...seamFiles(FULL_STACK_SEAMS),
  ],
  localImports: [...FULL_STACK_LOCAL_IMPORTS, ...seamLocalImports(FULL_STACK_SEAMS)],
  // Statements rather than plugin-array entries: this host composes through a
  // starter, so `plugins` must stay empty and there is nothing to spread into.
  setupCalls: [...seamSetupCalls(FULL_STACK_SEAMS), ...seamPluginRegistrations(FULL_STACK_SEAMS)],
  extraTasks: FULL_STACK_CHECK_TASK,
  manifest: {
    readmeSection: (cli) =>
      FULL_STACK_README_SECTION(cli) +
      `
## Behind a TLS proxy

React Router actions answer 400 behind TLS termination unless the proxy is trusted. Set
TRUSTED_PROXIES to a comma-separated list of your proxies (for example, 10.0.0.0/8). This trusts
their forwarded client IP, host and protocol headers. Leave it empty for direct access. List IPv4
proxies as addresses or CIDRs, and IPv6 proxies as single addresses: an IPv6 CIDR is compared
literally and matches nothing. Never use 0.0.0.0/0, which trusts every IPv4 client's forwarded
headers, so any client can choose its own address and origin.
`,
    envFilePath: '.env',
    // `fullStackArgs` emits `config.getOrThrow<string>('SESSION_SECRET')`, so
    // without this the template scaffolds a project that throws at startup.
    envVariables: [
      {
        name: 'TRUSTED_PROXIES',
        description:
          'Your proxies (IPv4 CIDRs or single IPv6 addresses), comma-separated; trusts their forwarded client IP, host and protocol, fixing TLS-proxy action 400s. Never 0.0.0.0/0: it trusts every client.',
        develop: '',
      },
      {
        name: 'SESSION_SECRET',
        description: 'Signs and encrypts session cookies. Use a long random value in production.',
        develop: 'dev-only-insecure-session-secret-change-me',
      },
    ],
    // The one template with a real frontend build, and the only one that should
    // therefore carry an npm manifest on a Deno or Workers target.
    npmBuild: {
      script: 'react-router build',
      // The npm specifier, not the bin shim: a Deno task resolves the package,
      // while `package.json` resolves the shim from `node_modules`.
      denoCommand: 'deno run -A npm:@react-router/dev build',
      outputDir: 'build',
      // React Router's typegen writes here (`react-router typegen`, and the Vite
      // plugin during dev/build). It is generated source, not the project's, so
      // it is ignored and excluded exactly like the build.
      generatedDirs: ['.react-router'],
      devEntry: FULL_STACK_DEV_ENTRY,
    },
    npmDependencies: {
      ...FULL_STACK_NPM_DEPENDENCIES,
      'swagger-ui-dist': SWAGGER_UI_DIST_VERSION,
      zod: '^4.6.6',
    },
    // The test packages are merged in because `setu generate module` is ungated
    // since M65: this template can emit a `<name>.test.ts` too, and a host
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
  runtimeSwaps: {
    // M113d §3.10: the full-stack Workers project builds before it bundles.
    // The static import of the server build in src/index.ts cannot resolve
    // until `react-router build` has run, and the client bundle must be served
    // as platform assets — no socket target needs either stanza.
    'cloudflare-workers': {
      appFactoryContext: { swaggerAssets: 'cdn' },
      removePackages: [],
      addPlugins: [],
      wranglerToml: `
# The client build is served as platform assets before the Worker runs, so a
# file in it answers instead of an application route with the same path, and
# the application's middleware never sees that request: no security headers, no
# authentication. Keep only public files here. It holds the hashed bundles under
# /assets/ and any files from public/; every other path reaches the application.
[assets]
directory = "./build/client"

# \`wrangler dev\` and \`wrangler deploy\` build the client and server BEFORE
# bundling the Worker — the static import in src/index.ts cannot resolve until
# the server build exists. The frontend build runs on every \`wrangler dev\`
# start; for this template that is well under a second.
[build]
command = "npm run build"`,
    },
  },
  // Every runtime is supported: a missing filesystem makes the asset handler
  // answer 404 rather than throw, and this template omits the asset route
  // entirely on Workers, so nothing here needs refusing.
};
