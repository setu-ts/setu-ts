/**
 * Instrumentation registry — builds, enables, and tracks auto-instrumentations.
 *
 * @module
 * @since 0.24.1
 */

import type {
  InstrumentationConfig,
  InstrumentationKind,
  InstrumentationsConfig,
} from '../interfaces/index.ts';
import type { IRuntimeServices } from '@hono-enterprise/common';
import { loadFetchInstrumentation, loadHttpInstrumentation } from './http-instrumentation.ts';
import { loadIORedisInstrumentation } from './database-instrumentation.ts';
import { loadAmqplibInstrumentation, loadKafkaJsInstrumentation } from './queue-instrumentation.ts';

/** Outcome of enabling a single instrumentation. */
export interface InstrumentationOutcome {
  /** The instrumentation kind. */
  kind: InstrumentationKind;
  /** Whether it was successfully enabled. */
  enabled: boolean;
  /** Reason for failure when `enabled` is `false`. */
  reason?: string;
}

/** Handle returned by the registry — call `shutdown()` on application teardown. */
export interface InstrumentationHandle {
  /** Shuts down all enabled instrumentations. */
  shutdown(): Promise<void>;
  /** Records of what happened during registry build. */
  outcomes: InstrumentationOutcome[];
}

/** Platform check — all five instrumentations target Node internals. */
export function isInstrumentationSupported(
  _kind: InstrumentationKind,
  platform: string,
): boolean {
  return platform === 'node';
}

/**
 * Builds an instrumentation registry and returns a handle.
 *
 * When `provider` is `undefined`, the registry is a no-op (zero loaders called).
 * Any loader failure degrades to a documented no-op and NEVER throws.
 *
 * @param config - The `instrumentations` option from plugin options.
 * @param runtime - Runtime services providing the platform gate.
 * @param provider - The OTel TracerProvider (from `TracerHost.otelProvider`); absent = no-op.
 * @returns An instrumentation handle.
 * @since 0.24.1
 */
export function buildInstrumentationRegistry(
  config: InstrumentationsConfig | undefined,
  runtime: IRuntimeServices,
  provider: unknown,
): InstrumentationHandle {
  const outcomes: InstrumentationOutcome[] = [];

  // If no provider, the registry is a no-op (noop mode / custom factory without otelProvider).
  if (!provider) {
    return {
      shutdown: async () => {},
      outcomes,
    };
  }

  const platform = runtime.platform();
  const enabledInstrumentations: Array<{
    kind: InstrumentationKind;
    instance: unknown;
  }> = [];

  // Sync helper: enable an instrumentation with an injected instance.
  function enableInjected(
    kind: InstrumentationKind,
    instance: unknown,
  ): void {
    // Attach to provider per-instance (NOT global singleton).
    try {
      if (
        instance &&
        typeof (instance as { setTracerProvider?: (p: unknown) => void }).setTracerProvider ===
          'function'
      ) {
        (instance as { setTracerProvider: (p: unknown) => void }).setTracerProvider(provider);
      }
    } catch (err) {
      outcomes.push({ kind, enabled: false, reason: (err as Error).message });
      return;
    }

    // Enable the instrumentation.
    try {
      if (instance && typeof (instance as { enable?: () => void }).enable === 'function') {
        (instance as { enable: () => void }).enable();
      }
    } catch (err) {
      outcomes.push({ kind, enabled: false, reason: (err as Error).message });
      return;
    }

    outcomes.push({ kind, enabled: true });
    enabledInstrumentations.push({ kind, instance });
  }

  // Async helper: lazy npm: import path.
  async function enableLazy(
    kind: InstrumentationKind,
    configArg: unknown | undefined,
    loader: (
      configArg: unknown | undefined,
    ) => Promise<{ instance: unknown; specifier: string }>,
  ): Promise<void> {
    if (!isInstrumentationSupported(kind, platform)) {
      outcomes.push({ kind, enabled: false, reason: 'unsupported platform' });
      return;
    }

    let instance: unknown;
    try {
      const result = await loader(configArg);
      instance = result.instance;
    } catch (err) {
      outcomes.push({ kind, enabled: false, reason: (err as Error).message });
      return;
    }

    enableInjected(kind, instance);
  }

  // Dispatch each configured key — inject path is synchronous, lazy path is fire-and-forget.
  function dispatch(
    kind: InstrumentationKind,
    cfg: true | InstrumentationConfig | undefined,
    loader: (
      configArg: unknown | undefined,
    ) => Promise<{ instance: unknown; specifier: string }>,
  ): void {
    if (cfg === undefined) return;

    if (typeof cfg === 'object' && cfg.instrumentation) {
      // Injected instance — synchronous path.
      enableInjected(kind, cfg.instrumentation);
    } else {
      // cfg === true or cfg without instrumentation — async lazy load.
      const configArg = typeof cfg === 'object' ? cfg.config : undefined;
      void enableLazy(kind, configArg, loader);
    }
  }

  const httpCfg = config?.http;
  if (httpCfg !== undefined) {
    dispatch('http', httpCfg, loadHttpInstrumentation);
  }

  const fetchCfg = config?.fetch;
  if (fetchCfg !== undefined) {
    dispatch('fetch', fetchCfg, loadFetchInstrumentation);
  }

  const ioredisCfg = config?.ioredis;
  if (ioredisCfg !== undefined) {
    dispatch('ioredis', ioredisCfg, loadIORedisInstrumentation);
  }

  const amqplibCfg = config?.amqplib;
  if (amqplibCfg !== undefined) {
    dispatch('amqplib', amqplibCfg, loadAmqplibInstrumentation);
  }

  const kafkajsCfg = config?.kafkajs;
  if (kafkajsCfg !== undefined) {
    dispatch('kafkajs', kafkajsCfg, loadKafkaJsInstrumentation);
  }

  return {
    shutdown: (): Promise<void> => {
      for (const { instance } of enabledInstrumentations) {
        try {
          if (instance && typeof (instance as { disable?: () => void }).disable === 'function') {
            (instance as { disable: () => void }).disable();
          }
        } catch {
          // Individual disable failures are silently ignored — the provider
          // shutdown will flush remaining spans.
        }
      }
      return Promise.resolve();
    },
    outcomes,
  };
}
