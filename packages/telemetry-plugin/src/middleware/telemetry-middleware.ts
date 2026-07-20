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
  SpanContext,
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
    let serverSpanContext: SpanContext | null = null;
    await service.withSpan(
      spanName,
      async (span) => {
        // Store the span on ctx.state for downstream consumers.
        ctx.state.set(TELEMETRY_SPAN_KEY, span);

        // Capture the span's own context for the response header (N2 fix).
        serverSpanContext = span.spanContext();

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
        } finally {
          span.end();
        }
      },
      { kind: 'server', parentContext },
    );

    // N2 fix: inject response traceparent from the span's own traceId/spanId/traceFlags.
    // Per plan §3.5, noop skips injection (empty traceId/spanId).
    // deno-lint-ignore no-explicit-any
    const sc: any = serverSpanContext;
    if (sc && sc.traceId && sc.spanId) {
      const flags = sc.traceFlags ?? '01';
      ctx.response.header(
        'traceparent',
        `00-${sc.traceId}-${sc.spanId}-${flags}`,
      );
    }
  };
}
