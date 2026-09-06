/**
 * The `429` answers in the application's configured error format (M90a §3.7).
 *
 * X32-2: `rateLimitMiddleware` wrote its own body with
 * `ctx.response.status(429).json({ error, message })`. M70f routed every
 * first-party short-circuit through `respondWithError` — "upload ×6, tenant,
 * session ×2, auth ×9, http-security ×3, the flag guard" — and missed this one,
 * presumably because the limiter is middleware rather than a guard. So the ONE
 * status a client is most likely to handle programmatically was the one status
 * that ignored the configured format, and a consumer parsing Problem Details —
 * which this framework's own generated SDK does — got an unreadable body under
 * `application/json`.
 *
 * Driven with `app.fetch`, never `inject()`: `inject()` exposes no response
 * headers, so the `content-type` half — the half a generic Problem Details
 * client actually branches on — would pass either way (the M70i lesson).
 */

import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { AuthPlugin } from '../../src/plugin/auth-plugin.ts';
import { authMiddleware } from '../../src/middleware/auth-middleware.ts';
import {
  DEFAULT_RATE_LIMIT_EXCLUDED_PATHS,
  rateLimitMiddleware,
} from '../../src/middleware/rate-limit-middleware.ts';
import { requireAuth } from '../../src/guards/index.ts';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';
import type { ErrorFormat } from '@setu-ts/exceptions';
import type { HandlerResult, IPluginContext, IRequestContext } from '@setu-ts/common';
import type { RateLimitResult, RateLimitStore } from '../../src/stores/rate-limit-store.ts';

/**
 * A store that reports every key as already past any budget.
 *
 * `resetTime` is an ABSOLUTE epoch-ms timestamp, which is what the
 * {@linkcode RateLimitStore} contract says and what both shipped stores return
 * — `MemoryRateLimitStore` from `runtime.now()`, `RedisRateLimitStore` from
 * `now + PTTL`. A double returning a small constant instead would make the
 * middleware's `ceil((resetTime - now) / 1000)` produce a large negative
 * `Retry-After` and the header assertions below meaningless: this app runs the
 * REAL `RuntimePlugin`, so `now()` is the wall clock.
 */
const exhausted: RateLimitStore = {
  increment(): Promise<RateLimitResult> {
    return Promise.resolve({ count: 1_000_000, resetTime: Date.now() + 60_000 });
  },
  reset(): Promise<void> {
    return Promise.resolve();
  },
};

/**
 * One application carrying BOTH short-circuit sites: the limiter's `429` and a
 * guard's `401`. Asserting them against each other is what proves the two agree
 * — a `429` asserted alone would pass against a formatter this middleware
 * happened to hardcode.
 */
async function bootApp(format: ErrorFormat) {
  const app = createApplication({
    plugins: [
      // The REAL RuntimePlugin: `app.fetch` needs an `IHttpAdapter`, and the
      // whole point of this file is the bytes that reach the wire.
      RuntimePlugin(),
      AuthPlugin({ jwt: { secret: 'format-secret' } }),
      {
        name: 'routes',
        version: '1.0.0',
        dependencies: ['auth-plugin'],
        register(ctx: IPluginContext) {
          ctx.middleware.add(errorHandler({ format }), { name: 'errors', priority: 10 });
          ctx.middleware.add(authMiddleware(), { name: 'auth', priority: 100 });
          ctx.middleware.add(
            rateLimitMiddleware({
              windowMs: 60_000,
              max: 1,
              store: exhausted,
              // `/guarded` is exempt so the GUARD's 401 is reachable. Without
              // this the limiter refuses it first and the comparison below is
              // a 429 against a 429 — which passes whatever the limiter writes,
              // i.e. exactly the vacuous assertion the comparison exists to
              // avoid. Found by the negative control: reverting the responder
              // routing left both agreement cases green.
              exclude: [...DEFAULT_RATE_LIMIT_EXCLUDED_PATHS, '/guarded'],
            }),
            { name: 'rate-limit', priority: 150 },
          );
          const ok = (reqCtx: IRequestContext): HandlerResult => reqCtx.response.json({ ok: true });
          ctx.router.get('/limited', { handler: ok });
          ctx.router.get('/guarded', { middleware: [requireAuth()], handler: ok });
          // Exempt, so the guard's 401 is reachable without the limiter
          // refusing first.
          ctx.router.get('/live', { handler: ok });
        },
      },
    ],
  });
  await app.start();
  return app;
}

