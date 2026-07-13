/**
 * Retry strategy for queue jobs.
 *
 * Provides exponential backoff with a maximum delay cap.
 *
 * @module
 */

/**
 * Default base delay for exponential backoff (1 second).
 */
const DEFAULT_BASE_DELAY = 1000;

/**
 * Maximum delay cap for exponential backoff (30 seconds).
 */
const DEFAULT_MAX_DELAY = 30000;

/**
 * Computes the backoff delay in milliseconds for a given attempt count.
 *
 * Uses exponential backoff: `baseDelay * 2^(attempts - 1)`, capped at `maxDelay`.
 *
 * @param attempts - The current attempt count (1-based)
 * @param baseDelay - The base delay in milliseconds (default 1000)
 * @param maxDelay - The maximum delay cap in milliseconds (default 30000)
 * @returns The backoff delay in milliseconds
 *
 * @example
 * ```typescript
 * computeBackoffMs(1); // 1000
 * computeBackoffMs(2); // 2000
 * computeBackoffMs(3); // 4000
 * computeBackoffMs(10); // 30000 (capped)
 * ```
 * @since 0.1.0
 */
export function computeBackoffMs(
  attempts: number,
  baseDelay: number = DEFAULT_BASE_DELAY,
  maxDelay: number = DEFAULT_MAX_DELAY,
): number {
  const delay = baseDelay * Math.pow(2, attempts - 1);
  return Math.min(delay, maxDelay);
}
