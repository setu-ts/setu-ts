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
} from '@hono-enterprise/common';
import { TELEMETRY_SPAN_KEY } from '../interfaces/index.ts';

/**
 * Parses a W3C `traceparent` header value into its components.
 *
 * @param header - The `traceparent` header value (e.g. `00-abcdef...-1234...-01`)
 * @returns The parsed traceId, parentId, and flags, or `null` if invalid
 *
 * @internal
 */
function parseTraceparent(header: string): {
  version: string;
  traceId: string;
  parentId: string;
  flags: string;
} | null {
  const match = header.match(/^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/);
  if (!match) {
    return null;
  }
  return {
    version: match[1],
    traceId: match[2],
    parentId: match[3],
    flags: match[4],
  };
}

/**
 * Builds a W3C `traceparent` header value from components.
 *
 * @internal
 */
function buildTraceparent(
  version: string,
  traceId: string,
  parentId: string,
  flags: string,
): string {
  return `${version}-${traceId}-${parentId}-${flags}`;
}

/**
 * Creates the request-span middleware.
 *
 * @param service - The `ITelemetryService` to use for span creation
 * @returns A middleware function
 *
 * @example
 * ```typescript
 * const middleware = telemetryMiddleware(telemetry);
 * ctx.middleware.add(middleware, { priority: 30, name: 'telemetry-middleware' });
 * ```
 */
export function telemetryMiddleware(
  service: ITelemetryService,
): MiddlewareFunction {
  return async (ctx: IRequestContext, next: NextFunction): Promise<void> => {
    const request = ctx.request;
    const traceparentHeader = request.headers.get('traceparent');

    let parentTraceId: string;
    let parentSpanId: string;

    if (traceparentHeader) {
      const parsed = parseTraceparent(traceparentHeader);
      if (parsed) {
        parentTraceId = parsed.traceId;
        parentSpanId = parsed.parentId;
      } else {
        parentTraceId = ctx.id;
        parentSpanId = ctx.id.slice(0, 16);
      }
    } else {
      parentTraceId = ctx.id;
      parentSpanId = ctx.id.slice(0, 16);
    }

    const spanName = `${request.method} ${request.path}`;

    await service.withSpan(spanName, async (span) => {
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

        // Inject traceparent into response headers
        const traceparent = buildTraceparent('00', parentTraceId, parentSpanId, '01');
        ctx.response.header('traceparent', traceparent);
      } catch (error) {
        span.setStatus('error');
        if (error instanceof Error) {
          span.recordException(error);
        }
        throw error;
      } finally {
        span.end();
      }
    });
  };
}
