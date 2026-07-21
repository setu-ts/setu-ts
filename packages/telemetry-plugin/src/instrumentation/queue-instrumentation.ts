/**
 * Queue instrumentation loaders for amqplib and kafkajs.
 *
 * Loads `@opentelemetry/instrumentation-amqplib` and
 * `@opentelemetry/instrumentation-kafkajs` via lazy `npm:` imports.
 * Honors the inject-or-lazy seam.
 *
 * @module
 * @since 0.24.1
 */

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
 * @returns A promise resolving to the constructed instrumentation.
 * @since 0.24.1
 */
export async function loadAmqplibInstrumentation(
  configArg: unknown | undefined,
): Promise<{ instance: unknown; specifier: string }> {
  const mod = await import('npm:@opentelemetry/instrumentation-amqplib@^0.67.0');
  const instance = createAmqplibInstrumentation(mod, configArg);
  return { instance, specifier: 'npm:@opentelemetry/instrumentation-amqplib@^0.67.0' };
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
 * @returns A promise resolving to the constructed instrumentation.
 * @since 0.24.1
 */
export async function loadKafkaJsInstrumentation(
  configArg: unknown | undefined,
): Promise<{ instance: unknown; specifier: string }> {
  const mod = await import('npm:@opentelemetry/instrumentation-kafkajs@^0.29.0');
  const instance = createKafkaJsInstrumentation(mod, configArg);
  return { instance, specifier: 'npm:@opentelemetry/instrumentation-kafkajs@^0.29.0' };
}
