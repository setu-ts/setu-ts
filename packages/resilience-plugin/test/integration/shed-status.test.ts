/**
 * X32-7 end to end: the resilience load-shedding signals reach the client as
 * the statuses the contract states — bulkhead shed `503`, open circuit
 * `503`, timeout `504` — instead of a masked `500` that reads as a bug in
 * every dashboard. Shedding is the bulkhead's PURPOSE, so the status is part
 * of the contract rather than an implementation detail.
 *
 * Each case also asserts `Retry-After` is ABSENT (§3.5): the hint channel
 * carries no header, the framework holds no honest value for a bulkhead's
 * drain horizon, and `503` is itself the retryable signal. Asserting the
 * absence makes a later addition a deliberate change rather than a drift.
 *
 * @module
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@setu-ts/common';
import type {
  HandlerResult,
  IPluginContext,
  IRequestContext,
  IResilienceService,
} from '@setu-ts/common';
import { createApplication } from '@setu-ts/kernel';
import { RuntimePlugin } from '@setu-ts/runtime';
import { errorHandler } from '@setu-ts/exceptions';

import { ResiliencePlugin } from '../../src/index.ts';

/** Set by `boot()`; opens the bulkhead gate once every request has claimed. */
let openGate: (() => void) | undefined;
/** Set by `boot()`; releases the never-ending timeout call before stop(). */
let releaseBlocked: (() => void) | undefined;

function boot(): ReturnType<typeof createApplication> {
  const app = createApplication({
    plugins: [RuntimePlugin(), ResiliencePlugin()],
  });
  app.middleware.add(errorHandler({ format: 'rfc9457' }), { priority: 10, name: 'errors' });

  app.register({
    name: 'guarded-routes',
    version: '1.0.0',
    dependencies: ['resilience'],
    register(ctx: IPluginContext) {
      const resilience = ctx.services.get<IResilienceService>(CAPABILITIES.RESILIENCE);

      // Holds every admitted call until the test opens the gate, so the
      // 2+2 capacity is genuinely occupied while all ten requests arrive.
      const gate = Promise.withResolvers<void>();
      openGate = gate.resolve;
      const bulkheaded = resilience.wrap(
        () => gate.promise.then(() => ({ served: true })),
        { bulkhead: { maxConcurrent: 2, maxQueue: 2 } },
      );

      ctx.router.get('/bulkhead', {
        handler: async (reqCtx: IRequestContext): Promise<HandlerResult> => {
          return reqCtx.response.json(await bulkheaded());
        },
      });

      // Trips on the first failure and stays open for the whole test.
      const breaker = resilience.wrap(() => Promise.reject(new Error('dependency down')), {
        circuitBreaker: { threshold: 1, timeout: 60_000, resetTimeout: 60_000 },
      });
      ctx.router.get('/breaker', {
        handler: async (reqCtx: IRequestContext): Promise<HandlerResult> => {
          return reqCtx.response.json(await breaker());
        },
      });

      // A protected call that never answers on its own; released at the end.
      const blocked = new Promise<void>((resolve) => {
        releaseBlocked = resolve;
      });
      const timed = resilience.wrap(() => blocked, { timeout: 25 });
      ctx.router.get('/timeout', {
        handler: async (reqCtx: IRequestContext): Promise<HandlerResult> => {
          return reqCtx.response.json(await timed());
        },
      });
    },
  });

  return app;
}

describe('load-shedding answers its contract status (X32-7)', () => {
  it('a full bulkhead sheds six of ten concurrent requests as 503', async () => {
    const app = boot();
    await app.start();
    try {
      // Fired, not awaited: each handler claims synchronously (run, queue,
      // or shed) and the two admitted calls block on the gate, so all ten
      // claims are settled before the gate opens.
      const pending = Array.from(
        { length: 10 },
        () => app.inject({ method: 'GET', url: 'http://localhost/bulkhead' }),
      );
      await new Promise((resolve) => setTimeout(resolve, 50));
      openGate?.();
      const responses = await Promise.all(pending);

      const statuses = responses.map((r) => r.statusCode).sort();
      expect(statuses).toEqual([200, 200, 200, 200, 503, 503, 503, 503, 503, 503]);

      for (const response of responses) {
        if (response.statusCode !== 503) continue;
        const body = response.json() as Record<string, unknown>;
        expect(body.title).toBe('Service Unavailable');
        expect(body.status).toBe(503);
        expect(body.detail).toBe('The operation was shed because the bulkhead is at capacity.');
        // §3.5: the framework holds no honest Retry-After for a bulkhead.
        expect(response.headers.get('retry-after')).toBe(null);
      }
    } finally {
      openGate?.();
      await app.stop();
    }
  });

  it('an open circuit answers 503 — shedding on behalf of a failing dependency', async () => {
    const app = boot();
    await app.start();
    try {
      // First call: the underlying failure, still a masked 500 (correct —
      // the exemption is for the breaker's OWN signal only).
      const first = await app.inject({ method: 'GET', url: 'http://localhost/breaker' });
      expect(first.statusCode).toBe(500);

      // Second call: the breaker is open and fails fast — `503`.
      const second = await app.inject({ method: 'GET', url: 'http://localhost/breaker' });
      expect(second.statusCode).toBe(503);
      const body = second.json() as Record<string, unknown>;
      expect(body.detail).toBe('The circuit breaker is open and the operation was not attempted.');
      expect(second.headers.get('retry-after')).toBe(null);
    } finally {
      await app.stop();
    }
  });

  it('a timeout answers 504 — the framework was the intermediary to a slow call', async () => {
    const app = boot();
    await app.start();
    try {
      const response = await app.inject({ method: 'GET', url: 'http://localhost/timeout' });
      expect(response.statusCode).toBe(504);
      const body = response.json() as Record<string, unknown>;
      expect(body.title).toBe('Gateway Timeout');
      expect(body.detail).toBe(
        'The protected operation did not complete within its timeout deadline.',
      );
      expect(response.headers.get('retry-after')).toBe(null);
    } finally {
      releaseBlocked?.();
      await app.stop();
    }
  });
});
