/**
 * The rate-limit key the README claims (M90h §3.1).
 *
 * X22-4: the auth README annotated its rate-limit example `// per IP`, but
 * the example registers `rateLimitMiddleware` ALONE — no `ipSecurityMiddleware`
 * — so `defaultRateLimitKey` resolves the literal `'anonymous'` for every
 * unauthenticated caller: one GLOBAL bucket. The fence compiler compiles this
 * README (`test/package-readme-fence-compiler.test.ts`) but cannot see a
 * comment, so the corrected comment can rot exactly as the original did. This
 * test pins the claim under the comment: the README's own composition, driven
 * by two requests that differ only in the address their proxy header claims,
 * both counting against `'anonymous'`.
 *
 * The remedy the comment names — `ipSecurityMiddleware` with `trustProxy` — is
 * deliberately NOT registered: a case that did register it would assert
 * per-address keys and would be testing the remedy rather than the claim.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  HandlerResult,
  IPluginContext,
  IRequestContext,
  IRuntimeServices,
} from '@setu-ts/common';
import {
  DEFAULT_RATE_LIMIT_EXCLUDED_PATHS,
  rateLimitMiddleware,
} from '../../src/middleware/rate-limit-middleware.ts';
import type { RateLimitResult, RateLimitStore } from '../../src/stores/rate-limit-store.ts';

/**
 * A store that records every key it is asked to increment, so the test
 * asserts the KEY the middleware resolved rather than an effect of it. A real
 * `MemoryRateLimitStore` would answer either way: a per-address key and a
 * shared `'anonymous'` key both let two requests through, so the counter
 * behaviour alone cannot distinguish the claim from its negation.
 *
 * The recorded `resetTime` is read from the same `IRuntimeServices` clock the
 * middleware reads at request time — never the host clock — so the double
 * stays correct for anyone who copies it into a fake-clock test.
 */
function recordingStore(
  counts: Map<string, number>,
  runtime: IRuntimeServices,
): RateLimitStore {
  return {
    increment(key: string, windowMs: number): Promise<RateLimitResult> {
      const count = (counts.get(key) ?? 0) + 1;
      counts.set(key, count);
      return Promise.resolve({ count, resetTime: runtime.now() + windowMs });
    },
    reset(key: string): Promise<void> {
      counts.delete(key);
      return Promise.resolve();
    },
  };
}

describe('documented rate-limit key (X22-4)', () => {
  it('counts two callers with different claimed addresses against ONE anonymous key', async () => {
    const counts = new Map<string, number>();
    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        {
          name: 'routes',
          version: '1.0.0',
          register(ctx: IPluginContext) {
            // The README's composition, verbatim: the limiter alone, no
            // ipSecurityMiddleware, no keyGenerator.
            ctx.middleware.add(
              rateLimitMiddleware({
                windowMs: 60_000,
                max: 100,
                exclude: [...DEFAULT_RATE_LIMIT_EXCLUDED_PATHS, /^\/internal\//],
                store: recordingStore(
                  counts,
                  ctx.services.get<IRuntimeServices>(CAPABILITIES.RUNTIME),
                ),
              }),
              { name: 'rate-limit', priority: 150 },
            );
            const ok = (reqCtx: IRequestContext): HandlerResult =>
              reqCtx.response.json({ ok: true });
            ctx.router.get('/a', { handler: ok });
            ctx.router.get('/b', { handler: ok });
          },
        },
      ],
    });
    await app.start();
    try {
      // Two callers, each claiming a DIFFERENT address through the one header
      // `ipSecurityMiddleware` would read. Without that middleware nothing
      // publishes a client IP, `ctx.request.ip` is unset on every first-party
      // adapter (M23), and there is no principal — so the only key available
      // is the fallback.
      const first = await app.inject({
        method: 'GET',
        url: 'http://localhost/a',
        headers: { 'x-forwarded-for': '198.51.100.1' },
      });
      const second = await app.inject({
        method: 'GET',
        url: 'http://localhost/b',
        headers: { 'x-forwarded-for': '203.0.113.7' },
      });

      expect(first.statusCode).toBe(200);
      expect(second.statusCode).toBe(200);

      // The claim: both callers share ONE bucket, and its key is the literal
      // 'anonymous' — not one key per claimed address.
      expect([...counts.keys()]).toEqual(['anonymous']);
      expect(counts.get('anonymous')).toBe(2);
    } finally {
      await app.stop();
    }
  });
});
