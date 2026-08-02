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

import type { TargetRuntime } from '../constants.ts';
import type { TemplateDefinition } from './registry.ts';
import { FULL_STACK_APP_FILES } from './full-stack-app-files.ts';
import {
  buildFullStackBuildFiles,
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
 * The static-asset option is the only runtime-dependent part of this template.
 * On Cloudflare Workers there is no filesystem, so the framework's asset
 * handler would answer 404 for every asset; omitting `assetsDir` registers no
 * asset route at all and leaves serving to the platform's own static-asset
 * binding, which is what a Workers deployment should use anyway. Everywhere
 * else the framework serves the client build directly.
 *
 * @param runtime - The selected runtime target
 * @returns Source for the call's arguments, without the enclosing parentheses
 */
function fullStackArgs(runtime: TargetRuntime): string {
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
  return `(config) => ({
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
      csrf: {},
    },
  }), { env }`;
}

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
  localImports: [
    {
      symbols: ['csrfContext', 'loggerContext', 'secretsContext', 'sessionContext'],
      from: './app/lib/context-keys.server.ts',
    },
  ],
  packageImports: [
    // The load-context bridge in the generated honoe.config.ts.
    { pkg: 'session-plugin', symbols: ['getCsrfToken', 'getSession'] },
    // The capability tokens and service types the bridge resolves.
    { pkg: 'common', symbols: ['CAPABILITIES', 'type ILogger', 'type ISecretManager'] },
    // Imported by app/lib/context-keys.server.ts for contextKeyFor(), so the
    // manifest must carry it even though honoe.config.ts names no symbol.
    { pkg: 'react-router-plugin' },
  ],
  files: [...FULL_STACK_APP_FILES, ...buildFullStackBuildFiles(FULL_STACK_APP_FRAMEWORK_PACKAGES)],
  manifest: {
    npmDependencies: FULL_STACK_NPM_DEPENDENCIES,
    npmDevDependencies: FULL_STACK_NPM_DEV_DEPENDENCIES,
    tsconfigCompilerOptions: FULL_STACK_TSCONFIG_OPTIONS,
    denoImports: FULL_STACK_DENO_IMPORTS,
    // The SSR plugin imports the compiled server build and reads client assets
    // through the runtime filesystem; without this the project starts and then
    // fails on its first request.
    denoPermissions: ['--allow-read'],
  },
  // Every runtime is supported: a missing filesystem makes the asset handler
  // answer 404 rather than throw, and this template omits the asset route
  // entirely on Workers, so nothing here needs refusing.
  unsupported: {},
};
