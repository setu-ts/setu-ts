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
import { contextToTraceparent } from '../tracing/tracer.ts';

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
          // A3 fix: withSpan owns error bookkeeping (setStatus + recordException).
          // The middleware only re-throws; TelemetryService.withSpan catches and
          // handles the error path exactly once.
          throw error;
        }
        // F1 fix: withSpan owns span.end() exactly once — no redundant end() here.
        // Return the span's context for response header injection.
        return span.spanContext();
      },
      { kind: 'server', parentContext },
    );

    // A1 fix: reuse contextToTraceparent instead of hand-building the header.
    // This avoids the duplication that let F7 in (numeric traceFlags never
    // normalized to 2-hex string). OtelSpan.spanContext() already normalizes
    // traceFlags to string, so contextToTraceparent receives a valid context.
    if (spanContext && spanContext.traceId && spanContext.spanId) {
      const traceparent = contextToTraceparent(spanContext as TelemetryContext);
      if (traceparent) {
        ctx.response.header('traceparent', traceparent);
      }
    }
  };
}
