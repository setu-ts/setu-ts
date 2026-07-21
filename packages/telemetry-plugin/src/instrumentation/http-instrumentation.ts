/**
 * HTTP and Fetch instrumentation loaders.
 *
 * Loads `@opentelemetry/instrumentation-http` for the `http` kind and
 * `@opentelemetry/instrumentation-undici` for the `fetch` kind via lazy
 * `npm:` imports. Honors the inject-or-lazy seam.
 *
 * @module
 * @since 0.24.1
 */

/** Result of loading an instrumentation. */
export interface LoadedInstrumentation {
  instance: unknown;
  specifier: string;
}

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
  return new (HttpInstrumentation as new (
    config?: Record<string, unknown>,
  ) => unknown)(configArg as Record<string, unknown> | undefined);
}

/**
 * Lazy-loads and constructs an HTTP instrumentation.
 *
 * @param configArg - Opaque config forwarded to the constructor (or `undefined` for defaults).
 * @returns A promise resolving to the constructed instrumentation.
 * @since 0.24.1
 */
export async function loadHttpInstrumentation(
  configArg: unknown | undefined,
): Promise<LoadedInstrumentation> {
  const mod = await import('npm:@opentelemetry/instrumentation-http@^0.220.0');
  const instance = createHttpInstrumentation(mod, configArg);
  return { instance, specifier: 'npm:@opentelemetry/instrumentation-http@^0.220.0' };
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
  return new (UndiciInstrumentation as new (
    config?: Record<string, unknown>,
  ) => unknown)(configArg as Record<string, unknown> | undefined);
}

/**
 * Lazy-loads and constructs a Fetch (undici) instrumentation.
 *
 * @param configArg - Opaque config forwarded to the constructor (or `undefined` for defaults).
 * @returns A promise resolving to the constructed instrumentation.
 * @since 0.24.1
 */
export async function loadFetchInstrumentation(
  configArg: unknown | undefined,
): Promise<LoadedInstrumentation> {
  const mod = await import('npm:@opentelemetry/instrumentation-undici@^0.30.0');
  const instance = createFetchInstrumentation(mod, configArg);
  return { instance, specifier: 'npm:@opentelemetry/instrumentation-undici@^0.30.0' };
}
