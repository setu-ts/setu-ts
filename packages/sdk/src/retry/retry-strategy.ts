/**
 * Internal retry strategy for the HTTP client.
 *
 * Implements retry classification, `Retry-After` delta-seconds parsing, and
 * the fixed/exponential backoff loop using the shared `RetryPolicy` from common.
 *
 * @internal
 */

import type { IClientTiming } from '../http/contracts.ts';
import type { RetryPolicy } from 'jsr:@hono-enterprise/common@^0.1.0-alpha.2';

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

/** Parse `Retry-After` header value as delta-seconds (integer). Returns null for HTTP-date or malformed. */
function parseRetryAfterDelta(headers: Headers): number | null {
  const value = headers.get('Retry-After');
  if (value === null) return null;
  const n = Number(value);
  if (Number.isFinite(n) && n >= 0) return n;
  // HTTP-date form is intentionally ignored per plan §3.4.
  return null;
}

/**
 * Execute `fn` with retry logic governed by `policy`.
 *
 * Only retries transport rejections (non-Response throws) and responses with
 * retryable status codes, and only for safe/idempotent methods.
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

      // Transport rejection (not an HTTP response) — retry if method is safe.
      if (!(error instanceof Response)) {
        if (!canRetry || attempt === policy.limit) throw error;
      } else {
        // HTTP response error — check status.
        if (!isRetryableStatus(error.status)) throw error;
        if (!canRetry || attempt === policy.limit) throw error;
      }

      // Compute backoff delay.
      let delay = policy.delay;
      if (policy.backoff === 'exponential') {
        delay = policy.delay * (1 << (attempt - 1));
      }

      // Check for Retry-After delta-seconds on the response (if available).
      if (error instanceof Response) {
        const retryAfter = parseRetryAfterDelta(error.headers);
        if (retryAfter !== null) {
          delay = retryAfter * 1000;
        }
      }

      await timing.sleep(delay, signal);
    }
  }

  // Should not reach here, but exhaustively throw last error.
  throw lastError;
}
