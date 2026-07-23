/**
 * Lazy import seam for the React Router server build and request handler.
 *
 * @module
 * @since 0.1.0
 */

import type { SsrRequestHandler } from '../interfaces/index.ts';

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
  // deno-lint-ignore no-explicit-any
  createRequestHandler: any,
  mode: string,
): SsrRequestHandler {
  return createRequestHandler(build, mode) as SsrRequestHandler;
}

/**
 * Default implementation of `loadRequestHandler`.
 *
 * Lazily imports the app-provided server build (`import(serverBuildPath)`) and
 * the core `react-router` package (`import('npm:react-router@7')`), unwraps
 * the `ServerBuild` (default export), then returns a callable request handler.
 *
 * @param serverBuildPath - Path to the RR Vite server build (app-provided)
 * @param mode - `'production'` or `'development'`
 * @param options - Optional override for the react-router import seam
 * @returns A promise resolving to the request handler
 * @throws {Error} When either import fails, with a message naming the missing specifier
 * @since 0.1.0
 */
export async function loadRequestHandler(
  serverBuildPath: string,
  mode: string,
  options?: { rrImportHook?: () => Promise<Record<string, unknown>> },
): Promise<SsrRequestHandler> {
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

  // deno-lint-ignore no-explicit-any
  let createRequestHandler: any;
  try {
    const rr = options?.rrImportHook
      ? await options.rrImportHook()
      : await import('npm:react-router@7');
    createRequestHandler = rr.createRequestHandler;
  } catch (err) {
    throw new Error(
      `Failed to import 'npm:react-router@7'. Ensure it is available in the ` +
        `runtime/module resolution. Cause: ${err instanceof Error ? err.message : String(err)}`,
    );
  }

  return assembleHandler(build, createRequestHandler, mode);
}
