/**
 * SDK factory: `createClient()`.
 *
 * Validates policy options, applies default timing, and wires everything into
 * the internal `HttpClient` class, returning it as `IHttpClient`.
 *
 * @module
 */

import type { ClientOptions, IHttpClient } from './http/contracts.ts';
import { HttpClient } from './http/http-client.ts';
import { createDefaultClientTiming } from './http/timing.ts';

// JavaScript runtimes clamp larger setTimeout delays, commonly to 1 ms.
const MAX_TIMER_DELAY_MS = 2_147_483_647;

/**
 * Create a configured HTTP client.
 *
 * Validates policy values at construction:
 * - `retry.limit` is a positive safe integer
 * - `retry.delay` is finite and non-negative
 * - the largest exponential retry delay remains finite
 * - `circuitBreaker.threshold >= 1`
 * - `rateLimit.maxRequests >= 1` and `rateLimit.windowMs > 0`
 *
 * Defaults `timing` to `createDefaultClientTiming()` when omitted.
 *
 * @param options - Client configuration.
 * @returns An `IHttpClient` instance.
 * @since 0.1.0
 */
export function createClient(options: ClientOptions): IHttpClient {
  // Default timing.
  const timing = options.timing ?? createDefaultClientTiming();

  // Validate retry policy.
  if (options.retry) {
    if (!Number.isSafeInteger(options.retry.limit) || options.retry.limit < 1) {
      throw new Error('retry.limit must be a positive safe integer');
    }
    if (!Number.isFinite(options.retry.delay) || options.retry.delay < 0) {
      throw new Error('retry.delay must be a finite non-negative number');
    }
    if (options.retry.delay > MAX_TIMER_DELAY_MS) {
      throw new Error('retry.delay exceeds the maximum timer delay');
    }
    const largestPolicyDelay = options.retry.delay * 2 ** (options.retry.limit - 1);
    if (
      options.retry.backoff === 'exponential' &&
      !Number.isFinite(largestPolicyDelay)
    ) {
      throw new Error('retry exponential backoff must remain finite');
    }
    if (
      options.retry.backoff === 'exponential' &&
      largestPolicyDelay > MAX_TIMER_DELAY_MS
    ) {
      throw new Error('retry exponential backoff exceeds the maximum timer delay');
    }
    if (
      options.retry.maxRetryAfterMs !== undefined &&
      (!Number.isFinite(options.retry.maxRetryAfterMs) || options.retry.maxRetryAfterMs < 0)
    ) {
      throw new Error('retry.maxRetryAfterMs must be a finite non-negative number');
    }
    if (
      options.retry.maxRetryAfterMs !== undefined &&
      options.retry.maxRetryAfterMs > MAX_TIMER_DELAY_MS
    ) {
      throw new Error('retry.maxRetryAfterMs exceeds the maximum timer delay');
    }
  }

  // Validate circuit breaker policy.
  if (options.circuitBreaker) {
    if (options.circuitBreaker.threshold < 1) {
      throw new Error('circuitBreaker.threshold must be >= 1');
    }
  }

  // Validate rate limit policy.
  if (options.rateLimit) {
    if (options.rateLimit.maxRequests < 1) {
      throw new Error('rateLimit.maxRequests must be >= 1');
    }
    if (options.rateLimit.windowMs <= 0) {
      throw new Error('rateLimit.windowMs must be > 0');
    }
  }

  return new HttpClient({ ...options, timing });
}
