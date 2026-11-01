/**
 * Rate limiting middleware factory.
 *
 * Fixed-window counter with 429 short-circuit, Retry-After and the
 * `RateLimit`/`RateLimit-Policy` fields of
 * draft-ietf-httpapi-ratelimit-headers-11, and a pluggable store (memory or
 * Redis).
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
  /** Time window in milliseconds; a positive integer. */
  readonly windowMs: number;
  /** Max requests per window per key; an integer from 0 to 999999999999999. */
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
  /**
   * Emit the `RateLimit` and `RateLimit-Policy` header fields of
   * draft-ietf-httpapi-ratelimit-headers-11 (default: true).
   */
  readonly standardHeaders?: boolean;
  /**
   * The quota policy name emitted in `RateLimit-Policy`, `RateLimit` and the
   * 429 body's `violated-policies` extension (default: `'default'`).
   *
   * Give two stacked limiters different names: both append one member to each
   * list field, so a shared name makes the two budgets indistinguishable to a
   * client.
   *
   * @since 0.12.0
   */
  readonly policyName?: string;
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
 * The IANA-registered problem type a refused request is identified as.
 *
 * Not exported from `src/index.ts`: callers receive it in the body, never as a
 * constant to match on.
 */
const QUOTA_EXCEEDED_TYPE = 'https://iana.org/assignments/http-problem-types#quota-exceeded';

/**
 * The largest integer an RFC 9651 `sf-integer` can carry (RFC 9651 §3.3.1:
 * at most 15 decimal digits).
 */
const MAX_SF_INTEGER = 999_999_999_999_999;

/**
 * Serializes a string as an RFC 9651 Structured Fields `sf-string`.
 *
 * Wraps the value in double quotes and escapes each `\` as `\\` and each `"`
 * as `\"` (RFC 9651 §4.1.6). Exported from this module — but not from
 * `src/index.ts` — so the escaping can be unit-tested directly.
 *
 * @param value - The raw policy name
 * @returns The quoted, escaped `sf-string`
 * @since 0.12.0
 */
export function serializeSfString(value: string): string {
  return `"${value.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;
}

/**
 * Rate limiting middleware factory.
 *
 * On each request, increments the counter for the resolved key. If count > max,
 * short-circuits with a 429 response (`Retry-After`, `RateLimit` and
 * `RateLimit-Policy` fields set, next() NOT called). Otherwise sets the header
 * fields and proceeds to next().
 *
 * Both header fields are Structured Field Lists (RFC 9651), so each limiter
 * APPENDS one member: stacking two limiters on one route yields one member per
 * policy rather than one field overwriting the other.
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
  if (!Number.isSafeInteger(max) || max < 0 || max > MAX_SF_INTEGER) {
    throw new RangeError('rateLimitMiddleware: max must be an integer from 0 to 999999999999999');
  }
  // Redis `PEXPIRE` refuses a fractional value after `INCR` has already created
  // the key, leaving a counter that never expires.
  if (!Number.isSafeInteger(windowMs) || windowMs <= 0) {
    throw new RangeError(
      'rateLimitMiddleware: windowMs must be a positive integer number of milliseconds',
    );
  }
  const policyName = options.policyName ?? 'default';
  if (!/^[\x20-\x7E]+$/.test(policyName)) {
    throw new TypeError('rateLimitMiddleware: policyName must be non-empty printable ASCII');
  }
  const keyGenerator = options.keyGenerator ?? defaultRateLimitKey;
  const message = options.message ?? 'Rate limit exceeded';
  const standardHeaders = options.standardHeaders ?? true;
  // Precomputed once at registration, never per request.
  //
  // `w` needs no sf-integer check of its own: `windowMs` is a safe integer, so
  // `ceil(9007199254740991 / 1000)` has 13 digits, well inside the 15-digit
  // maximum.
  const windowSeconds = Math.ceil(windowMs / 1000);
  const policyItem = serializeSfString(policyName);
  const policyHeader = `${policyItem};q=${max};w=${windowSeconds}`;
  // Partitioned once at registration, never per request.
  const isExcluded = createPathMatcher(options.exclude ?? DEFAULT_RATE_LIMIT_EXCLUDED_PATHS);

  // Lazily-built store (memoized per middleware instance, not per request)
  let store: RateLimitStore | undefined = options.store;

  return async (ctx: IRequestContext, next: () => Promise<void>): Promise<void | HandlerResult> => {
    // An exempt path skips the limiter entirely: no counter is incremented, so
    // a probe cannot consume the budget a real caller needs, and no
    // `RateLimit`/`RateLimit-Policy` fields are written for a request the limit
    // does not govern.
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
    const now = runtime.now();
    // The limiter is an abuse control, so a store it cannot read refuses rather
    // than serves — it fails closed, like an authorization check. A result that
    // is not a finite whole number is treated as an exhausted bucket for a full
    // window, and the ordinary 429 path below answers it.
    const readable =
      Number.isSafeInteger(result.count) && result.count >= 0 && Number.isFinite(result.resetTime);
    const count = readable ? result.count : max + 1;
    // Delta-seconds until the window resets — used for Retry-After AND the
    // draft-11 `t` parameter. Clamped to zero: a store can report a reset that
    // has already passed (clock skew, a Redis key expiring mid-call), and
    // delta-seconds is non-negative in both RFC 9110 and the draft. Clamped
    // above at the sf-integer maximum because both fields are RFC 9651
    // integers.
    const resetAfter = readable
      ? Math.min(MAX_SF_INTEGER, Math.max(0, Math.ceil((result.resetTime - now) / 1000)))
      : Math.min(MAX_SF_INTEGER, windowSeconds);

    if (standardHeaders) {
      const remaining = Math.max(0, max - count);
      ctx.response
        .appendHeader('RateLimit-Policy', policyHeader)
        .appendHeader('RateLimit', `${policyItem};r=${remaining};t=${resetAfter}`);
    }

    if (count > max) {
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
        problem: {
          type: QUOTA_EXCEEDED_TYPE,
          title: 'Quota Exceeded',
          extensions: { 'violated-policies': [policyName] },
        },
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
 * 2. `ctx.state.get(CLIENT_IP_STATE_KEY)` — the client IP `ipSecurityMiddleware` publishes.
 *    With proxy trust off it publishes the socket peer. **See the warning below:
 *    `trustProxy` alone can make this key attacker-controlled.**
 * 3. `ctx.request.ip` — the socket peer on Node, Deno and Bun (M113n), normalized
 *    from IPv4-mapped IPv6. Workers and plain fetch calls have no peer.
 * 4. `'anonymous'`.
 * A forwarded entry that is not an address resolves no client, so the key falls back to the socket peer, or `'anonymous'` without one.
 *
 * **The `'anonymous'` fallback makes the limiter one GLOBAL counter** — `max`
 * requests per window across ALL callers, which both starves legitimate traffic
 * and fails to limit any individual client. Socket-serving adapters now count
 * per peer even without IP security. Behind a proxy, register IP security to
 * resolve clients rather than proxies; on Workers supply a trusted header or
 * your own `keyGenerator`. Put the limiter after authentication to count users.
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
