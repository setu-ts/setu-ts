/**
 * Database instrumentation loader for ioredis.
 *
 * Loads `@opentelemetry/instrumentation-ioredis` via lazy `npm:` import.
 * Honors the inject-or-lazy seam.
 *
 * The default `importFn` keeps its `npm:` specifier as a **literal** at the
 * `import()` call — the only form that survives JSR's static
 * npm-compatibility rewrite and loads on Node or Bun (X7-3).
 *
 * @module
 * @since 0.2.0
 */

/** The `npm:` specifier the ioredis loader resolves. */
const IOREDIS_SPECIFIER = 'npm:@opentelemetry/instrumentation-ioredis@^0.68.0';

/**
 * Constructs an ioredis instrumentation instance from a loaded module.
 *
 * @internal
 */
export function createIORedisInstrumentation(
  mod: Record<string, unknown>,
  configArg: unknown,
): unknown {
  const IORedisInstrumentation = mod.IORedisInstrumentation as unknown;
  return new (IORedisInstrumentation as new (
    config?: Record<string, unknown>,
  ) => unknown)(configArg as Record<string, unknown> | undefined);
}

/**
 * Lazy-loads and constructs an ioredis instrumentation.
 *
 * @param configArg - Opaque config forwarded to the constructor (or `undefined` for defaults).
 * @param importFn - Zero-argument import seam; defaults to a real literal `import()`.
 * @returns A promise resolving to the constructed instrumentation.
 * @since 0.2.0
 */
export async function loadIORedisInstrumentation(
  configArg: unknown | undefined,
  importFn: () => Promise<Record<string, unknown>> = () =>
    import('npm:@opentelemetry/instrumentation-ioredis@^0.68.0'),
): Promise<{ instance: unknown; specifier: string }> {
  const mod = await importFn();
  const instance = createIORedisInstrumentation(mod, configArg);
  return { instance, specifier: IOREDIS_SPECIFIER };
}
