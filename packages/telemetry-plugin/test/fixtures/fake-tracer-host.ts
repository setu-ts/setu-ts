/**
 * Fake TracerHost and fake ISpan for testing.
 *
 * @module
 */
import type { TracerHost } from '../../src/interfaces/index.ts';
import type {
  ISpan,
  SpanAttributeValue,
  SpanStatus,
  TelemetryContext,
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

const telemetryContextSymbol = Symbol.for('telemetry-context');

/**
 * Creates a fake TracerHost that records all operations.
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
      options?: { kind?: number; attributes?: Record<string, unknown> },
    ) {
      recordedCalls.push({ type: 'startSpan', args: [name, options] });

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
      };

      recordedSpans.push(span._recorded);
      return span;
    },
    extractContext(_headers: Headers): TelemetryContext {
      recordedCalls.push({ type: 'extractContext', args: [_headers] });
      // deno-lint-ignore no-explicit-any
      return { _opaque: telemetryContextSymbol } as any;
    },
    injectContext(_context: unknown) {
      recordedCalls.push({ type: 'injectContext', args: [_context] });
      return {};
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

export interface FakeTracerHost extends TracerHost {
  recordedCalls: Array<{
    type: 'startSpan' | 'shutdown' | 'forceFlush' | 'extractContext' | 'injectContext';
    args: unknown[];
  }>;
  recordedSpans: RecordedSpan[];
}
