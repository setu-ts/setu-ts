/**
 * Queue instrumentation loaders for amqplib and kafkajs.
 *
 * Loads `@opentelemetry/instrumentation-amqplib` and
 * `@opentelemetry/instrumentation-kafkajs` via lazy dynamic imports.
 * Honors the inject-or-lazy seam.
 *
 * Each default `importFn` keeps its package specifier as a **literal** at the
 * `import()` call — the only form static analysis (a bundler, the type
 * checker, the repository's import audit) can see (X7-3).
 *
 * @module
 * @since 0.2.0
 */

import { OptionalDependencyUnavailableError } from '@setu-ts/common';

/** The package specifier the amqplib loader resolves. */
const AMQLIB_SPECIFIER = '@opentelemetry/instrumentation-amqplib';

/** The package specifier the kafkajs loader resolves. */
const KAFKAJS_SPECIFIER = '@opentelemetry/instrumentation-kafkajs';

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
  return new (AmqplibInstrumentation as new (config?: Record<string, unknown>) => unknown)(
    configArg as Record<string, unknown> | undefined,
  );
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
  importFn: () => Promise<Record<string, unknown>> = async () => {
    try {
      return await import('@opentelemetry/instrumentation-amqplib');
    } catch (error) {
      throw new OptionalDependencyUnavailableError('@opentelemetry/instrumentation-amqplib', {
        requiredBy: '@setu-ts/telemetry-plugin',
        cause: error,
      });
    }
  },
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
  return new (KafkaJsInstrumentation as new (config?: Record<string, unknown>) => unknown)(
    configArg as Record<string, unknown> | undefined,
  );
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
  importFn: () => Promise<Record<string, unknown>> = async () => {
    try {
      return await import('@opentelemetry/instrumentation-kafkajs');
    } catch (error) {
      throw new OptionalDependencyUnavailableError('@opentelemetry/instrumentation-kafkajs', {
        requiredBy: '@setu-ts/telemetry-plugin',
        cause: error,
      });
    }
  },
): Promise<{ instance: unknown; specifier: string }> {
  const mod = await importFn();
  const instance = createKafkaJsInstrumentation(mod, configArg);
  return { instance, specifier: KAFKAJS_SPECIFIER };
}
