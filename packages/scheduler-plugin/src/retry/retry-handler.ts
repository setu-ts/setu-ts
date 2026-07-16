/**
 * Retry backoff calculation.
 *
 * Pure helper that computes the backoff delay for a given attempt,
 * matching the committed `RetryOptions` shape.
 *
 * @module
 */
import type { RetryOptions } from '@hono-enterprise/common';

/**
 * Computes the backoff delay in milliseconds for a given attempt.
 *
 * - **fixed**: returns `retry.delay` for every attempt.
 * - **exponential**: returns `retry.delay * 2 ** (attempt - 1)`.
 *
 * @param attempt - The current attempt number (1-based)
 * @param retry - The retry configuration
 * @returns The backoff delay in milliseconds
 *
 * @example
 * ```typescript
 * computeBackoffMs(1, { limit: 3, delay: 1000, backoff: 'fixed' });       // 1000
 * computeBackoffMs(2, { limit: 3, delay: 1000, backoff: 'fixed' });       // 1000
 * computeBackoffMs(1, { limit: 3, delay: 1000, backoff: 'exponential' }); // 1000
 * computeBackoffMs(2, { limit: 3, delay: 1000, backoff: 'exponential' }); // 2000
 * computeBackoffMs(3, { limit: 3, delay: 1000, backoff: 'exponential' }); // 4000
 * ```
 * @since 0.1.0
 */
export function computeBackoffMs(attempt: number, retry: RetryOptions): number {
  switch (retry.backoff) {
    case 'exponential':
      return retry.delay * 2 ** (attempt - 1);
    case 'fixed':
    default:
      return retry.delay;
  }
}
