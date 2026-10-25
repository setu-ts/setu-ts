/**
 * HTTP and Fetch instrumentation loaders.
 *
 * Loads `@opentelemetry/instrumentation-http` for the `http` kind and
 * `@opentelemetry/instrumentation-undici` for the `fetch` kind via lazy
 * dynamic imports. Honors the inject-or-lazy seam.
 *
 * Each default `importFn` keeps its package specifier as a **literal** at the
 * `import()` call. Static analysis (a bundler, the type checker, the
 * repository's import audit) reaches only a literal argument; a specifier routed
 * through a `(spec) => import(spec)` indirection hides the dependency (X7-3).
 *
 * @module
 * @since 0.2.0
 */

import { OptionalDependencyUnavailableError } from '@setu-ts/common';

/** Result of loading an instrumentation. */
export interface LoadedInstrumentation {
  instance: unknown;
  specifier: string;
}

/** The package specifier the `http` loader resolves. */
const HTTP_SPECIFIER = '@opentelemetry/instrumentation-http';

/** The package specifier the `fetch` (undici) loader resolves. */
const FETCH_SPECIFIER = '@opentelemetry/instrumentation-undici';

/**
 * Constructs an HTTP instrumentation instance from a loaded module.
 *
 * @param mod - The loaded `@opentelemetry/instrumentation-http` module.
 * @param configArg - Opaque config forwarded to the constructor.
 * @returns The constructed instrumentation instance.
 * @internal
 */
export function createHttpInstrumentation(
  mod: Record<string, unknown>,
  configArg: unknown,
): unknown {
  const HttpInstrumentation = mod.HttpInstrumentation as unknown;
  return new (HttpInstrumentation as new (config?: Record<string, unknown>) => unknown)(
    configArg as Record<string, unknown> | undefined,
  );
}

/**
 * Lazy-loads and constructs an HTTP instrumentation.
 *
 * @param configArg - Opaque config forwarded to the constructor (or `undefined` for defaults).
 * @param importFn - Zero-argument import seam; defaults to a real literal `import()`.
 * @returns A promise resolving to the constructed instrumentation.
 * @since 0.2.0
 */
export async function loadHttpInstrumentation(
  configArg: unknown | undefined,
  importFn: () => Promise<Record<string, unknown>> = async () => {
    try {
      return await import('@opentelemetry/instrumentation-http');
    } catch (error) {
      throw new OptionalDependencyUnavailableError('@opentelemetry/instrumentation-http', {
        requiredBy: '@setu-ts/telemetry-plugin',
        cause: error,
      });
    }
  },
): Promise<LoadedInstrumentation> {
  const mod = await importFn();
  const instance = createHttpInstrumentation(mod, configArg);
  return { instance, specifier: HTTP_SPECIFIER };
}

/**
 * Constructs a Fetch (undici) instrumentation instance from a loaded module.
 *
 * @param mod - The loaded `@opentelemetry/instrumentation-undici` module.
 * @param configArg - Opaque config forwarded to the constructor.
 * @returns The constructed instrumentation instance.
 * @internal
 */
export function createFetchInstrumentation(
  mod: Record<string, unknown>,
  configArg: unknown,
): unknown {
  const UndiciInstrumentation = mod.UndiciInstrumentation as unknown;
  return new (UndiciInstrumentation as new (config?: Record<string, unknown>) => unknown)(
    configArg as Record<string, unknown> | undefined,
  );
}

/**
 * Lazy-loads and constructs a Fetch (undici) instrumentation.
 *
 * @param configArg - Opaque config forwarded to the constructor (or `undefined` for defaults).
 * @param importFn - Zero-argument import seam; defaults to a real literal `import()`.
 * @returns A promise resolving to the constructed instrumentation.
 * @since 0.2.0
 */
export async function loadFetchInstrumentation(
  configArg: unknown | undefined,
  importFn: () => Promise<Record<string, unknown>> = async () => {
    try {
      return await import('@opentelemetry/instrumentation-undici');
    } catch (error) {
      throw new OptionalDependencyUnavailableError('@opentelemetry/instrumentation-undici', {
        requiredBy: '@setu-ts/telemetry-plugin',
        cause: error,
      });
    }
  },
): Promise<LoadedInstrumentation> {
  const mod = await importFn();
  const instance = createFetchInstrumentation(mod, configArg);
  return { instance, specifier: FETCH_SPECIFIER };
}
