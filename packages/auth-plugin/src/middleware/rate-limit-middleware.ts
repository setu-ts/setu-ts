/**
 * Rate limiting middleware factory.
 *
 * Fixed-window counter with 429 short-circuit, Retry-After and RateLimit-*
 * headers, and a pluggable store (memory or Redis).
 *
 * @module
 */

import type { IRequestContext, MiddlewareFunction } from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { RateLimitStore } from '../stores/rate-limit-store.ts';
import { MemoryRateLimitStore } from '../stores/rate-limit-store.ts';

/**
 * Options for rate limiting middleware.
 */
export interface RateLimitOptions {
  /** Time window in milliseconds (default: 60000 = 1 minute). */
  readonly windowMs?: number;
  /** Max requests per window (default: 100). */
  readonly max?: number;
  /** Custom store implementation. If omitted, a MemoryRateLimitStore is built lazily. */
  readonly store?: RateLimitStore;
  /**
   * Key generator function. Defaults to request IP, falling back to 'anonymous'.
   * For authenticated requests, may read ctx.request.user?.id.
   */
  readonly keyGenerator?: (ctx: IRequestContext) => string;
  /** Message returned in the 429 body. */
  readonly message?: string;
  /** Emit standard RateLimit-* headers (default: true). */
  readonly standardHeaders?: boolean;
}

/**
 * Rate limiting middleware factory.
 *
 * On each request, increments the counter for the resolved key. If count > max,
 * short-circuits with a 429 response, sets Retry-After and RateLimit-* headers,
 * and does NOT call next(). Otherwise sets the headers and proceeds to next().
 *
 * @example
 * ```typescript
 * app.middleware.add(rateLimitMiddleware({ windowMs: 60000, max: 100 }));
 * ```
 */
export function rateLimitMiddleware(options: RateLimitOptions = {}): MiddlewareFunction {
  const windowMs = options.windowMs ?? 60000;
  const max = options.max ?? 100;
  const keyGenerator = options.keyGenerator ??
    ((ctx: IRequestContext) => ctx.request.ip ?? 'anonymous');
  const message = options.message ?? 'Rate limit exceeded';
  const standardHeaders = options.standardHeaders ?? true;

  // Lazily-built store (memoized per app instance, not per request)
  let store: RateLimitStore;

  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void> => {
    // Resolve or build the store
    if (store === undefined!) {
      if (options.store !== undefined) {
        store = options.store;
      } else {
        // Build a MemoryRateLimitStore from the runtime
        const runtime = ctx.services.get<{ now(): number }>(CAPABILITIES.RUNTIME);
        store = new MemoryRateLimitStore(runtime);
      }
    }

    const key = keyGenerator(ctx);
    const result = await store.increment(key, windowMs);
    const now = ctx.services.get<{ now(): number }>(CAPABILITIES.RUNTIME).now();
    const retryAfter = Math.ceil((result.resetTime - now) / 1000);

    if (result.count > max) {
      // Short-circuit: 429 with headers, no next()
      ctx.response
        .status(429)
        .header('Retry-After', String(retryAfter));

      if (standardHeaders) {
        ctx.response
          .header('RateLimit-Limit', String(max))
          .header('RateLimit-Remaining', '0')
          .header('RateLimit-Reset', String(retryAfter));
      }

      ctx.response.json({
        error: 'Too Many Requests',
        message,
      });

      return;
    }

    // Under limit — set headers and continue
    const remaining = Math.max(0, max - result.count);

    if (standardHeaders) {
      ctx.response
        .header('RateLimit-Limit', String(max))
        .header('RateLimit-Remaining', String(remaining))
        .header('RateLimit-Reset', String(retryAfter));
    }

    await next();
  };
}
