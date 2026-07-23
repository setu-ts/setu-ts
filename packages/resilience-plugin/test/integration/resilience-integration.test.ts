/**
 * Integration test: ResiliencePlugin wired into a real kernel app over the real
 * RuntimePlugin, driven through `app.inject` so the resolved IResilienceService
 * runs against the real runtime clock and timers (the REAL path, not the fake).
 */
import { describe, it } from '@std/testing/bdd';
import { expect } from '@std/expect';
import { CAPABILITIES } from '@hono-enterprise/common';
import type { IResilienceService } from '@hono-enterprise/common';
import { createApplication } from '@hono-enterprise/kernel';
import { RuntimePlugin } from '@hono-enterprise/runtime';
import { ResiliencePlugin } from '../../src/index.ts';

describe('ResiliencePlugin integration', () => {
  it('resolves the service and hardens a flaky call end-to-end', async () => {
    // A dependency that fails its first two calls, then recovers.
    let attempts = 0;
    // A dependency that always fails (drives the breaker open).
    let failCalls = 0;

    const app = createApplication({
      plugins: [
        RuntimePlugin(),
        ResiliencePlugin({
          defaultRetry: { limit: 3, delay: 5, backoff: 'exponential' },
        }),
      ],
    });

    let retryGuarded: () => Promise<string> = () => Promise.resolve('');
    let breakerGuarded: () => Promise<string> = () => Promise.resolve('');

    app.register({
      name: 'consumer',
      version: '1.0.0',
      dependencies: ['resilience'],
      register(ctx) {
        const resilience = ctx.services.get<IResilienceService>(CAPABILITIES.RESILIENCE);

        retryGuarded = resilience.wrap(() => {
          attempts++;
          if (attempts < 3) return Promise.reject(new Error('transient'));
          return Promise.resolve('recovered');
        }, { retry: true, timeout: 1000 });

        breakerGuarded = resilience.wrap(() => {
          failCalls++;
          return Promise.reject(new Error('down'));
        }, { circuitBreaker: { threshold: 2, timeout: 60_000, resetTimeout: 60_000 } });
      },
    });

    app.router.get('/retry', async (ctx) => {
      const value = await retryGuarded();
      return ctx.response.json({ value });
    });

    app.router.get('/breaker', async (ctx) => {
      try {
        await breakerGuarded();
        return ctx.response.json({ error: 'none' });
      } catch (error) {
        return ctx.response.json({ error: (error as Error).name });
      }
    });

    await app.start();
    try {
      // Retry recovers the transient failure end-to-end.
      const retryResponse = await app.inject({
        method: 'GET',
        url: 'http://localhost/retry',
        headers: new Headers(),
      });
      expect(retryResponse.statusCode).toBe(200);
      expect(retryResponse.json<{ value: string }>().value).toBe('recovered');
      expect(attempts).toBe(3);

      // Two failing calls trip the breaker; the third fails fast (fn untouched).
      const first = await app.inject({
        method: 'GET',
        url: 'http://localhost/breaker',
        headers: new Headers(),
      });
      const second = await app.inject({
        method: 'GET',
        url: 'http://localhost/breaker',
        headers: new Headers(),
      });
      const third = await app.inject({
        method: 'GET',
        url: 'http://localhost/breaker',
        headers: new Headers(),
      });
      expect(first.json<{ error: string }>().error).toBe('Error');
      expect(second.json<{ error: string }>().error).toBe('Error');
      expect(third.json<{ error: string }>().error).toBe('CircuitOpenError');
      // The breaker short-circuited the third call — fn ran only twice.
      expect(failCalls).toBe(2);
    } finally {
      await app.stop();
    }
  });
});
