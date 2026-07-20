/**
 * Telemetry contract — framework-owned types for distributed tracing.
 *
 * These interfaces are intentionally NOT re-exports of `@opentelemetry/api`
 * enums; `common` has zero dependencies and must stay importable without the
 * OTel SDK installed. The telemetry-plugin translates these framework types
 * to OTel types at the implementation seam.
 *
 * @module
 * @since 0.24.0
 */

/**
 * Span status — whether the span completed successfully or not.
 *
 * @since 0.24.0
 */
export type SpanStatus = 'ok' | 'error' | 'unset';

/**
 * The kind of span. Maps to OTel `SpanKind` at the implementation boundary.
 *
 * @since 0.24.0
 */
export type SpanKind = 'internal' | 'server' | 'client' | 'producer' | 'consumer';

/**
 * Attribute value — a span attribute can be a primitive or an array of primitives.
 *
 * @since 0.24.0
 */
export type SpanAttributeValue =
  | string
  | number
  | boolean
  | ReadonlyArray<string | number | boolean>;

/**
 * Options for span creation.
 *
 * @since 0.24.0
 */
export interface SpanOptions {
  /** The span kind (defaults to `'internal'`). */
  readonly kind?: SpanKind;
  /** Initial attributes to set on the span. */
  readonly attributes?: Readonly<Record<string, SpanAttributeValue>>;
  /** An optional parent span for manual parent-child linking. */
  readonly parentSpan?: ISpan;
  /**
   * Optional parent context for span parenting.
   *
   * When set, the real implementation uses this as the OTel parent context.
   * Takes precedence over {@link SpanOptions.parentSpan} when both are set.
   *
   * @since 0.24.1
   */
  readonly parentContext?: TelemetryContext;
}

/**
 * Opaque marker symbol for {@link TelemetryContext}.
 *
 * @since 0.24.0
 */
export const TELEMETRY_CONTEXT_OPAQUE: unique symbol = Symbol.for(
  'he.telemetry.context',
);

/**
 * Opaque handle representing the parent context for span creation.
 *
 * In the real (OTel-backed) implementation this wraps the OTel `Context`.
 * In noop mode it is unused but still accepted for API parity.
 *
 * Carries the W3C Trace Context fields extracted from incoming `traceparent`
 * / `tracestate` headers so the real `TracerHost` can use them to parent spans.
 *
 * @since 0.24.0
 */
export interface TelemetryContext {
  /** Internal marker — consumers must not inspect this type. */
  readonly _opaque: typeof TELEMETRY_CONTEXT_OPAQUE;
  /** 32-character lowercase hex trace ID (W3C format). */
  readonly traceId?: string;
  /** 16-character lowercase hex parent span ID (W3C format). */
  readonly spanId?: string;
  /** 2-character lowercase hex trace flags (W3C format). */
  readonly traceFlags?: string;
  /** Raw `tracestate` header value, if present. */
  readonly tracestate?: string;
}

/**
 * A span represents a single operation within a trace.
 *
 * @since 0.24.0
 */
export interface ISpan {
  /**
   * Sets a single attribute on the span.
   *
   * @param key - Attribute name
   * @param value - Attribute value
   * @returns This span, for chaining
   */
  setAttribute(key: string, value: SpanAttributeValue): this;

  /**
   * Sets multiple attributes on the span.
   *
   * @param attributes - Key-value map of attributes
   * @returns This span, for chaining
   */
  setAttributes(attributes: Readonly<Record<string, SpanAttributeValue>>): this;

  /**
   * Sets the status of the span.
   *
   * @param status - The span status
   */
  setStatus(status: SpanStatus): void;

  /**
   * Records an exception on this span.
   *
   * @param error - The error to record
   */
  recordException(error: Error): void;

  /**
   * Ends the span. Must be called exactly once.
   */
  end(): void;

  /**
   * Returns the span's context (traceId, spanId, traceFlags).
   *
   * Used by the middleware to inject the span's own `traceparent` into the
   * response header so downstream hops see this server span as the parent.
   *
   * @since 0.24.1
   */
  spanContext(): SpanContext;
}

/**
 * The return type of {@link ISpan.spanContext}.
 *
 * @since 0.24.1
 */
export interface SpanContext {
  /** 32-character lowercase hex trace ID. */
  readonly traceId: string;
  /** 16-character lowercase hex span ID. */
  readonly spanId: string;
  /** 2-character lowercase hex trace flags. */
  readonly traceFlags: string;
}

/**
 * Telemetry service — the primary API for creating spans.
 *
 * The `withSpan` method is the only manual span-creation API; it ensures
 * every span is ended in a `finally` block to prevent leaks.
 *
 * @since 0.24.0
 */
export interface ITelemetryService {
  /**
   * Creates a span, runs the callback, and ends the span.
   *
   * The span is guaranteed to be ended exactly once, even if the callback
   * throws. The callback receives an {@linkcode ISpan} that it can attach
   * attributes to.
   *
   * @typeParam T - The return type of the callback
   * @param name - The span name
   * @param fn - Callback receiving the span; its return value is forwarded
   * @param options - Optional span options (kind, attributes, parentSpan)
   * @returns The value returned by `fn`
   *
   * @example
   * ```typescript
   * const telemetry = ctx.services.get<ITelemetryService>(CAPABILITIES.TELEMETRY);
   * const result = await telemetry.withSpan('create-order', async (span) => {
   *   span.setAttribute('order.id', orderId);
   *   return await orderService.create(orderId);
   * });
   * ```
   */
  withSpan<T>(
    name: string,
    fn: (span: ISpan) => Promise<T>,
    options?: SpanOptions,
  ): Promise<T>;
}
