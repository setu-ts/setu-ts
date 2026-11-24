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

/**
 * Create a configured HTTP client.
 *
 * Validates policy values at construction (the retry and circuit-breaker
 * checks are owned by `validateRetryPolicy` and common's
 * `breakerPolicyRangeError`, which `HttpClient` itself runs, so they hold
 * however the client is built):
 * - `retry.limit` is a positive safe integer
 * - `retry.delay` and `retry.maxRetryAfterMs` are finite, non-negative, and
 *   within the maximum timer delay
 * - the largest exponential retry delay remains finite and timer-safe
 * - `circuitBreaker` is one arm of `CircuitBreakerPolicy` with valid fields
 *   (a `RangeError` naming the field otherwise)
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
