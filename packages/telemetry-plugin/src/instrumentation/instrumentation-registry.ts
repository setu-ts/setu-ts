/**
 * Instrumentation registry — builds, enables, and tracks auto-instrumentations.
 *
 * @module
 * @since 0.2.0
 */

import type {
  InstrumentationConfig,
  InstrumentationKind,
  InstrumentationsConfig,
} from '../interfaces/index.ts';
import type { IRuntimeServices } from '@setu-ts/common';
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

/**
 * Reports a single instrumentation outcome as the registry builds. The plugin
 * passes a reporter that reads `ctx.logger` at call time, so a logger
 * registered after this plugin still receives the lines. A reporter that
 * throws must not break the build — the observation path must not become the
 * failure path.
 *
 * @since 0.2.0
 */
export type InstrumentationReporter = (outcome: InstrumentationOutcome) => void;

/** Handle returned by the registry — call `shutdown()` on application teardown. */
export interface InstrumentationHandle {
  /** Shuts down all enabled instrumentations. */
  shutdown(): Promise<void>;
  /**
   * Records of what happened during registry build. Surfaced to the
   * application through the plugin's logger (one line per outcome: `debug`
   * for an enabled instrumentation, `warn` for a failure); a failure remains
   * a no-op and is never rethrown.
   */
  outcomes: InstrumentationOutcome[];
}

/**
 * Extracts a human-readable reason from a value caught in a `catch` block.
 *
 * `catch (err)` binds `unknown`: JS permits throwing any value, and a
 * non-`Error` throw (`throw null`, `throw 'boom'`) would make an
 * `(err as Error).message` read throw a fresh `TypeError` or yield
 * `undefined`. The registry must degrade, never throw, so the reason is
 * taken from `Error.message` when available and from `String(err)`
 * otherwise.
 *
 * @param err - The caught value.
 * @returns A non-empty string naming what was thrown.
 * @internal
 */
function reasonOf(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/** A single instrumentation loader: config → loaded instance + specifier. */
export type InstrumentationLoader = (
  configArg: unknown | undefined,
) => Promise<{ instance: unknown; specifier: string }>;

/**
 * Per-kind loaders the registry dispatches to. The registry takes them as an
 * option so tests can drive the lazy-load path without a real `npm:` import;
 * production passes the real loaders (the defaults below).
 *
 * @internal
 * @since 0.2.0
 */
export interface InstrumentationLoaders {
  readonly http: InstrumentationLoader;
  readonly fetch: InstrumentationLoader;
  readonly ioredis: InstrumentationLoader;
  readonly amqplib: InstrumentationLoader;
  readonly kafkajs: InstrumentationLoader;
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
 * **Async:** all lazy-load promises are collected and awaited (via `Promise.all`)
 * before the handle is returned, so `outcomes` is complete and `enabledInstrumentations`
 * is fully populated at return time.  This eliminates the shutdown-ordering race where
 * `onShutdown` could fire while a lazy load was still in-flight.
 *
 * @param config - The `instrumentations` option from plugin options.
 * @param runtime - Runtime services providing the platform gate.
 * @param provider - The OTel TracerProvider (from `TracerHost.otelProvider`); absent = no-op.
 * @param reporter - Invoked once per outcome as the registry builds. The plugin
 *   passes a `ctx.logger`-backed reporter; absent = outcomes are only recorded.
 * @param loaders - Per-kind loaders; defaults to the real lazy `npm:` loaders.
 *   Injectable so the lazy path is testable without a real import.
 * @returns An instrumentation handle (resolved after all lazy loads settle).
 * @since 0.2.0
 */
export async function buildInstrumentationRegistry(
  config: InstrumentationsConfig | undefined,
  runtime: IRuntimeServices,
  provider: unknown,
  reporter: InstrumentationReporter | undefined = undefined,
  loaders: InstrumentationLoaders = {
    http: loadHttpInstrumentation,
    fetch: loadFetchInstrumentation,
    ioredis: loadIORedisInstrumentation,
    amqplib: loadAmqplibInstrumentation,
    kafkajs: loadKafkaJsInstrumentation,
  },
): Promise<InstrumentationHandle> {
  const outcomes: InstrumentationOutcome[] = [];

  // Record an outcome and surface it to the reporter. The reporter is an
  // observation path: a throwing reporter must not break the build (M45b —
  // an observer must never become the failure path).
  function record(outcome: InstrumentationOutcome): void {
    outcomes.push(outcome);
    if (reporter) {
      try {
        reporter(outcome);
      } catch {
        // A failing observer must not become the failure path.
      }
    }
  }

  // If no provider, the registry is a no-op (noop mode / custom factory without otelProvider).
  // No outcomes are recorded, so the no-provider path reports nothing.
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
      record({ kind, enabled: false, reason: reasonOf(err) });
      return;
    }

    // Enable the instrumentation.
    try {
      if (instance && typeof (instance as { enable?: () => void }).enable === 'function') {
        (instance as { enable: () => void }).enable();
      }
    } catch (err) {
      record({ kind, enabled: false, reason: reasonOf(err) });
      return;
    }

    record({ kind, enabled: true });
    enabledInstrumentations.push({ kind, instance });
  }

  // Async helper: lazy npm: import path.
  async function enableLazy(
    kind: InstrumentationKind,
    configArg: unknown | undefined,
    loader: InstrumentationLoader,
  ): Promise<void> {
    if (!isInstrumentationSupported(kind, platform)) {
      record({ kind, enabled: false, reason: 'unsupported platform' });
      return;
    }

    let instance: unknown;
    try {
      const result = await loader(configArg);
      instance = result.instance;
    } catch (err) {
      record({ kind, enabled: false, reason: reasonOf(err) });
      return;
    }

    enableInjected(kind, instance);
  }

  // Collect lazy-load promises so we can await them all before returning.
  const lazyPromises: Promise<void>[] = [];

  // Dispatch each configured key — inject path is synchronous, lazy path collects promises.
  function dispatch(
    kind: InstrumentationKind,
    cfg: true | InstrumentationConfig | undefined,
    loader: InstrumentationLoader,
  ): void {
    if (cfg === undefined) return;

    if (typeof cfg === 'object' && cfg.instrumentation) {
      // Injected instance — synchronous path.
      enableInjected(kind, cfg.instrumentation);
    } else {
      // cfg === true or cfg without instrumentation — async lazy load.
      const configArg = typeof cfg === 'object' ? cfg.config : undefined;
      lazyPromises.push(enableLazy(kind, configArg, loader));
    }
  }

  const httpCfg = config?.http;
  if (httpCfg !== undefined) {
    dispatch('http', httpCfg, loaders.http);
  }

  const fetchCfg = config?.fetch;
  if (fetchCfg !== undefined) {
    dispatch('fetch', fetchCfg, loaders.fetch);
  }

  const ioredisCfg = config?.ioredis;
  if (ioredisCfg !== undefined) {
    dispatch('ioredis', ioredisCfg, loaders.ioredis);
  }

  const amqplibCfg = config?.amqplib;
  if (amqplibCfg !== undefined) {
    dispatch('amqplib', amqplibCfg, loaders.amqplib);
  }

  const kafkajsCfg = config?.kafkajs;
  if (kafkajsCfg !== undefined) {
    dispatch('kafkajs', kafkajsCfg, loaders.kafkajs);
  }

  // Await all lazy loads before returning — outcomes and enabledInstrumentations
  // are now fully populated.  Since each enableLazy catches internally, Promise.all
  // over the collected promises will never reject.
  await Promise.all(lazyPromises);

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
