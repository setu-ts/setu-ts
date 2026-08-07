/**
 * The frontend build files and manifest contributions of the `full-stack`
 * template.
 *
 * The React Router build runs on the npm toolchain (Vite), which is the one
 * documented exception to this project's Deno-only toolchain: Vite is an
 * application-level, build-time `devDependency`, never imported by a plugin and
 * never part of a published package's dependency graph. It is emitted into the
 * scaffolded project and stops there.
 *
 * @module
 */

import type { GeneratedFile } from '../utils/file-writer.ts';

/**
 * React Router major the emitted project is written against.
 *
 * Pinned to 8 because that is what the SSR plugin loads: it does
 * `await import('npm:react-router@8')` to get `createRequestHandler`, and hands
 * it the server build this project's toolchain produced. A project built
 * against 7 would compile, install, and then hand a v7 build to a v8 runtime.
 */
const REACT_ROUTER_RANGE = '^8.0.0';

const reactRouterConfig = `import type { Config } from '@react-router/dev/config';

/**
 * React Router build configuration.
 *
 * \`ssr: true\` is what makes this a server-rendered app: the build emits
 * \`build/server/index.js\`, which \`setu.config.ts\` hands to the SSR plugin as
 * its \`serverBuildPath\`. Changing the output directory means changing that
 * option too.
 */
export default {
  appDirectory: 'app',
  ssr: true,
} satisfies Config;
`;

/**
 * Renders `vite.config.ts` for a given set of framework packages.
 *
 * The externals list is derived from the packages the template declares rather
 * than written out again, so a package added to the template cannot be left out
 * of the build configuration — which would fail as a resolution error on Deno
 * and, worse, as a silent context-key mismatch everywhere else.
 *
 * @param frameworkPackages - Bare `@setu-ts` package names
 * @returns The `vite.config.ts` contents
 */
function renderViteConfig(frameworkPackages: readonly string[]): string {
  const externals = frameworkPackages
    .map((pkg) => `\n  '@setu-ts/${pkg}',`)
    .join('');

  return `import { reactRouter } from '@react-router/dev/vite';
import { defineConfig } from 'vite';

/**
 * Vite builds the client bundle and the server build; it does NOT serve the
 * application. The framework owns the server, so \`vite build\` is a build step
 * and \`setu\`/\`main.ts\` is the runtime.
 *
 * \`resolve.tsconfigPaths\` is what makes the \`~/*\` alias work at build time;
 * the same alias is declared in tsconfig.json for the type-checker.
 */
// Framework packages are NOT bundled into the server build. Two reasons, both
// load-bearing:
//
// 1. They are resolved by the SERVER runtime — from the Deno import map, or
//    from node_modules — and on Deno they are JSR specifiers that this npm
//    toolchain cannot resolve at all.
// 2. Bundling would inline a second copy of each package, and the context keys
//    in app/lib/context-keys.server.ts are matched by identity: the copy
//    setu.config.ts holds would stop matching the copy a loader reads, so
//    every context value would silently fall back to its default.
const frameworkPackages = [${externals}
];

export default defineConfig({
  plugins: [reactRouter()],
  resolve: { tsconfigPaths: true },
  // Declared per environment: React Router builds through Vite's Environment
  // API, and neither a top-level \`ssr.external\` nor
  // \`environments.ssr.resolve.external\` is applied to that build.
  environments: {
    ssr: { build: { rollupOptions: { external: frameworkPackages } } },
  },
});
`;
}

/**
 * Build files emitted for every runtime target.
 *
 * Runtime-independent by design: the frontend build produces the same artifacts
 * whichever server runtime serves them, and the one platform-dependent choice —
 * whether the framework serves static assets itself — lives in
 * `setu.config.ts`, not here.
 *
 * @param frameworkPackages - Bare `@setu-ts` package names the emitted
 * app imports, which the server build must treat as external
 * @returns The build files to emit
 */
export function buildFullStackBuildFiles(
  frameworkPackages: readonly string[],
): readonly GeneratedFile[] {
  return [
    { path: 'react-router.config.ts', contents: reactRouterConfig },
    { path: 'vite.config.ts', contents: renderViteConfig(frameworkPackages) },
  ];
}

/**
 * npm packages the frontend build needs, merged into the project's
 * `devDependencies`.
 *
 * These are build-time and app-level. No framework package appears here — those
 * are resolved through JSR, from `deno.json` or from the `dependencies` the
 * project already declares.
 */
export const FULL_STACK_NPM_DEV_DEPENDENCIES: Readonly<Record<string, string>> = {
  '@react-router/dev': REACT_ROUTER_RANGE,
  '@react-router/fs-routes': REACT_ROUTER_RANGE,
  'react-router': REACT_ROUTER_RANGE,
  react: '^19.2.0',
  'react-dom': '^19.2.0',
  '@types/react': '^19.2.0',
  '@types/react-dom': '^19.2.0',
  typescript: '^5.9.2',
  vite: '^8.0.0',
};

/**
 * npm packages the running application needs, merged into `dependencies`.
 *
 * `react-router` is imported by the server build the SSR plugin loads, so it is
 * a runtime dependency and not only a build-time one.
 */
export const FULL_STACK_NPM_DEPENDENCIES: Readonly<Record<string, string>> = {
  'react-router': REACT_ROUTER_RANGE,
  react: '^19.2.0',
  'react-dom': '^19.2.0',
};

/**
 * `compilerOptions` the emitted TypeScript needs, merged into the project's
 * `tsconfig.json`.
 *
 * `paths` is the `~/*` alias every emitted module imports through;
 * `allowImportingTsExtensions` is what lets those imports carry the `.ts`
 * extension that Deno requires, so ONE import style works under both
 * type-checkers.
 */
export const FULL_STACK_TSCONFIG_OPTIONS: Readonly<Record<string, unknown>> = {
  jsx: 'react-jsx',
  lib: ['DOM', 'DOM.Iterable', 'ES2022'],
  types: ['vite/client'],
  allowImportingTsExtensions: true,
  noEmit: true,
  paths: { '~/*': ['./app/*'] },
};

/**
 * Import-map entries the emitted TypeScript needs under Deno.
 *
 * The Deno counterpart of the `paths` alias above: without it, `deno check`
 * cannot resolve `~/models/product.ts`. A trailing slash on both sides is
 * required — Deno maps prefixes, not globs.
 */
export const FULL_STACK_DENO_IMPORTS: Readonly<Record<string, string>> = {
  '~/': './app/',
};