async function read(response: Response): Promise<{ contentType: string; body: unknown }> {
  return {
    contentType: response.headers.get('content-type') ?? '',
    body: await response.json(),
  };
}

describe('rate-limit 429 error format (X32-2)', () => {
  it("under 'rfc9457' the 429 is a Problem Details body under problem+json", async () => {
    const app = await bootApp('rfc9457');
    try {
      const response = await app.fetch(new Request('http://localhost/limited'));
      expect(response.status).toBe(429);

      const { contentType, body } = await read(response);
      expect(contentType).toContain('application/problem+json');

      const problem = body as Record<string, unknown>;
      // Field by field, forbidden fields included: a Problem Details body
      // carries `detail`, never `message`.
      expect(problem.type).toBe('about:blank');
      expect(problem.title).toBe('Too Many Requests');
      expect(problem.status).toBe(429);
      expect(problem.detail).toBe('Rate limit exceeded');
      expect('message' in problem).toBe(false);
    } finally {
      await app.stop();
    }
  });

  // The real assertion of X32-2, and it is run under BOTH formats on purpose:
  // asserting only `rfc9457` would pass against a middleware that hardcoded
  // that one formatter, which is a narrower version of the defect being fixed.
  for (const format of ['rfc9457', 'default'] as const) {
    it(`under '${format}' the 429 and a guard's 401 agree on shape and content type`, async () => {
      const app = await bootApp(format);
      try {
        const limitedResponse = await app.fetch(new Request('http://localhost/limited'));
        const guardedResponse = await app.fetch(new Request('http://localhost/guarded'));
        // Pinned so the comparison cannot go vacuous by both sides becoming a
        // 429 (which is what happened before `/guarded` was exempted).
        expect(limitedResponse.status).toBe(429);
        expect(guardedResponse.status).toBe(401);

        const limited = await read(limitedResponse);
        const guarded = await read(guardedResponse);

        expect(guarded.contentType).toBe(limited.contentType);
        expect(Object.keys(guarded.body as object).sort())
          .toEqual(Object.keys(limited.body as object).sort());
      } finally {
        await app.stop();
      }
    });
  }

  it("under 'default' the 429 takes the same shape every other refusal does", async () => {
    // The `'default'` formatter's own shape — `{ statusCode, message,
    // details }` — which is what the tenant, session and auth short-circuits
    // have answered with since M70f. The 429 used to answer
    // `{ error, message }` here instead: a BREAKING body change, recorded in
    // the CHANGELOG.
    const app = await bootApp('default');
    try {
      const response = await app.fetch(new Request('http://localhost/limited'));
      expect(response.status).toBe(429);
      const { contentType, body } = await read(response);
      expect(contentType).toContain('application/json');
      expect(contentType).not.toContain('problem+json');
      expect(body).toEqual({
        statusCode: 429,
        message: 'Too Many Requests',
        details: { detail: 'Rate limit exceeded' },
      });
    } finally {
      await app.stop();
    }
  });

  it('the Retry-After and RateLimit-* headers survive the responder', async () => {
    // The formatter writes the body through `.send(bytes)`; a header written
    // before it must still reach the wire.
    const app = await bootApp('rfc9457');
    try {
      const response = await app.fetch(new Request('http://localhost/limited'));
      expect(response.headers.get('Retry-After')).toBe('60');
      expect(response.headers.get('RateLimit-Limit')).toBe('1');
      expect(response.headers.get('RateLimit-Remaining')).toBe('0');
      expect(response.headers.get('RateLimit-Reset')).toBe('60');
      await response.body?.cancel();
    } finally {
      await app.stop();
    }
  });

  it('an excluded path is served even with the bucket exhausted', async () => {
    // X32-1 asserted through the real pipeline rather than a fake context.
    const app = await bootApp('rfc9457');
    try {
      const response = await app.fetch(new Request('http://localhost/live'));
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({ ok: true });
    } finally {
      await app.stop();
    }
  });
});
