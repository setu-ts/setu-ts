/**
 * React Router plugin configuration options and type definitions.
 *
 * @module
 * @since 0.1.0
 */

import type { IRequestContext } from '@hono-enterprise/common';
export type { IRequestContext } from '@hono-enterprise/common';

/**
 * React Router request handler — the callable returned by
 * `createRequestHandler(build, mode)`.
 *
 * @since 0.1.0
 */
export type SsrRequestHandler = (
  request: Request,
  loadContext: unknown,
) => Promise<Response>;

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
export type PopulateLoadContext = (
  ctx: IRequestContext,
  context: RouterLoadContext,
) => void;

/**
 * Options for the React Router plugin.
 *
 * @since 0.1.0
 */
export interface ReactRouterPluginOptions {
  /**
   * Path to the React Router Vite server build (default export = `ServerBuild`).
   * @since 0.1.0
   */
  readonly serverBuildPath: string;

  /**
   * Injectable seam for lazy loading the RR runtime. When omitted, the default
   * performs `await import(serverBuildPath)` + `await import('npm:react-router@8')`.
   *
   * Also the supported hook for a development server: return a handler built
   * over a build thunk (`createRequestHandler(() => vite.ssrLoadModule(...))`)
   * to pick up rebuilds without restarting the process.
   *
   * @since 0.2.0 Returns an {@linkcode SsrRuntime} rather than a bare handler,
   * so the context-provider constructor is sourced from the same `react-router`
   * module as the handler.
   */
  readonly loadRequestHandler?: (
    serverBuildPath: string,
    mode: string,
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
