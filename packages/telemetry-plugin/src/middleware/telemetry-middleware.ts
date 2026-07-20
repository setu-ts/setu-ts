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

    // Extract incoming parent context via TracerHost.
    const parentContext: TelemetryContext = tracerHost.extractContext(
      request.headers,
    );

    // N4 fix: pass parentContext directly (no bridge).
    // Capture the span's context synchronously by returning it from withSpan.
    const spanContext = await service.withSpan(
      spanName,
      async (span) => {
        // Store the span on ctx.state for downstream consumers.
        ctx.state.set(TELEMETRY_SPAN_KEY, span);

        // Set HTTP attributes.
        span.setAttribute('http.method', request.method);
        span.setAttribute('http.url', request.url);
        span.setAttribute('http.route', request.path);

        try {
          await next();

          // After next(), set the status code from the response snapshot.
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
        }
        // F1 fix: withSpan owns span.end() exactly once — no redundant end() here.
        // Return the span's context for response header injection.
        return span.spanContext();
      },
      { kind: 'server', parentContext },
    );

    // N2 fix: inject response traceparent from the span's own traceId/spanId/traceFlags.
    // Per plan §3.5, noop skips injection (empty traceId/spanId).
    // F3 fix: no redundant `: any` cast — use direct field access on typed SpanContext.
    if (spanContext && spanContext.traceId && spanContext.spanId) {
      const flags = spanContext.traceFlags ?? '01';
      ctx.response.header(
        'traceparent',
        `00-${spanContext.traceId}-${spanContext.spanId}-${flags}`,
      );
    }
  };
}
