/**
 * Internal retry strategy for the HTTP client.
 *
 * Implements retry classification, `Retry-After` delta-seconds parsing, and
 * the fixed/exponential backoff loop using the shared `RetryPolicy` from common.
 *
 * Classification operates on the real error type emitted by `HttpClient` —
 * `HttpClientError` for non-2xx responses (carrying `status` and `headers`)
 * and transport rejections otherwise — rather than a raw `Response`.
 *
 * @internal
 */

import type { IClientTiming } from '../http/contracts.ts';
import type { RetryPolicy } from 'jsr:@hono-enterprise/common@^0.1.0-alpha.2';

import { HttpClientError } from '../errors.ts';

// Idempotent/safe methods that may be automatically retried.
const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS', 'PUT', 'DELETE']);

/** Retryable status codes: 408, 425, 429, and 500–599. */
function isRetryableStatus(status: number): boolean {
  return (
    status === 408 ||
    status === 425 ||
    status === 429 ||
    (status >= 500 && status <= 599)
  );
}

/**
 * Parse `Retry-After` header value as delta-seconds (a non-negative integer).
 *
 * Returns the delta as milliseconds, or `null` for HTTP-date form, empty,
 * fractional, or otherwise malformed values. Per plan §3.4 only the
 * delta-seconds form is honored; the HTTP-date form is intentionally ignored.
 */
function parseRetryAfterDelta(headers: Headers): number | null {
  const value = headers.get('Retry-After');
  if (value === null || value.trim() === '') return null;
  const n = Number(value);
  // Gate on a non-negative integer: rejects fractional values and
  // non-numeric parses. Empty strings are rejected above.
  if (Number.isInteger(n) && n >= 0) return n * 1000;
  return null;
}

/**
 * Execute `fn` with retry logic governed by `policy`.
 *
 * Retries transport rejections and `HttpClientError` responses with retryable
 * status codes, and only for safe/idempotent methods. When a retryable
 * response carries a `Retry-After` delta-seconds header, that delay replaces
 * the computed backoff for that attempt.
 *
 * @internal
 */
export async function runWithRetry<T>(
  fn: () => Promise<T>,
  policy: RetryPolicy,
  method: string,
  timing: IClientTiming,
  signal?: AbortSignal,
): Promise<T> {
  let lastError: unknown;
  const canRetry = SAFE_METHODS.has(method.toUpperCase());

  for (let attempt = 1; attempt <= policy.limit; attempt++) {
    try {
      const result = await fn();
      return result;
    } catch (error) {
      lastError = error;

      // Never retry aborted requests.
      if (signal?.aborted) throw error;

      let isRetryable = false;
      let retryAfter: number | null = null;

      if (error instanceof HttpClientError) {
        // HTTP response error — classify on the real error type.
        isRetryable = isRetryableStatus(error.status);
        retryAfter = parseRetryAfterDelta(error.headers);
      } else {
        // Transport rejection (non-HttpClientError throw) — retryable on
        // safe methods. No Retry-After header to consider.
        isRetryable = true;
      }
      // Transport rejections (non-HttpClientError throws) are retryable on
      // safe methods; they carry no status or Retry-After.

      if (!isRetryable) throw error;
      if (!canRetry) throw error;
      if (attempt === policy.limit) throw error;

      // Compute backoff delay: `delay * 2^(attempt - 1)`, matching
      // resilience-plugin's server-side schedule.
      //
      // `2 **` rather than `1 << (attempt - 1)`: the shift operand is coerced to
      // int32, so attempt 32 shifts by 31 and yields a NEGATIVE multiplier (and
      // attempt 33 wraps to 1). A large `limit` would then produce negative or
      // collapsing delays instead of a growing backoff.
      let delay = policy.delay;
      if (policy.backoff === 'exponential') {
        delay = policy.delay * 2 ** (attempt - 1);
      }

      // A Retry-After delta-seconds value replaces the computed backoff.
      if (retryAfter !== null) {
        delay = retryAfter;
      }

      await timing.sleep(delay, signal);
    }
  }

  // Should not reach here, but exhaustively throw last error.
  throw lastError;
}
