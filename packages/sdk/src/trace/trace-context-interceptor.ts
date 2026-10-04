/**
 * SDK trace-context request interceptor.
 *
 * The SDK keeps imports from `@setu-ts/common` type-only, so this module
 * mirrors the W3C validation performed by common's `contextToTraceparent`.
 *
 * @module
 */

import type { SpanContext } from 'jsr:@setu-ts/common@^0.8.0';

import type { ClientRequestInterceptor } from '../http/contracts.ts';

const TRACE_ID_RE = /^[0-9a-f]{32}$/;
const SPAN_ID_RE = /^[0-9a-f]{16}$/;
const TRACE_FLAGS_RE = /^[0-9a-f]{2}$/;
const ZERO_TRACE_ID = '00000000000000000000000000000000';
const ZERO_SPAN_ID = '0000000000000000';

/**
 * Creates an interceptor that propagates the active W3C trace parent.
 *
 * The source is read for every request. An existing `traceparent` header wins.
 * Missing or malformed span identities are ignored.
 *
 * @param source - Provider of the currently active span
 * @returns A request interceptor
 * @since 0.9.0
 */
export function createTraceContextInterceptor(
  source: { readonly activeSpanContext?: () => SpanContext | undefined },
): ClientRequestInterceptor {
  return (ctx): void => {
    if (ctx.headers.has('traceparent')) return;
    const active = source.activeSpanContext?.();
    if (active === undefined) return;
    const { traceId, spanId, traceFlags } = active;
    if (
      !TRACE_ID_RE.test(traceId) || !SPAN_ID_RE.test(spanId) ||
      !TRACE_FLAGS_RE.test(traceFlags) || traceId === ZERO_TRACE_ID || spanId === ZERO_SPAN_ID
    ) return;
    ctx.headers.set('traceparent', `00-${traceId}-${spanId}-${traceFlags}`);
  };
}
