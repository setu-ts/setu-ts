/**
 * @module
 *
 * OpenTelemetry distributed tracing plugin for Hono Enterprise.
 *
 * Provides `ITelemetryService` registration under `CAPABILITIES.TELEMETRY`,
 * a request-span middleware at priority 30, and lazy-loaded OTel SDK support.
 *
 * @since 0.24.0
 */

export { TelemetryPlugin } from './plugin/telemetry-plugin.ts';
export type {
  InstrumentationConfig,
  InstrumentationKind,
  InstrumentationsConfig,
  SamplingConfig,
  SpanExporterKind,
  SpanProcessorKind,
  TelemetryPluginOptions,
  TracerHost,
} from './interfaces/index.ts';
export { TELEMETRY_SPAN_KEY, telemetryMiddleware } from './plugin/telemetry-plugin.ts';
export { NoopTelemetryService } from './services/telemetry-service.ts';

// Re-export common types for convenience
export type {
  ISpan,
  ITelemetryService,
  SpanAttributeValue,
  SpanKind,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
} from '@hono-enterprise/common';
