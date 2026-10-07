/**
 * A Vite plugin that keeps framework packages external in React Router
 * development mode, resolved the way the server runtime resolves them.
 *
 * @module
 * @since 0.9.0
 */

/**
 * Options for {@linkcode viteDevExternals}.
 *
 * @since 0.9.0
 */
export interface ViteDevExternalsOptions {
  /**
   * Package names the dev server must not load itself: every `@setu-ts`
   * package the application imports, and any workspace library. A subpath
   * import of a listed package is external too.
   */
  readonly packages: readonly string[];
  /**
   * Resolves a specifier the way the server runtime does. Pass
   * `import.meta.resolve` from the development entry, so a route module and the
   * entry receive the same module instance.
   */
  readonly resolve: (specifier: string) => string;
}

/**
 * The result of {@linkcode ViteDevExternalsPlugin.resolveId} for a listed package.
 *
 * @since 0.9.0
 */
export interface ViteDevExternalId {
  /** The specifier as the server runtime resolves it. */
  readonly id: string;
  /** Always `true`: the module is imported by the runtime, not by Vite. */
  readonly external: true;
}

/**
 * The part of Vite's resolved configuration {@linkcode ViteDevExternalsPlugin.configResolved}
 * reads: the SSR environment's resolve options.
 *
 * @since 0.9.0
 */
export interface ViteResolvedEnvironments {
  /** Resolved options per environment, keyed by environment name. */
  readonly environments: Readonly<
    Record<string, { readonly resolve: { builtins: (string | RegExp)[] } }>
  >;
}

/**
 * A Vite plugin, typed structurally so this package imports no Vite.
 *
 * @since 0.9.0
 */
export interface ViteDevExternalsPlugin {
  /** Plugin name, shown in Vite's diagnostics. */
  readonly name: string;
  /** Runs before Vite's own resolver, which would otherwise claim the import. */
  readonly enforce: 'pre';
  /**
   * Appends the resolved specifiers to the SSR environment's `resolve.builtins`.
   * Appended, not replaced: a configured list replaces Vite's default one, which
   * holds the Node built-ins.
   */
  configResolved(config: ViteResolvedEnvironments): void;
  /** Resolves a listed package to the runtime's specifier, external. */
  resolveId(id: string): ViteDevExternalId | null;
}

/** Escapes a string for literal use inside a regular expression. */
function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Whether `id` is a listed package or a subpath of one. */
function isListed(packages: readonly string[], id: string): boolean {
  return packages.some((name) => id === name || id.startsWith(name + '/'));
}

/**
 * The patterns that mark a resolved specifier as a runtime built-in.
 *
 * A `jsr:` or `npm:` specifier is never Vite's to load. A `file:` URL — a
 * package mapped to a local path — is matched by the directory of the
 * package's entry, so its subpath modules are matched too.
 */
function builtinPatterns(packages: readonly string[], resolve: (s: string) => string): RegExp[] {
  const patterns = [/^jsr:/, /^npm:/];
  for (const name of packages) {
    const resolved = resolve(name);
    if (resolved.startsWith('file:')) {
      const directory = resolved.slice(0, resolved.lastIndexOf('/') + 1);
      patterns.push(new RegExp(`^${escapeRegExp(directory)}`));
    }
  }
  return patterns;
}

/**
 * Creates a Vite plugin for React Router development mode under Deno.
 *
 * Vite's development SSR runner resolves imports through `node_modules`. On
 * Deno a framework package is a JSR import in `deno.json`, so a route module
 * importing `@setu-ts/react-router-plugin` fails with `Cannot find module`. And
 * Vite would load a package mapped to a local path itself, which makes a
 * second copy of it: the context keys `contextKeyFor()` returns are matched by
 * identity, so the copy a loader reads would stop matching the copy
 * `setu.config.ts` sets. This plugin resolves each listed package with the
 * runtime's own resolver and marks the result as a runtime built-in, so the
 * runner imports it natively and shares the instance the server already holds.
 *
 * Pass it to `vite.createServer({ plugins: [...] })` from the development
 * entry, which is where `import.meta.resolve` reads `deno.json`; inside
 * `vite.config.ts` that function is Vite's, not Deno's.
 *
 * @example
 * ```typescript
 * import * as vite from 'vite';
 * import { viteDevExternals } from '@setu-ts/react-router-plugin';
 *
 * const server = await vite.createServer({
 *   configFile: new URL('./vite.config.ts', import.meta.url).pathname,
 *   plugins: [viteDevExternals({
 *     packages: ['@setu-ts/common', '@setu-ts/react-router-plugin'],
 *     resolve: (specifier) => import.meta.resolve(specifier),
 *   })],
 * });
 * ```
 * @param options - The packages to keep external, and the runtime's resolver
 * @returns A Vite plugin
 * @since 0.9.0
 */
export function viteDevExternals(options: ViteDevExternalsOptions): ViteDevExternalsPlugin {
  const { packages, resolve } = options;
  return {
    name: 'setu-ts-dev-externals',
    enforce: 'pre',
    configResolved(config: ViteResolvedEnvironments): void {
      const ssr = config.environments['ssr'];
      if (ssr === undefined) return;
      ssr.resolve.builtins = [...ssr.resolve.builtins, ...builtinPatterns(packages, resolve)];
    },
    resolveId(id: string): ViteDevExternalId | null {
      return isListed(packages, id) ? { id: resolve(id), external: true } : null;
    },
  };
}
