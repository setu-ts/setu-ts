/**
 * Telemetry service implementations — real (OTel-backed) and noop.
 *
 * @module
 * @since 0.24.0
 */

import type {
  ISpan,
  ITelemetryService,
  SpanAttributeValue,
  SpanContext,
  SpanKind,
  SpanOptions,
  SpanStatus,
  TelemetryContext,
} from '@hono-enterprise/common';
import type { TracerHost } from '../interfaces/index.ts';

/**
 * Internal span operations available on an OTel span or a fake for testing.
 *
 * @internal
 */
interface SpanHandle {
  setAttribute(key: string, value: SpanAttributeValue): void;
  setAttributes(attributes: Record<string, SpanAttributeValue>): void;
  setStatus(status: SpanStatus): void;
  recordException(error: Error): void;
  end(): void;
  spanContext?(): SpanContext;
}

/**
 * Maps framework `SpanKind` to the numeric OTel `SpanKind` values.
 *
 * @internal
 */
/**
 * Extracts parentContext from a parentSpan bridge (backward compat).
 *
 * @internal
 */
function extractParentContextFromBridge(
  startSpanOptions: { parentContext?: TelemetryContext },
  parentSpan: ISpan | undefined,
): void {
  if (parentSpan) {
    const ctx = (parentSpan as { _context?: TelemetryContext })._context;
    if (ctx) {
      startSpanOptions.parentContext = ctx;
    }
  }
}

const SPAN_KIND_MAP: Record<SpanKind, number> = {
  internal: 0,
  server: 2,
  client: 3,
  producer: 4,
  consumer: 5,
};

/**
 * A span wrapper that translates framework types to OTel span calls.
 *
 * @internal
 */
class OtelSpan implements ISpan {
  readonly #span: SpanHandle;

  constructor(span: SpanHandle) {
    this.#span = span;
  }

  setAttribute(key: string, value: SpanAttributeValue): this {
    this.#span.setAttribute(key, value);
    return this;
  }

  /**
   * Delegates to OTel's native batch `setAttributes` when available (E2 fix).
   */
  setAttributes(attributes: Readonly<Record<string, SpanAttributeValue>>): this {
    if (typeof this.#span.setAttributes === 'function') {
      this.#span.setAttributes(attributes as Record<string, SpanAttributeValue>);
    } else {
      // Fallback: loop individual setAttribute calls.
      for (const [key, value] of Object.entries(attributes)) {
        this.#span.setAttribute(key, value);
      }
    }
    return this;
  }

  setStatus(status: SpanStatus): void {
    this.#span.setStatus(status);
  }

  recordException(error: Error): void {
    this.#span.recordException(error);
  }

  end(): void {
    this.#span.end();
  }

  spanContext(): SpanContext {
    if (typeof this.#span.spanContext === 'function') {
      return this.#span.spanContext();
    }
    // Fallback: return a minimal context (noop-like).
    return { traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: '01' };
  }
}

/**
 * OTel-backed telemetry service.
 *
 * @internal
 */
export class TelemetryService implements ITelemetryService {
  readonly #tracerHost: TracerHost;

  constructor(tracerHost: TracerHost) {
    this.#tracerHost = tracerHost;
  }

  async withSpan<T>(
    name: string,
    fn: (span: ISpan) => Promise<T>,
    options?: SpanOptions,
  ): Promise<T> {
    const startSpanOptions: {
      kind?: number;
      attributes?: Record<string, unknown>;
      parentContext?: TelemetryContext;
    } = {};
    if (options?.kind) {
      startSpanOptions.kind = SPAN_KIND_MAP[options.kind];
    }
    if (options?.attributes) {
      startSpanOptions.attributes = options.attributes;
    }
    // N4 fix: use parentContext directly from SpanOptions (no bridge).
    if (options?.parentContext) {
      startSpanOptions.parentContext = options.parentContext;
    } else {
      // Fall back to parentSpan bridge for backward compat (existing tests).
      extractParentContextFromBridge(startSpanOptions, options?.parentSpan);
    }
    const span = this.#tracerHost.startSpan(name, startSpanOptions) as SpanHandle;
    const heSpan = new OtelSpan(span);

    try {
      return await fn(heSpan);
    } catch (error) {
      heSpan.setStatus('error');
      if (error instanceof Error) {
        heSpan.recordException(error);
      }
      throw error;
    } finally {
      heSpan.end();
    }
  }
}

/**
 * A no-op span that discards all calls.
 *
 * @internal
 */
class NoopSpan implements ISpan {
  setAttribute(_key: string, _value: SpanAttributeValue): this {
    return this;
  }

  setAttributes(_attributes: Readonly<Record<string, SpanAttributeValue>>): this {
    return this;
  }

  setStatus(_status: SpanStatus): void {
    // no-op
  }

  recordException(_error: Error): void {
    // no-op
  }

  end(): void {
    // no-op
  }

  spanContext(): SpanContext {
    // Noop spans have no real context — return null-like values.
    return { traceId: '', spanId: '', traceFlags: '' };
  }
}

/** Shared singleton NoopSpan — E1 fix: allocate once, not per withSpan call. */
const NOOP_SPAN: NoopSpan = new NoopSpan();

/**
 * A telemetry service that does nothing — used when no exporter is configured.
 *
 * `withSpan` still runs the callback and returns its value, but all span
 * operations are no-ops.
 *
 * @since 0.24.0
 */
export class NoopTelemetryService implements ITelemetryService {
  // deno-lint-ignore require-await
  async withSpan<T>(
    _name: string,
    fn: (span: ISpan) => Promise<T>,
    _options?: SpanOptions,
  ): Promise<T> {
    return fn(NOOP_SPAN);
  }
}
