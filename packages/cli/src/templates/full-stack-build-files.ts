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

  return `import { readdirSync, readFileSync } from 'node:fs';
import { reactRouter } from '@react-router/dev/vite';
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
export const frameworkPackages = [${externals}
];

// Workspace libraries are resolved by Deno at runtime, just like framework
// packages. Read each library's declared name: a custom scope is valid too.
export const workspaceLibraries: string[] = [];
try {
  const libraries = new URL('../../libs/', import.meta.url);
  for (const entry of readdirSync(libraries, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    try {
      const manifest = readLibraryManifest(new URL(entry.name + '/', libraries));
      if (typeof manifest?.name === 'string') workspaceLibraries.push(manifest.name);
    } catch {
      // A directory without a readable library manifest contributes no name.
    }
  }
} catch {
  // Standalone projects and workspaces without libraries have no externals here.
}

/** Reads a member's manifest; Deno accepts deno.json first, then deno.jsonc. */
function readLibraryManifest(directory: URL): { name?: unknown } | undefined {
  for (const file of ['deno.json', 'deno.jsonc']) {
    let text: string;
    try {
      text = readFileSync(new URL(file, directory), 'utf8');
    } catch {
      continue;
    }
    return JSON.parse(stripJsonc(text));
  }
  return undefined;
}

/**
 * Drops JSONC comments, then trailing commas, leaving string contents untouched.
 * Each pass is linear: a comma looks ahead only across the whitespace after it.
 */
function stripJsonc(text: string): string {
  return dropTrailingCommas(dropComments(text));
}

/** Copies a string literal starting at \`start\`, returning the index after it. */
function skipString(text: string, start: number): number {
  let i = start + 1;
  while (i < text.length && text[i] !== '"') i += text[i] === '\\\\' ? 2 : 1;
  return i + 1;
}

/** Removes line and block comments outside string literals. */
function dropComments(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
    } else if (text.startsWith('//', i)) {
      const end = text.indexOf('\\n', i);
      i = end < 0 ? text.length : end;
    } else if (text.startsWith('/*', i)) {
      const end = text.indexOf('*/', i + 2);
      i = end < 0 ? text.length : end + 2;
      out += ' ';
    } else {
      out += text[i];
      i += 1;
    }
  }
  return out;
}

/** Removes a comma followed only by whitespace and a closing bracket. */
function dropTrailingCommas(text: string): string {
  let out = '';
  let i = 0;
  while (i < text.length) {
    if (text[i] === '"') {
      const end = skipString(text, i);
      out += text.slice(i, end);
      i = end;
      continue;
    }
    if (text[i] === ',') {
      let next = i + 1;
      while (/\\s/.test(text[next] ?? '')) next += 1;
      if (text[next] === '}' || text[next] === ']') {
        i += 1;
        continue;
      }
    }
    out += text[i];
    i += 1;
  }
  return out;
}

// A declared package is external together with every exported subpath of it.
const isDeclared = (names: readonly string[], id: string): boolean =>
  names.some((name) => id === name || id.startsWith(name + '/'));

export default defineConfig({
  plugins: [reactRouter()],
  resolve: { tsconfigPaths: true },
  // Declared per environment: React Router builds through Vite's Environment
  // API, and neither a top-level \`ssr.external\` nor
  // \`environments.ssr.resolve.external\` is applied to that build.
  environments: {
    ssr: {
      build: {
        rollupOptions: {
          external: (id) => isDeclared(frameworkPackages, id) || isDeclared(workspaceLibraries, id),
        },
      },
    },
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

/**
 * `compilerOptions` the emitted `app/` tree needs under Deno.
 *
 * The Deno counterpart of {@linkcode FULL_STACK_TSCONFIG_OPTIONS}'s `jsx` entry.
 * Both are required and neither substitutes for the other: Vite reads
 * `tsconfig.json` and `deno check` reads `deno.json`, so a project carrying only
 * the first builds cleanly while every `.tsx` route fails to type-check with
 * `TS2686 'React' refers to a UMD global, but the current file is a module`.
 *
 * `lib` names the DOM because these modules render in a browser as well as on
 * the server; without it `deno check` rejects every DOM reference in a component.
 */
export const FULL_STACK_DENO_COMPILER_OPTIONS: Readonly<Record<string, unknown>> = {
  jsx: 'react-jsx',
  jsxImportSource: 'react',
  lib: ['deno.window', 'dom', 'dom.iterable', 'esnext'],
};

/**
 * The task that type-checks the emitted `app/` tree and the generated seams.
 *
 * `deno check main.ts` reaches only what the entry statically imports, and the
 * route modules are loaded through the compiled server build — so without this
 * task nothing type-checks them at all. A glob rather than a file list, because
 * `app/routes.ts` resolves routes through `flatRoutes()` at build time and
 * statically imports none of them.
 *
 * `src/**` joined it in M70h. This template is a seam host now (X5-8), and
 * before that a generated artifact here was checked by NOTHING: `check:app`
 * globbed `app/` only, and `deno check main.ts setu.config.ts` never reached
 * `src/` because nothing imported it. A deliberate type error in a generated
 * service was clean under both.
 */
