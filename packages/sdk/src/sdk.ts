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
 * Validates policy values at construction:
 * - `retry.limit >= 1`
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
    if (options.retry.limit < 1) {
      throw new Error('retry.limit must be >= 1');
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
