/**
 * W3C Trace Context codec shared by transport integrations.
 *
 * @module
 * @since 0.2.0
 */

import { TELEMETRY_CONTEXT_OPAQUE, type TelemetryContext } from './services/telemetry.ts';

/** The W3C header carrying a trace parent. @since 0.2.0 */
export const TRACEPARENT_HEADER = 'traceparent';

/** The W3C header carrying vendor trace state. @since 0.2.0 */
export const TRACESTATE_HEADER = 'tracestate';

const TRACEPARENT_RE = /^([0-9a-f]{2})-([0-9a-f]{32})-([0-9a-f]{16})-([0-9a-f]{2})$/i;

/**
 * Parses a W3C `traceparent` value.
 *
 * @param header - Header value, or `null` when it is absent
 * @returns The parsed context, or an opaque context when invalid
 * @since 0.2.0
 */
export function parseTraceparentToContext(header: string | null): TelemetryContext {
  if (!header) return { _opaque: TELEMETRY_CONTEXT_OPAQUE };
  const match = TRACEPARENT_RE.exec(header);
  if (!match || match[1].toLowerCase() !== '00') {
    return { _opaque: TELEMETRY_CONTEXT_OPAQUE };
  }
  return {
    _opaque: TELEMETRY_CONTEXT_OPAQUE,
    traceId: match[2].toLowerCase(),
    spanId: match[3].toLowerCase(),
    traceFlags: match[4].toLowerCase(),
  };
}

/**
 * Formats a context as a W3C `traceparent` value.
 *
 * @param context - The trace context to format
 * @returns A header value, or `null` when the context has no span identity
 * @since 0.2.0
 */
export function contextToTraceparent(context: TelemetryContext): string | null {
  if (!context.traceId || !context.spanId) return null;
  return `00-${context.traceId}-${context.spanId}-${context.traceFlags ?? '01'}`;
}

/**
 * Extracts W3C trace context from web-standard headers.
 *
 * @param headers - Incoming headers
 * @returns The extracted context
 * @since 0.2.0
 */
export function extractContextFromHeaders(headers: Headers): TelemetryContext {
  const context = parseTraceparentToContext(headers.get(TRACEPARENT_HEADER));
  const tracestate = headers.get(TRACESTATE_HEADER);
  return tracestate ? { ...context, tracestate } : context;
}
