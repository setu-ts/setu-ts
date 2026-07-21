/**
 * Plugin-specific interfaces and constants.
 *
 * @module
 * @since 0.24.0
 */

import type { TelemetryContext } from '@hono-enterprise/common';

/**
 * The key used to store the active span on `ctx.state`.
 *
 * Downstream handlers and middleware can read the active span via
 * `ctx.state.get(TELEMETRY_SPAN_KEY)` and cast to {@linkcode ISpan}.
 *
 * @since 0.24.0
 */
export const TELEMETRY_SPAN_KEY = '__he_telemetry_span';

/**
 * Which span exporter to use.
 *
 * @since 0.24.0
 */
export type SpanExporterKind = 'otlp' | 'console';

/**
 * Which span processor to use.
 *
 * @since 0.24.1
 */
export type SpanProcessorKind = 'simple' | 'batch';

/**
 * The kind of instrumentation to enable.
 *
 * @since 0.24.1
 */
export type InstrumentationKind =
  | 'http'
  | 'fetch'
  | 'ioredis'
  | 'amqplib'
  | 'kafkajs';

/**
 * Sampling configuration.
 *
 * @since 0.24.0
 */
export interface SamplingConfig {
  /** Currently only `'traceidratio'` is supported. */
  type: 'traceidratio';
  /** Sampling ratio between 0.0 and 1.0 (default: 1.0). */
  ratio?: number;
}

/**
 * The host seam returned by {@linkcode loadOtelTracerProvider}.
 *
 * Consumers (the plugin factory, tests) can supply a pre-built host via
 * `tracerProviderFactory` to bypass the lazy OTel import.
 *
 * @since 0.24.0
 */
export interface TracerHost {
  /** Starts a new span. */
  startSpan(
    name: string,
    options?: {
      kind?: number;
      attributes?: Record<string, unknown>;
      parentContext?: TelemetryContext;
    },
  ): unknown;
  /** Extracts a context from incoming headers (for traceparent propagation). */
  extractContext(headers: Headers): TelemetryContext;
  /** Injects a context into outgoing headers. */
  injectContext(context: TelemetryContext): Record<string, string>;
  /** Shuts down the provider and flushes pending spans. */
  shutdown(): Promise<void>;
  /** Forces flush of pending spans. */
  forceFlush(): Promise<void>;
  /**
   * The underlying OTel TracerProvider; undefined for noop/custom hosts
   * (instrumentations then no-op).
   *
   * @since 0.24.1
   */
  readonly otelProvider?: unknown;
}

/**
 * Options for the {@linkcode TelemetryPlugin}.
 *
 * @since 0.24.0
 */
export interface TelemetryPluginOptions {
  /** Service name reported to the exporter (required when exporter is configured). */
  serviceName?: string;
  /** Service version (default: `'1.0.0'`). */
  serviceVersion?: string;
  /** Which exporter to use. Absent = noop mode. */
  exporter?: SpanExporterKind;
  /** OTLP endpoint URL (required when `exporter: 'otlp'`). */
  endpoint?: string;
  /** Optional headers sent with OTLP requests. */
  headers?: Record<string, string>;
  /** Sampling configuration. */
  sampling?: SamplingConfig;
  /** Injectable factory that returns a pre-built TracerHost (test seam). */
  tracerProviderFactory?: () => Promise<TracerHost>;
  /** Whether to register the request-span middleware (default: `true`). */
  middleware?: boolean;
  /**
   * Span processor to use (`'simple'` by default, `'batch'` as an option).
   *
   * @since 0.24.1
   */
  spanProcessor?: SpanProcessorKind;
  /**
   * Auto-instrumentation configuration.
   *
   * Each key enables one instrumentation on supported runtimes (Node only).
   * Omitting a key leaves that instrumentation off.
   *
   * @since 0.24.1
   */
  instrumentations?: InstrumentationsConfig;
}

/**
 * Per-instrumentation entry. Presence of the parent key enables; this configures or injects.
 *
 * @since 0.24.1
 */
export interface InstrumentationConfig {
  /**
   * An already-constructed OTel `Instrumentation` instance — the INJECT half of the
   * inject-or-lazy seam. When set, the registry skips the lazy `npm:` import and uses
   * this instance directly.
   */
  readonly instrumentation?: unknown;
  /**
   * Opaque config object forwarded VERBATIM to the OTel instrumentation constructor's
   * `config` argument (the LAZY half). Framework-owned and untyped on purpose: OTel
   * instrumentation config surfaces evolve independently and re-typing them here would
   * fabricate field names and drift.
   */
  readonly config?: Readonly<Record<string, unknown>>;
}

/**
 * Configuration for auto-instrumentations.
 *
 * @since 0.24.1
 */
export interface InstrumentationsConfig {
  /** node:http/https via @opentelemetry/instrumentation-http. Node-only; no-op elsewhere. */
  readonly http?: true | InstrumentationConfig;
  /** Node undici/fetch via @opentelemetry/instrumentation-undici. Node-only; no-op elsewhere. */
  readonly fetch?: true | InstrumentationConfig;
  /** ioredis via @opentelemetry/instrumentation-ioredis. Node-only; no-op elsewhere. */
  readonly ioredis?: true | InstrumentationConfig;
  /** amqplib via @opentelemetry/instrumentation-amqplib. Node-only; no-op elsewhere. */
  readonly amqplib?: true | InstrumentationConfig;
  /** kafkajs via @opentelemetry/instrumentation-kafkajs. Node-only; no-op elsewhere. */
  readonly kafkajs?: true | InstrumentationConfig;
}
