/**
 * Database instrumentation loader for ioredis.
 *
 * Loads `@opentelemetry/instrumentation-ioredis` via lazy `npm:` import.
 * Honors the inject-or-lazy seam.
 *
 * @module
 * @since 0.24.1
 */

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
 * @returns A promise resolving to the constructed instrumentation.
 * @since 0.24.1
 */
export async function loadIORedisInstrumentation(
  configArg: unknown | undefined,
): Promise<{ instance: unknown; specifier: string }> {
  const mod = await import('npm:@opentelemetry/instrumentation-ioredis@^0.68.0');
  const instance = createIORedisInstrumentation(mod, configArg);
  return { instance, specifier: 'npm:@opentelemetry/instrumentation-ioredis@^0.68.0' };
}
