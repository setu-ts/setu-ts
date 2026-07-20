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
}
