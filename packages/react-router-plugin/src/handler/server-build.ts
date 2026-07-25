/**
 * Lazy import seam for the React Router server build and request handler.
 *
 * @module
 * @since 0.1.0
 */

import type { RouterLoadContext, SsrRequestHandler, SsrRuntime } from '../interfaces/index.ts';

/**
 * Constructor shape of React Router's `RouterContextProvider` class.
 *
 * @since 0.2.0
 */
type RouterContextProviderConstructor = new () => RouterLoadContext;

/**
 * Builds the per-request context factory from React Router's
 * `RouterContextProvider` class.
 *
 * React Router 8 checks `initialContext instanceof RouterContextProvider` and
 * answers a 500 `Unexpected Server Error` when it fails, so the class itself —
 * not a structural stand-in — has to reach the handler.
 *
 * Extracted as a pure function so the branch is unit-testable without importing
 * `react-router`.
 *
 * @param rr - The loaded `react-router` module namespace
 * @returns A factory constructing a fresh, empty provider per request
 * @throws {Error} When the module exposes no `RouterContextProvider` export
 * @since 0.2.0
 */
export function createLoadContextFactory(
  rr: Record<string, unknown>,
): () => RouterLoadContext {
  const Provider = rr.RouterContextProvider as
    | RouterContextProviderConstructor
    | undefined;

  if (typeof Provider !== 'function') {
    throw new Error(
      `The loaded 'react-router' module exposes no 'RouterContextProvider' export. ` +
        `React Router 8 or later is required — 'createRequestHandler' rejects any ` +
        `context that is not an instance of that class.`,
    );
  }

  return () => new Provider();
}

/**
 * Names a rejected `loadRequestHandler` result for the error message.
 *
 * @param value - The value the seam resolved to
 * @returns A short human description
 * @since 0.2.0
 */
function describeSeamResult(value: unknown): string {
  if (typeof value === 'function') {
    return 'a bare request handler function (the pre-0.2.0 shape)';
  }
  if (value === null || value === undefined) {
    return String(value);
  }
  if (typeof value === 'object') {
    const keys = Object.keys(value as Record<string, unknown>);
    return `an object with keys [${keys.join(', ')}]`;
  }
  return `a ${typeof value}`;
}

/**
 * Validates that an injected `loadRequestHandler` resolved to a usable
 * {@linkcode SsrRuntime}, and narrows it.
 *
 * Without this check a seam returning the pre-0.2.0 bare handler registers
 * cleanly, reports a healthy indicator, and then fails EVERY request with an
 * opaque 500 when the missing `createLoadContext` is invoked per request —
 * the same silent-500 class of defect this contract exists to remove. Failing
 * during `register()` turns that into one actionable startup error.
 *
 * @param value - Whatever the seam resolved to
 * @returns The value narrowed to an `SsrRuntime`
 * @throws {Error} When `handler` or `createLoadContext` is not a function
 * @since 0.2.0
 */
export function assertSsrRuntime(value: unknown): SsrRuntime {
  const candidate = value as Partial<SsrRuntime> | null | undefined;

  if (
    typeof candidate?.handler !== 'function' ||
    typeof candidate?.createLoadContext !== 'function'
  ) {
    throw new Error(
      `'loadRequestHandler' must resolve to { handler, createLoadContext }, but got ` +
        `${describeSeamResult(value)}. React Router 8 requires a real 'RouterContextProvider' ` +
        `instance for every request, so the seam must return a 'createLoadContext' factory ` +
        `alongside the handler — sourced from the same 'react-router' module the handler came ` +
        `from. See docs/react-router-dev.md for a worked development-mode seam.`,
    );
  }

  return candidate as SsrRuntime;
}

/**
 * Pure function that assembles an RR request handler from a pre-loaded build
 * and the `createRequestHandler` factory.
 *
 * Extracted so it can be unit-tested without any I/O or network imports.
 *
 * @param build - The RR `ServerBuild` (default export of the app's server build)
 * @param createRequestHandler - The factory from `npm:react-router`
 * @param mode - `'production'` or `'development'`
 * @returns A callable `SsrRequestHandler`
 * @since 0.1.0
 */
export function assembleHandler(
  build: unknown,
  createRequestHandler: (build: unknown, mode: string) => unknown,
  mode: string,
): SsrRequestHandler {
  return createRequestHandler(build, mode) as SsrRequestHandler;
}

/**
 * Default implementation of `loadRequestHandler`.
 *
 * Lazily imports the app-provided server build (`import(serverBuildPath)`) and
 * the core `react-router` package (`import('npm:react-router@8')`), unwraps
 * the `ServerBuild` (default export), then returns a callable request handler.
 *
 * Both the handler and the context-provider factory come from the SAME module
 * object, so the provider instance can never be tested against a different copy
 * of the `RouterContextProvider` class than the one it was constructed from.
 *
 * @param serverBuildPath - Path to the RR Vite server build (app-provided)
 * @param mode - `'production'` or `'development'`
 * @param options - Optional override for the react-router import seam
 * @returns A promise resolving to the handler and its context factory
 * @throws {Error} When either import fails, with a message naming the missing specifier
 * @since 0.1.0
 */
export async function loadRequestHandler(
  serverBuildPath: string,
  mode: string,
  options?: { rrImportHook?: () => Promise<Record<string, unknown>> },
): Promise<SsrRuntime> {
  let buildMod: unknown;
  try {
    // Vite ESM build: { default: ServerBuild, routes: {}, ... }
    buildMod = await import(/* @vite-ignore */ serverBuildPath);
  } catch (err) {
    throw new Error(
      `Failed to load React Router server build from "${serverBuildPath}". ` +
        `Ensure the path is correct and the file exports a ServerBuild as default. ` +
        `Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  // Unwrap the default export (ESM `default` or CJS spread).
  const build = (buildMod as Record<string, unknown>)?.default ?? buildMod;

  let rr: Record<string, unknown>;
  try {
    rr = options?.rrImportHook ? await options.rrImportHook() : await import('npm:react-router@8');
  } catch (err) {
    throw new Error(
      `Failed to import 'npm:react-router@8'. Ensure it is available in the ` +
        `runtime/module resolution. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  if (typeof rr.createRequestHandler !== 'function') {
    throw new Error(
      `The loaded 'react-router' module exposes no 'createRequestHandler' export. ` +
        `Ensure the resolved package is React Router 8 or later.`,
    );
  }

  const createRequestHandler = rr.createRequestHandler as (
    build: unknown,
    mode: string,
  ) => unknown;

  return {
    handler: assembleHandler(build, createRequestHandler, mode),
    createLoadContext: createLoadContextFactory(rr),
  };
}
