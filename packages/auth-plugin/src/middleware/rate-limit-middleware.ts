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
  PathPattern,
} from '@setu-ts/common';
import {
  CAPABILITIES,
  CLIENT_IP_STATE_KEY,
  createPathMatcher,
  respondWithError,
} from '@setu-ts/common';
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
  /**
   * Paths exempted from the limiter, matched against `IRequest.path`. A string
   * is an EXACT match; a `RegExp` is tested against the path.
   *
   * Omitted, this is {@linkcode DEFAULT_RATE_LIMIT_EXCLUDED_PATHS} — the six
   * operational paths the framework's own plugins serve. That default exists
   * because the limiter is documented as a global middleware and the CLI
   * scaffolds Kubernetes probes pointing at `/live` and `/ready`: without it,
   * an exhausted bucket answers the liveness probe `429` and the kubelet
   * restarts a container whose only fault is that it is under load.
   *
   * Pass `[]` to exempt nothing, which is the pre-0.5.0 behaviour.
   *
   * @since 0.5.0
   */
  readonly exclude?: readonly PathPattern[];
}

/**
 * The operational paths {@linkcode RateLimitOptions.exclude} exempts by
 * default: the framework's health, metrics and OpenAPI routes plus the
 * interactive docs. The same six `tenantMiddleware` exempts, deliberately —
 * one list to remember rather than two.
 *
 * @since 0.5.0
 */
export const DEFAULT_RATE_LIMIT_EXCLUDED_PATHS: readonly PathPattern[] = [
  '/live',
  '/ready',
  '/health',
  '/metrics',
  '/openapi.json',
  '/docs',
];

/**
 * Rate limiting middleware factory.
 *
 * On each request, increments the counter for the resolved key. If count > max,
 * short-circuits with a 429 response (Retry-After and RateLimit-* headers set,
 * next() NOT called). Otherwise sets the headers and proceeds to next().
 *
 * Registered globally — the usage below, and the one the README shows — the
 * limiter sees the operational probes too, so
 * {@linkcode RateLimitOptions.exclude} exempts them by default. Widen or
 * narrow that list rather than dropping it: an exhausted bucket that refuses
 * `/live` gets the container restarted.
 *
 * @example
 * ```typescript
 * app.middleware.add(rateLimitMiddleware({
 *   windowMs: 60000,
 *   max: 100,
 *   // The six operational paths are exempt by default; add your own.
 *   exclude: [...DEFAULT_RATE_LIMIT_EXCLUDED_PATHS, /^\/internal\//],
 * }));
 * ```
 */
export function rateLimitMiddleware(options: RateLimitOptions): MiddlewareFunction {
  const { windowMs, max } = options;
  const keyGenerator = options.keyGenerator ?? defaultRateLimitKey;
  const message = options.message ?? 'Rate limit exceeded';
  const standardHeaders = options.standardHeaders ?? true;
  // Partitioned once at registration, never per request.
  const isExcluded = createPathMatcher(options.exclude ?? DEFAULT_RATE_LIMIT_EXCLUDED_PATHS);

  // Lazily-built store (memoized per middleware instance, not per request)
  let store: RateLimitStore | undefined = options.store;

  return async (
    ctx: IRequestContext,
    next: () => Promise<void>,
  ): Promise<void | HandlerResult> => {
    // An exempt path skips the limiter entirely: no counter is incremented, so
    // a probe cannot consume the budget a real caller needs, and no
    // RateLimit-* headers are written for a request the limit does not govern.
    if (isExcluded(ctx.request.path)) {
      await next();
      return;
    }

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
      // Short-circuit: 429 with headers, no next().
      //
      // The body goes through the error responder seam rather than a raw
      // `.json()`. M70f routed every first-party short-circuit through it and
      // missed this one — presumably because the limiter is middleware rather
      // than a guard — which left the single status a client is most likely to
      // handle as the one status that ignored the application's configured
      // error format. `Retry-After` is written first so it survives whichever
      // formatter answers.
      ctx.response.header('Retry-After', String(resetAfter));
      respondWithError(ctx, {
        status: 429,
        title: 'Too Many Requests',
        detail: message,
      });
      return;
    }

    await next();
  };
}

/**
 * Default rate-limit key, in order of preference:
 *
 * 1. `ctx.request.user?.id` — the authenticated principal, when auth middleware ran first.
 * 2. `ctx.state.get(CLIENT_IP_STATE_KEY)` — the IP `ipSecurityMiddleware` publishes (it needs
 *    `trustProxy` plus a proxy header to resolve one). **See the warning below: on its own
 *    `trustProxy` can make this key attacker-controlled.**
 * 3. `ctx.request.ip` — set only by a custom `IHttpAdapter`; the first-party adapters
 *    cannot populate it, because a web `Request` carries no peer address (M23).
 * 4. `'anonymous'`.
 *
 * **The `'anonymous'` fallback makes the limiter one GLOBAL counter** — `max`
 * requests per window across ALL callers, which both starves legitimate traffic
 * and fails to limit any individual client. The previous default went straight
 * from `ctx.request.ip` to `'anonymous'`, so on every first-party adapter that
 * is exactly what it did. Register `ipSecurityMiddleware`, put this after
 * authentication, or pass your own `keyGenerator`.
 *
 * **`trustProxy: true` alone is not enough, and this is the sharper hazard of
 * the two.** It resolves the LEFTMOST entry of the proxy header, which is safe
 * only behind a proxy that OVERWRITES that header. The standard nginx idiom
 * (`proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for`) APPENDS, so a
 * request arriving with a forged `X-Forwarded-For: 7.7.7.7` reaches the
 * application as `7.7.7.7, 198.51.100.9` and this function keys the limiter on
 * the value the caller chose — rotating it defeats the budget entirely, which is
 * worse than the global counter above because it looks configured. Behind an
 * appending proxy, set `ipSecurityMiddleware({ trustProxy: true, trustedProxies })`
 * (or `proxyHops`) so the client is resolved from the right.
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
  const stateIp = ctx.state.get(CLIENT_IP_STATE_KEY);
  if (typeof stateIp === 'string' && stateIp !== '') {
    return `ip:${stateIp}`;
  }
  const requestIp = ctx.request.ip;
  if (requestIp !== undefined && requestIp !== '') {
    return `ip:${requestIp}`;
  }
  return 'anonymous';
}
