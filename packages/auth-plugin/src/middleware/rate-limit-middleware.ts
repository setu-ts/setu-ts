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
} from '@setu-ts/common';
import { CAPABILITIES } from '@setu-ts/common';
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
   * Key generator function. Defaults to {@linkcode defaultRateLimitKey}, which
   * prefers the authenticated principal, then the client IP published by
   * `ipSecurityMiddleware`, then `IRequest.ip`, and only then `'anonymous'`.
   *
   * Supply your own when none of those identify a caller in your deployment —
   * an `'anonymous'` key makes the limiter a single GLOBAL counter (see the note
   * on {@linkcode defaultRateLimitKey}).
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
  const keyGenerator = options.keyGenerator ?? defaultRateLimitKey;
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

/**
 * Default rate-limit key, in order of preference:
 *
 * 1. `ctx.request.user?.id` — the authenticated principal, when auth middleware ran first.
 * 2. `ctx.state.get('clientIp')` — the IP `ipSecurityMiddleware` publishes (it needs
 *    `trustProxy` plus a proxy header to resolve one).
 * 3. `ctx.request.ip` — set only by a custom `IHttpAdapter`; the first-party adapters
 *    cannot populate it, because a web `Request` carries no peer address (M23).
 * 4. `'anonymous'`.
 *
 * **The `'anonymous'` fallback makes the limiter one GLOBAL counter** — `max`
 * requests per window across ALL callers, which both starves legitimate traffic
 * and fails to limit any individual client. The previous default went straight
 * from `ctx.request.ip` to `'anonymous'`, so on every first-party adapter that
 * is exactly what it did. Register `ipSecurityMiddleware` (with `trustProxy`),
 * put this after authentication, or pass your own `keyGenerator`.
 *
 * @param ctx - The request context
 * @returns The key to count against
 * @since 0.1.0
 */
export function defaultRateLimitKey(ctx: IRequestContext): string {
  const userId = ctx.request.user?.id;
  if (userId !== undefined && userId !== '') {
    return `user:${userId}`;
  }
  const stateIp = ctx.state.get('clientIp');
  if (typeof stateIp === 'string' && stateIp !== '') {
    return `ip:${stateIp}`;
  }
  const requestIp = ctx.request.ip;
  if (requestIp !== undefined && requestIp !== '') {
    return `ip:${requestIp}`;
  }
  return 'anonymous';
}
