// deno-lint-ignore-file require-await
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
  SpanKind,
  SpanOptions,
  SpanStatus,
} from '@hono-enterprise/common';
import type { TracerHost } from '../interfaces/index.ts';

/**
 * Maps framework `SpanKind` to the numeric OTel `SpanKind` values.
 *
 * @internal
 */
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
  readonly #span: unknown;

  constructor(span: unknown) {
    this.#span = span;
  }

  setAttribute(key: string, value: SpanAttributeValue): this {
    // deno-lint-ignore no-explicit-any
    (this.#span as any).setAttribute(key, value);
    return this;
  }

  setAttributes(attributes: Readonly<Record<string, SpanAttributeValue>>): this {
    for (const [key, value] of Object.entries(attributes)) {
      // deno-lint-ignore no-explicit-any
      (this.#span as any).setAttribute(key, value);
    }
    return this;
  }

  setStatus(status: SpanStatus): void {
    // deno-lint-ignore no-explicit-any
    (this.#span as any).setStatus(status);
  }

  recordException(error: Error): void {
    // deno-lint-ignore no-explicit-any
    (this.#span as any).recordException(error);
  }

  end(): void {
    // deno-lint-ignore no-explicit-any
    (this.#span as any).end();
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
    _name: string,
    fn: (span: ISpan) => Promise<T>,
    options?: SpanOptions,
  ): Promise<T> {
    const kindNum = options?.kind ? SPAN_KIND_MAP[options.kind] : undefined;
    // deno-lint-ignore no-explicit-any
    const span = (this.#tracerHost as any).startSpan(_name, {
      kind: kindNum,
      attributes: options?.attributes,
    });
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
}

/**
 * A telemetry service that does nothing — used when no exporter is configured.
 *
 * `withSpan` still runs the callback and returns its value, but all span
 * operations are no-ops.
 *
 * @since 0.24.0
 */
export class NoopTelemetryService implements ITelemetryService {
  async withSpan<T>(
    _name: string,
    fn: (span: ISpan) => Promise<T>,
    _options?: SpanOptions,
  ): Promise<T> {
    const noopSpan = new NoopSpan();
    return fn(noopSpan);
  }
}
