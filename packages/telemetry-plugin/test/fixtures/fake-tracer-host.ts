/**
 * Fake TracerHost and fake ISpan for testing.
 *
 * @module
 */
import type { TracerHost } from '../../src/interfaces/index.ts';
import type { SpanContext } from '@hono-enterprise/common';
import {
  type ISpan,
  type SpanAttributeValue,
  type SpanStatus,
  TELEMETRY_CONTEXT_OPAQUE,
  type TelemetryContext,
} from '@hono-enterprise/common';

/**
 * Records span operations for test assertions.
 */
export interface RecordedSpan {
  name: string;
  attributes: Record<string, SpanAttributeValue>;
  status: SpanStatus | null;
  exceptions: Error[];
  ended: boolean;
}

/**
 * Creates a fake TracerHost that records all operations.
 *
 * The fake supports behavioral propagation testing:
 * - `extractContext` parses W3C `traceparent` headers into a real `TelemetryContext`.
 * - `injectContext` serialises a `TelemetryContext` into a valid W3C `traceparent` header.
 * - `startSpan` records the `parentContext` option so tests can assert span parenting.
 */
export function createFakeTracerHost(): FakeTracerHost {
  const recordedCalls: Array<{
    type: 'startSpan' | 'shutdown' | 'forceFlush' | 'extractContext' | 'injectContext';
    args: unknown[];
  }> = [];

  const recordedSpans: RecordedSpan[] = [];

  return {
    recordedCalls,
    recordedSpans,

    startSpan(
      name: string,
      options?: {
        kind?: number;
        attributes?: Record<string, unknown>;
        parentContext?: TelemetryContext;
      },
    ) {
      recordedCalls.push({ type: 'startSpan', args: [name, options] });

      // Generate a unique spanId for this fake span.
      const fakeSpanId = generateHexId(16);
      const fakeTraceId = options?.parentContext?.traceId ?? generateHexId(32);

      const span: ISpan & { _recorded: RecordedSpan } = {
        _recorded: {
          name,
          attributes: (options?.attributes as Record<string, SpanAttributeValue>) ?? {},
          status: null,
          exceptions: [],
          ended: false,
        },
        setAttribute(key, value) {
          this._recorded.attributes[key] = value;
          return this;
        },
        setAttributes(attrs) {
          for (const [k, v] of Object.entries(attrs)) {
            this._recorded.attributes[k] = v;
          }
          return this;
        },
        setStatus(status) {
          this._recorded.status = status;
        },
        recordException(error) {
          this._recorded.exceptions.push(error);
        },
        end() {
          this._recorded.ended = true;
        },
        spanContext(): SpanContext {
          return { traceId: fakeTraceId, spanId: fakeSpanId, traceFlags: '01' };
        },
      };

      recordedSpans.push(span._recorded);
      return span;
    },
    extractContext(headers: Headers): TelemetryContext {
      recordedCalls.push({ type: 'extractContext', args: [headers] });
      const traceparent = headers.get('traceparent');
      const tracestate = headers.get('tracestate');
      const match = traceparent?.match(
        /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/,
      );
      if (!match || match[1] !== '00') {
        return { _opaque: TELEMETRY_CONTEXT_OPAQUE };
      }
      const result: TelemetryContext = {
        _opaque: TELEMETRY_CONTEXT_OPAQUE,
        traceId: match[2],
        spanId: match[3],
        traceFlags: match[4],
      };
      if (tracestate) {
        return { ...result, tracestate };
      }
      return result;
    },
    injectContext(context: TelemetryContext) {
      recordedCalls.push({ type: 'injectContext', args: [context] });
      if (!context.traceId || !context.spanId) {
        return {};
      }
      const flags = context.traceFlags ?? '01';
      return { traceparent: `00-${context.traceId}-${context.spanId}-${flags}` };
    },
    shutdown(): Promise<void> {
      recordedCalls.push({ type: 'shutdown', args: [] });
      return Promise.resolve();
    },
    forceFlush(): Promise<void> {
      recordedCalls.push({ type: 'forceFlush', args: [] });
      return Promise.resolve();
    },
  };
}

/** Generates a random lowercase hex string. */
function generateHexId(length: number): string {
  const chars = '0123456789abcdef';
  const bytes = new Uint8Array(length / 2);
  crypto.getRandomValues(bytes);
  let result = '';
  for (const byte of bytes) {
    result += chars[(byte >> 4) & 0x0f];
    result += chars[byte & 0x0f];
  }
  return result;
}

export interface FakeTracerHost extends TracerHost {
  recordedCalls: Array<{
    type: 'startSpan' | 'shutdown' | 'forceFlush' | 'extractContext' | 'injectContext';
    args: unknown[];
  }>;
  recordedSpans: RecordedSpan[];
}
