/**
 * Request-span middleware for the telemetry plugin.
 *
 * Registers at priority 30 (inside metrics at 20, outside auth at 300).
 * Wraps every inbound HTTP request in a server span with W3C `traceparent`
 * / `tracestate` propagation.
 *
 * @module
 * @since 0.24.0
 */

import type {
  IRequestContext,
  ITelemetryService,
  MiddlewareFunction,
  NextFunction,
  TelemetryContext,
} from '@hono-enterprise/common';
import type { TracerHost } from '../interfaces/index.ts';
import { TELEMETRY_SPAN_KEY } from '../interfaces/index.ts';

/**
 * Creates the request-span middleware.
 *
 * @param service - The `ITelemetryService` to use for span creation
 * @param tracerHost - The `TracerHost` seam for context extraction/injection
 * @returns A middleware function
 *
 * @example
 * ```typescript
 * const middleware = telemetryMiddleware(telemetry, tracerHost);
 * ctx.middleware.add(middleware, { priority: 30, name: 'telemetry-middleware' });
 * ```
 */
export function telemetryMiddleware(
  service: ITelemetryService,
  tracerHost: TracerHost,
): MiddlewareFunction {
  return async (ctx: IRequestContext, next: NextFunction): Promise<void> => {
    const request = ctx.request;
    const spanName = `${request.method} ${request.path}`;

    // C4 fix: extract incoming parent context via TracerHost (not local parse)
    const parentContext: TelemetryContext = tracerHost.extractContext(
      request.headers,
    );

    // C1 fix: pass parentContext into withSpan via SpanOptions.parentSpan.
    // The TelemetryService translates parentSpan into parentContext on startSpan.
    const bridge: ISpanBridge = {
      _context: parentContext,
      setAttribute() {
        return bridge;
      },
      setAttributes() {
        return bridge;
      },
      setStatus() {/* no-op for bridge */},
      recordException() {/* no-op for bridge */},
      end() {/* no-op for bridge */},
    };

    await service.withSpan(
      spanName,
      async (span) => {
        // Store the span on ctx.state for downstream consumers
        ctx.state.set(TELEMETRY_SPAN_KEY, span);

        // Set HTTP attributes
        span.setAttribute('http.method', request.method);
        span.setAttribute('http.url', request.url);
        span.setAttribute('http.route', request.path);

        try {
          await next();

          // After next(), set the status code from the response snapshot
          const snapshot = ctx.response.snapshot();
          span.setAttribute('http.status_code', snapshot.status);

          if (snapshot.status >= 400) {
            span.setStatus('error');
          } else {
            span.setStatus('ok');
          }
        } catch (error) {
          span.setStatus('error');
          if (error instanceof Error) {
            span.recordException(error);
          }
          throw error;
        } finally {
          span.end();
        }
      },
      { kind: 'server', parentSpan: bridge },
    );

    // C2+R2 fix: inject response traceparent via TracerHost.injectContext.
    // Build a context carrying the span's own traceId/spanId.
    // When parentContext carried a valid incoming trace, the span inherited
    // that traceId. We generate a fresh spanId to represent the server span.
    const spanContext: TelemetryContext = {
      _opaque: parentContext._opaque,
      traceId: parentContext.traceId ?? generateHexId(32),
      spanId: generateHexId(16),
      traceFlags: parentContext.traceFlags ?? '01',
    };
    const responseHeaders = tracerHost.injectContext(spanContext);
    if (responseHeaders.traceparent) {
      ctx.response.header('traceparent', responseHeaders.traceparent);
    }
  };
}

/**
 * Bridge object that wraps a TelemetryContext as an ISpan for the parentSpan option.
 *
 * @internal
 */
interface ISpanBridge {
  _context: TelemetryContext;
  setAttribute(): ISpanBridge;
  setAttributes(): ISpanBridge;
  setStatus(): void;
  recordException(): void;
  end(): void;
}

/**
 * Generates a lowercase hex string of the given length.
 *
 * @internal
 */
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
