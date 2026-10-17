/**
 * React Router plugin configuration options and type definitions.
 *
 * @module
 * @since 0.1.0
 */

import type { IRequestContext } from '@setu-ts/common';
export type { IRequestContext } from '@setu-ts/common';

/**
 * React Router request handler — the callable returned by
 * `createRequestHandler(build, mode)`.
 *
 * @since 0.1.0
 */
export type SsrRequestHandler = (request: Request, loadContext: unknown) => Promise<Response>;

/**
 * A React Router context key, used by identity as the argument to
 * {@linkcode RouterLoadContext.get} / {@linkcode RouterLoadContext.set}.
 *
 * Structurally identical to React Router's `RouterContext<T>`, so a key created
 * by this package and a key created by `createContext<T>()` from `react-router`
 * are interchangeable. `defaultValue` is returned by `get()` when no value has
 * been set; a key without one makes `get()` throw for an unset key.
 *
 * @since 0.2.0
 */
export interface RouterContextKey<T> {
  /** Value returned by `get()` when the key has not been set. */
  readonly defaultValue?: T;
}

/**
 * The per-request context object React Router passes to loaders, actions, and
 * middleware as `context`.
 *
 * React Router 8 requires this to be a real `RouterContextProvider` instance —
 * it performs a nominal `instanceof` check in `createRequestHandler` and again
 * in the static handler whenever route middleware is used. A structurally
 * equivalent object is therefore NOT sufficient, which is why the instance is
 * always constructed by {@linkcode SsrRuntime.createLoadContext}, sourced from
 * the same `react-router` module the request handler came from.
 *
 * @since 0.2.0
 */
export interface RouterLoadContext {
  /**
   * Reads a key, falling back to the key's `defaultValue`.
   *
   * @param key - The context key
   * @returns The stored value, or the key's `defaultValue`
   * @throws {Error} When the key is unset and carries no `defaultValue`
   */
  get<T>(key: RouterContextKey<T>): T;
  /**
   * Writes a key, overwriting any previous value.
   *
   * @param key - The context key
   * @param value - The value to store
   */
  set<T>(key: RouterContextKey<T>, value: T): void;
}

/**
 * Everything the plugin needs from a loaded React Router module: the request
 * handler, plus a factory for the `RouterContextProvider` that handler will
 * accept.
 *
 * Both are resolved from ONE `react-router` module object so the provider can
 * never be an instance of a different copy of the class than the one the
 * handler's `instanceof` check tests against.
 *
 * @since 0.2.0
 */
export interface SsrRuntime {
  /** The callable returned by `createRequestHandler(build, mode)`. */
  readonly handler: SsrRequestHandler;
  /** Constructs a fresh, empty per-request context provider. */
  readonly createLoadContext: () => RouterLoadContext;
}

/**
 * Hook for adding application values to the per-request React Router context.
 *
 * Called AFTER the plugin has set {@linkcode servicesContext} and
 * {@linkcode userContext}, so it augments the defaults rather than replacing
 * them. It receives the provider and mutates it; it does not return one,
 * because only the plugin can construct an instance of the correct class.
 *
 * @since 0.2.0
 */
export type PopulateLoadContext = (ctx: IRequestContext, context: RouterLoadContext) => void;

/**
 * The options shared by both arms of {@linkcode ReactRouterPluginOptions}.
 *
 * @since 0.10.0
 */
export interface ReactRouterCommonOptions {
  /**
   * Injectable seam for lazy loading the RR runtime. When omitted, the default
   * loads the server build (by path or module) + `await import('react-router')`.
   *
   * Also the supported hook for a development server: return a handler built
   * over a build thunk (`createRequestHandler(() => vite.ssrLoadModule(...))`)
   * to pick up rebuilds without restarting the process.
   *
   * The first argument is the app's `serverBuildPath`, or the placeholder
   * `'<serverBuild>'` when the build was supplied as a module. On the module
   * arm the third argument carries that module as `serverBuild`; on the path
   * arm it is `undefined`.
   *
   * @since 0.2.0 Returns an {@linkcode SsrRuntime} rather than a bare handler,
   * so the context-provider constructor is sourced from the same `react-router`
   * module as the handler.
   */
  readonly loadRequestHandler?: (
    serverBuildPath: string,
    mode: string,
    options?: { readonly serverBuild?: unknown },
  ) => Promise<SsrRuntime>;

  /**
   * Filesystem root of the built client bundle. Omit to disable static-asset
   * serving (no asset route registered).
   * @since 0.1.0
   */
  readonly assetsDir?: string;

