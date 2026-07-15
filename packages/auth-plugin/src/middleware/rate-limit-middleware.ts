/**
 * Rate limiting middleware factory.
 *
 * Fixed-window counter with 429 short-circuit, Retry-After and RateLimit-*
 * headers, and a pluggable store (memory or Redis).
 *
 * @module
 */

import type {
  HandlerResult,
  IRequestContext,
  IRuntimeServices,
  MiddlewareFunction,
} from '@hono-enterprise/common';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { RateLimitStore } from '../stores/rate-limit-store.ts';
import { MemoryRateLimitStore } from '../stores/rate-limit-store.ts';

/**
 * Options for rate limiting middleware.
 */
export interface RateLimitOptions {
  /** Time window in milliseconds. */
  readonly windowMs: number;
  /** Max requests per window per key. */
  readonly max: number;
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
 * short-circuits with a 429 response (Retry-After and RateLimit-* headers set,
 * next() NOT called). Otherwise sets the headers and proceeds to next().
 *
 * @example
 * ```typescript
 * app.middleware.add(rateLimitMiddleware({ windowMs: 60000, max: 100 }));
 * ```
 */
export function rateLimitMiddleware(options: RateLimitOptions): MiddlewareFunction {
  const { windowMs, max } = options;
  const keyGenerator = options.keyGenerator ??
    ((ctx: IRequestContext) => ctx.request.ip ?? 'anonymous');
  const message = options.message ?? 'Rate limit exceeded';
  const standardHeaders = options.standardHeaders ?? true;

  // Lazily-built store (memoized per middleware instance, not per request)
  let store: RateLimitStore | undefined = options.store;

  return async (
    ctx: IRequestContext,
    next: () => Promise<void>,
  ): Promise<void | HandlerResult> => {
    const runtime = ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME);
    if (store === undefined) {
      store = new MemoryRateLimitStore(runtime);
    }

    const key = keyGenerator(ctx);
    const result = await store.increment(key, windowMs);
    // Delta-seconds until the window resets — used for Retry-After AND
    // RateLimit-Reset (the IETF draft defines Reset as delta-seconds).
    const resetAfter = Math.ceil((result.resetTime - runtime.now()) / 1000);

    if (standardHeaders) {
      ctx.response
        .header('RateLimit-Limit', String(max))
        .header('RateLimit-Remaining', String(Math.max(0, max - result.count)))
        .header('RateLimit-Reset', String(resetAfter));
    }

    if (result.count > max) {
      // Short-circuit: 429 with headers, no next()
      return ctx.response
        .status(429)
        .header('Retry-After', String(resetAfter))
        .json({
          error: 'Too Many Requests',
          message,
        });
    }

    await next();
  };
}