export const FULL_STACK_CHECK_TASK: Readonly<Record<string, string>> = {
  'check:app': 'deno check app/**/*.ts app/**/*.tsx src/**/*.ts',
};

/**
 * The development entry a Deno full-stack project carries, run by `deno task dev`.
 *
 * Runs Vite in-process, hands its server build to the SSR plugin through
 * `createApp`'s `ssr` parameter, and proxies Vite's client URLs (all under
 * `/__vite/`) through the application's port, so a route edit is served on the
 * next request with no restart. `viteDevExternals` keeps every `@setu-ts`
 * package and workspace library external, resolved through `deno.json`: Vite
 * cannot resolve a JSR import, and loading one itself would make a second copy
 * whose context keys match nothing.
 */
export const FULL_STACK_DEV_ENTRY: { readonly path: string; readonly contents: string } = {
  path: 'dev.ts',
  contents: `import * as vite from 'vite';
import { createRequestHandler, RouterContextProvider, type ServerBuild } from 'react-router';
import { viteDevExternals } from '@setu-ts/react-router-plugin';
import { createRuntimeServices } from '@setu-ts/runtime';
import { createApp } from './setu.config.ts';
import { frameworkPackages, workspaceLibraries } from './vite.config.ts';

/**
 * Development server: React Router with hot module replacement.
 *
 * Vite serves the route modules and the client graph; the application still
 * owns the port, the plugins and every non-page route. Client URLs are
 * namespaced under \`/__vite/\` so one proxy route reaches Vite without
 * colliding with application routes. Production does not use this file:
 * \`deno task start\` builds and runs \`main.ts\`.
 */
const BASE = '/__vite/';
const runtime = createRuntimeServices();
const port = Number(runtime.env.PORT ?? '3000');
const vitePort = Number(runtime.env.VITE_PORT ?? '5173');

// A file module always has a directory; the fallback only satisfies the type.
const root = import.meta.dirname ?? '.';

const viteServer = await vite.createServer({
  root,
  configFile: \`\${root}/vite.config.ts\`,
  base: BASE,
  server: { port: vitePort, strictPort: true },
  plugins: [viteDevExternals({
    packages: [...frameworkPackages, ...workspaceLibraries],
    // Deno's resolver, so a route shares the module instances this entry holds.
    resolve: (specifier) => import.meta.resolve(specifier),
  })],
});
await viteServer.listen();

// Re-read on every request, so an edited route is served without a restart.
const loadServerBuild = async (): Promise<ServerBuild> =>
  (await viteServer.ssrLoadModule('virtual:react-router/server-build')) as ServerBuild;

const app = await createApp(undefined, undefined, {
  mode: 'development',
  loadRequestHandler: (_path, mode) => {
    const handler = createRequestHandler(loadServerBuild, mode);
    return Promise.resolve({
      handler: (request, loadContext) => handler(request, loadContext as RouterContextProvider),
      // From the same react-router module as the handler: React Router checks
      // the context with instanceof.
      createLoadContext: () => new RouterContextProvider(),
    });
  },
});

app.router.get(\`\${BASE}*\`, async (ctx) => {
  const url = new URL(ctx.request.url);
  const upstream = await fetch(\`http://localhost:\${vitePort}\${url.pathname}\${url.search}\`, {
    headers: ctx.request.headers,
  });
  ctx.response.status(upstream.status);
  for (const [key, value] of upstream.headers.entries()) {
    const lower = key.toLowerCase();
    if (lower !== 'content-encoding' && lower !== 'content-length') {
      ctx.response.appendHeader(key, value);
    }
  }
  return upstream.body === null ? ctx.response.text('') : ctx.response.stream(upstream.body);
});

await app.start({ port });

for (const signal of ['SIGTERM', 'SIGINT'] as const) {
  runtime.onSignal?.(signal, () => {
    void Promise.allSettled([app.stop(), viteServer.close()]).then(() => runtime.exit(0));
  });
}
`,
};
