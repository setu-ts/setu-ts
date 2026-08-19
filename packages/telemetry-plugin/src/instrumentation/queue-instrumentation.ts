/**
 * Queue instrumentation loaders for amqplib and kafkajs.
 *
 * Loads `@opentelemetry/instrumentation-amqplib` and
 * `@opentelemetry/instrumentation-kafkajs` via lazy `npm:` imports.
 * Honors the inject-or-lazy seam.
 *
 * Each default `importFn` keeps its `npm:` specifier as a **literal** at the
 * `import()` call — the only form that survives JSR's static
 * npm-compatibility rewrite and loads on Node or Bun (X7-3).
 *
 * @module
 * @since 0.2.0
 */

/** The `npm:` specifier the amqplib loader resolves. */
const AMQLIB_SPECIFIER = 'npm:@opentelemetry/instrumentation-amqplib@^0.67.0';

/** The `npm:` specifier the kafkajs loader resolves. */
const KAFKAJS_SPECIFIER = 'npm:@opentelemetry/instrumentation-kafkajs@^0.29.0';

/**
 * Constructs an amqplib instrumentation instance from a loaded module.
 *
 * @internal
 */
export function createAmqplibInstrumentation(
  mod: Record<string, unknown>,
  configArg: unknown,
): unknown {
  const AmqplibInstrumentation = mod.AmqplibInstrumentation as unknown;
  return new (AmqplibInstrumentation as new (
    config?: Record<string, unknown>,
  ) => unknown)(configArg as Record<string, unknown> | undefined);
}

/**
 * Lazy-loads and constructs an amqplib instrumentation.
 *
 * @param configArg - Opaque config forwarded to the constructor (or `undefined` for defaults).
 * @param importFn - Zero-argument import seam; defaults to a real literal `import()`.
 * @returns A promise resolving to the constructed instrumentation.
 * @since 0.2.0
 */
export async function loadAmqplibInstrumentation(
  configArg: unknown | undefined,
  importFn: () => Promise<Record<string, unknown>> = () =>
    import('npm:@opentelemetry/instrumentation-amqplib@^0.67.0'),
): Promise<{ instance: unknown; specifier: string }> {
  const mod = await importFn();
  const instance = createAmqplibInstrumentation(mod, configArg);
  return { instance, specifier: AMQLIB_SPECIFIER };
}

/**
 * Constructs a KafkaJS instrumentation instance from a loaded module.
 *
 * @internal
 */
export function createKafkaJsInstrumentation(
  mod: Record<string, unknown>,
  configArg: unknown,
): unknown {
  const KafkaJsInstrumentation = mod.KafkaJsInstrumentation as unknown;
  return new (KafkaJsInstrumentation as new (
    config?: Record<string, unknown>,
  ) => unknown)(configArg as Record<string, unknown> | undefined);
}

/**
 * Lazy-loads and constructs a KafkaJS instrumentation.
 *
 * @param configArg - Opaque config forwarded to the constructor (or `undefined` for defaults).
 * @param importFn - Zero-argument import seam; defaults to a real literal `import()`.
 * @returns A promise resolving to the constructed instrumentation.
 * @since 0.2.0
 */
export async function loadKafkaJsInstrumentation(
  configArg: unknown | undefined,
  importFn: () => Promise<Record<string, unknown>> = () =>
    import('npm:@opentelemetry/instrumentation-kafkajs@^0.29.0'),
): Promise<{ instance: unknown; specifier: string }> {
  const mod = await importFn();
  const instance = createKafkaJsInstrumentation(mod, configArg);
  return { instance, specifier: KAFKAJS_SPECIFIER };
}
