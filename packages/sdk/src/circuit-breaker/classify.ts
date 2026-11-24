/**
 * What a settled request means for the per-origin circuit breaker.
 *
 * @internal
 */

import { HttpClientError } from '../errors.ts';

/**
 * How the breaker records one settled call: `'failure'` counts against the
 * origin, `'success'` is a call the origin answered (on the rate arm it sits in
 * the denominator), and `'ignore'` records nothing.
 *
 * @internal
 */
export type BreakerOutcome = 'failure' | 'success' | 'ignore';

/**
 * Whether an error represents a caller-initiated abort.
 *
 * `AbortSignal.reason` defaults to a `DOMException` named `AbortError`, but a
 * caller may abort with ANY value, so the name is checked structurally rather
 * than by `instanceof DOMException` alone.
 */
function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && 'name' in error && error.name === 'AbortError'
  );
}

/**
 * Classifies a request's rejection for the breaker.
 *
 * - A 5xx `HttpClientError` is a `'failure'`.
 * - A 4xx `HttpClientError` is a `'success'`: the request was wrong, but the
 *   origin answered. Counting it as a failure would let ordinary 404 traffic
 *   take an API offline for every caller sharing the client; leaving it out of
 *   the rate arm's denominator would let a rare 5xx trip a mostly-404 client.
 * - A caller abort is `'ignore'`: the caller left, which says nothing about the
 *   origin.
 * - Anything else (a transport rejection, an exhausted retry sequence) is a
 *   `'failure'`.
 *
 * @internal
 */
export function classifyBreakerOutcome(error: unknown): BreakerOutcome {
  if (error instanceof HttpClientError) return error.status >= 500 ? 'failure' : 'success';
  if (isAbortError(error)) return 'ignore';
  return 'failure';
}