  /**
   * URL prefix for the static-asset route. Default `/assets/`.
   * @since 0.1.0
   */
  readonly assetUrlPrefix?: string;

  /**
   * Also serves files from the client-build ROOT — where Vite copies `public/`
   * (`robots.txt`, `favicon.ico`, …) — in addition to
   * {@linkcode ReactRouterCommonOptions.assetUrlPrefix}, with
   * `Cache-Control: public, max-age=0, must-revalidate`: root files are not
   * content-hashed, so they must be revalidated rather than cached immutably.
   * A request matching neither the root nor the prefix still falls through to
   * the SSR catch-all.
   *
   * Default `true`. `false` preserves prefix-only serving exactly as before.
   *
   * @since 0.2.0
   */
  readonly publicFiles?: boolean;

  /**
   * Mount prefix for the SSR catch-all route. Default `/`.
   * MUST match the app's `react-router.config.ts` `basename` for flat/nested
   * routes to resolve.
   * @since 0.1.0
   */
  readonly basename?: string;

  /**
   * Adds application values to the per-request React Router context, on top of
   * the {@linkcode servicesContext} and {@linkcode userContext} keys the plugin
   * always sets.
   *
   * Replaces the removed `getLoadContext` option: React Router 8 requires a
   * real `RouterContextProvider` instance, which an app-supplied function
   * cannot safely construct, so the callback now mutates the provider the
   * plugin built instead of returning a plain object.
   *
   * @since 0.2.0
   */
  readonly populateLoadContext?: PopulateLoadContext;

  /**
   * Mode passed to `createRequestHandler(build, mode)`.
   * @since 0.1.0
   */
  readonly mode?: 'production' | 'development';
}

/**
 * The path arm: the server build is loaded by `await import(serverBuildPath)`.
 *
 * @since 0.10.0
 */
export interface ReactRouterPathOptions extends ReactRouterCommonOptions {
  /**
   * Path to the React Router Vite server build (default export = `ServerBuild`).
   *
   * Must be **absolute** — an absolute filesystem path or a `file:` URL. The
   * default loader performs `await import(serverBuildPath)`, and a relative
   * specifier there resolves against this plugin's own module rather than
   * against the consuming application, so it can never find the build. From an
   * application module, derive one with
   * `new URL('./build/server/index.js', import.meta.url).href`.
   *
   * Correct for the socket targets. On Cloudflare Workers a bundled module
   * cannot resolve `new URL(…, import.meta.url)` against the application, so
   * the build arrives as a module instead — supply
   * {@linkcode ReactRouterModuleOptions.serverBuild}.
   *
   * In the npm build, a relative specifier is also passed through TypeScript's
   * `rewriteRelativeImportExtensions` helper, which turns a trailing
   * `.ts`/`.tsx`/`.mts`/`.cts` into its `.js` counterpart before the import.
   * An absolute path or `file:` URL is passed through unchanged.
   *
   * @since 0.1.0
   */
  readonly serverBuildPath: string;

  /**
   * The exclusivity marker (M113d §3.10): supplying `serverBuild` alongside
   * `serverBuildPath` is a compile error, because `never` accepts nothing.
   */
  readonly serverBuild?: never;
}

/**
 * The module arm: the compiled server build is supplied as a module namespace,
 * so no path import happens at all. This is the form a bundled Cloudflare
 * Worker uses — the generated entry statically imports
 * `../build/server/index.js` and passes it here (M113d §3.10).
 *
 * @since 0.10.0
 */
export interface ReactRouterModuleOptions extends ReactRouterCommonOptions {
  /**
   * The namespace of the app's compiled server build (default export =
   * `ServerBuild`). Mutually exclusive with
   * {@linkcode ReactRouterPathOptions.serverBuildPath} at the type level:
   * supplying neither or both is a compile error.
   *
   * @since 0.10.0
   */
  readonly serverBuild: unknown;

  /**
   * The exclusivity marker (M113d §3.10): supplying `serverBuildPath`
   * alongside `serverBuild` is a compile error, because `never` accepts
   * nothing.
   */
  readonly serverBuildPath?: never;
}

/**
 * The plugin's options: exactly one of `serverBuildPath` (path arm) and
 * `serverBuild` (module arm).
 *
 * A union `type`, not an `interface`: an application that `extends` it or
 * merges a declaration into it stops compiling (breaking for implementors,
 * shipped in minor 0.10.0). A caller passing `serverBuildPath` is unaffected.
 *
 * @since 0.1.0
 */
export type ReactRouterPluginOptions = ReactRouterPathOptions | ReactRouterModuleOptions;
